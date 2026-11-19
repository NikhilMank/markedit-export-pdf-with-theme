import { MarkEdit } from 'markedit-api';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

declare global {
  // Provided by the Markdown View Modes extension.
  function MarkEditGetHtml(styled?: boolean): string;
}

const SCALE = 2;
const A4_RATIO = 297 / 210;

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Walk up from an element to find the background the user actually sees.
function resolveBackground(el: HTMLElement): string {
  for (let node: HTMLElement | null = el; node !== null; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') {
      return color;
    }
  }
  return '#ffffff';
}

function isVisible(el: HTMLElement | null): el is HTMLElement {
  if (el === null) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function newPDF(width: number, height: number) {
  return new jsPDF({ unit: 'pt', format: [width, height], orientation: width > height ? 'l' : 'p', compress: true });
}

function addPage(pdf: jsPDF, canvas: HTMLCanvasElement, width: number, height: number, first: boolean, background: string) {
  if (!first) {
    pdf.addPage([width, height], width > height ? 'l' : 'p');
  }
  pdf.setFillColor(background);
  pdf.rect(0, 0, width, height, 'F');
  pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, width, (canvas.height / canvas.width) * width);
}

/**
 * Mixed / source modes: capture the live editor one screen at a time,
 * so every pixel of the active theme (fonts, colors, table widgets) is kept.
 */
async function exportEditor(): Promise<string> {
  const view = MarkEdit.editorView;
  const scroller = view.scrollDOM;
  const background = resolveBackground(view.dom);
  const pageWidth = view.dom.clientWidth;
  const pageHeight = view.dom.clientHeight;
  const savedTop = scroller.scrollTop;
  const pdf = newPDF(pageWidth, pageHeight);

  view.contentDOM.blur(); // hide the caret and selection layers
  try {
    const total = scroller.scrollHeight;
    for (let top = 0, first = true; top < total; top += scroller.clientHeight, first = false) {
      scroller.scrollTop = top;
      await nextFrame();
      await wait(150); // let CodeMirror render the new viewport
      const overlap = top - scroller.scrollTop; // > 0 on the last, clamped screen

      const shot = await html2canvas(view.dom, { scale: SCALE, backgroundColor: background, useCORS: true });
      const cropTop = Math.round(Math.max(overlap, 0) * SCALE);
      const page = document.createElement('canvas');
      page.width = shot.width;
      page.height = shot.height - cropTop;
      page.getContext('2d')?.drawImage(shot, 0, cropTop, shot.width, page.height, 0, 0, shot.width, page.height);
      addPage(pdf, page, pageWidth, page.height / SCALE, first, background);
    }
  } finally {
    scroller.scrollTop = savedTop;
    view.focus();
  }

  return pdf.output('datauristring');
}

/**
 * Preview mode: clone the rendered preview inside the same document
 * (so the preview's CSS keeps applying) and slice it into A4 pages.
 */
async function exportPreview(source: HTMLElement): Promise<string> {
  const background = resolveBackground(source);
  const width = source.clientWidth;

  const clone = source.cloneNode(true) as HTMLElement;
  clone.style.cssText += ';height:auto;overflow:visible;position:static;';
  const stage = document.createElement('div');
  stage.style.cssText = `position:fixed;left:0;top:0;width:${width}px;z-index:-1;background:${background};`;
  stage.appendChild(clone);
  document.body.appendChild(stage);

  try {
    const shot = await html2canvas(stage, { scale: SCALE, backgroundColor: background, useCORS: true });
    const pageHeightPx = Math.floor(shot.width * A4_RATIO);
    const pdf = newPDF(width, width * A4_RATIO);
    for (let y = 0, first = true; y < shot.height; y += pageHeightPx, first = false) {
      const page = document.createElement('canvas');
      page.width = shot.width;
      page.height = pageHeightPx;
      const context = page.getContext('2d');
      context?.drawImage(shot, 0, y, shot.width, Math.min(pageHeightPx, shot.height - y), 0, 0, shot.width, Math.min(pageHeightPx, shot.height - y));
      addPage(pdf, page, width, width * A4_RATIO, first, background);
    }
    return pdf.output('datauristring');
  } finally {
    stage.remove();
  }
}

async function exportPDF() {
  try {
    const preview = document.querySelector<HTMLElement>('.markdown-body');
    const uri = isVisible(preview) ? await exportPreview(preview) : await exportEditor();
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
