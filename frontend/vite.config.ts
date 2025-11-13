import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { URL, fileURLToPath } from 'node:url'
import { visualizer } from 'rollup-plugin-visualizer'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), '')
  const baseUrl = env.VITE_MANIFEST_START_URL || '/'

  return {
    plugins: [
      react(),
      tailwindcss(),
      visualizer({
        filename: 'stats.html',
        open: true,
      }),
      {
        name: 'generate-manifest',
        apply: 'build',
        closeBundle() {
          const manifestPath = resolve(__dirname, 'dist/manifest.json')

          const manifest = {
            name: "From a mote, a universe.",
            short_name: "Mote",
            start_url: baseUrl,
            display: "standalone",
            background_color: "#fafafa",
            theme_color: "#0f172a",
            icons: [
              {
                src: "logo_192.png",
                sizes: "192x192",
                type: "image/png"
              },
              {
                src: "logo_512.png",
                sizes: "512x512",
                type: "image/png"
              }
            ]
          }

          try {
            writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
            console.log(`✓ manifest.json generated with start_url: ${baseUrl}`)
          } catch (error) {
            console.warn('Could not generate manifest.json:', error)
          }
        }
      }
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      watch: {
        ignored: ['**/e2e/**', '**/tests/**'],
      },
      host: '0.0.0.0',
      port: 3000,
      open: true,
      proxy: {
        '/api': 'http://localhost:8000',
        '/shared': 'http://localhost:8000',
        '/static': 'http://localhost:8000',
        '/uploads': 'http://localhost:8000',
      },
    },
  }
})
