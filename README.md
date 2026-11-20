# MarkEdit Export PDF with Theme

A [MarkEdit](https://github.com/MarkEdit-app/MarkEdit) extension that exports the current document as a PDF styled with the theme you are using in the editor: colors, fonts, headings, quotes, code blocks, lists, links, and tables.

The existing PDF export extensions render their own styling, so the result doesn't look like the editor. This one reads the styles from the live editor and applies them to the rendered Markdown.

## Requirements

- MarkEdit with [Markdown View Modes](https://markedit-app.github.io/extensions/) (`markedit-preview`) installed. It provides the rendered HTML through `MarkEditGetHtml`, and this extension does not work without it.
- To build from source: Node.js 22 or newer.

## Install

Once it is listed in MarkEdit's extension manager, install it from there and restart MarkEdit.

To install by hand:

1. Download `markedit-export-pdf-with-theme.js` from the [latest release](https://github.com/NikhilMank/markedit-export-pdf-with-theme/releases/latest), or build it yourself (see [Build](#build)). The build produces `dist/markedit-export-pdf-with-theme.cjs`, which must be renamed to end in `.js`.
2. Copy the file into MarkEdit's scripts folder:

   ```
   ~/Library/Containers/app.cyan.markedit/Data/Documents/scripts/markedit-export-pdf-with-theme.js
   ```

   macOS may block `cp` from a terminal here. If so, copy the file with Finder, or give your terminal Full Disk Access in System Settings.
3. Restart MarkEdit.

## Use

Open **Extensions → Export PDF with Theme…**, choose a location, and save. The file name defaults to the document name with a `.pdf` extension.

While exporting, the editor scrolls briefly to a list, a link, a code block, and a table to read their live styles, then returns to where you were.

## How it works

1. **Get HTML.** Calls `MarkEditGetHtml(false)` from Markdown View Modes to get clean HTML for the document.
2. **Read the theme.** Samples hidden probe elements that carry the editor's own `cm-md-*` classes for headings, bold, italic, inline code, and so on. Styles that come from generated highlight classes or widgets (list markers, plain URLs, code block borders, tables) are read from live elements, after scrolling the editor next to a matching line.
3. **Restyle.** Applies those styles to the HTML at A4 width, with margins. The page background is the editor's background.
4. **Paginate.** Pages end between blocks (paragraphs, list items, table rows) rather than mid-line, and the last page is not left with a single orphan line.
5. **Render.** Each page is drawn with [html2canvas-pro](https://github.com/yorickshan/html2canvas-pro) at 3x and assembled with [jsPDF](https://github.com/parallax/jsPDF).
6. **Save.** Hands the PDF to MarkEdit's native save panel with `MarkEdit.showSavePanel`.

## Limitations

- **The text is not selectable.** Pages are PNG images, because the editor's font cannot be embedded in a PDF from inside the app.
- **Math (KaTeX) and Mermaid diagrams** are not specially handled and may not look right.
- **Relative image paths** may not load.
- **Tables** copy the editor's table look only when the document contains a table. Otherwise they use a neutral style. Borders can look slightly lighter than in the editor.
- **Quotes** show everything in the quote color and italics, as in the editor.
- File size is a few MB for a short document, because pages are images.

## Build

```
npm install
yarn build        # or: npx tsc --noEmit && npx vite build
```

The build type-checks, then bundles everything into a single file, because MarkEdit loads one script per extension. `vite.config.mts` uses [`markedit-vite`](https://github.com/MarkEdit-app/MarkEdit-vite) with `copyDistFile: false`, so builds never write into the app container, and with `inlineDynamicImports` so lazy chunks from jsPDF and html2canvas are inlined.

## Project layout

| File | Purpose |
| --- | --- |
| `main.ts` | The whole extension: theme sampling, CSS generation, pagination, PDF output, menu item |
| `vite.config.mts` | Build configuration |
| `dist/` | Build output, copy this into MarkEdit's `scripts` folder |

## Troubleshooting

- **"Markdown View Modes is required":** install the Markdown View Modes extension and restart MarkEdit.
- **Menu item missing, or changes not showing:** the script was not replaced, or MarkEdit was not restarted. Check the `scripts` folder for duplicate copies.
- **"PDF export failed":** the alert shows the error text. Report it with the document features involved.
- **A color is wrong:** some theme colors come from generated classes and are read from live editor elements. If the document has no example (a plain `https://` link outside a quote, a list, a code block, a table), that color falls back to the body text color or a neutral style.

## License

[MIT](LICENSE). The bundled libraries (html2canvas-pro, jsPDF and their dependencies) keep their own licenses, whose notices are preserved in the built file.
