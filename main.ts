import { MarkEdit } from 'markedit-api';
import html2canvas from 'html2canvas-pro';
import { jsPDF } from 'jspdf';

declare global {
  // Provided by the Markdown View Modes extension, resolves to an HTML string.
  function MarkEditGetHtml(styled?: boolean): Promise<string>;
}

const SCALE = 3; // PNG at 3x keeps text crisp when zooming
const PAGE_W = 794; // A4 at 96 dpi, in CSS px
const PAGE_H = 1123;
const MARGIN_X = 56;
const MARGIN_Y = 48;
const PT = 595.28 / PAGE_W; // CSS px -> PDF points

type RGBA = [number, number, number, number];

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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
  borderColor: RGBA;
  borderWidth: number;
  borderRadius: string;
  accentBorder: RGBA;
  accentBorderWidth: number;
}

interface TableSample {
  family: string;
  size: number;
  border: RGBA;
  borderWidth: number;
  headBackground: RGBA;
  headColor: RGBA;
  headWeight: string;
  cellBackground: RGBA;
  cellAltBackground: RGBA;
  cellColor: RGBA;
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
    url: 'cm-md-url',
    code: 'cm-md-inlineCode cm-md-monospace',
    codeBlock: 'cm-md-codeBlock cm-md-monospace',
    mark: 'cm-md-listMark',
  };

  // Block-level classes are applied to whole lines or wrappers, not to inline spans.
  const blocks: Record<string, string> = {
    quote: 'cm-line cm-md-quote',
    hr: 'cm-line cm-md-horizontalRule',
    codeWrapper: 'cm-md-codeBlockWrapper',
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

  for (const [key, cls] of Object.entries(blocks)) {
    const block = document.createElement('div');
    block.className = cls;
    block.textContent = 'x';
    content.appendChild(block);
    nodes[key] = block;
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
        borderColor: parseColor(s.borderTopColor),
        borderWidth: parseFloat(s.borderTopWidth) || 0,
        borderRadius: s.borderTopLeftRadius,
        accentBorder: parseColor(s.borderLeftColor),
        accentBorderWidth: parseFloat(s.borderLeftWidth) || 0,
      };
    }
  } finally {
    wrapper.remove();
  }

  return samples;
}

// The list marker color comes from a generated highlight class, so read it from
// a rendered marker: either the tagged one or a bullet / number widget.
function findListMark(root: HTMLElement): HTMLElement | null {
  const tagged = root.querySelector<HTMLElement>('.cm-md-listMark');
  if (tagged !== null) {
    return tagged;
  }

  // Bullets and numbers may be widgets or plain text, so scan the rendered text nodes.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent !== null && /^\s*([•◦▪‣*+-]|\d+[.)])\s*$/.test(node.textContent ?? '')) {
      return parent;
    }
  }
  return null;
}

const sameColor = (a: RGBA, b: RGBA) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

// Plain `https://...` text is colored by the theme, but URLs inside quotes just take the quote color.
// So collect every rendered URL and keep the first color that is neither the body nor the quote color.
function findUrlColor(root: HTMLElement, body: RGBA, quote: RGBA): RGBA | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || !/^\s*https?:\/\/\S+/.test(node.textContent ?? '')) {
      continue;
    }

    const color = parseColor(getComputedStyle(parent).color);
    if (!sameColor(color, body) && !sameColor(color, quote)) {
      return color;
    }
  }
  return null;
}

interface Edge {
  color: RGBA;
  width: number;
}

// The editor may draw bars and lines as a border, an inset box-shadow, or a pseudo-element,
// so look at all of them and return the first one that is actually visible.
function visibleEdge(el: HTMLElement, sides: string[]): Edge | null {
  for (const pseudo of [null, '::before', '::after']) {
    const style = getComputedStyle(el, pseudo);
    for (const side of sides) {
      const width = parseFloat(style.getPropertyValue(`border-${side}-width`));
      const color = parseColor(style.getPropertyValue(`border-${side}-color`));
      if (width > 0 && style.getPropertyValue(`border-${side}-style`) !== 'none' && color[3] > 0) {
        return { color, width };
      }
    }

    const shadows = style.boxShadow.matchAll(/(rgba?\([^)]+\)|color\([^)]+\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+([\d.]+)px)?/g);
    for (const m of shadows) {
      const width = parseFloat(m[5] ?? '0') || Math.max(Math.abs(parseFloat(m[2])), Math.abs(parseFloat(m[3])));
      const color = parseColor(m[1]);
      if (width > 0 && color[3] > 0) {
        return { color, width };
      }
    }
  }
  return null;
}

function sampleTable(root: HTMLElement): TableSample | null {
  const table = root.querySelector<HTMLElement>('.cm-md-tableWrapper table, .cm-md-table table');
  const head = table?.querySelector<HTMLElement>('th');
  const rows = Array.from(table?.querySelectorAll<HTMLElement>('tbody tr') ?? []);
  const cell = rows[0]?.querySelector<HTMLElement>('td') ?? table?.querySelector<HTMLElement>('td');
  if (table === undefined || table === null || head === null || head === undefined || cell === null || cell === undefined) {
    return null;
  }

  const th = getComputedStyle(head);
  const td = getComputedStyle(cell);
  const alt = rows[1]?.querySelector<HTMLElement>('td');
  const edge = [cell, head, cell.parentElement, table]
    .filter((el): el is HTMLElement => el !== null)
    .map(el => visibleEdge(el, ['bottom', 'top', 'left']))
    .find(e => e !== null) ?? null;
  return {
    family: td.fontFamily,
    size: parseFloat(td.fontSize) || 15,
    border: edge?.color ?? ([...parseColor(td.color).slice(0, 3), 0.2] as RGBA),
    borderWidth: edge?.width ?? 1,
    headBackground: parseColor(th.backgroundColor),
    headColor: parseColor(th.color),
    headWeight: th.fontWeight,
    cellBackground: parseColor(td.backgroundColor),
    cellAltBackground: parseColor(alt !== undefined && alt !== null ? getComputedStyle(alt).backgroundColor : td.backgroundColor),
    cellColor: parseColor(td.color),
  };
}

// Scroll the editor so the first line matching `pattern` is rendered, then wait for CodeMirror.
async function reveal(view: typeof MarkEdit.editorView, pattern: RegExp): Promise<boolean> {
  const doc = view.state.doc;
  for (let n = 1; n <= doc.lines; ++n) {
    const line = doc.line(n);
    if (pattern.test(line.text)) {
      view.scrollDOM.scrollTop = Math.max(view.lineBlockAt(line.from).top - 40, 0);
      await nextFrame();
      await wait(180);
      return true;
    }
  }
  return false;
}

// Some styles come from generated highlight classes or widgets that probes can't see,
// so move the editor next to a matching line and read them from live elements.
async function sampleLive(view: typeof MarkEdit.editorView, samples: Record<string, Sampled>): Promise<TableSample | null> {
  const scroller = view.scrollDOM;
  const savedTop = scroller.scrollTop;
  let table: TableSample | null = null;

  try {
    if (await reveal(view, /^\s*([-*+]|\d+[.)])\s+\S/)) {
      const mark = findListMark(view.contentDOM);
      if (mark !== null) {
        samples.mark.color = parseColor(getComputedStyle(mark).color);
      }
    }

    if (await reveal(view, /^(?!\s*>).*https?:\/\/\S+/)) {
      const url = findUrlColor(view.contentDOM, samples.line.color, samples.quote.color);
      if (url !== null) {
        samples.url.color = url;
      }
    }

    if (await reveal(view, /^\s*>/)) {
      const quote = view.contentDOM.querySelector<HTMLElement>('.cm-md-quote');
      if (quote !== null) {
        const chain: HTMLElement[] = [];
        for (let el: HTMLElement | null = quote; el !== null && el !== view.contentDOM; el = el.parentElement) {
          chain.push(el);
        }
        const mark = quote.closest('.cm-line')?.querySelector<HTMLElement>('.cm-md-quoteMark');
        const edge = [...chain, ...(mark !== null && mark !== undefined ? [mark] : [])]
          .map(el => visibleEdge(el, ['left']))
          .find(e => e !== null);
        if (edge !== undefined && edge !== null) {
          samples.quote.accentBorder = edge.color;
          samples.quote.accentBorderWidth = edge.width;
        } else {
          // No real border found: the bar shares its color with the quote mark, or with list marks.
          const markColor = mark !== null && mark !== undefined ? parseColor(getComputedStyle(mark).color) : null;
          samples.quote.accentBorder = markColor !== null && !sameColor(markColor, samples.line.color) ? markColor : samples.mark.color;
          samples.quote.accentBorderWidth = 3;
        }
      }
    }

    if (await reveal(view, /^\s*```/)) {
      const wrapper = view.contentDOM.querySelector<HTMLElement>('.cm-md-codeBlockWrapper');
      if (wrapper !== null) {
        const s = getComputedStyle(wrapper);
        samples.codeWrapper.borderColor = parseColor(s.borderTopColor);
        samples.codeWrapper.borderWidth = parseFloat(s.borderTopWidth) || 0;
        samples.codeWrapper.borderRadius = s.borderTopLeftRadius;
        samples.codeWrapper.background = parseColor(s.backgroundColor);
      }
    }

    if (await reveal(view, /^\s*\|.*\|\s*$/)) {
      table = sampleTable(view.contentDOM);
    }
  } finally {
    scroller.scrollTop = savedTop;
  }

  return table;
}

function buildCSS(t: Record<string, Sampled>, table: TableSample | null, pageBg: RGBA): string {
  const base = t.line;
  const fg = base.color;
  const soft = (alpha: number) => rgba(fg, alpha);
  const wrapper = t.codeWrapper;
  const codeBox = wrapper.borderWidth > 0 && wrapper.borderColor[3] > 0
    ? `background:${wrapper.background[3] > 0 ? css(wrapper.background) : 'transparent'};border:${wrapper.borderWidth}px solid ${css(wrapper.borderColor)};border-radius:${wrapper.borderRadius}`
    : `background:transparent;border:1px solid ${soft(0.3)};border-radius:8px`;
  const quote = t.quote;
  const quoteBar = quote.accentBorderWidth > 0 && quote.accentBorder[3] > 0
    ? `${quote.accentBorderWidth}px solid ${css(quote.accentBorder)}`
    : `4px solid ${soft(0.35)}`;
  const rule = t.hr;
  const ruleColor = rule.background[3] > 0
    ? css(rule.background)
    : rule.borderWidth > 0 && rule.borderColor[3] > 0
      ? css(rule.borderColor)
      : rgba(rule.color, 0.5);

  const heading = (key: string) => {
    const h = t[key];
    return `.pdf-root ${key}{color:${rgba(h.color, 1)};font-family:${h.family};font-size:${h.size}px;font-weight:${h.weight};font-style:${h.style};line-height:${h.lineHeight};margin:1.3em 0 0.6em;}`;
  };
  const inline = (key: string, tag: string, extra = '') => {
    const s = t[key];
    return `.pdf-root ${tag}{color:${rgba(s.color, 1)};font-weight:${s.weight};font-style:${s.style};text-decoration:${s.decoration};${extra}}`;
  };

  // The editor's table widget has its own look; fall back to neutral borders if it isn't available.
  const tableCSS = table !== null
    ? [
      `.pdf-root table{border-collapse:collapse;margin:0 0 1em;max-width:100%;font-family:${table.family};font-size:${table.size}px;}`,
      `.pdf-root th,.pdf-root td{border:${table.borderWidth}px solid ${css(table.border)};padding:6px 12px;text-align:left;vertical-align:top;overflow-wrap:normal;word-break:normal;color:${rgba(table.cellColor, 1)};background:${css(table.cellBackground)};}`,
      `.pdf-root tbody tr:nth-child(even) td{background:${css(table.cellAltBackground)};}`,
      `.pdf-root th{background:${css(table.headBackground)};color:${rgba(table.headColor, 1)};font-weight:${table.headWeight};}`,
    ]
    : [
      `.pdf-root table{border-collapse:collapse;margin:0 0 1em;max-width:100%;}`,
      `.pdf-root th,.pdf-root td{border:1px solid ${soft(0.28)};padding:6px 12px;text-align:left;vertical-align:top;overflow-wrap:normal;word-break:normal;}`,
      `.pdf-root th{background:${soft(0.08)};font-weight:700;}`,
    ];

  return [
    `.pdf-root{box-sizing:border-box;width:${PAGE_W}px;padding:0 ${MARGIN_X}px;background:${hex(pageBg)};color:${rgba(fg, 1)};font-family:${base.family};font-size:${base.size}px;line-height:${base.lineHeight};overflow-wrap:break-word;}`,
    ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(heading),
    `.pdf-root p{margin:0 0 1em;}`,
    inline('bold', 'strong, .pdf-root b', 'font-weight:700;'),
    inline('italic', 'em, .pdf-root i', 'font-style:italic;'),
    inline('strike', 'del, .pdf-root s', 'text-decoration:line-through;'),
    `.pdf-root a{color:${rgba(t.link.color, 1)};text-decoration:none;}`,
    `.pdf-root a.bare-url{color:${rgba(t.url.color, 1)};}`,
    `.pdf-root code{font-family:${t.code.family};font-size:${t.code.size}px;color:${rgba(t.code.color, 1)};background:${t.code.background[3] > 0 ? css(t.code.background) : soft(0.1)};padding:0.1em 0.3em;border-radius:4px;}`,
    `.pdf-root pre{font-family:${t.codeBlock.family};font-size:${t.codeBlock.size}px;${codeBox};padding:0.9em 1em;white-space:pre-wrap;margin:0 0 1em;}`,
    `.pdf-root pre code{background:none;padding:0;color:${rgba(t.codeBlock.color, 1)};font-size:inherit;}`,
    `.pdf-root blockquote{margin:0 0 1em;padding:0 1em;border-left:${quoteBar};}`,
    `.pdf-root blockquote, .pdf-root blockquote *, .pdf-root blockquote a.bare-url{color:${rgba(t.quote.color, 1)};font-style:italic;}`,
    // html2canvas ignores li::marker, so draw bullets and numbers ourselves.
    `.pdf-root ul,.pdf-root ol{margin:0 0 1em;padding-left:1.6em;list-style:none;counter-reset:pdfitem;}`,
    `.pdf-root li{position:relative;counter-increment:pdfitem;}`,
    `.pdf-root li::before{position:absolute;left:-1.6em;width:1.3em;text-align:right;color:${rgba(t.mark.color, 1)};}`,
    `.pdf-root ul > li::before{content:'•';}`,
    `.pdf-root ol > li::before{content:counter(pdfitem) '.';}`,
    `.pdf-root hr{border:0;height:2px;background:${ruleColor};margin:1.8em 0;}`,
    ...tableCSS,
    `.pdf-root img,.pdf-root svg{max-width:100%;height:auto;}`,
  ].join('\n');
}

function cleanHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, link, meta, iframe').forEach(el => el.remove());
  // The editor only colors full https:// URLs; bare domains that get auto-linked stay body text.
  doc.querySelectorAll('a').forEach(a => {
    if (/^\s*https?:\/\//.test(a.textContent ?? '')) {
      a.classList.add('bare-url');
    }
  });
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

function nextBreak(points: number[], from: number, max: number, total: number): number {
  if (total - from <= max) {
    return total;
  }

  // Keep at least a few lines for the last page instead of leaving a lone orphan.
  const minTail = max * 0.18;
  const limit = total - (from + max) < minTail ? total - minTail : from + max;

  let best = limit; // hard cut if a block is taller than a page
  for (const p of points) {
    if (p > from + max * 0.4 && p <= limit) {
      best = p;
    }
  }
  return best;
}

async function render(html: string): Promise<string> {
  const view = MarkEdit.editorView;
  const theme = sampleTheme(view);
  const table = await sampleLive(view, theme);
  const pageBg = resolveBackground(view.dom);
  const sliceH = PAGE_H - MARGIN_Y * 2;

  const style = document.createElement('style');
  style.textContent = buildCSS(theme, table, pageBg);

  const root = document.createElement('div');
  root.className = 'pdf-root';
  root.style.cssText = 'position:absolute;left:0;top:0;';
  root.innerHTML = cleanHtml(html);

  // frame is one full page (so margins share the exact same pixels as the content),
  // clip shows one slice of the document inside the margins.
  const frame = document.createElement('div');
  frame.style.cssText = `position:absolute;left:0;top:0;width:${PAGE_W}px;height:${PAGE_H}px;overflow:hidden;z-index:-1;background:${hex(pageBg)};`;
  const clip = document.createElement('div');
  clip.style.cssText = `position:absolute;left:0;top:${MARGIN_Y}px;width:${PAGE_W}px;height:${sliceH}px;overflow:hidden;`;
  clip.append(style, root);
  frame.appendChild(clip);
  document.body.appendChild(frame);

  try {
    await document.fonts.ready;
    const points = breakPoints(root);
    const total = root.getBoundingClientRect().height;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });

    for (let y = 0, first = true; y < total || first; first = false) {
      const end = Math.min(nextBreak(points, y, sliceH, total), Math.max(total, y + 1));
      root.style.top = `${-y}px`;
      clip.style.height = `${Math.min(end - y, sliceH)}px`;

      const shot = await html2canvas(frame, { scale: SCALE, backgroundColor: hex(pageBg), useCORS: true });
      if (!first) {
        pdf.addPage('a4', 'portrait');
      }
      pdf.addImage(shot.toDataURL('image/png'), 'PNG', 0, 0, PAGE_W * PT, PAGE_H * PT);
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
