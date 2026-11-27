// Jhatpat drop box: holds end-to-end encrypted files for a desk/shop while its
// devices are offline, and sends a Web Push "you have files waiting" alert.
// The server never sees file names or contents: visitors encrypt on their phone
// with the desk's public key; only the desk owner's devices hold the private key.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Access-Control-Max-Age': '86400',
};
const MAX_PART = 1_100_000;      // one encrypted 1 MB chunk (+iv/tag)
const MAX_PARTS_DROP = 110;      // ~100 MB per send
const MAX_PARTS_DESK = 300;      // ~300 MB waiting per desk at most
const MAX_FILES = 30;
const MAX_DROPS = 20;
const TTL = 24 * 3600 * 1000;    // delete after 24 h
const STALE_UPLOAD = 3600 * 1000;
const LINK_EXP = [3600, 86400, 7 * 86400];     // 1 hour, 1 day, 7 days
const LINK_PARTS = 110;                        // ~100 MB per link
const LINK_STORE = 350 * 1024 * 1024;          // all live links together (free database is 500 MB)
const DAY_LINKS = 30, DAY_BYTES = 300 * 1024 * 1024;   // per person per day
const PIN_TRIES = 5, REPORTS_BLOCK = 3;

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const rid = n => { const a = 'abcdefghijkmnpqrstuvwxyz23456789'; return [...crypto.getRandomValues(new Uint8Array(n))].map(x => a[x % a.length]).join(''); };
const b64u = b => { let s = ''; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const sum = a => a.reduce((x, y) => x + y, 0);

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS desks(code TEXT PRIMARY KEY, tok TEXT, pub TEXT, name TEXT, mode TEXT, at INTEGER)',
  'CREATE TABLE IF NOT EXISTS drops(id TEXT PRIMARY KEY, code TEXT, epk TEXT, meta TEXT, parts TEXT, done INTEGER, at INTEGER)',
  'CREATE INDEX IF NOT EXISTS drops_code ON drops(code)',
  'CREATE TABLE IF NOT EXISTS chunks(drop_id TEXT, n INTEGER, k INTEGER, data BLOB, PRIMARY KEY(drop_id,n,k))',
  'CREATE TABLE IF NOT EXISTS subs(endpoint TEXT PRIMARY KEY, code TEXT, at INTEGER)',
  // sender-initiated links: encrypted in the browser, key stays in the link (#fragment) — never sent here
  'CREATE TABLE IF NOT EXISTS links(id TEXT PRIMARY KEY, up TEXT, parts TEXT, total INTEGER, manifest TEXT, exp INTEGER, maxdl INTEGER, opens INTEGER, lastopen INTEGER, pin TEXT, tries INTEGER, sub TEXT, lang TEXT, reports INTEGER, ready INTEGER, at INTEGER)',
  'CREATE TABLE IF NOT EXISTS lchunks(id TEXT, n INTEGER, k INTEGER, data BLOB, PRIMARY KEY(id,n,k))',
  'CREATE TABLE IF NOT EXISTS ltok(tok TEXT PRIMARY KEY, id TEXT, until INTEGER)',
  'CREATE TABLE IF NOT EXISTS pmsg(ep TEXT PRIMARY KEY, msg TEXT, at INTEGER)',
  'CREATE TABLE IF NOT EXISTS rl(k TEXT PRIMARY KEY, n INTEGER, bytes INTEGER, day TEXT)',
  'CREATE INDEX IF NOT EXISTS subs_code ON subs(code)',
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map(q => env.DB.prepare(q)));
  try { await env.DB.prepare('ALTER TABLE desks ADD COLUMN pref TEXT').run(); } catch (e) { /* already there */ }
  schemaReady = true;
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try { await ensureSchema(env); return await route(req, env, ctx); }
    catch (e) { return json({ error: String(e && e.message || e) }, 500); }
  },
  async scheduled(_ev, env, ctx) { ctx.waitUntil((async () => { await ensureSchema(env); await cleanup(env); })()); },
};

async function owner(req, env, code) {
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/, '');
  if (tok.length < 20) return null;
  const d = await env.DB.prepare('SELECT tok FROM desks WHERE code=?').bind(code).first();
  return d && d.tok === await sha(tok) ? d : null;
}

async function route(req, env, ctx) {
  const p = new URL(req.url).pathname.split('/').filter(Boolean);
  if (p[0] === 'vapid') return json({ key: env.VAPID_PUBLIC });
  if (p[0] === 'health') return json({ ok: true });
  // Maker contact: redirects to WhatsApp so the number is never in the site's code.
  // Set with: npx wrangler secret put CONTACT_WA   (digits with country code, e.g. 9198xxxxxxxx)
  if (p[0] === 'contact') {
    const n = String(env.CONTACT_WA || '').replace(/\D/g, '');
    if (!n) return new Response('Contact link not set yet.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return Response.redirect('https://wa.me/' + n + '?text=' + encodeURIComponent('Hello, I found you through Jhatpat (ঝটপট).'), 302);
  }
  if (p[0] === 'l') return links(req, env, ctx, p);
  if (p[0] === 'pm' && /^[0-9a-f]{64}$/.test(p[1] || '')) {      // service worker asks: any message for this phone?
    const m = await env.DB.prepare('SELECT msg FROM pmsg WHERE ep=?').bind(p[1]).first();
    if (m) await env.DB.prepare('DELETE FROM pmsg WHERE ep=?').bind(p[1]).run();
    return json(m ? JSON.parse(m.msg) : {});
  }
  if (p[0] !== 'd' || !/^[a-z0-9]{6}$/.test(p[1] || '')) return json({ error: 'not found' }, 404);
  const code = p[1], act = p[2], M = req.method;

  // Owner device claims / refreshes its desk (first device to register owns the code)
  if (act === 'register' && M === 'POST') {
    const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/, '');
    if (tok.length < 20) return json({ error: 'auth' }, 401);
    const b = await req.json();
    if (!b.pub || !b.pub.x || !b.pub.y) return json({ error: 'bad' }, 400);
    const h = await sha(tok);
    const d = await env.DB.prepare('SELECT tok FROM desks WHERE code=?').bind(code).first();
    if (d && d.tok !== h) return json({ error: 'taken' }, 403);
    await env.DB.prepare('INSERT INTO desks(code,tok,pub,name,mode,at) VALUES(?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET pub=excluded.pub,name=excluded.name,mode=excluded.mode,at=excluded.at')
      .bind(code, h, JSON.stringify({ x: String(b.pub.x), y: String(b.pub.y) }), String(b.name || '').slice(0, 80), b.mode === 'shop' ? 'shop' : 'desk', Date.now()).run();
    return json({ ok: true });
  }

  // Public: visitor fetches the desk's public key to encrypt for it
  if (act === 'key' && M === 'GET') {
    const d = await env.DB.prepare('SELECT pub,name,mode,pref FROM desks WHERE code=?').bind(code).first();
    if (!d) return json({ error: 'none' }, 404);
    return json({ pub: JSON.parse(d.pub), name: d.name, mode: d.mode, pref: d.pref || 'pc' });
  }

  // Owner chooses which of their devices gets files first: 'pc' or 'phone'
  if (act === 'pref' && M === 'POST') {
    if (!await owner(req, env, code)) return json({ error: 'auth' }, 401);
    const b = await req.json();
    const v = b.pref === 'phone' ? 'phone' : 'pc';
    await env.DB.prepare('UPDATE desks SET pref=? WHERE code=?').bind(v, code).run();
    return json({ ok: true, pref: v });
  }

  if (act === 'drops') {
    const id = p[3];
    if (!id && M === 'POST') {                         // visitor opens a drop
      if (!await env.DB.prepare('SELECT code FROM desks WHERE code=?').bind(code).first()) return json({ error: 'none' }, 404);
      const b = await req.json();
      const parts = (Array.isArray(b.files) ? b.files : []).map(x => Math.max(1, Math.floor(+x || 1)));
      if (!b.epk || !b.epk.x || !b.epk.y || typeof b.meta !== 'string' || b.meta.length > 20000 || parts.length > MAX_FILES || sum(parts) > MAX_PARTS_DROP)
        return json({ error: 'limits' }, 413);
      const rows = (await env.DB.prepare('SELECT parts FROM drops WHERE code=?').bind(code).all()).results;
      if (rows.length >= MAX_DROPS || sum(rows.map(r => sum(JSON.parse(r.parts)))) + sum(parts) > MAX_PARTS_DESK) return json({ error: 'full' }, 429);
      const nid = rid(16);
      await env.DB.prepare('INSERT INTO drops(id,code,epk,meta,parts,done,at) VALUES(?,?,?,?,?,0,?)')
        .bind(nid, code, JSON.stringify({ x: String(b.epk.x), y: String(b.epk.y) }), b.meta, JSON.stringify(parts), Date.now()).run();
      return json({ id: nid });
    }
    if (!/^[a-z0-9]{16}$/.test(id || '')) return json({ error: 'bad' }, 400);
    const drop = await env.DB.prepare('SELECT * FROM drops WHERE id=? AND code=?').bind(id, code).first();
    if (!drop) return json({ error: 'none' }, 404);
    const parts = JSON.parse(drop.parts);

    if (p[4] === 'done' && M === 'POST') {             // visitor finished uploading
      if (drop.done) return json({ ok: true });
      const have = await env.DB.prepare('SELECT COUNT(*) AS n FROM chunks WHERE drop_id=?').bind(id).first();
      if (have.n !== sum(parts)) return json({ error: 'incomplete' }, 409);
      await env.DB.prepare('UPDATE drops SET done=1,at=? WHERE id=?').bind(Date.now(), id).run();
      ctx.waitUntil(notify(env, code));
      return json({ ok: true });
    }
    if (p.length === 6) {
      const n = +p[4], k = +p[5];
      if (!(Number.isInteger(n) && Number.isInteger(k) && n >= 0 && n < parts.length && k >= 0 && k < parts[n])) return json({ error: 'range' }, 400);
      if (M === 'PUT') {                               // visitor uploads one encrypted chunk
        if (drop.done) return json({ error: 'closed' }, 409);
        const buf = await req.arrayBuffer();
        if (buf.byteLength > MAX_PART) return json({ error: 'big' }, 413);
        await env.DB.prepare('INSERT OR REPLACE INTO chunks(drop_id,n,k,data) VALUES(?,?,?,?)').bind(id, n, k, buf).run();
        return json({ ok: true });
      }
      if (M === 'GET') {                               // owner downloads one chunk
        if (!await owner(req, env, code)) return json({ error: 'auth' }, 401);
        const c = await env.DB.prepare('SELECT data FROM chunks WHERE drop_id=? AND n=? AND k=?').bind(id, n, k).first();
        if (!c) return json({ error: 'none' }, 404);
        return new Response(new Uint8Array(c.data), { headers: { ...CORS, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
      }
    }
    if (p.length === 4 && M === 'DELETE') {            // owner got it: delete now
      if (!await owner(req, env, code)) return json({ error: 'auth' }, 401);
      await delDrop(env, id);
      return json({ ok: true });
    }
    return json({ error: 'bad' }, 400);
  }

  if (act === 'inbox' && M === 'GET') {
    if (!await owner(req, env, code)) return json({ error: 'auth' }, 401);
    const r = await env.DB.prepare('SELECT id,epk,meta,parts,at FROM drops WHERE code=? AND done=1 ORDER BY at').bind(code).all();
    return json(r.results.map(x => ({ id: x.id, epk: JSON.parse(x.epk), meta: x.meta, parts: JSON.parse(x.parts), at: x.at })));
  }

  if (act === 'sub' && (M === 'POST' || M === 'DELETE')) {
    if (!await owner(req, env, code)) return json({ error: 'auth' }, 401);
    const b = await req.json();
    if (!b.endpoint || !/^https:\/\//.test(b.endpoint) || b.endpoint.length > 1000) return json({ error: 'bad' }, 400);
    if (M === 'POST') await env.DB.prepare('INSERT OR REPLACE INTO subs(endpoint,code,at) VALUES(?,?,?)').bind(b.endpoint, code, Date.now()).run();
    else await env.DB.prepare('DELETE FROM subs WHERE endpoint=? AND code=?').bind(b.endpoint, code).run();
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

// ================= sender-initiated links =================
async function links(req, env, ctx, p) {
  const M = req.method, now = Date.now(), id = p[1];
  const bearer = () => (req.headers.get('Authorization') || '').replace(/^Bearer\s+/, '');
  if (!id && M === 'POST') {                                       // create
    const b = await req.json();
    const parts = (Array.isArray(b.parts) ? b.parts : []).map(x => Math.max(1, Math.floor(+x || 1)));
    const total = Math.max(0, Math.floor(+b.total || 0));
    if (parts.length > MAX_FILES || sum(parts) > LINK_PARTS || typeof b.manifest !== 'string' || b.manifest.length > 60000)
      return json({ error: 'limits' }, 413);
    const exp = LINK_EXP.includes(+b.exp) ? +b.exp : 86400;
    // per-person daily limit (IP is hashed with a server secret and kept for one day only)
    const day = new Date().toISOString().slice(0, 10);
    const who = await sha((req.headers.get('CF-Connecting-IP') || 'x') + '|' + day + '|' + (env.VAPID_PRIVATE_JWK || '').slice(-24));
    const r = await env.DB.prepare('SELECT n,bytes FROM rl WHERE k=?').bind(who).first();
    if (r && (r.n >= DAY_LINKS || r.bytes + total > DAY_BYTES)) return json({ error: 'daily' }, 429);
    const used = await env.DB.prepare('SELECT COALESCE(SUM(total),0) AS t FROM links').first();
    if (used.t + total > LINK_STORE) return json({ error: 'store' }, 507);
    const nid = rid(12), up = rid(24);
    const pin = /^\d{4,8}$/.test(String(b.pin || '')) ? await sha(nid + '|' + b.pin) : null;
    const sub = typeof b.sub === 'string' && /^https:\/\//.test(b.sub) && b.sub.length < 1000 ? b.sub : null;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO links(id,up,parts,total,manifest,exp,maxdl,opens,lastopen,pin,tries,sub,lang,reports,ready,at) VALUES(?,?,?,?,?,?,?,0,0,?,0,?,?,0,0,?)')
        .bind(nid, await sha(up), JSON.stringify(parts), total, b.manifest, now + exp * 1000, b.maxdl === 1 ? 1 : 0, pin, sub, ['bn', 'hi', 'en'].includes(b.lang) ? b.lang : 'bn', now),
      env.DB.prepare('INSERT INTO rl(k,n,bytes,day) VALUES(?,1,?,?) ON CONFLICT(k) DO UPDATE SET n=n+1,bytes=bytes+excluded.bytes').bind(who, total, day),
    ]);
    return json({ id: nid, up, exp: now + exp * 1000 });
  }
  if (!/^[a-z0-9]{12}$/.test(id || '')) return json({ error: 'bad' }, 400);
  const L = await env.DB.prepare('SELECT * FROM links WHERE id=?').bind(id).first();
  const gone = !L ? 'none' : L.reports >= REPORTS_BLOCK ? 'blocked' : L.exp < now ? 'expired' : (L.maxdl && L.opens >= L.maxdl) ? 'used' : !L.ready ? 'notready' : '';
  const parts = L ? JSON.parse(L.parts) : [];
  const act = p[2];

  if (!act && M === 'GET')                                          // what is this link?
    return json({ gone, pin: !!(L && L.pin), exp: L ? L.exp : 0, total: L ? L.total : 0, files: parts.length, once: !!(L && L.maxdl) });

  if (L && !L.ready && L.up === await sha(bearer())) {              // sender uploading
    if (p.length === 4 && M === 'PUT') {
      const n = +p[2], k = +p[3];
      if (!(Number.isInteger(n) && Number.isInteger(k) && n >= 0 && n < parts.length && k >= 0 && k < parts[n])) return json({ error: 'range' }, 400);
      const buf = await req.arrayBuffer();
      if (buf.byteLength > MAX_PART) return json({ error: 'big' }, 413);
      await env.DB.prepare('INSERT OR REPLACE INTO lchunks(id,n,k,data) VALUES(?,?,?,?)').bind(id, n, k, buf).run();
      return json({ ok: true });
    }
    if (act === 'done' && M === 'POST') {
      const have = await env.DB.prepare('SELECT COUNT(*) AS n FROM lchunks WHERE id=?').bind(id).first();
      if (have.n !== sum(parts)) return json({ error: 'incomplete' }, 409);
      await env.DB.prepare('UPDATE links SET ready=1 WHERE id=?').bind(id).run();
      return json({ ok: true });
    }
  }
  if (act === 'open' && M === 'POST') {                             // receiver opens (PIN checked here, tries limited)
    if (gone) return json({ error: gone }, 410);
    const b = await req.json().catch(() => ({}));
    if (L.pin && L.pin !== await sha(id + '|' + String(b.pin || ''))) {
      const left = PIN_TRIES - L.tries - 1;
      if (left <= 0) { await delLink(env, id); return json({ error: 'locked' }, 410); }
      await env.DB.prepare('UPDATE links SET tries=tries+1 WHERE id=?').bind(id).run();
      return json({ error: 'pin', left }, 403);
    }
    const tok = rid(24);
    await env.DB.batch([
      env.DB.prepare('UPDATE links SET opens=opens+1,lastopen=?,tries=0 WHERE id=?').bind(now, id),
      env.DB.prepare('INSERT INTO ltok(tok,id,until) VALUES(?,?,?)').bind(await sha(tok), id, now + 3 * 3600 * 1000),
    ]);
    if (L.sub && !L.opens) ctx.waitUntil(pushMsg(env, L.sub, { k: 'opened', n: parts.length, lang: L.lang }));
    return json({ manifest: L.manifest, parts, tok, exp: L.exp, once: !!L.maxdl });
  }
  if (p.length === 4 && M === 'GET') {                              // receiver downloads one encrypted chunk
    const t = await env.DB.prepare('SELECT until FROM ltok WHERE tok=? AND id=?').bind(await sha(new URL(req.url).searchParams.get('t') || ''), id).first();
    if (!L || !t || t.until < now || L.reports >= REPORTS_BLOCK) return json({ error: 'auth' }, 401);
    const c = await env.DB.prepare('SELECT data FROM lchunks WHERE id=? AND n=? AND k=?').bind(id, +p[2], +p[3]).first();
    if (!c) return json({ error: 'none' }, 404);
    return new Response(new Uint8Array(c.data), { headers: { ...CORS, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
  }
  if (act === 'report' && M === 'POST') {
    if (!L) return json({ ok: true });
    await env.DB.prepare('UPDATE links SET reports=reports+1 WHERE id=?').bind(id).run();
    if (L.reports + 1 >= REPORTS_BLOCK) await env.DB.prepare('DELETE FROM lchunks WHERE id=?').bind(id).run();
    return json({ ok: true });
  }
  if (act === 'del' && M === 'POST' && L && L.up === await sha(bearer())) { await delLink(env, id); return json({ ok: true }); }
  return json({ error: 'bad' }, 400);
}
async function delLink(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM lchunks WHERE id=?').bind(id),
    env.DB.prepare('DELETE FROM ltok WHERE id=?').bind(id),
    env.DB.prepare('DELETE FROM links WHERE id=?').bind(id),
  ]);
}
async function pushMsg(env, endpoint, msg) {
  await env.DB.prepare('INSERT OR REPLACE INTO pmsg(ep,msg,at) VALUES(?,?,?)').bind(await sha(endpoint), JSON.stringify(msg), Date.now()).run();
  try { await fetch(endpoint, { method: 'POST', headers: { Authorization: await vapidHeader(env, endpoint), TTL: '86400', Urgency: 'high', 'Content-Length': '0' } }); } catch (e) { }
}

async function delDrop(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chunks WHERE drop_id=?').bind(id),
    env.DB.prepare('DELETE FROM drops WHERE id=?').bind(id),
  ]);
}

async function cleanup(env) {
  const now = Date.now();
  const r = await env.DB.prepare('SELECT id FROM drops WHERE at<? OR (done=0 AND at<?)').bind(now - TTL, now - STALE_UPLOAD).all();
  for (const x of r.results) await delDrop(env, x.id);
  const l = await env.DB.prepare('SELECT id FROM links WHERE exp<? OR (ready=0 AND at<?) OR (maxdl>0 AND opens>=maxdl AND lastopen<?) OR reports>=?')
    .bind(now, now - STALE_UPLOAD, now - 3 * 3600 * 1000, REPORTS_BLOCK).all();
  for (const x of l.results) await delLink(env, x.id);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ltok WHERE until<?').bind(now),
    env.DB.prepare('DELETE FROM pmsg WHERE at<?').bind(now - 86400 * 1000),
    env.DB.prepare('DELETE FROM rl WHERE day<>?').bind(new Date().toISOString().slice(0, 10)),
  ]);
}

// ---- Web Push (RFC 8030/8292): payload-less "tickle"; the service worker shows the alert
async function vapidHeader(env, endpoint) {
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUB })));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${env.VAPID_PUBLIC}`;
}
async function notify(env, code) {
  const subs = (await env.DB.prepare('SELECT endpoint FROM subs WHERE code=?').bind(code).all()).results;
  await Promise.all(subs.map(async s => {
    try {
      const res = await fetch(s.endpoint, { method: 'POST', headers: { Authorization: await vapidHeader(env, s.endpoint), TTL: '86400', Urgency: 'high', 'Content-Length': '0' } });
      if (res.status === 404 || res.status === 410) await env.DB.prepare('DELETE FROM subs WHERE endpoint=?').bind(s.endpoint).run();
    } catch (e) { /* try next time */ }
  }));
}
