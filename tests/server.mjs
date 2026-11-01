// Local stand-in for Supabase, for testing Stream Team without touching the
// live project. Serves:
//   /rest/v1/*          a PostgREST-compatible subset over a real local Postgres,
//                       with RLS enforced by SET ROLE anon / service_role
//   /functions/v1/notify  the real Edge Function source, run in-process
//   /__test/*           hooks: captured Telegram messages, fake clock, SQL
//   everything else     static files of the site (config.js is generated)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
import pg from 'pg';
import * as esbuild from 'esbuild';

const PORT = +(process.env.PORT || 8787);
const SITE = process.env.SITE || path.resolve(HERE, '..');
const FUNC_SRC = process.env.FUNC || path.resolve(HERE, '../supabase/functions/notify/index.ts');
const DB = process.env.PGDB || 'postgres';
const ANON = 'anon-key', SERVICE = 'service-key';

// Never let pg turn dates/times into JS objects: PostgREST returns them as
// the plain strings Postgres prints, and the app slices those strings.
for (const oid of [1082, 1083, 1114, 1184]) pg.types.setTypeParser(oid, v => v);
const pool = new pg.Pool({ host: '127.0.0.1', port: +(process.env.PGPORT || 54329), user: 'postgres', database: DB, max: 8 });

// ---------- fake clock (affects this process only: the function's "now") ----------
const RealDate = Date;
let clockOffset = 0;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(RealDate.now() + clockOffset); else super(...a); }
  static now() { return RealDate.now() + clockOffset; }
}
globalThis.Date = FakeDate;

// ---------- fake Telegram ----------
const tg = { sent: [], blocked: new Set(), updates: [], failGroup: false };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.telegram.org/')) {
    const method = url.split('/').pop().split('?')[0];
    if (method === 'getUpdates') {
      return new Response(JSON.stringify({ ok: true, result: tg.updates }), { status: 200 });
    }
    const b = JSON.parse(init.body || '{}');
    const isGroup = String(b.chat_id) === process.env.TELEGRAM_GROUP;
    if (tg.blocked.has(String(b.chat_id)) || (isGroup && tg.failGroup)) {
      tg.sent.push({ chat: String(b.chat_id), text: b.text, failed: true });
      return new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }), { status: 403 });
    }
    // Real Telegram rejects malformed HTML; mimic the common cases so a bad
    // escape shows up as a failed send in tests rather than passing silently.
    const bad = b.parse_mode === 'HTML' && htmlInvalid(b.text || '');
    if (bad) {
      tg.sent.push({ chat: String(b.chat_id), text: b.text, failed: true, reason: bad });
      return new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities: " + bad }), { status: 400 });
    }
    tg.sent.push({ chat: String(b.chat_id), text: b.text });
    return new Response(JSON.stringify({ ok: true, result: { message_id: tg.sent.length } }), { status: 200 });
  }
  return realFetch(input, init);
};
function htmlInvalid(t) {
  const allowed = /^(b|strong|i|em|u|ins|s|strike|del|a|code|pre|span|tg-spoiler|blockquote|tg-emoji)$/;
  if (/&(?!(amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/i.test(t)) return 'bare &';
  const tags = t.match(/<\/?([a-zA-Z-]+)[^>]*>|<(?![a-zA-Z\/])/g) || [];
  for (const tag of tags) {
    if (tag === '<') return 'bare <';
    const name = tag.replace(/^<\/?/, '').split(/[\s>]/)[0];
    if (!allowed.test(name)) return 'unsupported tag ' + name;
  }
  return '';
}

// ---------- the Edge Function, run in-process ----------
let fnHandler = null;
async function loadFunction() {
  if (!FUNC_SRC) return;
  const env = {
    SUPABASE_URL: 'http://127.0.0.1:' + PORT,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    TELEGRAM_TOKEN: 'TEST',
    TELEGRAM_GROUP: process.env.TELEGRAM_GROUP || '-100'
  };
  process.env.TELEGRAM_GROUP = env.TELEGRAM_GROUP;
  globalThis.Deno = { env: { get: k => env[k] }, serve: h => { fnHandler = typeof h === 'function' ? h : h.handler; } };
  const out = path.join('/tmp', 'fn-' + path.basename(path.dirname(FUNC_SRC)) + '-' + RealDate.now() + '.mjs');
  await esbuild.build({
    entryPoints: [FUNC_SRC], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
    plugins: [{ name: 'jsr', setup(b) {
      b.onResolve({ filter: /^jsr:@supabase\/supabase-js/ }, () => ({ path: path.resolve(HERE, 'node_modules/@supabase/supabase-js/dist/index.mjs') }));
    } }]
  });
  await import(pathToFileURL(out).href);
  if (!fnHandler) throw new Error('function did not call Deno.serve');
}

// ---------- PostgREST subset ----------
const qi = s => '"' + String(s).replace(/"/g, '""') + '"';
const FK = {   // embedded resources the app uses: table -> rel -> [localCol, foreignTable, foreignCol]
  services: { members: ['member_id', 'members', 'id'] },
  requests: { services: ['service_id', 'services', 'id'] }
};
function splitTop(s) {             // split on commas not inside () or ""
  const out = []; let depth = 0, cur = '', q = false;
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}
const unq = v => (v.startsWith('"') && v.endsWith('"')) ? v.slice(1, -1) : v;
function filterSql(alias, col, expr, vals) {
  let neg = false;
  if (expr.startsWith('not.')) { neg = true; expr = expr.slice(4); }
  const i = expr.indexOf('.');
  const op = expr.slice(0, i), v = expr.slice(i + 1);
  const c = alias + '.' + qi(col);
  const ops = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  let sql;
  if (ops[op]) { vals.push(unq(v)); sql = `${c} ${ops[op]} $${vals.length}`; }
  else if (op === 'like' || op === 'ilike') { vals.push(unq(v).replace(/\*/g, '%')); sql = `${c} ${op} $${vals.length}`; }
  else if (op === 'is') { sql = `${c} is ${({ null: 'null', true: 'true', false: 'false', unknown: 'unknown' })[v.toLowerCase()]}`; }
  else if (op === 'in') { vals.push(splitTop(v.replace(/^\(|\)$/g, '')).map(unq)); sql = `${c} = any($${vals.length})`; }
  else throw Object.assign(new Error('unsupported operator ' + op), { status: 400, code: 'PGRST100' });
  return neg ? `not (${sql})` : sql;
}
function whereSql(alias, params, vals) {
  const parts = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
    if (k === 'or' || k === 'and') {
      const items = splitTop(v.replace(/^\(|\)$/g, '')).map(it => {
        const d = it.indexOf('.');
        return filterSql(alias, it.slice(0, d), it.slice(d + 1), vals);
      });
      parts.push('(' + items.join(k === 'or' ? ' or ' : ' and ') + ')');
      continue;
    }
    parts.push(filterSql(alias, k, v, vals));
  }
  return parts.length ? ' where ' + parts.join(' and ') : '';
}
function selectSql(schema, table, alias, sel) {
  const items = splitTop(sel || '*');
  return items.map(it => {
    const m = it.match(/^([\w]+)(?::([\w]+))?\((.*)\)$/);
    if (m) {
      const relName = m[2] || m[1];
      const fk = (FK[table] || {})[relName];
      if (!fk) throw Object.assign(new Error('no relationship ' + relName), { status: 400, code: 'PGRST200' });
      const inner = selectSql(schema, fk[1], 'e', m[3]);
      return `(select row_to_json(x) from (select ${inner} from ${qi(schema)}.${qi(fk[1])} e where e.${qi(fk[2])} = ${alias}.${qi(fk[0])}) x) as ${qi(m[1])}`;
    }
    if (it === '*') return alias + '.*';
    const [a, c] = it.includes(':') ? it.split(':') : [null, it];
    return `${alias}.${qi(c)}` + (a ? ' as ' + qi(a) : '');
  }).join(', ');
}
function orderSql(alias, o) {
  if (!o) return '';
  return ' order by ' + o.split(',').map(p => {
    const [c, dir, nulls] = p.split('.');
    return `${alias}.${qi(c)} ${dir === 'desc' ? 'desc' : 'asc'}` + (nulls ? (nulls === 'nullsfirst' ? ' nulls first' : ' nulls last') : '');
  }).join(', ');
}
async function pk(client, schema, table) {
  const r = await client.query(`select a.attname from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = ($1||'.'||$2)::regclass and i.indisprimary`, [qi(schema), qi(table)]);
  return r.rows.map(x => x.attname);
}
function pgError(e, role) {
  const map = { '42501': role === 'anon' ? 401 : 403, '23505': 409, '23503': 409, '23502': 400, '22P02': 400, '42P01': 404, '42883': 404, PGRST116: 406 };
  const status = e.status || map[e.code] || 400;
  return { status, body: { code: e.code || 'PGRST000', details: e.detail || null, hint: e.hint || null, message: e.message } };
}

async function rest(req, url, bodyText) {
  const key = req.headers.apikey || (req.headers.authorization || '').replace(/^Bearer /, '');
  const role = key === SERVICE ? 'service_role' : key === ANON ? 'anon' : null;
  if (!role) return { status: 401, body: { message: 'Invalid API key' } };
  const schema = req.headers['accept-profile'] || req.headers['content-profile'] || 'public';
  const prefer = req.headers.prefer || '';
  const wantsObject = /vnd\.pgrst\.object/.test(req.headers.accept || '');
  const rel = decodeURIComponent(url.pathname.replace(/^\/rest\/v1\/?/, ''));
  const params = [...url.searchParams.entries()];
  const P = Object.fromEntries(params);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${role}`);
    await client.query(`select set_config('search_path', $1, true), set_config('request.jwt.claims', $2, true)`, [schema + ', public', JSON.stringify({ role })]);
    let rows;
    if (rel.startsWith('rpc/')) {
      const fn = rel.slice(4);
      const args = bodyText ? JSON.parse(bodyText) : {};
      const names = Object.keys(args);
      const vals = names.map(n => (args[n] !== null && typeof args[n] === 'object') ? JSON.stringify(args[n]) : args[n]);
      const r = await client.query(`select to_json(${qi(schema)}.${qi(fn)}(${names.map((n, i) => `${qi(n)} => $${i + 1}`).join(', ')})) as r`, vals);
      await client.query('commit');
      return { status: 200, body: r.rows[0].r };
    }
    const table = rel, T = `${qi(schema)}.${qi(table)}`;
    const vals = [];
    const repr = /return=representation/.test(prefer);
    if (req.method === 'GET') {
      let sql = `select ${selectSql(schema, table, 't', P.select)} from ${T} t${whereSql('t', params, vals)}${orderSql('t', P.order)}`;
      if (P.limit) sql += ' limit ' + (+P.limit);
      if (P.offset) sql += ' offset ' + (+P.offset);
      const r = await client.query(`select coalesce(json_agg(x), '[]'::json) as j from (${sql}) x`, vals);
      rows = r.rows[0].j;
    } else if (req.method === 'PATCH') {
      const body = JSON.parse(bodyText || '{}');
      const sets = Object.keys(body).map(k => { vals.push(body[k] !== null && typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]); return `${qi(k)} = $${vals.length}`; });
      const where = whereSql(T, params, vals);
      const r = await client.query(`with u as (update ${T} set ${sets.join(', ')}${where} returning *) select coalesce(json_agg(x), '[]'::json) as j from (select ${selectSql(schema, table, 't', P.select)} from u t) x`, vals);
      rows = r.rows[0].j;
    } else if (req.method === 'DELETE') {
      const where = whereSql(T, params, vals);
      const r = await client.query(`with d as (delete from ${T}${where} returning *) select coalesce(json_agg(x), '[]'::json) as j from (select ${selectSql(schema, table, 't', P.select)} from d t) x`, vals);
      rows = r.rows[0].j;
    } else if (req.method === 'POST') {
      let body = JSON.parse(bodyText || '{}');
      if (!Array.isArray(body)) body = [body];
      const upsert = /resolution=merge-duplicates/.test(prefer), ignore = /resolution=ignore-duplicates/.test(prefer);
      const conflict = P.on_conflict ? P.on_conflict.split(',') : await pk(client, schema, table);
      rows = [];
      for (const row of body) {
        const cols = Object.keys(row), v = cols.map(c => row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c]);
        let sql = `insert into ${T} (${cols.map(qi).join(', ')}) values (${cols.map((_, i) => '$' + (i + 1)).join(', ')})`;
        if (upsert) sql += ` on conflict (${conflict.map(qi).join(', ')}) do update set ${cols.map(c => `${qi(c)} = excluded.${qi(c)}`).join(', ')}`;
        else if (ignore) sql += ' on conflict do nothing';
        const r = await client.query(`with i as (${sql} returning *) select row_to_json(i) as j from i`, v);
        r.rows.forEach(x => rows.push(x.j));
      }
      if (P.select && P.select !== '*') {
        const keep = splitTop(P.select);
        rows = rows.map(o => Object.fromEntries(keep.map(k => [k, o[k]])));
      }
    } else {
      throw Object.assign(new Error('method not allowed'), { status: 405 });
    }
    await client.query('commit');
    if (wantsObject) {
      if (rows.length !== 1) return { status: 406, body: { code: 'PGRST116', details: `The result contains ${rows.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' } };
      return { status: 200, body: rows[0] };
    }
    if (req.method !== 'GET' && !repr) return { status: req.method === 'POST' ? 201 : 204, body: null };
    return { status: req.method === 'POST' ? 201 : 200, body: rows };
  } catch (e) {
    try { await client.query('rollback'); } catch (_) {}
    return pgError(e, role);
  } finally {
    client.release();
  }
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.css': 'text/css' };
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const chunks = []; for await (const c of req) chunks.push(c);
  const bodyText = Buffer.concat(chunks).toString('utf8');
  const send = (status, body, headers = {}) => {
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, cors, headers));
    res.end(body == null ? '' : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)));
  };
  try {
    if (url.pathname.startsWith('/rest/v1')) {
      if (req.method === 'OPTIONS') return send(204, null);
      const r = await rest(req, url, bodyText);
      return send(r.status, r.body);
    }
    if (url.pathname === '/functions/v1/notify') {
      if (!fnHandler) return send(404, { error: 'no function loaded' });
      const key = req.headers.apikey || (req.headers.authorization || '').replace(/^Bearer /, '');
      if (req.method !== 'OPTIONS' && key !== ANON && key !== SERVICE) return send(401, { msg: 'Invalid JWT' });
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(',') : v);
      if (!headers.get('x-forwarded-for')) headers.set('x-forwarded-for', req.socket.remoteAddress || '127.0.0.1');
      const r = await fnHandler(new Request('http://127.0.0.1' + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyText }));
      const out = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
      return res.end(out);
    }
    if (url.pathname.startsWith('/__test/')) {
      const what = url.pathname.slice(8);
      if (what === 'telegram') { if (req.method === 'DELETE') tg.sent = []; return send(200, tg.sent); }
      if (what === 'tg-config') { const b = JSON.parse(bodyText || '{}'); tg.blocked = new Set((b.blocked || []).map(String)); tg.updates = b.updates || []; tg.failGroup = !!b.failGroup; return send(200, { ok: true }); }
      if (what === 'now') { const b = JSON.parse(bodyText || '{}'); clockOffset = b.iso ? new RealDate(b.iso).getTime() - RealDate.now() : 0; return send(200, { now: new Date().toISOString() }); }
      if (what === 'sql') { const r = await pool.query(bodyText); return send(200, Array.isArray(r) ? r.map(x => x.rows) : r.rows); }
      return send(404, null);
    }
    if (url.pathname.startsWith('/realtime/')) return send(404, null);
    // static site
    if (url.pathname === '/config.js') {
      return send(200, `window.STREAM_CONFIG = { url: "http://127.0.0.1:${PORT}", key: "${ANON}" };`, { 'Content-Type': 'text/javascript' });
    }
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '') || 'index.html';
    const file = path.join(SITE, p);
    if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(404, 'not found', { 'Content-Type': 'text/plain' });
    return send(200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  } catch (e) {
    console.error(e);
    send(500, { error: String(e) });
  }
});

await loadFunction();
server.listen(PORT, '127.0.0.1', () => console.log('harness on', PORT, 'site', SITE, 'fn', FUNC_SRC || '-'));
