import { defineConfig } from 'vite'
import { hostname } from 'os'
import { resolve } from 'path'

export default defineConfig({
  root: './web',
  publicDir: false,
  build: {
    outDir: '../dist-web'
  },
  resolve: {
    alias: {
      '/dist': resolve(__dirname, './dist')
    }
  },
  server: {
    open: '/',
    host: true,
    allowedHosts: [
      hostname(),
      'localhost',
      '.local'
    ],
    fs: {
      // Allow serving files from parent directory
      allow: ['..']
    }
  }
})
