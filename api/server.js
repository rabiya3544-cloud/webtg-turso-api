/**
 * Vercel Edge Function · Turso proxy
 *
 * POST /api/server      → run a whitelisted SELECT against Turso
 * GET  /api/server      → health check
 *
 * Environment variables (set in Vercel dashboard → Settings → Environment Variables):
 *   TURSO_HOST   webtg-rabex.aws-us-east-1.turso.io
 *   TURSO_TOKEN  <read-only token>
 *
 * Why Edge runtime?
 *   - ~0ms cold start (vs 300-800ms Node.js)
 *   - Runs at the CDN edge closest to the user
 *   - Only needs fetch(), which is available
 */

export const config = { runtime: 'edge' };

/* ── Whitelist: only these views are reachable ── */
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
   HANDLER
   ══════════════════════════════════════════════════════════════ */
export default async function handler(req) {

  /* CORS preflight */
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  /* Health check */
  if (req.method === 'GET') {
    return jsonResponse({
      ok: true,
      ready: true,
      views: ALLOWED_VIEWS,
      config: {
        host:  !!process.env.TURSO_HOST,
        token: !!process.env.TURSO_TOKEN,
      },
    });
  }

  /* Only POST past this point */
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  /* Parse body */
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

  /* Validate query */
  const validationError = validateQuery(sql);
  if (validationError) {
    return jsonResponse({ ok: false, error: validationError }, 403);
  }

  /* Check env */
  const host  = process.env.TURSO_HOST;
  const token = process.env.TURSO_TOKEN;

  if (!host || !token) {
    console.error('[api] Missing TURSO_HOST or TURSO_TOKEN');
    return jsonResponse({
      ok: false,
      error: 'Server misconfigured: missing TURSO_HOST or TURSO_TOKEN',
    }, 500);
  }

  /* Forward to Turso */
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
            stmt: {
              sql,
              args: args.map(encodeArg),
            },
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

  /* Parse Turso response */
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

  /* Flatten rows: [{ chat_json: '...' }, ...] */
  const cols = result.cols?.map(c => c.name) || [];
  const rows = result.rows?.map(row => {
    const obj = {};
    row.forEach((cell, i) => {
      obj[cols[i]] = cell?.value ?? null;
    });
    return obj;
  }) || [];

  return jsonResponse({
    ok: true,
    rowCount: rows.length,
    cols,
    rows,
  });
}

/* ══════════════════════════════════════════════════════════════
   QUERY VALIDATION
   ══════════════════════════════════════════════════════════════ */
function validateQuery(sql) {
  const lower = sql.toLowerCase().trim();

  /* 1 · Must be SELECT */
  if (!lower.startsWith('select')) {
    return 'Only SELECT queries are allowed';
  }

  /* 2 · No multi-statement */
  if (/;\s*\S/.test(sql)) {
    return 'Multi-statement queries are not allowed';
  }

  /* 3 · No dangerous keywords */
  const banned = [
    'insert', 'update', 'delete', 'drop', 'alter', 'create',
    'pragma', 'attach', 'detach', 'vacuum', 'replace', 'trigger',
  ];
  for (const kw of banned) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(sql)) {
      return `Forbidden keyword: ${kw}`;
    }
  }

  /* 4 · Ban comma joins (could bypass the table check) */
  if (/\bfrom\s+[a-z_][a-z0-9_]*\s*,/i.test(sql)) {
    return 'Comma joins are not allowed; use explicit JOIN';
  }

  /* 5 · Every referenced table/view must be whitelisted */
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

/* Encode args in Turso's strict format:
   - integer → string
   - float   → raw JSON number
   - text    → string
   - null    → { type: 'null' }                                  */
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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(),
    },
  });
}
