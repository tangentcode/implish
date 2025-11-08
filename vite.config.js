import { defineConfig } from 'vite'
import { hostname } from 'os'
import { resolve } from 'path'
import { execSync } from 'node:child_process'

function ensureCoreBuild() {
  let built = false

  const runBuild = () => {
    if (built) return
    execSync('npm run build:core', { stdio: 'inherit' })
    built = true
  }

  return {
    name: 'implish-core-build',
    buildStart() {
      runBuild()
    },
    configureServer() {
      runBuild()
    }
  }
}

export default defineConfig({
  root: './web',
  publicDir: false,
  build: {
    outDir: '../dist-web'
  },
  plugins: [
    ensureCoreBuild()
  ],
  resolve: {
    alias: {
      '/dist': resolve(__dirname, './dist'),
      '@misc': resolve(__dirname, './misc')
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
