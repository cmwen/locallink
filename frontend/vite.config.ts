import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'frontend',
  base: './',
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: false,
    assetsDir: 'assets/app',
    rollupOptions: {
      input: {
        index: 'frontend/index.html',
        dashboard: 'frontend/dashboard.html',
        template: 'frontend/template.html',
      },
      output: {
        entryFileNames: 'assets/app/[name].js',
        chunkFileNames: 'assets/app/[name].js',
        assetFileNames: 'assets/app/[name][extname]',
      },
    },
  },
});
