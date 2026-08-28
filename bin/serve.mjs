// HTTP and TOON helpers shared by the windows view and the pipeline.
//
// The two agent endpoints (/api/board and /api/pipeline) answer in the same
// shape and reject bad parameters with the same words, so an agent that learned
// one of them can read the other without being told twice.

// A bad request from the page is not a board failure: answer 400 with our own
// text rather than the JSON parser's complaint, which the page would show to the
// owner right next to the button.
export class BadRequest extends Error {}

export function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

// An answer to an agent is plain text, both on success and on failure. It reads
// an error the same way it reads data, so the error is short and carries a hint
// about what to do next.
export function sendText(res, code, body) {
  send(res, code, body.endsWith('\n') ? body : body + '\n', 'text/plain; charset=utf-8');
}

// The body of a POST request. The board accepts no more than a hundred kilobytes:
// there is only a card title and a couple of lines of text in there anyway.
export async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100000) throw new BadRequest('request too long');
  }
  if (!body) return {};
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { throw new BadRequest('bad request: body cannot be parsed'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequest('bad request: an object was expected');
  }
  return parsed;
}

// How many characters of a long text are shown without ?full=1.
export const AGENT_TEXT_LIMIT = 200;

// Clipping with the size marked: the agent sees how much it did NOT read and
// knows the rest is behind ?full=1. Dropping the tail silently is not allowed —
// the agent would take it for the whole text.
export function clipText(text, full, limit = AGENT_TEXT_LIMIT) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (full || t.length <= limit) return t;
  return `${t.slice(0, limit)}… (clipped, ${t.length} chars total)`;
}

// A cell value. Quotes are needed where parsing would otherwise break: comma,
// colon, quote, newline, edges made of spaces. There are no empty cells — where
// there is nothing to say, a "-" stands.
export function toonValue(v) {
  const s = String(v ?? '');
  if (s === '') return '""';
  if (/[",:\n]/.test(s) || s !== s.trim()) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

// A table: a header with the row count and the fields, then indented rows.
// An empty table is not emptiness but an explicit zero in words.
export function toonTable(name, rows, fields, emptyText) {
  if (!rows.length) return `${name}: 0 — ${emptyText}`;
  return [
    `${name}[${rows.length}]{${fields.join(',')}}:`,
    ...rows.map(r => '  ' + fields.map(f => toonValue(r[f])).join(',')),
  ].join('\n');
}

// Parsing the parameters of the agent endpoints. The rules for format, full and
// spec are the same: the value must be spelled out. An empty value (?format= or
// ?full=) is a typo, not "on", and a repeated parameter
// (?format=toon&format=json) is one too: silently taking the first and losing
// the second means answering something other than what was asked.
export function agentParams(url, allowFull, allowSpec = false) {
  const allowed = ['format'];
  if (allowFull) allowed.push('full');
  if (allowSpec) allowed.push('spec');
  const desc = ['format=toon|json'];
  if (allowFull) desc.push('full=1');
  if (allowSpec) desc.push('spec=1');
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) {
      return { error: `error: unknown parameter "${key}"\n`
        + `help: allowed are ${desc.length > 1 ? desc.join(' and ') : desc[0] + ' only'}` };
    }
    if (url.searchParams.getAll(key).length > 1) {
      return { error: `error: parameter "${key}" given more than once\n`
        + 'help: leave one value — the board does not guess which of them you meant' };
    }
  }
  const format = url.searchParams.get('format') ?? 'toon';
  if (format !== 'toon' && format !== 'json') {
    return { error: `error: unknown format "${format}"\n`
      + 'help: format=toon (default, short text) or format=json' };
  }
  const fullRaw = url.searchParams.get('full');
  if (fullRaw !== null && !['0', '1', 'true', 'false'].includes(fullRaw)) {
    return { error: `error: full has an unclear value "${fullRaw}"\n`
      + 'help: full=1 — texts in full, full=0 (or no parameter) — clipped' };
  }
  const specRaw = url.searchParams.get('spec');
  if (specRaw !== null && !['0', '1', 'true', 'false'].includes(specRaw)) {
    return { error: `error: spec has an unclear value "${specRaw}"\n`
      + 'help: spec=1 — the spec text in the answer, spec=0 (or no parameter) — summary and the line count only' };
  }
  return {
    format,
    full: fullRaw !== null && fullRaw !== '0' && fullRaw !== 'false',
    spec: specRaw !== null && specRaw !== '0' && specRaw !== 'false',
  };
}
