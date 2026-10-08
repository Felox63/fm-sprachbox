import { defineConfig } from 'vite'
import path from 'node:path'

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
    target: 'es2024',
    rollupOptions: {
      input: path.resolve(__dirname, 'src/renderer/index.html'),
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
