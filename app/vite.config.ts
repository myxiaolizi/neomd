import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5280,
    strictPort: false,
    watch: {
      // 编辑器原子写入会产生瞬时临时目录，避免 watcher 报 EBUSY
      ignored: ['**/*.tmpdir/**', '**/*.tmp', '**/dist/**'],
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    cssCodeSplit: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: [
            '@codemirror/state',
            '@codemirror/view',
            '@codemirror/commands',
            '@codemirror/language',
            '@codemirror/lang-markdown',
            '@codemirror/search',
            '@codemirror/autocomplete',
          ],
        },
      },
    },
  },
});
