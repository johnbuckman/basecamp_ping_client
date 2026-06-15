// Basecamp Pings — native wrapper (Electron), OAuth2 edition.
// No `basecamp` CLI dependency: authenticates directly via 37signals Launchpad
// OAuth2 and calls the Basecamp API itself. Account is discovered (not hardcoded)
// from /authorization.json. Right pane still embeds the real Basecamp chat in a
// <webview> (sharing the same login session).

const { app, BrowserWindow, ipcMain, session, shell, Notification, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const LAUNCHPAD = 'https://launchpad.37signals.com';
const API_ROOT = 'https://3.basecampapi.com';
const DEFAULT_REDIRECT = 'http://localhost:8089/oauth/callback';
// OAuth credentials are NOT baked into the binary — each user registers their
// own free 37signals Launchpad integration and enters its Client ID + Secret
// on the setup screen (or via the ⚙ button to re-edit later). Stored at
// userData/config.json on their own machine, never in source control.
const UA = 'Basecamp Pings Native (https://decentespresso.com)';
const PARTITION = 'persist:basecamp';   // shared by the auth window and the chat webview → one login
const READ_PAGES = 6;

let CFG_PATH, TOK_PATH;
let config = {};   // { clientId, clientSecret, redirectUri, accountId, appHref }
let tokens = {};   // { access_token, refresh_token, expires_at }
let identityCache = null;
let mainWin = null;

const readJSON = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; } };
const writeJSON = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2));

const redirectUri = () => config.redirectUri || DEFAULT_REDIRECT;
const haveCreds = () => !!(config.clientId && config.clientSecret);
const tokenValid = () => !!(tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000);

// ---- OAuth2 ----
function saveTokens(j) {
  if (!j || !j.access_token) throw new Error('no access_token in response');
  tokens = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + ((j.expires_in || 1209600) * 1000),
  };
  writeJSON(TOK_PATH, tokens);
}
async function exchangeCode(code) {
  const url = `${LAUNCHPAD}/authorization/token?grant_type=authorization_code`
    + `&client_id=${encodeURIComponent(config.clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri())}`
    + `&client_secret=${encodeURIComponent(config.clientSecret)}`
    + `&code=${encodeURIComponent(code)}`;
  const r = await fetch(url, { method: 'POST', headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('token exchange failed (HTTP ' + r.status + ')');
  saveTokens(await r.json());
}
async function refreshTokens() {
  if (!tokens.refresh_token) throw new Error('not authorized');
  const url = `${LAUNCHPAD}/authorization/token?grant_type=refresh_token`
    + `&refresh_token=${encodeURIComponent(tokens.refresh_token)}`
    + `&client_id=${encodeURIComponent(config.clientId)}`
    + `&client_secret=${encodeURIComponent(config.clientSecret)}`;
  const r = await fetch(url, { method: 'POST', headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('token refresh failed (HTTP ' + r.status + ')');
  saveTokens(await r.json());
}
async function validToken() {
  if (tokenValid()) return tokens.access_token;
  await refreshTokens();
  return tokens.access_token;
}
// Interactive auth: open Launchpad in the SYSTEM browser (so passkeys + an
// existing Basecamp session work) and receive the redirect on an embedded
// loopback HTTP server. RFC 8252 — recommended pattern for native apps.
let activeAuth = null;   // { cancel } — lets the renderer abort an in-flight sign-in

async function authInteractive() {
  if (activeAuth) { try { activeAuth.cancel(); } catch (e) {} activeAuth = null; }

  const ru = redirectUri();
  let port = 8089, cbPath = '/oauth/callback';
  try { const u = new URL(ru); if (u.port) port = parseInt(u.port, 10); cbPath = u.pathname || cbPath; } catch (e) {}

  let server, timer, externalReject;
  const codePromise = new Promise((resolve, reject) => {
    externalReject = reject;
    server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (u.pathname !== cbPath) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      const code = u.searchParams.get('code');
      const errParam = u.searchParams.get('error');
      const ok = !errParam && !!code;
      const body = '<!doctype html><meta charset="utf-8"><title>bping</title>'
        + '<style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f5f3;color:#2b2926}'
        + '.b{text-align:center;padding:28px 36px;background:#fff;border:1px solid #e3e1dd;border-radius:14px;max-width:360px}'
        + 'h2{margin:0 0 6px}.s{color:#1b8a5a}.e{color:#b3261e}p{margin:8px 0 0;color:#6b6862}</style>'
        + '<div class="b">'
        + (ok
            ? '<h2 class="s">✓ Sign-in complete</h2><p>You can close this tab and return to bping.</p>'
            : '<h2 class="e">Sign-in failed</h2><p>' + (errParam || 'no code received') + '</p>')
        + '</div>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body);
      if (ok) resolve(code); else reject(new Error(errParam || 'no code received'));
    });
    server.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE') reject(new Error(`Port ${port} is in use — close whatever is using it and try Connect again.`));
      else reject(e);
    });
    server.listen(port, '127.0.0.1');
    timer = setTimeout(() => reject(new Error('Sign-in timed out. Click Connect to try again.')), 10 * 60 * 1000);
  });

  activeAuth = {
    cancel: () => {
      try { clearTimeout(timer); } catch (e) {}
      try { server.close(); } catch (e) {}
      externalReject(new Error('Sign-in cancelled.'));
    },
  };

  const authUrl = `${LAUNCHPAD}/authorization/new?response_type=code`
    + `&client_id=${encodeURIComponent(config.clientId)}&redirect_uri=${encodeURIComponent(ru)}`;
  try { await shell.openExternal(authUrl); }
  catch (e) { externalReject(new Error('Could not open your default browser: ' + e.message)); }

  try {
    const code = await codePromise;
    await exchangeCode(code);
  } finally {
    try { clearTimeout(timer); } catch (e) {}
    try { server && server.close(); } catch (e) {}
    activeAuth = null;
  }
}

// ---- API ----
async function bearerFetch(absUrl) {
  const token = await validToken();
  const opts = () => ({ headers: { Authorization: 'Bearer ' + tokens.access_token, 'User-Agent': UA, Accept: 'application/json' } });
  let r = await fetch(absUrl, opts());
  if (r.status === 401) { await refreshTokens(); r = await fetch(absUrl, opts()); }
  if (!r.ok) throw new Error('API HTTP ' + r.status);
  return r.json();
}
const api = p => bearerFetch(`${API_ROOT}/${config.accountId}${p}`);

// Generic bearer-auth fetch with method + optional JSON body. Used for
// POST/PUT/DELETE — returns the raw Response so callers can inspect status.
async function bearerSend(absUrl, method, body) {
  await validToken();
  const headers = {
    Authorization: 'Bearer ' + tokens.access_token,
    'User-Agent': UA,
    Accept: 'application/json',
  };
  const opts = { method, headers };
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let r = await fetch(absUrl, opts);
  if (r.status === 401) {
    await refreshTokens();
    headers.Authorization = 'Bearer ' + tokens.access_token;
    r = await fetch(absUrl, opts);
  }
  return r;
}
const apiSend = (p, method, body) => bearerSend(`${API_ROOT}/${config.accountId}${p}`, method, body);

// --- Bookmarks / forward helpers ----------------------------------------
// Basecamp's OAuth API DOES NOT expose `/my/bookmarks.json` (returns null even
// when the user has bookmarks made via the web UI). But every recording carries
// a per-recording `bookmark_url` of the form
// `/my/bookmarks/<signed-token>.json` which returns `{"bookmarked": true|false}`
// for the calling user. DELETE on that same URL removes the bookmark. We
// discover the user's bookmarks by scanning the chat's recent lines and
// inspecting each line's bookmark_url.
//
// Trade-off: there's no `bookmarked_at` timestamp anywhere, so we can't filter
// by "bookmarked in the past 30 minutes" as originally spec'd. We surface ALL
// currently-bookmarked lines in the chat — the auto-DELETE after a successful
// forward keeps stale bookmarks from accumulating.
async function fetchChatBookmarks(bucket, chat) {
  // Scan the chat's recent lines (up to ~4 pages = newest ~100-150 lines).
  // /lines.json doesn't honor per_page; we just walk pages 1..N.
  const PAGES = 4;
  const byId = new Map();
  for (let page = 1; page <= PAGES; page++) {
    let lines;
    try {
      lines = await api(`/buckets/${bucket}/chats/${chat}/lines.json` + (page > 1 ? `?page=${page}` : ''));
    } catch (e) { break; }
    if (!Array.isArray(lines) || !lines.length) break;
    for (const l of lines) if (!byId.has(l.id)) byId.set(l.id, l);
    if (lines.length < 10) break;
  }
  const lines = [...byId.values()];

  // Probe each line's bookmark_url in parallel (concurrency capped to stay
  // well under Basecamp's 50 req / 10 s rate limit).
  const CONCURRENCY = 8;
  const bookmarked = [];
  let i = 0;
  async function worker() {
    while (i < lines.length) {
      const l = lines[i++];
      if (!l || !l.bookmark_url) continue;
      try {
        const r = await bearerSend(l.bookmark_url, 'GET');
        if (!r.ok) continue;
        const j = await r.json();
        if (j && j.bookmarked === true) bookmarked.push(l);
      } catch (e) { /* skip on transient error */ }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Annotate creator with profile URL the forwarded-message recipient can click
  // to start a ping with the original author.
  const base = (config.appHref || `https://3.basecamp.com/${config.accountId}`).replace(/\/$/, '');
  for (const l of bookmarked) {
    const c = l.creator;
    if (c && c.id) c.profile_url = `${base}/people/${c.id}`;
  }
  // Oldest-first so the forwarded thread reads chronologically.
  bookmarked.sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0));
  return bookmarked;
}

// DELETE the bookmark via the line's bookmark_url (verified to work; returns 204).
async function unbookmarkUrl(bookmarkUrl) {
  if (!bookmarkUrl || !/^https:\/\/[^/]+\.basecampapi\.com\//.test(bookmarkUrl)) return false;
  try {
    const r = await bearerSend(bookmarkUrl, 'DELETE');
    return r.ok || r.status === 204;
  } catch (e) { return false; }
}

// Fetch a Basecamp attachment as raw bytes + content type. Used by the Copy
// feature to re-upload each attachment as a fresh Basecamp Upload resource,
// whose attachable_sgid can then be embedded as <bc-attachment> in the
// clipboard HTML (Basecamp's docs/comments render that inline with previews).
//
// Follows redirects manually because the bearer token MUST be dropped on the
// `*.basecampapi.com` → `storage.basecamp.com` hop (S3 returns
// `objectNameNotDecodedYet` if we forward the bearer). The Location string is
// used as-is — running it through `new URL().toString()` re-encodes the
// signed-URL query and breaks the signature.
async function fetchAttachmentBytes(url, maxBytes) {
  const allowed = /^https:\/\/([a-z0-9-]+\.basecampapi\.com|[a-z0-9-]+\.basecamp-static\.com|preview\.app\.basecamp\.com|storage\.basecamp\.com)\//i;
  if (!allowed.test(url)) return null;
  await validToken();
  async function attempt() {
    let current = url;
    for (let hops = 0; hops < 4; hops++) {
      const isApi = /^https:\/\/[a-z0-9-]+\.basecampapi\.com\//i.test(current);
      const headers = { 'User-Agent': UA };
      if (isApi) headers.Authorization = 'Bearer ' + tokens.access_token;
      const r = await fetch(current, { method: 'GET', headers, redirect: 'manual' });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) return null;
        current = loc;        // raw string — don't re-parse, would break the S3 signature
        continue;
      }
      return r;
    }
    return null;
  }
  let r = await attempt();
  if (r && r.status === 401) { await refreshTokens(); r = await attempt(); }
  if (!r || !r.ok) return null;
  const cl = parseInt(r.headers.get('content-length') || '0', 10);
  if (maxBytes && cl && cl > maxBytes) return null;
  const ab = await r.arrayBuffer();
  const buf = Buffer.from(ab);
  if (maxBytes && buf.length > maxBytes) return null;
  const mime = (r.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  return { buffer: buf, mime, bytes: buf.length };
}

// POST raw bytes to /attachments.json — Basecamp creates a fresh Attachment
// resource and returns its attachable_sgid, which is the value we need for
// <bc-attachment sgid="..."> in document/comment HTML.
async function uploadAttachmentBytes(buffer, mime, filename) {
  await validToken();
  const url = `${API_ROOT}/${config.accountId}/attachments.json?name=${encodeURIComponent(filename)}`;
  const headers = {
    Authorization: 'Bearer ' + tokens.access_token,
    'User-Agent': UA,
    'Content-Type': mime || 'application/octet-stream',
    'Content-Length': String(buffer.length),
    Accept: 'application/json',
  };
  let r = await fetch(url, { method: 'POST', headers, body: buffer });
  if (r.status === 401) {
    await refreshTokens();
    headers.Authorization = 'Bearer ' + tokens.access_token;
    r = await fetch(url, { method: 'POST', headers, body: buffer });
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('attachment upload HTTP ' + r.status + (txt ? ' — ' + txt.slice(0, 200) : ''));
  }
  const j = await r.json();
  return j && j.attachable_sgid ? j.attachable_sgid : null;
}

// Download a chat-line attachment from `downloadUrl`, re-upload it as a fresh
// Basecamp Attachment, return the new attachable_sgid (or null on failure).
async function reuploadAttachment(downloadUrl, filename, fallbackMime, maxBytes) {
  const got = await fetchAttachmentBytes(downloadUrl, maxBytes);
  if (!got) return null;
  return await uploadAttachmentBytes(got.buffer, got.mime || fallbackMime, filename || 'attachment');
}

async function sendChatLine(bucket, chat, html) {
  const r = await apiSend(`/buckets/${bucket}/chats/${chat}/lines.json`,
    'POST', { content: html, content_type: 'text/html' });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('send line HTTP ' + r.status + (txt ? ' — ' + txt.slice(0, 200) : ''));
  }
  try { return await r.json(); } catch (e) { return {}; }
}

// Full account roster — for the recipient filter. Cached ~25 min.
let peopleCache = { at: 0, list: [] };
async function fetchAllPeople() {
  if (peopleCache.list.length && Date.now() - peopleCache.at < 25 * 60 * 1000) return peopleCache.list;
  const out = [];
  for (let page = 1; page <= 10; page++) {
    let p; try { p = await api(`/people.json?page=${page}`); } catch (e) { break; }
    if (!Array.isArray(p) || !p.length) break;
    for (const x of p) if (x.can_ping) out.push({ id: x.id, name: x.name, avatar: x.avatar_url });
    if (p.length < 50) break;
  }
  peopleCache = { at: Date.now(), list: out };
  return out;
}

async function listAccounts() {
  const j = await bearerFetch(`${LAUNCHPAD}/authorization.json`);
  identityCache = j.identity || null;
  const accounts = (j.accounts || [])
    .filter(a => a.product === 'bc3')
    .map(a => ({ id: a.id, name: a.name, href: a.href, appHref: a.app_href }));
  return { identity: identityCache, accounts };
}

// ---- Pings (same shape as before, now via direct API) ----
let me = null;
async function getMe() {
  if (me) return me;
  const p = await api('/my/profile.json');
  me = { id: p.id, name: p.name, avatar_url: p.avatar_url };
  return me;
}
function idsFromReading(item) {
  const m = (item.subscription_url || item.unread_url || '').match(/buckets\/(\d+)\/recordings\/(\d+)/);
  return m ? { bucket: m[1], chat: m[2] } : null;
}
function personName(item, meId) {
  const others = (item.participants || []).filter(p => p.id !== meId);
  return others.length ? others.map(p => p.name).join(', ')
    : (item.creator && item.creator.name) || item.bucket_name || 'Ping';
}
function personAvatar(item, meId) {
  const others = (item.participants || []).filter(p => p.id !== meId);
  return (others.length && others[0].avatar_url) || (item.creator && item.creator.avatar_url) || '';
}
async function buildPings(light) {
  const m = await getMe();
  const convos = new Map();
  const add = (item, fromUnread) => {
    if (item.section !== 'pings') return;
    const ids = idsFromReading(item); if (!ids) return;
    const unreadCount = item.unread_count || 0;
    const unread = fromUnread || unreadCount > 0;
    const lastDate = item.updated_at || item.created_at;
    const prev = convos.get(ids.chat);
    if (prev && new Date(prev.lastDate) >= new Date(lastDate) && prev.unread >= unread) return;
    convos.set(ids.chat, {
      bucket: ids.bucket, chat: ids.chat, name: personName(item, m.id), avatar: personAvatar(item, m.id),
      excerpt: item.content_excerpt || '', appUrl: item.app_url || '', unread, unreadCount, lastDate,
    });
  };
  const first = await api('/my/readings.json');
  (first.unreads || []).forEach(i => add(i, true));
  (first.reads || []).forEach(i => add(i, false));
  for (let page = 2; page <= READ_PAGES; page++) {
    let r; try { r = await api(`/my/readings.json?page=${page}`); } catch (e) { break; }
    const reads = r.reads || []; reads.forEach(i => add(i, false));
    if (reads.length < 50) break;
  }
  const list = [...convos.values()];
  // /my/readings.json only reflects RECEIVED pings, so a ping you SENT does not
  // bubble the conversation up. Correct each conversation's recency (and excerpt)
  // from its latest line, which includes your own sent messages. Capped + parallel.
  // Skipped in "light" mode (used for fast background polling — saves N requests).
  if (!light) await Promise.all(list.slice(0, 50).map(async c => {
    try {
      const lines = await api(`/buckets/${c.bucket}/chats/${c.chat}/lines.json`);
      const newest = Array.isArray(lines) && lines.length ? lines[0] : null;
      if (newest && newest.created_at) {
        if (new Date(newest.created_at) > new Date(c.lastDate)) c.lastDate = newest.created_at;
        const txt = (newest.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (txt) c.excerpt = txt;
        c.lastMine = !!(newest.creator && newest.creator.id === m.id);   // did *I* send the latest line?
        if (c.lastMine) c.excerpt = 'You: ' + c.excerpt;
      }
    } catch (e) { /* keep the readings values on error */ }
  }));
  const byDate = (a, b) => new Date(b.lastDate) - new Date(a.lastDate);
  return { me: m, people: [...list.filter(c => c.unread).sort(byDate), ...list.filter(c => !c.unread).sort(byDate)] };
}

// ---- IPC ----
ipcMain.handle('state:get', () => ({
  configured: haveCreds(),
  authed: !!tokens.access_token,
  accountId: config.accountId || null,
  appHref: config.appHref || null,
  clientId: config.clientId || '',
  hasSecret: !!config.clientSecret,    // lets the settings UI hint "(unchanged)" instead of revealing the secret
  redirectUri: redirectUri(),
  defaultRedirect: DEFAULT_REDIRECT,
}));
ipcMain.handle('creds:save', async (_e, c) => {
  const newClientId  = (c && c.clientId || '').trim();
  const newSecret    = (c && c.clientSecret || '').trim();
  const newRedirect  = (c && c.redirectUri || '').trim() || DEFAULT_REDIRECT;
  if (!newClientId) return { error: 'Client ID is required' };
  // Blank secret in EDIT mode → keep the existing one. In INITIAL setup mode
  // (no secret saved yet), the renderer enforces non-blank before calling us.
  if (!newSecret && !config.clientSecret) return { error: 'Client Secret is required' };
  const credsChanged =
    config.clientId !== newClientId ||
    (newSecret && config.clientSecret !== newSecret) ||
    config.redirectUri !== newRedirect;
  config.clientId = newClientId;
  if (newSecret) config.clientSecret = newSecret;
  config.redirectUri = newRedirect;
  writeJSON(CFG_PATH, config);
  // Any change to clientId/secret/redirect invalidates the current token —
  // it was issued by a different OAuth integration (or with a different
  // redirect URI). Clear tokens and force re-auth on the next state:get.
  if (credsChanged) {
    tokens = {};
    try { fs.unlinkSync(TOK_PATH); } catch (e) {}
    me = null; identityCache = null;
    peopleCache = { at: 0, list: [] };
  }
  return { ok: true, credsChanged };
});
ipcMain.handle('auth:start', async () => {
  try { await authInteractive(); return await listAccounts(); }
  catch (e) { return { error: e.message }; }
});
ipcMain.handle('auth:cancel', () => {
  if (activeAuth) { try { activeAuth.cancel(); } catch (e) {} activeAuth = null; }
  return { ok: true };
});
// Native macOS notification for a new incoming ping. Clicking it focuses the
// app and tells the renderer which conversation to open.
ipcMain.handle('notify:show', (_e, opts) => {
  try {
    if (!Notification.isSupported()) return { ok: false };
    const n = new Notification({
      title: (opts && opts.title) || 'bping',
      body: (opts && opts.body) || '',
      silent: false,
    });
    n.on('click', () => {
      try {
        if (mainWin) { mainWin.show(); mainWin.focus(); mainWin.webContents.send('notify-clicked', { chat: opts && opts.chat }); }
      } catch (e) {}
    });
    n.show();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('accounts:list', async () => {
  try { return await listAccounts(); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('account:set', (_e, a) => {
  config.accountId = String(a.id); config.appHref = a.appHref || null;
  writeJSON(CFG_PATH, config); me = null;
  return { ok: true };
});
ipcMain.handle('pings:list', async (_e, opts) => {
  if (!config.accountId) return { error: 'no account selected' };
  try { return await buildPings(opts && opts.light); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('signout', async () => {
  // --- LEFT PANE: clear OAuth + per-account state (API access) ---
  tokens = {};
  try { fs.unlinkSync(TOK_PATH); } catch (e) {}
  config.accountId = null; config.appHref = null;
  try { writeJSON(CFG_PATH, config); } catch (e) {}
  me = null; identityCache = null;
  peopleCache = { at: 0, list: [] };

  // --- RIGHT PANE: wipe everything tied to the Basecamp webview session ---
  // A bare clearStorageData() turned out to leave the user logged in if any
  // Basecamp page was still running (its JS would write cookies back on the
  // next tick). Belt-and-suspenders: clear storage, network cache, HTTP auth
  // cache, AND explicitly enumerate + delete every cookie on Basecamp /
  // 37signals hosts. flushStore() at the end forces the cookie DB to disk
  // so it doesn't get re-read from memory on the next request.
  const sess = session.fromPartition(PARTITION);
  try { await sess.clearStorageData(); } catch (e) {}
  try { await sess.clearCache(); } catch (e) {}
  try { await sess.clearAuthCache(); } catch (e) {}
  // Some cookies (Secure / HttpOnly) need explicit removal — clearStorageData
  // sometimes misses them. Enumerate and DELETE for each Basecamp / Launchpad
  // host.
  for (const domain of [
    'basecamp.com', '.basecamp.com', 'app.basecamp.com', '3.basecamp.com',
    'basecampapi.com', '.basecampapi.com', '3.basecampapi.com',
    'launchpad.37signals.com', '37signals.com', '.37signals.com',
    'preview.app.basecamp.com', 'storage.basecamp.com',
  ]) {
    try {
      const cks = await sess.cookies.get({ domain });
      for (const c of cks) {
        const scheme = c.secure ? 'https' : 'http';
        // cookies.remove expects a full URL where the cookie lives.
        const dom = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
        const url = `${scheme}://${dom}${c.path || '/'}`;
        try { await sess.cookies.remove(url, c.name); } catch (e) {}
      }
    } catch (e) {}
  }
  try { await sess.cookies.flushStore(); } catch (e) {}
  return { ok: true };
});
ipcMain.handle('open-external', (_e, url) => { if (/^https?:\/\//.test(url || '')) shell.openExternal(url); });
ipcMain.handle('app:focused', () => !!(mainWin && mainWin.isFocused()));

// --- Forward feature IPC ----------------------------------------------------
ipcMain.handle('bookmarks:list', async (_e, opts = {}) => {
  if (!config.accountId) return { error: 'no account selected' };
  const { bucket, chat } = opts;
  if (!bucket || !chat) return { error: 'bucket and chat required' };
  try {
    const bookmarks = await fetchChatBookmarks(bucket, chat);
    return { ok: true, bookmarks };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('bookmark:delete', async (_e, opts = {}) => {
  const url = opts && opts.bookmarkUrl;
  try { return { ok: await unbookmarkUrl(url) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('people:list', async () => {
  try { return { ok: true, people: await fetchAllPeople() }; }
  catch (e) { return { error: e.message }; }
});
ipcMain.handle('api:send-line', async (_e, { bucket, chat, html } = {}) => {
  if (!bucket || !chat || !html) return { error: 'missing bucket/chat/html' };
  try { const line = await sendChatLine(bucket, chat, html); return { ok: true, line }; }
  catch (e) { return { error: e.message }; }
});
ipcMain.handle('attachment:reupload', async (_e, { downloadUrl, filename, mime, maxBytes } = {}) => {
  if (!downloadUrl) return { error: 'no downloadUrl' };
  try {
    const sgid = await reuploadAttachment(downloadUrl, filename, mime, maxBytes || 0);
    return sgid ? { ok: true, sgid } : { error: 'fetch or upload failed' };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('attachment:dataUri', async (_e, { url, maxBytes } = {}) => {
  if (!url) return { error: 'no url' };
  try {
    const r = await fetchAttachmentBytes(url, maxBytes || 0);
    if (!r) return { error: 'fetch failed or too large' };
    return { ok: true, mime: r.mime, base64: r.buffer.toString('base64'), bytes: r.bytes };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('clipboard:write', (_e, { text, html } = {}) => {
  try {
    // Electron's clipboard.write puts BOTH plain text and HTML on the clipboard
    // in one shot, so a paste into a rich-text editor (Mail, Basecamp, Notes)
    // keeps formatting + author links, and a paste into a plain editor still
    // gets readable text.
    clipboard.write({ text: text || '', html: html || '' });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- App ----
function stripFraming(sess) {
  sess.webRequest.onHeadersReceived((details, cb) => {
    const h = details.responseHeaders || {};
    for (const k of Object.keys(h)) {
      const lk = k.toLowerCase();
      if (lk === 'x-frame-options') delete h[k];
      else if (lk === 'content-security-policy') h[k] = (Array.isArray(h[k]) ? h[k] : [h[k]]).map(v => v.replace(/frame-ancestors[^;]*;?/gi, ''));
    }
    cb({ responseHeaders: h });
  });
}
// When the user sends a ping in the embedded Basecamp <webview>, we don't run
// that POST ourselves — but it travels through this session's network layer.
// Tap into it and push a 'message-sent' notification to the renderer so the
// pings list refreshes right away (instead of waiting for the next poll).
function watchForSends(sess) {
  sess.webRequest.onCompleted({ urls: ['https://*.basecamp.com/*', 'https://*.basecampapi.com/*'] }, (details) => {
    if (details.method !== 'POST') return;
    if (!/\/chats?\/[^/]+\/lines(\.json)?(\?|$)/.test(details.url)) return;
    const sc = details.statusCode;
    if (sc < 200 || sc >= 400) return;
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('message-sent');
  });
}

function createWindow() {
  stripFraming(session.fromPartition(PARTITION));
  stripFraming(session.defaultSession);
  watchForSends(session.fromPartition(PARTITION));
  mainWin = new BrowserWindow({
    width: 1240, height: 840, title: 'Basecamp Pings — Native',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, webviewTag: true },
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.on('focus', () => mainWin.webContents.send('focus-changed', true));
  mainWin.on('blur', () => mainWin.webContents.send('focus-changed', false));
}

// Links clicked in the chat <webview> open in the system browser — both external
// links and Basecamp links. Opening a ping uses webview.src (a programmatic load),
// which does NOT fire will-navigate, so the selected conversation still loads in
// the pane; only user-clicked links are intercepted here.
//
// EXCEPTION: the login flow MUST stay in the webview, otherwise its session
// cookies land in the wrong place (the system browser instead of
// persist:basecamp). Two parts:
//
//   1) Navigations TO auth hosts (Launchpad, Google, Apple, etc.) — these
//      are the form submits and OAuth steps. Stay in-webview.
//   2) Navigations FROM an auth host TO Basecamp — this is the post-login
//      redirect. Launchpad's "Logging you in…" page does a
//      `window.location = "https://3.basecamp.com/<acct>"` once auth
//      completes; that fires will-navigate with a basecamp.com URL. We
//      need to let it through, otherwise the webview is stuck forever on
//      the loading screen while the real session lands in the system
//      browser instead of persist:basecamp.
//
// Everything else — user-clicked Basecamp/external links in chat content
// once you're already in the app — still gets diverted to the system
// browser, preserving the original UX (the sidebar drives in-pane
// navigation; chat links pop out so they don't blow away the conversation).
const AUTH_HOSTS = /^https:\/\/(launchpad\.37signals\.com|accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com|github\.com)\//i;
const BASECAMP_UI_HOSTS = /^https:\/\/([a-z0-9-]+\.)?basecamp\.com\//i;

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {            // target=_blank / popups
    if (AUTH_HOSTS.test(url)) return { action: 'allow' };  // OAuth popup → stay in-app
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (ev, url) => {             // any user-clicked link / form submit
    if (AUTH_HOSTS.test(url)) return;                     // login flow stays in the webview
    const current = contents.getURL() || '';
    // Post-login redirect from Launchpad's "Logging you in…" → Basecamp app.
    if (AUTH_HOSTS.test(current) && BASECAMP_UI_HOSTS.test(url)) return;
    if (/^https?:\/\//i.test(url)) { ev.preventDefault(); shell.openExternal(url); }
  });
});

app.whenReady().then(() => {
  CFG_PATH = path.join(app.getPath('userData'), 'config.json');
  TOK_PATH = path.join(app.getPath('userData'), 'tokens.json');
  config = readJSON(CFG_PATH);   // { clientId, clientSecret, redirectUri, accountId, appHref }
  tokens = readJSON(TOK_PATH);
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
