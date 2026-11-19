import { MarkEdit } from 'markedit-api';
import html2canvas from 'html2canvas-pro';
import { jsPDF } from 'jspdf';

declare global {
  // Provided by the Markdown View Modes extension, resolves to an HTML string.
  function MarkEditGetHtml(styled?: boolean): Promise<string>;
}

const SCALE = 2;
const PAGE_W = 794; // A4 at 96 dpi, in CSS px
const PAGE_H = 1123;
const MARGIN_X = 56;
const MARGIN_Y = 48;
const PT = 595.28 / PAGE_W; // CSS px -> PDF points

type RGBA = [number, number, number, number];

// Parses any CSS color (including color(srgb ...) / oklch) through a canvas.
function parseColor(color: string): RGBA {
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (context === null) {
    return [255, 255, 255, 1];
  }
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}

const rgba = ([r, g, b]: RGBA, alpha: number) => `rgba(${r}, ${g}, ${b}, ${alpha})`;
const hex = ([r, g, b]: RGBA) => `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
const css = (color: RGBA) => rgba(color, color[3]);

// Walk up from an element to find the background the user actually sees.
function resolveBackground(el: HTMLElement): RGBA {
  for (let node: HTMLElement | null = el; node !== null; node = node.parentElement) {
    const color = parseColor(getComputedStyle(node).backgroundColor);
    if (color[3] > 0) {
      return color;
    }
  }
  return [255, 255, 255, 1];
}

interface Sampled {
  color: RGBA;
  background: RGBA;
  family: string;
  size: number;
  weight: string;
  style: string;
  lineHeight: number;
  decoration: string;
}

// Theme styles are applied by class, so we sample them from probe elements
// instead of depending on which lines happen to be rendered right now.
function sampleTheme(view: typeof MarkEdit.editorView): Record<string, Sampled> {
  const wrapper = document.createElement('div');
  wrapper.className = 'cm-scroller';
  wrapper.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:700px;';
  const content = document.createElement('div');
  content.className = view.contentDOM.className;
  wrapper.appendChild(content);

  const classes: Record<string, string> = {
    h1: 'cm-md-header cm-md-heading1',
    h2: 'cm-md-header cm-md-heading2',
    h3: 'cm-md-header cm-md-heading3',
    h4: 'cm-md-header cm-md-heading4',
    h5: 'cm-md-header cm-md-heading5',
    h6: 'cm-md-header cm-md-heading6',
    bold: 'cm-md-bold',
    italic: 'cm-md-italic',
    strike: 'cm-md-strikethrough',
    link: 'cm-md-link',
    code: 'cm-md-inlineCode cm-md-monospace',
    codeBlock: 'cm-md-codeBlock cm-md-monospace',
    mark: 'cm-md-listMark',
    quote: 'cm-md-quote',
    hr: 'cm-md-horizontalRule',
  };

  const nodes: Record<string, HTMLElement> = {};
  const line = document.createElement('div');
  line.className = 'cm-line';
  content.appendChild(line);
  nodes.line = line;
  for (const [key, cls] of Object.entries(classes)) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = 'x';
    line.appendChild(span);
    nodes[key] = span;
  }

  view.dom.appendChild(wrapper);
  const baseSize = parseFloat(getComputedStyle(line).fontSize) || 15;
  const samples: Record<string, Sampled> = {};
  try {
    for (const [key, node] of Object.entries(nodes)) {
      const s = getComputedStyle(node);
      const size = parseFloat(s.fontSize) || baseSize;
      const lh = parseFloat(s.lineHeight);
      samples[key] = {
        color: parseColor(s.color),
        background: parseColor(s.backgroundColor),
        family: s.fontFamily,
        size,
        weight: s.fontWeight,
        style: s.fontStyle,
        lineHeight: Number.isFinite(lh) ? lh / size : 1.6,
        decoration: s.textDecorationLine,
      };
    }
  } finally {
    wrapper.remove();
  }

  return samples;
}

function buildCSS(t: Record<string, Sampled>, pageBg: RGBA): string {
  const base = t.line;
  const fg = base.color;
  const soft = (alpha: number) => rgba(fg, alpha);
  const heading = (key: string) => {
    const h = t[key];
    return `.pdf-root ${key}{color:${rgba(h.color, 1)};font-family:${h.family};font-size:${h.size}px;font-weight:${h.weight};font-style:${h.style};line-height:${h.lineHeight};margin:1.3em 0 0.6em;}`;
  };
  const inline = (key: string, tag: string, extra = '') => {
    const s = t[key];
    return `.pdf-root ${tag}{color:${rgba(s.color, 1)};font-weight:${s.weight};font-style:${s.style};text-decoration:${s.decoration};${extra}}`;
  };

  return [
    `.pdf-root{box-sizing:border-box;width:${PAGE_W}px;padding:0 ${MARGIN_X}px;background:${hex(pageBg)};color:${rgba(fg, 1)};font-family:${base.family};font-size:${base.size}px;line-height:${base.lineHeight};overflow-wrap:anywhere;}`,
    ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(heading),
    `.pdf-root p{margin:0 0 1em;}`,
    inline('bold', 'strong, .pdf-root b'),
    inline('italic', 'em, .pdf-root i'),
    inline('strike', 'del, .pdf-root s'),
    inline('link', 'a', 'text-decoration:none;'),
    `.pdf-root code{font-family:${t.code.family};font-size:${t.code.size}px;color:${rgba(t.code.color, 1)};background:${t.code.background[3] > 0 ? css(t.code.background) : soft(0.1)};padding:0.1em 0.3em;border-radius:4px;}`,
    `.pdf-root pre{font-family:${t.codeBlock.family};font-size:${t.codeBlock.size}px;background:${t.codeBlock.background[3] > 0 ? css(t.codeBlock.background) : soft(0.08)};border-radius:6px;padding:0.9em 1em;white-space:pre-wrap;margin:0 0 1em;}`,
    `.pdf-root pre code{background:none;padding:0;color:${rgba(t.codeBlock.color, 1)};font-size:inherit;}`,
    `.pdf-root blockquote{margin:0 0 1em;padding:0 1em;border-left:4px solid ${soft(0.35)};color:${rgba(t.quote.color, 1)};font-style:${t.quote.style};}`,
    `.pdf-root ul,.pdf-root ol{margin:0 0 1em;padding-left:1.6em;}`,
    `.pdf-root li::marker{color:${rgba(t.mark.color, 1)};}`,
    `.pdf-root hr{border:0;height:2px;background:${soft(0.3)};margin:1.5em 0;}`,
    `.pdf-root table{border-collapse:collapse;margin:0 0 1em;max-width:100%;}`,
    `.pdf-root th,.pdf-root td{border:1px solid ${soft(0.28)};padding:6px 12px;text-align:left;vertical-align:top;}`,
    `.pdf-root th{background:${soft(0.08)};font-weight:700;}`,
    `.pdf-root img,.pdf-root svg{max-width:100%;height:auto;}`,
  ].join('\n');
}

function cleanHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, link, meta, iframe').forEach(el => el.remove());
  return doc.body.innerHTML;
}

// Block boundaries (relative to the root) where a page may safely end.
function breakPoints(root: HTMLElement): number[] {
  const origin = root.getBoundingClientRect().top;
  const tops = new Set<number>();
  root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,tr,pre,blockquote,hr,table,img').forEach(el => {
    tops.add(Math.round(el.getBoundingClientRect().top - origin));
  });
  return [...tops].sort((a, b) => a - b);
}

function nextBreak(points: number[], from: number, max: number): number {
  let best = from + max; // hard cut if a block is taller than a page
  for (const p of points) {
    if (p > from + max * 0.4 && p <= from + max) {
      best = p;
    }
  }
  return best;
}

async function render(html: string): Promise<string> {
  const view = MarkEdit.editorView;
  const theme = sampleTheme(view);
  const pageBg = resolveBackground(view.dom);
  const sliceH = PAGE_H - MARGIN_Y * 2;

  const style = document.createElement('style');
  style.textContent = buildCSS(theme, pageBg);

  const root = document.createElement('div');
  root.className = 'pdf-root';
  root.style.cssText = 'position:absolute;left:0;top:0;';
  root.innerHTML = cleanHtml(html);

  const frame = document.createElement('div');
  frame.style.cssText = `position:absolute;left:0;top:0;width:${PAGE_W}px;height:${sliceH}px;overflow:hidden;z-index:-1;background:${hex(pageBg)};`;
  frame.append(style, root);
  document.body.appendChild(frame);

  try {
    await document.fonts.ready;
    const points = breakPoints(root);
    const total = root.getBoundingClientRect().height;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });

    for (let y = 0, first = true; y < total || first; first = false) {
      const end = Math.min(nextBreak(points, y, sliceH), Math.max(total, y + 1));
      root.style.top = `${-y}px`;
      frame.style.height = `${Math.min(end - y, sliceH)}px`;

      const shot = await html2canvas(frame, { scale: SCALE, backgroundColor: hex(pageBg), useCORS: true });
      if (!first) {
        pdf.addPage('a4', 'portrait');
      }
      pdf.setFillColor(hex(pageBg));
      pdf.rect(0, 0, 595.28, 841.89, 'F');
      pdf.addImage(shot.toDataURL('image/jpeg', 0.95), 'JPEG', 0, MARGIN_Y * PT, PAGE_W * PT, (shot.height / SCALE) * PT);
      y = end;
    }

    return pdf.output('datauristring');
  } finally {
    frame.remove();
  }
}

async function exportPDF() {
  try {
    if (typeof MarkEditGetHtml !== 'function') {
      await MarkEdit.showAlert({
        title: 'Markdown View Modes is required',
        message: 'This extension uses its renderer to turn the document into HTML.',
      });
      return;
    }

    const uri = await render(await MarkEditGetHtml(false));
    const base64 = uri.slice(uri.indexOf('base64,') + 'base64,'.length);
    const path = (await MarkEdit.getFileInfo())?.filePath ?? 'Untitled';
    const name = (path.split('/').pop() ?? 'Untitled').replace(/\.[^.]+$/, '');
    await MarkEdit.showSavePanel({ data: base64, fileName: `${name}.pdf` });
  } catch (error) {
    await MarkEdit.showAlert({ title: 'PDF export failed', message: String(error) });
  }
}

MarkEdit.addMainMenuItem({
  title: 'Export PDF with Theme…',
  action: () => void exportPDF(),
});
