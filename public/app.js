'use strict';
// Client: draws JPEG frames on a canvas and forwards mouse, wheel, keyboard
// and clipboard to the server over one WebSocket.

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d', { alpha: false });
const overlay = $('overlay');
const urlInput = $('url');
const tabsEl = $('tabs');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

let ws = null;
let retry = 0;
let kicked = false;
let tabsState = { tabs: [], active: null };

// ------------------------------------------------------------ connection
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { retry = 0; showOverlay(null); canvas.focus(); };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return drawFrame(ev.data);
    const m = JSON.parse(ev.data);
    if (m.t === 'init') { canvas.width = m.w; canvas.height = m.h; }
    else if (m.t === 'tabs') renderTabs(m);
    else if (m.t === 'clipboard') writeLocalClipboard(m.text);
    else if (m.t === 'kicked') kicked = true;
  };
  ws.onclose = (ev) => {
    if (kicked || ev.code === 4000) {
      showOverlay('This session was opened in another window.', 'Take control here', () => { kicked = false; connect(); });
      return;
    }
    if (ev.code === 1006 && retry > 2) {
      // Possibly logged out (401 on upgrade): check before retrying forever.
      fetch('/app.js', { method: 'HEAD', cache: 'no-store' }).then((r) => { if (r.status === 401) location.href = '/login'; });
    }
    const wait = Math.min(10000, 500 * 2 ** retry++);
    showOverlay(`Disconnected. Reconnecting in ${Math.round(wait / 1000)}s…`);
    setTimeout(connect, wait);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function showOverlay(text, buttonLabel, onClick) {
  if (!text) { overlay.hidden = true; return; }
  overlay.hidden = false;
  overlay.textContent = '';
  const box = document.createElement('div');
  box.textContent = text;
  if (buttonLabel) {
    const b = document.createElement('button');
    b.textContent = buttonLabel;
    b.onclick = onClick;
    box.append(document.createElement('br'), b);
  }
  overlay.append(box);
}

function toast(text, ms = 2500) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

// --------------------------------------------------------------- drawing
let decoding = false;
let nextFrame = null;
function drawFrame(buf) {
  nextFrame = buf;
  if (decoding) return; // drop intermediate frames if decoding falls behind
  decoding = true;
  const data = nextFrame;
  nextFrame = null;
  createImageBitmap(new Blob([data], { type: 'image/jpeg' }))
    .then((bmp) => {
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width; canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
    })
    .catch(() => {})
    .finally(() => { decoding = false; if (nextFrame) drawFrame(nextFrame); });
}

// Map a client point to remote screen pixels (canvas uses object-fit: contain).
function toRemote(e) {
  const r = canvas.getBoundingClientRect();
  const scale = Math.min(r.width / canvas.width, r.height / canvas.height);
  const ox = (r.width - canvas.width * scale) / 2;
  const oy = (r.height - canvas.height * scale) / 2;
  const x = (e.clientX - r.left - ox) / scale;
  const y = (e.clientY - r.top - oy) / scale;
  return {
    x: Math.max(0, Math.min(canvas.width - 1, Math.round(x))),
    y: Math.max(0, Math.min(canvas.height - 1, Math.round(y))),
  };
}

// ------------------------------------------------------------------ mouse
let lastMove = null;
let moveQueued = false;
canvas.addEventListener('pointermove', (e) => {
  lastMove = toRemote(e);
  if (moveQueued) return;
  moveQueued = true;
  requestAnimationFrame(() => { moveQueued = false; send({ t: 'mm', ...lastMove }); });
});
canvas.addEventListener('pointerdown', (e) => {
  canvas.focus();
  canvas.setPointerCapture(e.pointerId);
  send({ t: 'md', ...toRemote(e), b: [1, 2, 3][e.button] || 1 });
  e.preventDefault();
});
canvas.addEventListener('pointerup', (e) => {
  send({ t: 'mu', ...toRemote(e), b: [1, 2, 3][e.button] || 1 });
  e.preventDefault();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
  send({ t: 'wh', ...toRemote(e), dx: e.deltaX * k, dy: e.deltaY * k });
}, { passive: false });

// --------------------------------------------------------------- keyboard
const down = new Set();
function remoteKey(e) {
  if (isMac && e.key === 'Meta') return 'Control'; // Cmd behaves like Ctrl remotely
  if (e.key === 'Dead' || e.key === 'Unidentified' || e.key === 'Process') return null;
  return e.key;
}
canvas.addEventListener('keydown', (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  // Let the local paste event fire; it delivers your clipboard text (see below).
  if (mod && (e.key === 'v' || e.key === 'V')) return;
  e.preventDefault();
  const key = remoteKey(e);
  if (!key) return;
  down.add(e.code);
  send({ t: 'kd', key, code: e.code });
  if (mod && !e.shiftKey && (e.key === 'c' || e.key === 'x')) send({ t: 'copy' });
});
canvas.addEventListener('keyup', (e) => {
  if (!down.has(e.code)) return;
  e.preventDefault();
  down.delete(e.code);
  send({ t: 'ku', code: e.code });
});
function releaseAll() {
  down.clear();
  send({ t: 'reset' });
}
canvas.addEventListener('blur', releaseAll);
window.addEventListener('blur', releaseAll);

// -------------------------------------------------------------- clipboard
window.addEventListener('paste', (e) => {
  if (document.activeElement !== canvas) return;
  const text = e.clipboardData && e.clipboardData.getData('text/plain');
  if (text) send({ t: 'paste', text });
  e.preventDefault();
});
$('paste').onclick = async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) { send({ t: 'paste', text }); toast('Pasted'); }
  } catch { toast(`Clipboard blocked: press ${isMac ? '⌘' : 'Ctrl'}+V inside the page instead`); }
  canvas.focus();
};
$('copy').onclick = () => { send({ t: 'copy', press: true }); canvas.focus(); };
async function writeLocalClipboard(text) {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); toast('Copied to your clipboard'); }
  catch { toast('Could not write to your clipboard (browser refused)'); }
}

// ------------------------------------------------------------ navigation
$('bar').addEventListener('submit', (e) => {
  e.preventDefault();
  send({ t: 'nav', url: urlInput.value });
  canvas.focus();
});
$('back').onclick = () => { send({ t: 'back' }); canvas.focus(); };
$('fwd').onclick = () => { send({ t: 'fwd' }); canvas.focus(); };
$('reload').onclick = () => { send({ t: 'reload' }); canvas.focus(); };
$('full').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
};
$('logout').onclick = () => $('logoutForm').submit();
urlInput.addEventListener('focus', () => urlInput.select());
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { syncUrl(true); canvas.focus(); }
});

function syncUrl(force) {
  const t = tabsState.tabs.find((x) => x.id === tabsState.active);
  if (t && (force || document.activeElement !== urlInput)) {
    urlInput.value = t.url === 'about:blank' ? '' : t.url;
  }
  document.title = t && t.title ? `${t.title} · Private browser` : 'Private browser';
}

function renderTabs(state) {
  tabsState = state;
  tabsEl.textContent = '';
  for (const t of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === state.active ? ' active' : '');
    el.setAttribute('role', 'tab');
    el.title = t.url;
    const label = document.createElement('span');
    label.textContent = t.title || t.url || 'New tab';
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close tab');
    close.onclick = (e) => { e.stopPropagation(); send({ t: 'close', id: t.id }); };
    el.append(label, close);
    el.onclick = () => { send({ t: 'activate', id: t.id }); canvas.focus(); };
    tabsEl.append(el);
  }
  const plus = document.createElement('button');
  plus.className = 'newtab';
  plus.textContent = '+';
  plus.title = 'New tab';
  plus.onclick = () => { send({ t: 'newtab' }); setTimeout(() => urlInput.focus(), 150); };
  tabsEl.append(plus);
  syncUrl(false);
}

connect();
