// Cloudflare entry point. wrangler bundles this; assets.gen.mjs must exist
// (run build-assets.mjs first — bin/lavish-deploy.mjs does it for you).

import { createWorker } from './worker.mjs';
import { assets } from './assets.gen.mjs';

export default createWorker(assets);
