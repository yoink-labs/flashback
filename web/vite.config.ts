import { defineConfig } from 'vite';
// `npm run dev` here plus `npm run dev --prefix worker` (wrangler dev on :8787).
// Point the proxy at another worker port with FLASHBACK_API (e.g. when another
// agent already owns :8787).
export default defineConfig(() => {
  const target = process.env.FLASHBACK_API ?? 'http://localhost:8787';
  return { server: { proxy: { '/v1': { target, ws: true } } } };
});
