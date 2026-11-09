#!/usr/bin/env node
// Send to Laptop v2 - single file, zero dependencies. Run: node server.js
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT = +process.env.PORT || 8080;
const ROOT = path.join(os.homedir(), 'PhoneTransfer');
const BOX = { in: path.join(ROOT, 'From Phone'), out: path.join(ROOT, 'From Laptop') };
Object.values(BOX).forEach((d) => fs.mkdirSync(d, { recursive: true }));

// Access key: phones must scan the QR code once; the key is remembered between runs.
const tokenFile = path.join(ROOT, '.token');
let TOKEN = '';
try { TOKEN = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) { /* first run */ }
if (!TOKEN) { TOKEN = crypto.randomBytes(4).toString('hex'); fs.writeFileSync(tokenFile, TOKEN); }

// Optional HTTPS: put cert.pem and key.pem in the PhoneTransfer folder (e.g. made with mkcert).
const certF = path.join(ROOT, 'cert.pem');
const keyF = path.join(ROOT, 'key.pem');
const SECURE = fs.existsSync(certF) && fs.existsSync(keyF);

const notes = []; // text snippets shared between devices (kept in memory)

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
};

function ips() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal) out.push(i.address);
    }
  }
  return out.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));
}

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const cookieOk = (req) => (req.headers.cookie || '').split(/;\s*/).includes('k=' + TOKEN);

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function send(res, type, body) {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(p) || fs.existsSync(p + '.part')) p = path.join(dir, base + ' (' + i++ + ')' + ext);
  return p;
}

function listFiles() {
  const out = [];
  for (const box of ['in', 'out']) {
    for (const name of fs.readdirSync(BOX[box])) {
      if (name.endsWith('.part')) continue;
      try {
        const st = fs.statSync(path.join(BOX[box], name));
        if (st.isFile()) out.push({ box, name, size: st.size, t: st.mtimeMs });
      } catch (e) { /* file vanished */ }
    }
  }
  return out.sort((a, b) => b.t - a.t);
}

function receive(req, res, url) {
  const box = url.searchParams.get('box') === 'out' ? 'out' : 'in';
  const raw = url.searchParams.get('name') || 'file';
  const name = path.basename(raw).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
  const target = uniquePath(BOX[box], name);
  const tmp = target + '.part';
  const ws = fs.createWriteStream(tmp);
  let finished = false;
  const fail = () => { if (finished) return; finished = true; ws.destroy(); fs.unlink(tmp, () => {}); };
  ws.on('finish', () => {
    if (finished) return;
    finished = true;
    fs.renameSync(tmp, target);
    json(res, 200, { ok: true, name: path.basename(target) });
  });
  ws.on('error', (e) => { fail(); if (!res.headersSent) json(res, 500, { error: e.message }); });
  req.on('close', () => { if (!req.complete) fail(); });
  req.pipe(ws);
}

function serveFile(req, res, box, name, download) {
  const file = path.join(BOX[box], path.basename(name));
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const h = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': (download ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(path.basename(file)),
    };
    if (st.size === 0) { h['Content-Length'] = 0; res.writeHead(200, h); return res.end(); }
    let start = 0, end = st.size - 1, code = 200;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      if (m[1] !== '') { start = +m[1]; if (m[2] !== '') end = Math.min(+m[2], end); }
      else if (m[2] !== '') start = Math.max(0, st.size - +m[2]);
      if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      code = 206;
      h['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    }
    h['Content-Length'] = end - start + 1;
    res.writeHead(code, h);
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const local = isLocal(req);

    if (p === '/manifest.webmanifest') return send(res, 'application/manifest+json', JSON.stringify(MANIFEST));
    if (p === '/sw.js') return send(res, 'text/javascript', SW);
    if (p === '/icon.svg') return send(res, 'image/svg+xml', ICON);

    if (!local) {
      if (req.method === 'GET' && url.searchParams.get('k') === TOKEN) {
        res.writeHead(302, { Location: p, 'Set-Cookie': 'k=' + TOKEN + '; Path=/; Max-Age=31536000; SameSite=Lax' });
        return res.end();
      }
      if (!cookieOk(req)) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:2rem"><h2>Not connected</h2><p>Scan the QR code on the laptop to connect this device.</p>');
      }
    }

    if (req.method === 'GET' && p === '/') return send(res, 'text/html; charset=utf-8', PAGE);

    if (req.method === 'GET' && p === '/api/state') {
      const scheme = SECURE ? 'https' : 'http';
      return json(res, 200, {
        local,
        root: ROOT,
        urls: local ? ips().map((ip) => scheme + '://' + ip + ':' + PORT + '/?k=' + TOKEN) : [],
        files: listFiles(),
        notes,
      });
    }

    if (req.method === 'POST' && p === '/api/upload') return receive(req, res, url);

    if (req.method === 'GET' && p.startsWith('/f/')) {
      const parts = p.split('/');
      const box = parts[2];
      if (!BOX[box]) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, box, decodeURIComponent(parts.slice(3).join('/')), url.searchParams.get('dl') === '1');
    }

    if (req.method === 'DELETE' && p === '/api/file') {
      const box = url.searchParams.get('box');
      if (!BOX[box]) return json(res, 400, { error: 'bad box' });
      fs.unlink(path.join(BOX[box], path.basename(url.searchParams.get('name') || '')), () => json(res, 200, { ok: true }));
      return;
    }

    if (req.method === 'POST' && p === '/api/text') {
      const body = JSON.parse((await readBody(req, 1e6)) || '{}');
      const text = String(body.text || '').slice(0, 20000);
      if (text.trim()) {
        notes.unshift({ id: crypto.randomBytes(4).toString('hex'), text, from: local ? 'laptop' : 'phone', t: Date.now() });
        notes.length = Math.min(notes.length, 30);
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && p === '/api/text') {
      const i = notes.findIndex((n) => n.id === url.searchParams.get('id'));
      if (i >= 0) notes.splice(i, 1);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/open') {
      if (!local) return json(res, 403, { error: 'laptop only' });
      const cmd = process.platform === 'win32' ? 'explorer "' + ROOT + '"' : process.platform === 'darwin' ? 'open "' + ROOT + '"' : 'xdg-open "' + ROOT + '"';
      exec(cmd, () => {});
      return json(res, 200, { ok: true });
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
  }
}

const MANIFEST = {
  name: 'Send to Laptop',
  short_name: 'Send to Laptop',
  start_url: '/',
  display: 'standalone',
  background_color: '#eef2f5',
  theme_color: '#eef2f5',
  icons: [
    { src: '/icon.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
  ],
  share_target: {
    action: '/share-target',
    method: 'POST',
    enctype: 'multipart/form-data',
    params: { files: [{ name: 'files', accept: ['*/*'] }] },
  },
};

// Service worker: receives files from the Android share sheet and forwards them to the laptop.
const SW = String.raw`
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method === 'POST' && u.pathname === '/share-target') {
    e.respondWith((async function () {
      var fd = await e.request.formData();
      var files = fd.getAll('files');
      for (var i = 0; i < files.length; i++) {
        await fetch('/api/upload?box=in&name=' + encodeURIComponent(files[i].name), { method: 'POST', body: files[i] });
      }
      return Response.redirect('/', 303);
    })());
  }
});
`;

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#14213d"/><path d="M256 340V148m0 0l-72 72m72-72l72 72" stroke="#35e0a1" stroke-width="40" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M150 378h212" stroke="#eef2f5" stroke-width="40" stroke-linecap="round"/></svg>';

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#eef2f5">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg">
<title>Send to Laptop</title>
<style>
:root{--bg:#eef2f5;--card:#fff;--ink:#14213d;--mute:#5d6b82;--line:#d9e0e8;--go:#0a9d6e;--goBg:#dff7ee;--err:#c8372d;--accent:#14213d}
@media (prefers-color-scheme:dark){:root{--bg:#0f1624;--card:#17213a;--ink:#e8eef8;--mute:#93a2bd;--line:#2a3857;--go:#35e0a1;--goBg:#12382f;--err:#ff7a70;--accent:#35e0a1}}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);font:16px/1.45 "Segoe UI",system-ui,-apple-system,Roboto,sans-serif;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:760px;margin:0 auto;padding:18px 16px 6px}
h1{font-size:1.35rem;margin:0;font-weight:700;letter-spacing:-.01em}
h2{font-size:1rem;margin:0 0 10px;font-weight:650}
main{max-width:760px;margin:0 auto;padding:8px 16px 40px;display:grid;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.pill{font-size:.8rem;padding:3px 10px;border-radius:99px;background:var(--line);color:var(--mute)}
.pill.ok{background:var(--goBg);color:var(--go)}
.pill.bad{background:#fde5e3;color:var(--err)}
.drop{display:grid;place-items:center;gap:4px;text-align:center;padding:34px 16px;border:2px dashed var(--line);border-radius:12px;cursor:pointer;transition:border-color .15s,background .15s}
.drop b{font-size:1.15rem}
.drop span{color:var(--mute);font-size:.92rem}
.drop.over,.drop:focus-visible{border-color:var(--go);background:var(--goBg);outline:none}
button,.btn{font:inherit;font-weight:600;border:0;border-radius:9px;padding:9px 14px;background:var(--accent);color:var(--bg);cursor:pointer;text-decoration:none;display:inline-block}
button.ghost,.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
button.small,.btn.small{padding:5px 10px;font-size:.88rem}
button:focus-visible,.btn:focus-visible{outline:2px solid var(--go);outline-offset:2px}
.job{margin-top:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px}
.job .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.job .meta{color:var(--mute);font-size:.85rem;margin-top:2px}
.bar{height:6px;background:var(--line);border-radius:9px;margin-top:8px;overflow:hidden}
.bar i{display:block;height:100%;width:0;background:var(--go);transition:width .12s linear}
.job.done .meta{color:var(--go)}
.job.fail .meta{color:var(--err);cursor:pointer}
.row{display:flex;gap:10px;align-items:flex-start}
textarea{flex:1;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:9px 11px;resize:vertical;min-height:44px}
.note{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;padding:10px 0;border-top:1px solid var(--line)}
.note p{margin:0;white-space:pre-wrap;word-break:break-word;flex:1}
.note small,.f small{color:var(--mute)}
.tabs{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap}
.tabs button{background:transparent;color:var(--mute);border:1px solid var(--line)}
.tabs button.on{background:var(--accent);color:var(--bg);border-color:var(--accent)}
.f{display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--line)}
.th{flex:none;width:48px;height:48px;border-radius:9px;background:var(--bg);border:1px solid var(--line);display:grid;place-items:center;overflow:hidden;font-weight:700;font-size:.75rem;color:var(--mute)}
.th img{width:100%;height:100%;object-fit:cover}
.fi{flex:1;min-width:0}
.fi .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acts{display:flex;gap:6px;flex:none}
.empty{color:var(--mute);padding:14px 0 4px}
#connect{display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:center}
#qr{background:#fff;padding:10px;border-radius:10px;width:164px;height:164px}
#qr img,#qr canvas{width:100%!important;height:100%!important}
.url{font-size:.85rem;color:var(--mute);word-break:break-all}
[hidden]{display:none!important}
@media (max-width:520px){#connect{grid-template-columns:1fr;justify-items:center;text-align:center}.acts .small{padding:5px 8px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<header><h1>Send to Laptop</h1><span id="status" class="pill">connecting</span></header>
<main>
  <section id="connect" class="card" hidden>
    <div id="qr"></div>
    <div>
      <h2>Connect your phone</h2>
      <p style="margin:0 0 8px">Scan this with your phone camera (same Wi-Fi). You only need to do it once.</p>
      <div id="urls" class="url"></div>
      <p style="margin:12px 0 0"><button class="ghost small" id="openFolder">Open received folder</button></p>
    </div>
  </section>

  <section class="card">
    <div class="drop" id="drop" tabindex="0" role="button">
      <b id="dropTitle">Send files to laptop</b>
      <span id="dropHint">Tap to choose files</span>
      <input type="file" id="pick" multiple hidden>
    </div>
    <div id="queue"></div>
  </section>

  <section class="card">
    <h2>Text and links</h2>
    <div class="row"><textarea id="txt" rows="2" placeholder="Paste a link or some text"></textarea><button id="sendTxt">Send</button></div>
    <div id="notes"></div>
  </section>

  <section class="card">
    <h2>Files</h2>
    <div class="tabs" id="tabs">
      <button data-t="all" class="on">All</button>
      <button data-t="in">From phone</button>
      <button data-t="out">From laptop</button>
    </div>
    <div id="files"></div>
  </section>
</main>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
var $ = function (s) { return document.querySelector(s); };
var state = null, last = '', tab = 'all', local = false, qrDone = '';

function fmt(n) {
  var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
  while (n >= 1024 && i < 4) { n /= 1024; i++; }
  return (i ? n.toFixed(n >= 100 ? 0 : 1) : n) + ' ' + u[i];
}
function ago(t) {
  var s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(t).toLocaleDateString();
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
function setStatus(ok) {
  var s = $('#status');
  s.textContent = ok ? (local ? 'laptop' : 'connected to laptop') : 'offline';
  s.className = 'pill ' + (ok ? 'ok' : 'bad');
}

function poll() {
  fetch('/api/state').then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (s) {
    state = s; local = s.local; setStatus(true);
    var sig = JSON.stringify([s.files, s.notes, s.urls]);
    $('#dropTitle').textContent = local ? 'Send files to phone' : 'Send files to laptop';
    $('#dropHint').textContent = local ? 'Drop files here, paste an image, or click to choose' : 'Tap to choose files';
    if (sig !== last) { last = sig; render(); }
  }).catch(function () { setStatus(false); });
}

function render() {
  var s = state;
  var c = $('#connect');
  if (s.local && s.urls.length) {
    c.hidden = false;
    $('#urls').innerHTML = s.urls.map(function (u) { return '<div>' + esc(u.replace(/\?k=.*/, '')) + '</div>'; }).join('');
    if (window.QRCode && qrDone !== s.urls[0]) {
      qrDone = s.urls[0];
      $('#qr').innerHTML = '';
      new QRCode($('#qr'), { text: s.urls[0], width: 164, height: 164 });
    } else if (!window.QRCode) {
      $('#qr').textContent = 'QR needs internet once. Open the address on the right.';
    }
  } else { c.hidden = true; }

  var nh = s.notes.map(function (n) {
    return '<div class="note"><div style="flex:1"><p>' + esc(n.text) + '</p><small>from ' + n.from + ' · ' + ago(n.t) + '</small></div>' +
      '<div class="acts"><button class="ghost small" data-copy="' + n.id + '">Copy</button><button class="ghost small" data-delnote="' + n.id + '">Delete</button></div></div>';
  }).join('');
  $('#notes').innerHTML = nh;

  var files = s.files.filter(function (f) { return tab === 'all' || f.box === tab; });
  $('#files').innerHTML = files.length ? files.map(function (f) {
    var url = '/f/' + f.box + '/' + encodeURIComponent(f.name);
    var ext = (f.name.split('.').pop() || '').slice(0, 4);
    var img = /\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(f.name);
    return '<div class="f"><div class="th">' + (img ? '<img loading="lazy" alt="" src="' + url + '">' : esc(ext)) + '</div>' +
      '<div class="fi"><div class="nm" title="' + esc(f.name) + '">' + esc(f.name) + '</div><small>' + (f.box === 'in' ? 'from phone' : 'from laptop') + ' · ' + fmt(f.size) + ' · ' + ago(f.t) + '</small></div>' +
      '<div class="acts"><a class="btn small" href="' + url + '?dl=1" download>Save</a><button class="ghost small" data-del="' + f.box + '|' + encodeURIComponent(f.name) + '">Delete</button></div></div>';
  }).join('') : '<div class="empty">No files yet. Send something from the box above.</div>';
}

$('#tabs').onclick = function (e) {
  var t = e.target.dataset.t; if (!t) return;
  tab = t;
  Array.prototype.forEach.call($('#tabs').children, function (b) { b.className = b.dataset.t === t ? 'on' : ''; });
  render();
};

document.addEventListener('click', function (e) {
  var d = e.target.dataset || {};
  if (d.del) {
    var p = d.del.split('|');
    if (confirm('Delete this file from the laptop?')) fetch('/api/file?box=' + p[0] + '&name=' + p[1], { method: 'DELETE' }).then(poll);
  }
  if (d.delnote) fetch('/api/text?id=' + d.delnote, { method: 'DELETE' }).then(poll);
  if (d.copy) {
    var n = state.notes.filter(function (x) { return x.id === d.copy; })[0];
    if (n) copyText(n.text, e.target);
  }
});

function copyText(t, btn) {
  function done() { var o = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = o; }, 1200); }
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(t).then(done); return; }
  var a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select();
  try { document.execCommand('copy'); done(); } catch (x) { /* ignore */ }
  a.remove();
}

$('#sendTxt').onclick = function () {
  var v = $('#txt').value; if (!v.trim()) return;
  fetch('/api/text', { method: 'POST', body: JSON.stringify({ text: v }) }).then(function () { $('#txt').value = ''; poll(); });
};
$('#openFolder').onclick = function () { fetch('/api/open', { method: 'POST' }); };

// ---- uploads ----
var jobs = [], running = false;
function enqueue(list) {
  Array.prototype.forEach.call(list, function (f) {
    var el = document.createElement('div');
    el.className = 'job';
    el.innerHTML = '<div class="nm"></div><div class="meta">Waiting</div><div class="bar"><i></i></div>';
    el.firstChild.textContent = f.name;
    $('#queue').appendChild(el);
    jobs.push({ f: f, el: el, meta: el.querySelector('.meta'), bar: el.querySelector('i') });
  });
  next();
}
function next() {
  if (running) return;
  var j = jobs.shift(); if (!j) return;
  running = true;
  upload(j, function () { running = false; next(); });
}
function upload(j, done) {
  var x = new XMLHttpRequest(), t0 = Date.now();
  j.el.classList.remove('fail');
  x.open('POST', '/api/upload?box=' + (local ? 'out' : 'in') + '&name=' + encodeURIComponent(j.f.name));
  x.upload.onprogress = function (e) {
    if (!e.lengthComputable) return;
    j.bar.style.width = (e.loaded / e.total * 100) + '%';
    j.meta.textContent = fmt(e.loaded) + ' of ' + fmt(e.total) + ' · ' + fmt(e.loaded / ((Date.now() - t0) / 1000 || 1)) + '/s';
  };
  x.onload = function () {
    if (x.status === 200) {
      j.el.classList.add('done'); j.bar.style.width = '100%';
      j.meta.textContent = 'Sent · ' + fmt(j.f.size);
      setTimeout(function () { j.el.remove(); }, 4000);
      poll();
    } else fail();
  };
  x.onerror = fail;
  function fail() {
    j.el.classList.add('fail'); j.meta.textContent = 'Failed. Tap to retry.';
    j.meta.onclick = function () { j.meta.onclick = null; jobs.push(j); next(); };
    done();
  }
  x.send(j.f);
  x.onloadend = function () { if (x.status === 200) done(); };
}

$('#drop').onclick = function () { $('#pick').click(); };
$('#drop').onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#pick').click(); } };
$('#pick').onchange = function (e) { enqueue(e.target.files); e.target.value = ''; };
['dragenter', 'dragover'].forEach(function (n) { $('#drop').addEventListener(n, function (e) { e.preventDefault(); $('#drop').classList.add('over'); }); });
['dragleave', 'drop'].forEach(function (n) { $('#drop').addEventListener(n, function (e) { e.preventDefault(); $('#drop').classList.remove('over'); }); });
$('#drop').addEventListener('drop', function (e) { enqueue(e.dataTransfer.files); });
document.addEventListener('paste', function (e) {
  if (e.target.tagName === 'TEXTAREA') return;
  var fs = e.clipboardData && e.clipboardData.files;
  if (fs && fs.length) enqueue(fs);
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
setInterval(poll, 2500);
poll();
</script>
</body>
</html>`;

const server = SECURE
  ? https.createServer({ cert: fs.readFileSync(certF), key: fs.readFileSync(keyF) }, handler)
  : http.createServer(handler);
server.requestTimeout = 0; // allow very large uploads
server.timeout = 0;
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is busy. Close the old copy or set PORT=8081.' : e.message);
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => {
  const scheme = SECURE ? 'https' : 'http';
  console.log('\n  Send to Laptop is running\n');
  console.log('  On this laptop:  ' + scheme + '://localhost:' + PORT);
  ips().forEach((ip) => console.log('  On your phone:   ' + scheme + '://' + ip + ':' + PORT));
  console.log('\n  Files are saved in: ' + ROOT + '\n');
  if (!process.env.NO_OPEN) {
    const link = scheme + '://localhost:' + PORT;
    exec(process.platform === 'win32' ? 'start "" "' + link + '"' : process.platform === 'darwin' ? 'open "' + link + '"' : 'xdg-open "' + link + '"', () => {});
  }
});
