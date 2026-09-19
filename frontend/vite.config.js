import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Backend (server.js) runs on PORT (default 5000) and already has
      // CORS enabled, but proxying keeps the frontend on a single origin
      // during development and matches how it would sit behind a real
      // reverse proxy in production.
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
})
