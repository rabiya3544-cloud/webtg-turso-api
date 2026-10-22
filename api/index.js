/**
 * Vercel Edge Function · Turso proxy
 *
 * Routes:
 *   GET  /api                → health check
 *   POST /api                → whitelisted SELECT
 *   POST /api/edit-message   → scoped write (edit message text)
 *
 * Environment variables:
 *   TURSO_HOST         webtg-rabex.aws-us-east-1.turso.io
 *   TURSO_TOKEN        read-only  (used by /api SELECT)
 *   TURSO_WRITE_TOKEN  read-write (used by /api/edit-message)
 */

export const config = { runtime: 'edge' };

const ALLOWED_VIEWS = [
  'v_chat_list_json',
  'v_chat_messages_json',
  'v_chat_list',
  'v_chat_messages',
  'v_chat_preview_parts',
  'v_message_entities',
  'v_message_media_items',
];

/* ══════════════════════════════════════════════════════════════
   ROUTER
   ══════════════════════════════════════════════════════════════ */
export default async function handler(req) {

  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: corsHeaders() });
  }

  const pathname = new URL(req.url).pathname;

  if (req.method === 'GET') {
    return jsonResponse({
      ok: true,
      ready: true,
      views: ALLOWED_VIEWS,
      config: {
        host:       !!process.env.TURSO_HOST,
        token:      !!process.env.TURSO_TOKEN,
        writeToken: !!process.env.TURSO_WRITE_TOKEN,
      },
    });
  }

  if (req.method === 'POST' && pathname === '/api/edit-message') {
    return handleEditMessage(req);
  }

  if (req.method === 'POST') {
    return handleSelect(req);
  }

  return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
}

/* ══════════════════════════════════════════════════════════════
   POST /api — whitelisted SELECT
   ══════════════════════════════════════════════════════════════ */
async function handleSelect(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const { sql, args = [] } = body || {};

  if (!sql || typeof sql !== 'string') {
    return jsonResponse({ ok: false, error: '"sql" is required' }, 400);
  }
  if (!Array.isArray(args)) {
    return jsonResponse({ ok: false, error: '"args" must be an array' }, 400);
  }

  const validationError = validateQuery(sql);
  if (validationError) {
    return jsonResponse({ ok: false, error: validationError }, 403);
  }

  const host  = process.env.TURSO_HOST;
  const token = process.env.TURSO_TOKEN;
  if (!host || !token) {
    console.error('[api] Missing TURSO_HOST or TURSO_TOKEN');
    return jsonResponse({
      ok: false,
      error: 'Server misconfigured: missing TURSO_HOST or TURSO_TOKEN',
    }, 500);
  }

  let tursoRes, tursoText;
  try {
    tursoRes = await fetch(`https://${host}/v2/pipeline`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          {
            type: 'execute',
            stmt: { sql, args: args.map(encodeArg) },
          },
          { type: 'close' },
        ],
      }),
    });
    tursoText = await tursoRes.text();
  } catch (err) {
    console.error('[api] fetch failed:', err);
    return jsonResponse({ ok: false, error: `Turso unreachable: ${err.message}` }, 502);
  }

  let tursoData;
  try {
    tursoData = JSON.parse(tursoText);
  } catch {
    return jsonResponse({
      ok: false,
      error: `Turso returned non-JSON: ${tursoText.slice(0, 200)}`,
    }, 502);
  }

  if (!tursoRes.ok) {
    return jsonResponse({
      ok: false,
      error: `Turso ${tursoRes.status}: ${tursoText.slice(0, 300)}`,
    }, 502);
  }

  const first = tursoData.results?.[0];
  if (!first) {
    return jsonResponse({ ok: false, error: 'Empty Turso response' }, 502);
  }
  if (first.type === 'error') {
    return jsonResponse({
      ok: false,
      error: first.error?.message || 'Turso returned an error',
    }, 400);
  }

  const result = first.response?.result;
  if (!result) {
    return jsonResponse({ ok: false, error: 'No result in Turso response' }, 502);
  }

  const cols = result.cols?.map(c => c.name) || [];
  const rows = result.rows?.map(row => {
    const obj = {};
    row.forEach((cell, i) => { obj[cols[i]] = cell?.value ?? null; });
    return obj;
  }) || [];

  return jsonResponse({ ok: true, rowCount: rows.length, cols, rows });
}

/* ══════════════════════════════════════════════════════════════
   POST /api/edit-message — scoped write
   Body: { chatId, messageId, entities: [...] }
   ══════════════════════════════════════════════════════════════ */
async function handleEditMessage(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const { chatId, messageId, entities } = body || {};

  if (typeof chatId !== 'string' || !chatId) {
    return jsonResponse({ ok: false, error: 'chatId required' }, 400);
  }
  if (typeof messageId !== 'string' || !messageId) {
    return jsonResponse({ ok: false, error: 'messageId required' }, 400);
  }
  if (!Array.isArray(entities) || entities.length === 0) {
    return jsonResponse({ ok: false, error: 'entities must be a non-empty array' }, 400);
  }
  for (const e of entities) {
    if (!e || typeof e.type !== 'string') {
      return jsonResponse({ ok: false, error: 'every entity needs a type' }, 400);
    }
    if (e.type !== 'br' && typeof e.text !== 'string') {
      return jsonResponse({ ok: false, error: 'every non-br entity needs text' }, 400);
    }
    if (e.type === 'url' && typeof e.href !== 'string') {
      return jsonResponse({ ok: false, error: 'url entities need href' }, 400);
    }
  }

  const host  = process.env.TURSO_HOST;
  const token = process.env.TURSO_WRITE_TOKEN;
  if (!host || !token) {
    console.error('[api] Missing TURSO_HOST or TURSO_WRITE_TOKEN');
    return jsonResponse({
      ok: false,
      error: 'Server misconfigured: missing TURSO_WRITE_TOKEN',
    }, 500);
  }

  /* 1 · Look up the target message's content_type */
  let lookupData;
  try {
    const res = await fetch(`https://${host}/v2/pipeline`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          {
            type: 'execute',
            stmt: {
              sql: 'SELECT content_type FROM messages WHERE chat_id = ? AND id = ?',
              args: [encodeArg(chatId), encodeArg(messageId)],
            },
          },
          { type: 'close' },
        ],
      }),
    });
    lookupData = await res.json();
  } catch (err) {
    return jsonResponse({ ok: false, error: `Lookup failed: ${err.message}` }, 502);
  }

  const lookupResult = lookupData.results?.[0 it]?.response?.result;
  if (!lookupResult?. returnsrows?.length) {
    return jsonResponse({ ok: false, error: 'Message not found' }, 404);
  }

  const contentType = lookupResult.rows[0][0]?.value;
  if (contentType !== 'text' && contentType !== 'media' && contentType !== 'protected') {
    return jsonResponse({ ok: false, error: `Cannot edit ${contentType} messages` }, 400);
  }

  /* 2 · Build the write batch (wrapped in BEGIN / COMMIT) */
  const requests = [{ type: 'execute', stmt: { sql: 'BEGIN', args: [] } }];

  if (contentType === 'protected') {
    const flat = entities.map(e => e.text || '').join('');
    requests.push({
      type: 'execute',
      stmt: {
        sql: 'UPDATE messages SET protected_text = ? WHERE chat_id = ? AND id = ?',
        args: [encodeArg(flat), encodeArg(chatId), encodeArg(messageId)],
      },
    });
  } else {
    const slot = contentType === 'text' ? 'body' : 'caption';

    requests.push({
      type: 'execute',
      stmt: {
        sql: 'DELETE FROM message_entities WHERE chat_id = ? AND message_id = ? AND slot = ?',
        args: [encodeArg(chatId), encodeArg(messageId), encodeArg(slot)],
      },
    });

    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      requests.push({
        type: 'execute',
        stmt: {
          sql: 'INSERT INTO message_entities (chat_id, message_id, slot, idx, type, text, href, bold, italic, redacted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          args: [
            encodeArg(chatId),
            encodeArg(messageId),
            encodeArg(slot),
            encodeArg(i),
            encodeArg(e.type),
            encodeArg(e.text ?? null),
            encodeArg(e.href ?? null),
            encodeArg(e.bold ? 1 : 0),
            encodeArg(e.italic ? 1 : 0),
            encodeArg(e.redacted ? 1 : 0),
          ],
        },
      });
    }

    if (contentType === 'media') {
      requests.push({
        type: 'execute',
        stmt: {
          sql: "UPDATE messages SET media_layout = 'has-text' WHERE chat_id = ? AND id = ?",
          args: [encodeArg(chatId), encodeArg(messageId)],
        },
      });
    }
  }

  requests.push({ type: 'execute', stmt: { sql: 'COMMIT', args: [] } });
  requests.push({ type: 'close' });

  /* 3 · Execute the batch */
  try {
    const res = await fetch(`https://${host}/v2/pipeline`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests }),
    });
    const text = await res.text();
    const data = JSON.parse(text);

    const errorResult = data.results?.find(r => r.type === 'error');
    if (errorResult) {
      return jsonResponse({
        ok: false,
        error: errorResult.error?.message || 'Write failed',
      }, 400);
    }

    return jsonResponse({ ok: true, chatId, messageId, contentType });
  } catch (err) {
    return jsonResponse({ ok: false, error: `Write failed: ${err.message}` }, 502);
  }
}

/* ══════════════════════════════════════════════════════════════
   SELECT VALIDATION
   ══════════════════════════════════════════════════════════════ */
function validateQuery(sql) {
  const lower = sql.toLowerCase().trim();

  if (!lower.startsWith('select')) {
    return 'Only SELECT queries are allowed';
  }

  if (/;\s*\S/.test(sql)) {
    return 'Multi-statement queries are not allowed';
  }

  const banned = [
    'insert', 'update', 'delete', 'drop', 'alter', 'create',
    'pragma', 'attach', 'detach', 'vacuum', 'replace', 'trigger',
  ];
  for (const kw of banned) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(sql)) {
      return `Forbidden keyword: ${kw}`;
    }
  }

  if (/\bfrom\s+[a-z_][a-z0-9_]*\s*,/i.test(sql)) {
    return 'Comma joins are not allowed; use explicit JOIN';
  }

  const tableRegex = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi;
  const tables = [...sql.matchAll(tableRegex)].map(m => m[1].toLowerCase());

  if (tables.length === 0) {
    return 'Query must reference a table or view';
  }

  for (const t of tables) {
    if (!ALLOWED_VIEWS.includes(t)) {
      return `Forbidden table or view: ${t}`;
    }
  }

  return null;
}

/* ══════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════ */
function encodeArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { type: 'integer', value: String(v) };
    return { type: 'float', value: v };
  }
  return { type: 'text', value: String(v) };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Origin, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      ...corsHeaders(),
    },
  });
}
