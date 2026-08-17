import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const appVersion = process.env.VERCEL_GIT_COMMIT_SHA
  || process.env.GITHUB_SHA
  || `local-${Date.now().toString(36)}`

const versionPayload = JSON.stringify({ version: appVersion })

const versionEndpoint = () => ({
  name: 'app-version-endpoint',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (new URL(request.url, 'http://localhost').pathname !== '/version.json') return next()
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.end(versionPayload)
    })
  },
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: versionPayload })
  }
})

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  plugins: [react(), versionEndpoint()]
})
