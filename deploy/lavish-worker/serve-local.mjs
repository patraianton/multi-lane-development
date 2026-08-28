// Credential-free local instance of the artifact worker: the same code that
// runs on Cloudflare, served by node:http with an in-memory KV. This is what
// the publish CLI's dry-run and the integration tests talk to. Nothing here
// touches Cloudflare.
//
//   node deploy/lavish-worker/serve-local.mjs [port] [--token <apiToken>]
//
// Uses the real fork-built assets (assets.gen.mjs) when they exist, the
// committed stubs otherwise.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorker } from './worker.mjs';
import { createMemoryKv } from './memory-kv.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function loadAssets() {
  try {
    const mod = await import(new URL('./assets.gen.mjs', import.meta.url).href);
    return mod.assets;
  } catch {
    const mod = await import(new URL('./stub-assets.mjs', import.meta.url).href);
    return mod.stubAssets;
  }
}

// Serve a worker-shaped { fetch } over node:http. Returns the http.Server.
export function serveWorker(worker, env, port, host = '127.0.0.1') {
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyBytes = Buffer.concat(chunks);
      const request = new Request(`http://${req.headers.host ?? `${host}:${port}`}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBytes,
      });
      const response = await worker.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      const body = Buffer.from(await response.arrayBuffer());
      res.end(body);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  });
  server.listen(port, host);
  return server;
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.join(HERE, 'serve-local.mjs');

if (isMain) {
  const args = process.argv.slice(2);
  const tokenIdx = args.indexOf('--token');
  const token = tokenIdx >= 0 ? args[tokenIdx + 1] : 'local-dev-token';
  const port = Number(args.find(a => /^\d+$/.test(a))) || 8787;
  const assets = await loadAssets();
  const worker = createWorker(assets);
  const env = { LAVISH_KV: createMemoryKv(), LAVISH_API_TOKEN: token };
  serveWorker(worker, env, port);
  console.log(`local artifact instance on http://127.0.0.1:${port} (assets: ${assets.version})`);
  console.log(`publish with: node bin/lavish-publish.mjs publish <file.html> --base http://127.0.0.1:${port} --token ${token}`);
}
