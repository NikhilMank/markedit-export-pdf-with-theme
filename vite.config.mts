import { defineConfig, mergeConfig } from 'vite';
import { defaultViteConfig } from 'markedit-vite';

// copyDistFile is off so builds never touch the app container; copy dist/ manually.
const base = defineConfig(defaultViteConfig({ copyDistFile: false }));

// MarkEdit loads exactly one script file, so lazy chunks (jspdf, html2canvas) must be inlined.
export default mergeConfig(base, {
  build: { rollupOptions: { output: { inlineDynamicImports: true } } },
});
