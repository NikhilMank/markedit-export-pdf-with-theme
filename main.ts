import { MarkEdit } from 'markedit-api';
import html2pdf from 'html2pdf.js';

declare global {
  // Provided by the Markdown View Modes extension.
  function MarkEditGetHtml(styled?: boolean): string;
}

const PAGE_WIDTH_PX = 794; // A4 at 96 dpi

function findPreviewElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.markdown-body');
}

// Walk up from the preview to find the background the user actually sees.
function resolveBackground(el: HTMLElement): string {
  for (let node: HTMLElement | null = el; node !== null; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') {
      return color;
    }
  }
  return '#ffffff';
}

function buildSandbox(): { host: HTMLElement; background: string } | null {
  const source = findPreviewElement();
  if (source !== null) {
    // Cloning inside the same document keeps every theme rule applicable.
    const clone = source.cloneNode(true) as HTMLElement;
    clone.style.cssText += `;width:${PAGE_WIDTH_PX}px;height:auto;overflow:visible;position:static;`;
    return { host: clone, background: resolveBackground(source) };
  }

  if (typeof MarkEditGetHtml === 'function') {
    const host = document.createElement('div');
    host.className = 'markdown-body';
    host.style.width = `${PAGE_WIDTH_PX}px`;
    host.innerHTML = MarkEditGetHtml(true);
    return { host, background: '#ffffff' };
  }

  return null;
}

async function exportPDF() {
  const sandbox = buildSandbox();
  if (sandbox === null) {
    await MarkEdit.showAlert({
      title: 'Nothing to export',
      message: 'Open the preview with Markdown View Modes first.',
    });
    return;
  }

  const stage = document.createElement('div');
  stage.style.cssText = `position:fixed;left:-10000px;top:0;width:${PAGE_WIDTH_PX}px;background:${sandbox.background};`;
  stage.appendChild(sandbox.host);
  document.body.appendChild(stage);

  try {
    const uri: string = await html2pdf()
      .set({
        margin: 0,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, backgroundColor: sandbox.background, useCORS: true },
        jsPDF: { unit: 'pt', format: 'a4' },
        pagebreak: { mode: ['css', 'legacy'] },
      } as never) // the bundled typings omit pagebreak
      .from(stage)
      .outputPdf('datauristring');

    const base64 = uri.slice(uri.indexOf('base64,') + 'base64,'.length);
    const path = (await MarkEdit.getFileInfo())?.filePath ?? 'Untitled';
    const name = path.split('/').pop() ?? 'Untitled';
    await MarkEdit.showSavePanel({ data: base64, fileName: `${name.replace(/\.[^.]+$/, '')}.pdf` });
  } catch (error) {
    await MarkEdit.showAlert({ title: 'PDF export failed', message: String(error) });
  } finally {
    stage.remove();
  }
}

MarkEdit.addMainMenuItem({
  title: 'Export PDF with Theme…',
  action: () => void exportPDF(),
});
