'use strict';
// HTTP + WebSocket front door: login, static UI, and the control channel.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Auth } = require('./auth');
const { Browser } = require('./browser');
const { Capture } = require('./capture');

const env = process.env;
const cfg = {
  port: parseInt(env.PORT || '8080', 10),
  password: env.RBI_PASSWORD,
  dataDir: env.DATA_DIR || '/data',
  width: parseInt(env.SCREEN_WIDTH || '1600', 10),
  height: parseInt(env.SCREEN_HEIGHT || '900', 10),
  fps: parseInt(env.FPS || '15', 10),
  quality: parseInt(env.JPEG_QUALITY || '7', 10), // 2 (best) .. 31 (worst)
  startUrl: env.START_URL || 'https://duckduckgo.com/',
  searchUrl: env.SEARCH_URL || 'https://duckduckgo.com/?q=',
  chromiumPath: env.CHROMIUM_PATH || '/usr/bin/chromium',
  sandbox: (env.CHROMIUM_SANDBOX || 'auto').toLowerCase(), // auto | on | off
  lang: env.BROWSER_LANG || 'en-US',
  trustProxy: env.TRUST_PROXY !== '0',
  sessionDays: parseInt(env.SESSION_DAYS || '7', 10),
  debug: env.DEBUG === '1',
};

const auth = new Auth({ password: cfg.password, dataDir: cfg.dataDir, sessionDays: cfg.sessionDays });
const browser = new Browser({
  width: cfg.width, height: cfg.height, lang: cfg.lang, startUrl: cfg.startUrl,
  profileDir: path.join(cfg.dataDir, 'profile'), chromiumPath: cfg.chromiumPath,
  sandbox: cfg.sandbox, debug: cfg.debug,
});
const capture = new Capture({
  display: browser.display, width: cfg.width, height: cfg.height, fps: cfg.fps, quality: cfg.quality,
});

// ------------------------------------------------------------------ HTTP
const PUBLIC = path.join(__dirname, '..', 'public');
const files = {};
for (const [name, type] of [
  ['index.html', 'text/html; charset=utf-8'], ['login.html', 'text/html; charset=utf-8'],
  ['app.js', 'text/javascript; charset=utf-8'], ['login.js', 'text/javascript; charset=utf-8'], ['style.css', 'text/css; charset=utf-8'],
]) files[name] = { body: fs.readFileSync(path.join(PUBLIC, name)), type };

function clientIp(req) {
  if (cfg.trustProxy && req.headers['x-forwarded-for']) {
    const parts = String(req.headers['x-forwarded-for']).split(',');
    return parts[parts.length - 1].trim(); // rightmost = added by our own Caddy
  }
  return req.socket.remoteAddress;
}

function isSecure(req) {
  return req.socket.encrypted || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https');
}

function securityHeaders(req) {
  const host = String(req.headers.host || '').replace(/[^a-zA-Z0-9.:\-\[\]]/g, '');
  return {
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:",
      `connect-src 'self' wss://${host} ws://${host}`, "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cache-Control': 'no-store',
    ...(isSecure(req) ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  };
}

function send(req, res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...securityHeaders(req), 'Content-Type': type, ...extra });
  res.end(body);
}

function redirect(req, res, to, extra = {}) {
  res.writeHead(303, { ...securityHeaders(req), Location: to, ...extra });
  res.end();
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // older browsers omit Origin on same-origin form posts
  if (origin === 'null') return req.headers['sec-fetch-site'] === 'same-origin';
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/healthz') return send(req, res, browser.ready ? 200 : 503, browser.ready ? 'ok' : 'starting');

    if (p === '/login' && req.method === 'GET') {
      return send(req, res, 200, files['login.html'].body, files['login.html'].type);
    }
    if (p === '/style.css') return send(req, res, 200, files['style.css'].body, files['style.css'].type);
    if (p === '/login.js') return send(req, res, 200, files['login.js'].body, files['login.js'].type);

    if (p === '/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (!sameOrigin(req)) return send(req, res, 403, 'Bad origin');
      if (auth.isLocked(ip)) return redirect(req, res, '/login?e=locked');
      const form = new URLSearchParams(await readBody(req));
      if (!auth.checkPassword(form.get('password'))) {
        auth.recordFailure(ip);
        console.warn(`[auth] failed login from ${ip}`);
        await new Promise((r) => setTimeout(r, 800));
        return redirect(req, res, '/login?e=1');
      }
      auth.clearFailures(ip);
      return redirect(req, res, '/', { 'Set-Cookie': auth.cookie(auth.issue(), isSecure(req), auth.maxAge) });
    }

    if (p === '/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) return send(req, res, 403, 'Bad origin');
      return redirect(req, res, '/login', { 'Set-Cookie': auth.cookie('', isSecure(req), 0) });
    }

    if (!auth.fromRequest(req)) {
      if (p === '/') return redirect(req, res, '/login');
      return send(req, res, 401, 'Unauthorized');
    }

    if (p === '/' && req.method === 'GET') return send(req, res, 200, files['index.html'].body, files['index.html'].type);
    if (p === '/app.js') return send(req, res, 200, files['app.js'].body, files['app.js'].type);
    return send(req, res, 404, 'Not found');
  } catch (e) {
    console.error('[http]', e);
    if (!res.headersSent) send(req, res, 500, 'Server error');
  }
});

// ------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
let current = null;

server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p !== '/ws' || !sameOrigin(req) || !req.headers.origin || !auth.fromRequest(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function normalizeUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^about:blank$/i.test(s)) return 'about:blank';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^\s/]+:\d+/.test(s)) return null; // file:, javascript:, chrome:, ...
  if (!/\s/.test(s) && (/^[^\s/]+\.[^\s/]{2,}(\/|$|:|\?)/.test(s) || /^localhost(:\d+)?/.test(s))) return `https://${s}`;
  return cfg.searchUrl + encodeURIComponent(s);
}

wss.on('connection', (ws, req) => {
  // One controller at a time: a new tab/device takes over.
  if (current && current !== ws) {
    try { current.send(JSON.stringify({ t: 'kicked' })); current.close(4000, 'taken over'); } catch {}
  }
  current = ws;
  console.log(`[ws] client connected from ${clientIp(req)}`);

  let pending = null;
  let drainTimer = null;
  const MAX_BUFFERED = 1.5 * 1024 * 1024;
  const pushFrame = (frame) => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      pending = frame; // slow link: keep only the newest frame
      if (!drainTimer) {
        drainTimer = setInterval(() => {
          if (ws.readyState !== ws.OPEN) { clearInterval(drainTimer); drainTimer = null; return; }
          if (ws.bufferedAmount <= MAX_BUFFERED && pending) {
            ws.send(pending, { binary: true });
            pending = null;
            clearInterval(drainTimer);
            drainTimer = null;
          }
        }, 30);
      }
      return;
    }
    ws.send(frame, { binary: true });
  };
  const sendTabs = () => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'tabs', ...browser.tabs() }));
  };

  ws.send(JSON.stringify({ t: 'init', w: cfg.width, h: cfg.height }));
  sendTabs();
  if (capture.lastFrame) pushFrame(capture.lastFrame);
  capture.on('frame', pushFrame);
  browser.on('tabs', sendTabs);
  capture.start();

  const alive = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 25000);
  const titles = setInterval(() => { browser.refreshTargets().catch(() => {}); }, 2000);

  ws.on('message', async (data, isBinary) => {
    if (isBinary || ws !== current) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    const num = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
    try {
      switch (m.t) {
        case 'mm': browser.sendInput({ t: 'mm', x: num(m.x, cfg.width - 1), y: num(m.y, cfg.height - 1) }); break;
        case 'md':
        case 'mu': browser.sendInput({ t: m.t, x: num(m.x, cfg.width - 1), y: num(m.y, cfg.height - 1), b: num(m.b, 3) }); break;
        case 'wh': browser.sendInput({
          t: 'wh', x: num(m.x, cfg.width - 1), y: num(m.y, cfg.height - 1),
          dx: Math.max(-5000, Math.min(5000, Number(m.dx) || 0)), dy: Math.max(-5000, Math.min(5000, Number(m.dy) || 0)),
        }); break;
        case 'kd': browser.sendInput({ t: 'kd', key: String(m.key || '').slice(0, 32), code: String(m.code || '').slice(0, 32) }); break;
        case 'ku': browser.sendInput({ t: 'ku', code: String(m.code || '').slice(0, 32) }); break;
        case 'reset': browser.sendInput({ t: 'reset' }); break;
        case 'paste': if (typeof m.text === 'string' && m.text) await browser.insertText(m.text.slice(0, 200000)); break;
        case 'copy': {
          if (m.press) browser.sendInput({ t: 'combo', keys: ['Control_L', 'c'] });
          await new Promise((r) => setTimeout(r, 250));
          const text = await browser.readClipboard();
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'clipboard', text }));
          break;
        }
        case 'nav': { const u = normalizeUrl(m.url); if (u) await browser.navigate(u); break; }
        case 'back': await browser.history(-1); break;
        case 'fwd': await browser.history(1); break;
        case 'reload': await browser.reload(); break;
        case 'newtab': await browser.newTab(); break;
        case 'activate': await browser.activate(String(m.id)); break;
        case 'close': await browser.closeTab(String(m.id)); break;
        default: break;
      }
    } catch (e) {
      if (cfg.debug) console.error('[ws] command failed', m.t, e.message);
    }
  });

  ws.on('close', () => {
    clearInterval(alive);
    clearInterval(titles);
    if (drainTimer) clearInterval(drainTimer);
    capture.off('frame', pushFrame);
    browser.off('tabs', sendTabs);
    if (current === ws) {
      current = null;
      browser.sendInput({ t: 'reset' });
      capture.stop(); // nobody watching: stop encoding to save CPU
    }
    console.log('[ws] client disconnected');
  });
});

// ------------------------------------------------------------------ boot
(async () => {
  await browser.start();
  server.listen(cfg.port, () => console.log(`[rbi] listening on :${cfg.port} (screen ${cfg.width}x${cfg.height})`));
})().catch((e) => { console.error(e); process.exit(1); });

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`[rbi] ${sig}: shutting down`);
    capture.stop();
    await browser.stop();
    process.exit(0);
  });
}
