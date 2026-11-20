import { defineConfig } from 'vite';
// `npm run dev` here plus `npm run dev --prefix worker` (wrangler dev on :8787).
export default defineConfig({
  server: { proxy: { '/v1': { target: 'http://localhost:8787', ws: true } } },
});
