// Draven Sports · CRM hospedado
// Servidor único: login da equipe, banco de dados (SQLite), atualização em tempo real e conexão com WhatsApp por QR Code.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createWhatsApp } from './whatsapp.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(DIR, 'public');
const DATA = process.env.DATA_DIR || path.join(DIR, 'data');
const PORT = Number(process.env.PORT) || 3000;
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP !== 'false';
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
fs.mkdirSync(DATA, { recursive: true });

const SECRET = process.env.SESSION_SECRET || (() => {
  const f = path.join(DATA, '.secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'));
  return fs.readFileSync(f, 'utf8').trim();
})();

// ---------- banco ----------
const sql = new DatabaseSync(path.join(DATA, 'draven.db'));
sql.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS docs(col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(col,id));
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);`);
const Q = {
  get: sql.prepare('SELECT data FROM docs WHERE col=? AND id=?'),
  list: sql.prepare('SELECT id, data FROM docs WHERE col=?'),
  put: sql.prepare('INSERT INTO docs(col,id,data,updated) VALUES(?,?,?,?) ON CONFLICT(col,id) DO UPDATE SET data=excluded.data, updated=excluded.updated'),
  del: sql.prepare('DELETE FROM docs WHERE col=? AND id=?'),
  kvGet: sql.prepare('SELECT v FROM kv WHERE k=?'),
  kvSet: sql.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
  userById: sql.prepare('SELECT * FROM users WHERE id=?'),
  userByEmail: sql.prepare('SELECT * FROM users WHERE email=?'),
  userCount: sql.prepare('SELECT COUNT(*) AS n FROM users'),
  userIns: sql.prepare('INSERT INTO users(id,email,name,pass,created) VALUES(?,?,?,?,?)'),
  userPass: sql.prepare('UPDATE users SET pass=? WHERE email=?'),
};
const kv = { get: k => Q.kvGet.get(k)?.v ?? null, set: (k, v) => Q.kvSet.run(k, v) };

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
const SEG = /^(?!\.\.?$)[A-Za-z0-9_\-.~:@+]{1,200}$/;
function checkPath(p, even) {
  const s = String(p || '').split('/');
  if (!s.every(x => SEG.test(x)) || s.length > 16 || (s.length % 2 === 0) !== even) throw err(400, 'invalid_argument', 'Caminho inválido: ' + p);
  return even ? [s.slice(0, -1).join('/'), s.at(-1)] : s.join('/');
}
function merge(a, b) {
  const o = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) o[k] = merge(a[k], v);
    else o[k] = v;
  }
  return o;
}
export const store = {
  get(col, id) { const r = Q.get.get(col, id); return r ? JSON.parse(r.data) : null; },
  list(col) { return Q.list.all(col).map(r => ({ id: r.id, data: JSON.parse(r.data) })); },
  set(col, id, data) { Q.put.run(col, id, JSON.stringify(data), Date.now()); emit(col, id, data); return data; },
  update(col, id, patch) {
    const cur = this.get(col, id);
    if (!cur) throw err(400, 'invalid_argument', 'O registro não existe mais.');
    return this.set(col, id, merge(cur, patch));
  },
  del(col, id) { Q.del.run(col, id); emit(col, id, null); },
};
export const rid = (n = 20) => { const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; return [...crypto.randomBytes(n)].map(x => c[x % 62]).join(''); };

// ---------- tempo real ----------
const streams = new Set();
function emit(col, id, data) {
  const msg = `data: ${JSON.stringify({ t: 'doc', col, id, data })}\n\n`;
  for (const s of streams) { try { if (canRead(s.user, col)) s.res.write(msg); } catch {} }
}
setInterval(() => { for (const s of streams) { try { s.res.write(': ping\n\n'); } catch {} } }, 25000).unref();

// ---------- usuários e sessões ----------
function hashPass(p, salt = crypto.randomBytes(16).toString('hex')) { return salt + ':' + crypto.scryptSync(p, salt, 64).toString('hex'); }
function checkPass(p, h) { const [s, x] = h.split(':'); const y = crypto.scryptSync(p, s, 64); const xb = Buffer.from(x, 'hex'); return xb.length === y.length && crypto.timingSafeEqual(xb, y); }
function sign(uid) { const exp = Date.now() + 30 * 864e5; const b = `${uid}.${exp}`; return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); }
function cookies(req) { const o = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function session(req) {
  const c = cookies(req).sid; if (!c) return null;
  const [uid, exp, sig] = c.split('.'); if (!sig || Number(exp) < Date.now()) return null;
  const ok = crypto.createHmac('sha256', SECRET).update(`${uid}.${exp}`).digest('base64url');
  if (sig.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return null;
  const u = Q.userById.get(uid); if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, isOwner: kv.get('owner') === u.id };
}
function role(u) { if (!u) return null; return u.isOwner ? 'gestao' : (store.get('equipe', u.id)?.papel || null); }
function canRead(u, col) { if (role(u)) return true; const top = col.split('/')[0]; return top === 'equipe' || top === 'acessos'; }
function canWrite(u, col, id) {
  const r = role(u); const top = col.split('/')[0];
  if (top === 'equipe') return r === 'gestao';
  if (top === 'acessos') return r === 'gestao' || (col === 'acessos' && id === u.id);
  if (top === 'whatsapp') return r === 'gestao';
  return !!r;
}
function setCookie(req, res, val, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  res.setHeader('set-cookie', `sid=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}
const tries = new Map();
function rateLimit(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const now = Date.now(); const t = (tries.get(ip) || []).filter(x => now - x < 60000); t.push(now); tries.set(ip, t);
  if (t.length > 12) throw err(429, 'resource_exhausted', 'Muitas tentativas. Aguarde um minuto.');
}

// ---------- IA (opcional) ----------
export async function askClaude(input, maxTokens = 1500) {
  if (!AI_KEY) throw err(400, 'not_granted', 'IA não configurada no servidor.');
  const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: maxTokens, messages }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw err(502, 'unavailable', j.error?.message || 'A IA não respondeu.');
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// ---------- WhatsApp ----------
const wa = createWhatsApp({ store, rid, dataDir: DATA, ai: AI_KEY ? askClaude : null, fake: process.env.WA_FAKE === '1' });

// ---------- HTTP ----------
function send(res, status, obj) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
async function body(req) {
  const ch = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 2e6) throw err(413, 'invalid_argument', 'Envio grande demais.'); ch.push(c); }
  const t = Buffer.concat(ch).toString('utf8');
  try { return t ? JSON.parse(t) : {}; } catch { throw err(400, 'invalid_argument', 'JSON inválido.'); }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function file(res, rel) {
  const f = path.join(PUB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': rel.endsWith('.html') ? 'no-store' : 'public, max-age=3600' });
  fs.createReadStream(f).pipe(res);
}
const leases = new Map();

async function api(req, res, url) {
  const p = url.pathname, M = req.method;

  if (p === '/api/auth/state') return send(res, 200, { hasUsers: Q.userCount.get().n > 0, signup: ALLOW_SIGNUP || Q.userCount.get().n === 0 });
  if (p === '/api/auth/signup' && M === 'POST') {
    rateLimit(req);
    const b = await body(req); const first = Q.userCount.get().n === 0;
    if (!first && !ALLOW_SIGNUP) throw err(403, 'not_granted', 'O cadastro está fechado. Peça para a gestão liberar.');
    const email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim(), pass = String(b.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email)) throw err(400, 'invalid_argument', 'Informe um e-mail válido.');
    if (name.length < 2) throw err(400, 'invalid_argument', 'Informe seu nome.');
    if (pass.length < 8) throw err(400, 'invalid_argument', 'A senha precisa ter pelo menos 8 caracteres.');
    if (Q.userByEmail.get(email)) throw err(400, 'invalid_argument', 'Já existe uma conta com este e-mail.');
    const id = 'u_' + rid(22);
    Q.userIns.run(id, email, name, hashPass(pass), Date.now());
    if (first) kv.set('owner', id); else store.set('acessos', id, { em: Date.now() });
    setCookie(req, res, sign(id), 30 * 86400);
    return send(res, 200, { ok: true, owner: first });
  }
  if (p === '/api/auth/login' && M === 'POST') {
    rateLimit(req);
    const b = await body(req);
    const u = Q.userByEmail.get(String(b.email || '').trim().toLowerCase());
    if (!u || !checkPass(String(b.password || ''), u.pass)) throw err(401, 'invalid_argument', 'E-mail ou senha incorretos.');
    setCookie(req, res, sign(u.id), 30 * 86400);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/auth/logout' && M === 'POST') { setCookie(req, res, '', 0); return send(res, 200, { ok: true }); }

  const me = session(req);
  if (!me) throw err(401, 'not_granted', 'Faça login para continuar.');
  const papel = role(me);

  if (p === '/api/me') return send(res, 200, { ...me, papel, ai: !!AI_KEY });
  if (p === '/api/users') {
    const ids = String(url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 200); const o = {};
    for (const id of ids) { const u = Q.userById.get(id); if (u) o[id] = { name: u.name }; }
    return send(res, 200, o);
  }
  if (p === '/api/col' && M === 'GET') {
    const col = checkPath(url.searchParams.get('path'), false);
    if (!canRead(me, col)) throw err(403, 'not_granted', 'Sem acesso.');
    return send(res, 200, store.list(col));
  }
  if (p === '/api/doc' && M === 'GET') {
    const [col, id] = checkPath(url.searchParams.get('path'), true);
    return send(res, 200, { data: canRead(me, col) ? store.get(col, id) : null });
  }
  if (p === '/api/doc' && M === 'POST') {
    const b = await body(req); const [col, id] = checkPath(b.path, true);
    if (!canWrite(me, col, id)) throw err(400, 'invalid_argument', 'Você não tem permissão para gravar aqui.');
    if (b.op === 'delete') { store.del(col, id); return send(res, 200, { ok: true }); }
    if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) throw err(400, 'invalid_argument', 'Dados inválidos.');
    if (JSON.stringify(b.data).length > 262144) throw err(400, 'invalid_argument', 'Registro grande demais.');
    const data = b.op === 'update' ? store.update(col, id, b.data) : store.set(col, id, b.data);
    return send(res, 200, { data });
  }
  if (p === '/api/lease' && M === 'POST') {
    const b = await body(req); checkPath(b.path, true);
    const now = Date.now(), ttl = Math.min(600000, Math.max(1000, Number(b.ttlMs) || 30000)), cur = leases.get(b.path);
    if (cur && cur.exp > now && cur.holder !== b.holder) return send(res, 200, { acquired: false, expiresAt: new Date(cur.exp).toISOString() });
    leases.set(b.path, { holder: b.holder, exp: now + ttl });
    return send(res, 200, { acquired: true, holder: b.holder, expiresAt: new Date(now + ttl).toISOString() });
  }
  if (p === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\ndata: {"t":"hello"}\n\n');
    const s = { res, user: me }; streams.add(s);
    req.on('close', () => streams.delete(s));
    return;
  }
  if (p === '/api/ai' && M === 'POST') {
    if (!papel) throw err(403, 'not_granted', 'Sem acesso.');
    const b = await body(req);
    return send(res, 200, { text: await askClaude(b.input) });
  }

  // WhatsApp
  if (p.startsWith('/api/wa/')) {
    const gestao = papel === 'gestao';
    const b = M === 'POST' ? await body(req) : {};
    if (p === '/api/wa/qr') { if (!gestao) throw err(403, 'not_granted', 'Somente a gestão conecta números.'); return send(res, 200, wa.qr(url.searchParams.get('id'))); }
    if (p === '/api/wa/connect' && M === 'POST') { if (!gestao) throw err(403, 'not_granted', 'Somente a gestão conecta números.'); return send(res, 200, await wa.create(b, me)); }
    if (p === '/api/wa/restart' && M === 'POST') { if (!gestao) throw err(403, 'not_granted', 'Somente a gestão conecta números.'); await wa.restart(b.id); return send(res, 200, { ok: true }); }
    if (p === '/api/wa/disconnect' && M === 'POST') { if (!gestao) throw err(403, 'not_granted', 'Somente a gestão desconecta números.'); await wa.logout(b.id); return send(res, 200, { ok: true }); }
    if (p === '/api/wa/remove' && M === 'POST') { if (!gestao) throw err(403, 'not_granted', 'Somente a gestão remove números.'); await wa.remove(b.id); return send(res, 200, { ok: true }); }
    if (p === '/api/wa/send' && M === 'POST') { if (papel !== 'gestao' && papel !== 'vendedor') throw err(403, 'not_granted', 'Seu perfil não envia mensagens.'); return send(res, 200, await wa.send(b, me)); }
    if (p === '/api/wa/fake-incoming' && M === 'POST' && process.env.WA_FAKE === '1') { wa.fakeIncoming(b); return send(res, 200, { ok: true }); }
  }
  throw err(404, 'invalid_argument', 'Rota não encontrada.');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!session(req)) { res.writeHead(302, { location: '/login.html' }); return res.end(); }
      return file(res, 'index.html');
    }
    return file(res, url.pathname.slice(1));
  } catch (e) {
    const st = e.status || 500; if (st === 500) console.error(e);
    if (!res.headersSent) send(res, st, { code: e.code || 'unavailable', message: st === 500 ? 'Erro interno. Tente de novo.' : e.message });
  }
});

// ---------- linha de comando ----------
const args = process.argv.slice(2);
if (args[0] === '--senha') {
  const [, email, nova] = args;
  if (!email || !nova || nova.length < 8) { console.log('Uso: node server.mjs --senha email@empresa.com NovaSenha123'); process.exit(1); }
  const r = Q.userPass.run(hashPass(nova), email.toLowerCase());
  console.log(r.changes ? 'Senha alterada.' : 'E-mail não encontrado.'); process.exit(0);
}
if (args[0] === '--importar') {
  const dados = JSON.parse(fs.readFileSync(args[1], 'utf8')); let n = 0;
  for (const [col, rows] of Object.entries(dados)) for (const r of rows) { Q.put.run(col, r.id, JSON.stringify(r.data), Date.now()); n++; }
  console.log(`${n} registros importados.`); process.exit(0);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Draven CRM rodando em http://localhost:${PORT}`);
  wa.boot();
});
