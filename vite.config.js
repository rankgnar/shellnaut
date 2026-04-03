import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  root: 'client',
  build: {
    outDir: resolve(__dirname, 'public'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:3001', ws: true },
      '/ping': 'http://localhost:3001',
    }
  }
})
