import { defineConfig } from 'vite';
import { defaultViteConfig } from 'markedit-vite';

// copyDistFile is off so builds never touch the app container; copy dist/ manually.
export default defineConfig(defaultViteConfig({ copyDistFile: false }));
