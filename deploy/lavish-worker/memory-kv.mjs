// The slice of the Cloudflare KV API worker.mjs uses, backed by a Map. This is
// what the unit tests and the local smoke server (serve-local.mjs) hand to
// createWorker() as env.LAVISH_KV — no Cloudflare account involved.

export function createMemoryKv() {
  const store = new Map(); // name -> { value: Uint8Array|string, metadata }

  function decode(entry, type) {
    if (entry === undefined) return null;
    const { value } = entry;
    if (type === 'arrayBuffer' || type === 'stream') {
      if (typeof value === 'string') return new TextEncoder().encode(value).buffer;
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
    if (type === 'json') {
      try { return JSON.parse(text); } catch { return null; }
    }
    return text;
  }

  return {
    async get(name, type = 'text') {
      return decode(store.get(name), type);
    },
    async getWithMetadata(name, type = 'text') {
      const entry = store.get(name);
      if (entry === undefined) return { value: null, metadata: null };
      return { value: decode(entry, type), metadata: entry.metadata ?? null };
    },
    async put(name, value, options = {}) {
      const stored = typeof value === 'string' ? value
        : value instanceof ArrayBuffer ? new Uint8Array(value.slice(0))
        : new Uint8Array(value);
      store.set(name, { value: stored, metadata: options.metadata ?? null });
    },
    async delete(name) {
      store.delete(name);
    },
    async list({ prefix = '', cursor } = {}) {
      void cursor;
      const keys = [...store.keys()]
        .filter(name => name.startsWith(prefix))
        .sort()
        .map(name => ({ name, metadata: store.get(name)?.metadata ?? null }));
      return { keys, list_complete: true };
    },
  };
}
