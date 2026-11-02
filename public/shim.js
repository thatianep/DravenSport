// Ponte entre a interface do CRM e o servidor próprio da Draven.
// Oferece as mesmas funções que a página usava no claude.ai (banco em tempo real, usuário, IA e downloads).
(() => {
  async function api(url, opt = {}) {
    const r = await fetch(url, { credentials: 'same-origin', method: opt.method || 'GET', headers: opt.body ? { 'content-type': 'application/json' } : {}, body: opt.body ? JSON.stringify(opt.body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401 && !url.startsWith('/api/auth')) { location.href = '/crm'; }
      throw { code: j.code || 'unavailable', message: j.message || 'Não foi possível concluir. Tente de novo.' };
    }
    return j;
  }
  const meP = api('/api/me');

  // ---------- banco em tempo real ----------
  const stores = new Map();
  const st = col => { let s = stores.get(col); if (!s) { s = { docs: new Map(), ready: false, load: null, listeners: new Set() }; stores.set(col, s); } return s; };
  function notify(col) { const s = stores.get(col); if (!s || !s.ready) return; for (const fn of [...s.listeners]) { try { fn(); } catch (e) { console.error(e); } } }
  function load(col) {
    const s = st(col);
    if (!s.load) s.load = api('/api/col?path=' + encodeURIComponent(col)).then(rows => { s.docs.clear(); rows.forEach(r => s.docs.set(r.id, r.data)); s.ready = true; notify(col); }).catch(e => { s.load = null; throw e; });
    return s.load;
  }
  const clone = d => (d == null ? d : JSON.parse(JSON.stringify(d)));
  const snap = (id, data) => ({ id, exists: data != null, data: () => (data == null ? undefined : clone(data)), metadata: { fromCache: false, hasPendingWrites: false } });
  function cmp(a, op, v) {
    switch (op) { case '==': return a === v; case '!=': return a !== v; case '<': return a < v; case '<=': return a <= v; case '>': return a > v; case '>=': return a >= v;
      case 'in': return v.includes(a); case 'not-in': return !v.includes(a); case 'array-contains': return Array.isArray(a) && a.includes(v); }
    return false;
  }
  function query(col, f = [], ob = null, lim = null) {
    const run = () => {
      let arr = [...st(col).docs.entries()].map(([id, d]) => ({ id, d }));
      for (const [k, op, v] of f) arr = arr.filter(x => cmp(x.d[k], op, v));
      if (ob) { const [k, dir] = ob; arr.sort((a, b) => { const x = a.d[k], y = b.d[k]; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1); }); }
      else arr.sort((a, b) => (a.id < b.id ? -1 : 1));
      if (lim) arr = arr.slice(0, lim);
      const docs = arr.map(x => snap(x.id, x.d));
      return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((doc, i) => ({ type: 'added', doc, oldIndex: -1, newIndex: i })), metadata: { fromCache: false, hasPendingWrites: false } };
    };
    return {
      where: (k, op, v) => query(col, [...f, [k, op, v]], ob, lim),
      orderBy: (k, dir = 'asc') => query(col, f, [k, dir], lim),
      limit: n => query(col, f, ob, n),
      get: async () => { await load(col); return run(); },
      onSnapshot(next, error) {
        const s = st(col); const fn = () => next(run()); s.listeners.add(fn);
        if (s.ready) setTimeout(fn, 0); else load(col).catch(e => { error && error(e); });
        return () => s.listeners.delete(fn);
      },
    };
  }
  const rid = () => { const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; return [...crypto.getRandomValues(new Uint8Array(20))].map(x => c[x % 62]).join(''); };
  function docRef(path) {
    const i = path.lastIndexOf('/'); const col = path.slice(0, i), id = path.slice(i + 1);
    const local = data => { const s = stores.get(col); if (s && s.ready) { if (data == null) s.docs.delete(id); else s.docs.set(id, data); notify(col); } };
    return {
      id, path,
      get: async () => { const r = await api('/api/doc?path=' + encodeURIComponent(path)); return snap(id, r.data); },
      set: async data => { const r = await api('/api/doc', { method: 'POST', body: { op: 'set', path, data } }); local(r.data); },
      update: async data => { const r = await api('/api/doc', { method: 'POST', body: { op: 'update', path, data } }); local(r.data); },
      delete: async () => { await api('/api/doc', { method: 'POST', body: { op: 'delete', path } }); local(null); },
      acquire: async o => api('/api/lease', { method: 'POST', body: { path, ...o } }),
      onSnapshot(next, error) {
        const s = st(col); const fn = () => next(snap(id, s.docs.get(id) ?? null)); s.listeners.add(fn);
        if (s.ready) setTimeout(fn, 0); else load(col).catch(e => { error && error(e); });
        return () => s.listeners.delete(fn);
      },
      collection: sub => colRef(path + '/' + sub),
    };
  }
  function colRef(col) { return Object.assign(query(col), { path: col, doc: id => docRef(col + '/' + (id || rid())), add: async d => { const r = docRef(col + '/' + rid()); await r.set(d); return r; } }); }
  const db = { doc: docRef, collection: colRef };

  // atualizações do servidor
  let conectou = false;
  function stream(me) {
    const es = new EventSource('/api/stream');
    es.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'hello') {
        if (conectou) for (const [col, s] of stores) { if (s.listeners.size) { s.load = null; load(col).catch(() => {}); } }
        conectou = true; return;
      }
      if (m.t !== 'doc') return;
      if (m.col === 'equipe' && m.id === me.id && !me.isOwner && (m.data?.papel || null) !== (me.papel || null)) { location.reload(); return; }
      const s = stores.get(m.col);
      if (s && s.ready) { if (m.data == null) s.docs.delete(m.id); else s.docs.set(m.id, m.data); notify(m.col); }
    };
  }

  // ---------- usuário ----------
  const cores = ['#B45309', '#1E3A8A', '#15803D', '#9D174D', '#6D28D9', '#0E7490', '#B91C1C', '#4D7C0F'];
  const cor = id => cores[[...String(id || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % cores.length];
  const avatar = (nome, id) => {
    const ini = String(nome || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase() || '?';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="${cor(id)}"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-weight="700" font-size="26" fill="#fff">${ini.replace(/[<&>]/g, '')}</text></svg>`);
  };
  const perfis = {};
  const user = {
    isOwner: async () => (await meP).isOwner,
    canEdit: async () => { const m = await meP; return m.isOwner || m.papel === 'gestao'; },
    can: async n => { const m = await meP; return n === 'data.write' ? (m.papel ? true : null) : null; },
    me: async () => { const m = await meP; return { id: m.id, name: m.name, email: m.email, isOwner: m.isOwner, canEdit: m.isOwner || m.papel === 'gestao', avatarUrl: avatar(m.name, m.id), color: cor(m.id) }; },
    id: async () => (await meP).id,
    name: async () => (await meP).name,
    email: async () => (await meP).email,
    avatarUrl: async () => { const m = await meP; return avatar(m.name, m.id); },
    profiles: async ids => {
      ids = [...new Set([].concat(ids).filter(Boolean))];
      const falta = ids.filter(i => !(i in perfis));
      if (falta.length) { try { const r = await api('/api/users?ids=' + falta.map(encodeURIComponent).join(',')); falta.forEach(i => (perfis[i] = r[i] || { name: '' })); } catch {} }
      const m = await meP; const o = {};
      ids.forEach(i => { const n = perfis[i]?.name || ''; o[i] = { id: i, name: n, avatarUrl: avatar(n, i), color: cor(i), email: null, isMe: i === m.id, guest: false }; });
      return o;
    },
    search: async () => [],
  };

  // ---------- IA e downloads ----------
  function sample(input, opts = {}) {
    return api('/api/ai', { method: 'POST', body: { input } }).then(r => { opts.onText && opts.onText({ text: r.text, delta: r.text }); return { text: r.text, truncated: false }; });
  }
  sample.json = async (i, o) => { const { text } = await sample(i, o); return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); };
  sample.limits = async () => ({});
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return { status: 'saved' };
    },
  };

  meP.then(m => stream(m)).catch(() => {});
  window.DRAVEN = { api, me: meP };
  window.claude = {
    use: async name => {
      const m = await meP.catch(() => null); if (!m) return null;
      if (name === 'db') return db;
      if (name === 'user') return user;
      if (name === 'sample') return m.ai ? sample : null;
      if (name === 'downloads') return downloads;
      return null;
    },
  };
})();
