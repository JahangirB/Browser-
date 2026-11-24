'use strict';
// Runs Xvfb + a real, headful Chromium + the X11 input helper, and talks to
// Chromium over the DevTools protocol on a random port bound to 127.0.0.1
// inside the container (never published). We deliberately do NOT use
// --remote-debugging-pipe: Chromium treats it as automation and sets
// navigator.webdriver = true.
//
// Stealth notes:
//  * Chromium is launched by us, not by Playwright/Puppeteer, so there is no
//    --enable-automation flag and navigator.webdriver stays false.
//  * We never call Runtime.enable (the classic CDP leak bot detectors probe).
//    Anything we need to read from a page is evaluated in an isolated world.
//  * Input goes through X11/XTEST like a physical keyboard and mouse.

const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Ask the OS for an unused localhost port.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

class CDP extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result || {});
      } else if (msg.method) {
        this.emit('event', msg);
      }
    });
    this.ws.on('close', () => this.closeAll());
    this.ws.on('error', () => this.closeAll());
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) return reject(new Error('CDP not connected'));
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }

  closeAll() {
    for (const { reject } of this.pending.values()) reject(new Error('CDP closed'));
    this.pending.clear();
  }

  close() { try { this.ws.close(); } catch {} }
}

class Browser extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.display = ':99';
    this.cdp = null;
    this.chrome = null;
    this.input = null;
    this.targets = new Map(); // targetId -> {id,title,url,created}
    this.sessions = new Map(); // targetId -> sessionId
    this.active = null;
    this.noSandbox = cfg.sandbox === 'off';
    this.crashes = [];
    this.stopping = false;
    this.clipWaiters = [];
    this.ready = false;
  }

  async start() {
    await this.startXvfb();
    this.startInput();
    await this.startChromium();
  }

  // ---------------------------------------------------------------- Xvfb
  async startXvfb() {
    const n = this.display.slice(1);
    for (const f of [`/tmp/.X${n}-lock`, `/tmp/.X11-unix/X${n}`]) {
      try { fs.unlinkSync(f); } catch {}
    }
    const { width, height } = this.cfg;
    this.xvfb = spawn('Xvfb', [this.display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-dpi', '96'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.xvfb.stderr.on('data', (d) => {
      const s = d.toString();
      if (!/Could not resolve keysym|_XSERVTransmkdir|xkbcomp|Warning:/.test(s)) process.stderr.write(`[xvfb] ${s}`);
    });
    this.xvfb.on('exit', (code) => {
      if (this.stopping) return;
      console.error(`[xvfb] exited with ${code}; exiting so the container restarts`);
      process.exit(1);
    });
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(`/tmp/.X11-unix/X${n}`)) return;
      await sleep(100);
    }
    throw new Error('Xvfb did not start');
  }

  // ------------------------------------------------------- input helper
  startInput() {
    this.input = spawn('python3', ['-u', path.join(__dirname, 'input.py')], {
      env: { ...process.env, DISPLAY: this.display },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let buf = '';
    this.input.stdout.setEncoding('utf8');
    this.input.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.t === 'miss') this.insertText(m.text).catch(() => {});
        if (m.t === 'clip') {
          const w = this.clipWaiters.shift();
          if (w) w(m.text);
        }
      }
    });
    this.input.stdin.on('error', () => {});
    this.input.on('exit', (code) => {
      if (this.stopping) return;
      console.error(`[input] helper exited (${code}); restarting`);
      setTimeout(() => this.startInput(), 1000);
    });
  }

  sendInput(cmd) {
    if (this.input && this.input.stdin.writable) this.input.stdin.write(JSON.stringify(cmd) + '\n');
  }

  readClipboard() {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        const i = this.clipWaiters.indexOf(done);
        if (i >= 0) this.clipWaiters.splice(i, 1);
        resolve('');
      }, 3000);
      const done = (text) => { clearTimeout(t); resolve(text); };
      this.clipWaiters.push(done);
      this.sendInput({ t: 'clip' });
    });
  }

  // ------------------------------------------------------------ Chromium
  prepareProfile() {
    const dir = this.cfg.profileDir;
    const fresh = !fs.existsSync(path.join(dir, 'Default', 'Preferences'));
    fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
    // A killed container leaves these behind and Chromium would refuse to start.
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.rmSync(path.join(dir, f), { force: true }); } catch {}
    }
    // Mark the last exit as clean (no "Restore pages?" bubble) and keep
    // "continue where you left off" so tabs survive restarts.
    const prefFile = path.join(dir, 'Default', 'Preferences');
    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(prefFile, 'utf8')); } catch {}
    prefs.profile = { ...(prefs.profile || {}), exit_type: 'Normal', exited_cleanly: true };
    prefs.session = { ...(prefs.session || {}), restore_on_startup: 1 };
    prefs.browser = { ...(prefs.browser || {}), has_seen_welcome_page: true };
    prefs.translate = { ...(prefs.translate || {}), enabled: false };
    try { fs.writeFileSync(prefFile, JSON.stringify(prefs)); } catch (e) { console.error('[chromium] cannot write prefs', e.message); }
    return fresh;
  }

  chromiumArgs(fresh) {
    const { width, height, lang, profileDir, startUrl } = this.cfg;
    const args = [
      // Explicit port on purpose: Chromium treats --remote-debugging-port=0
      // (what Puppeteer uses) as automation and sets navigator.webdriver.
      `--remote-debugging-port=${this.cdpPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--kiosk',
      '--window-position=0,0',
      `--window-size=${width},${height}`,
      `--lang=${lang}`,
      '--password-store=basic',
      '--ozone-platform=x11',
      '--hide-crash-restore-bubble',
      '--disable-features=Translate,MediaRouter,DialMediaRouteProvider',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ];
    if (this.noSandbox) args.push('--no-sandbox');
    if (fresh && startUrl) args.push(startUrl);
    return args;
  }

  async startChromium() {
    this.cdpPort = await freePort();
    const fresh = this.prepareProfile();
    const args = this.chromiumArgs(fresh);
    console.log(`[chromium] launching (sandbox ${this.noSandbox ? 'OFF' : 'on'})`);
    const startedAt = Date.now();
    const chrome = spawn(this.cfg.chromiumPath, args, {
      env: { ...process.env, DISPLAY: this.display },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.chrome = chrome;
    let errTail = '';
    chrome.stderr.on('data', (d) => {
      errTail = (errTail + d.toString()).slice(-4000);
      if (this.cfg.debug) process.stderr.write(`[chromium] ${d}`);
    });
    chrome.on('error', (e) => console.error('[chromium] spawn error', e.message));
    chrome.on('exit', (code, signal) => {
      this.ready = false;
      if (this.cdp) this.cdp.close();
      this.cdp = null;
      this.targets.clear();
      this.sessions.clear();
      this.active = null;
      this.emit('tabs');
      if (this.stopping) return;
      const lived = Date.now() - startedAt;
      console.error(`[chromium] exited code=${code} signal=${signal} after ${lived}ms`);
      if (lived < 8000 && !this.noSandbox && this.cfg.sandbox === 'auto') {
        console.error('[chromium] sandbox start failed; retrying with --no-sandbox (set CHROMIUM_SANDBOX=on to forbid this).');
        console.error(errTail.split('\n').filter((l) => /sandbox|namespace|zygote/i.test(l)).slice(-3).join('\n'));
        this.noSandbox = true;
      }
      const now = Date.now();
      this.crashes = this.crashes.filter((t) => now - t < 60000).concat(now);
      if (this.crashes.length > 5) {
        console.error('[chromium] crashing repeatedly; last stderr:\n' + errTail);
        process.exit(1);
      }
      setTimeout(() => this.startChromium().catch((e) => console.error('[chromium]', e.message)), 1000);
    });

    this.connectCDP(chrome).catch((e) => console.error('[chromium] CDP init failed:', e.message));
  }

  async connectCDP(chrome) {
    // Poll the local DevTools HTTP endpoint until Chromium is listening.
    let wsUrl;
    for (let i = 0; i < 150 && !wsUrl; i++) {
      if (this.chrome !== chrome) return;
      wsUrl = await getJson(`http://127.0.0.1:${this.cdpPort}/json/version`)
        .then((j) => j.webSocketDebuggerUrl).catch(() => null);
      if (!wsUrl) await sleep(100);
    }
    if (!wsUrl) throw new Error('DevTools endpoint never came up');
    const cdp = new CDP(wsUrl);
    await cdp.opened;
    if (this.chrome !== chrome) return cdp.close();
    this.cdp = cdp;
    cdp.on('event', (m) => this.onEvent(m));
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    this.ready = true;
    console.log('[chromium] ready');
  }

  onEvent({ method, params }) {
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const ti = params.targetInfo;
      if (ti.type !== 'page') return;
      const isNew = !this.targets.has(ti.targetId);
      this.targets.set(ti.targetId, {
        id: ti.targetId,
        title: ti.title,
        url: ti.url,
        created: isNew ? Date.now() : this.targets.get(ti.targetId).created,
      });
      if (isNew) {
        if (!this.active) this.active = ti.targetId;
        else if (this.ready) this.checkIfShown(ti.targetId); // popup or new tab?
      }
      this.emit('tabs');
    } else if (method === 'Target.targetDestroyed' || method === 'Target.targetCrashed') {
      if (!this.targets.has(params.targetId)) return;
      this.targets.delete(params.targetId);
      this.sessions.delete(params.targetId);
      if (this.active === params.targetId) {
        const rest = [...this.targets.values()].sort((a, b) => b.created - a.created);
        this.active = rest[0] ? rest[0].id : null;
        if (this.active) this.cdp.send('Target.activateTarget', { targetId: this.active }).catch(() => {});
      }
      this.emit('tabs');
    } else if (method === 'Target.detachedFromTarget') {
      for (const [tid, sid] of this.sessions) if (sid === params.sessionId) this.sessions.delete(tid);
    }
  }

  async checkIfShown(targetId) {
    // Ctrl+click opens a background tab; window.open / target=_blank shows it.
    await sleep(400);
    const state = await this.evalIsolated(targetId, 'document.visibilityState').catch(() => null);
    if (state === 'visible' && this.targets.has(targetId)) {
      this.active = targetId;
      this.emit('tabs');
    }
  }

  async session(targetId) {
    if (this.sessions.has(targetId)) return this.sessions.get(targetId);
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessions.set(targetId, sessionId);
    return sessionId;
  }

  // Evaluate in an isolated world: page scripts can't see or detect it.
  async evalIsolated(targetId, expression) {
    const s = await this.session(targetId);
    const { frameTree } = await this.cdp.send('Page.getFrameTree', {}, s);
    const { executionContextId } = await this.cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: '__rbi',
    }, s);
    const r = await this.cdp.send('Runtime.evaluate', {
      expression, contextId: executionContextId, returnByValue: true,
    }, s);
    return r.result ? r.result.value : undefined;
  }

  // Chromium doesn't always emit targetInfoChanged for title-only changes,
  // so the server calls this every few seconds while someone is watching.
  async refreshTargets() {
    if (!this.cdp || !this.ready) return;
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    let changed = false;
    for (const ti of targetInfos) {
      const t = this.targets.get(ti.targetId);
      if (t && ti.type === 'page' && (t.title !== ti.title || t.url !== ti.url)) {
        t.title = ti.title;
        t.url = ti.url;
        changed = true;
      }
    }
    if (changed) this.emit('tabs');
  }

  // ---------------------------------------------------------- controls
  tabs() {
    return {
      active: this.active,
      tabs: [...this.targets.values()].sort((a, b) => a.created - b.created)
        .map(({ id, title, url }) => ({ id, title, url })),
    };
  }

  async withActive(fn) {
    if (!this.cdp || !this.active) return;
    const s = await this.session(this.active);
    return fn(s);
  }

  navigate(url) {
    return this.withActive((s) => this.cdp.send('Page.navigate', { url }, s));
  }

  async history(delta) {
    return this.withActive(async (s) => {
      const { currentIndex, entries } = await this.cdp.send('Page.getNavigationHistory', {}, s);
      const e = entries[currentIndex + delta];
      if (e) await this.cdp.send('Page.navigateToHistoryEntry', { entryId: e.id }, s);
    });
  }

  reload() {
    return this.withActive((s) => this.cdp.send('Page.reload', {}, s));
  }

  insertText(text) {
    return this.withActive((s) => this.cdp.send('Input.insertText', { text }, s));
  }

  async newTab(url = 'about:blank') {
    if (!this.cdp) return;
    const { targetId } = await this.cdp.send('Target.createTarget', { url });
    this.active = targetId;
    await this.cdp.send('Target.activateTarget', { targetId }).catch(() => {});
    this.emit('tabs');
  }

  async activate(targetId) {
    if (!this.cdp || !this.targets.has(targetId)) return;
    await this.cdp.send('Target.activateTarget', { targetId });
    this.active = targetId;
    this.emit('tabs');
  }

  async closeTab(targetId) {
    if (!this.cdp || !this.targets.has(targetId)) return;
    // Closing the last tab would quit Chromium in kiosk mode; blank it instead.
    if (this.targets.size <= 1) {
      const s = await this.session(targetId);
      return this.cdp.send('Page.navigate', { url: 'about:blank' }, s);
    }
    await this.cdp.send('Target.closeTarget', { targetId });
  }

  async stop() {
    this.stopping = true;
    const chrome = this.chrome;
    if (chrome && chrome.exitCode === null) {
      // Graceful close so Chromium flushes cookies/session to the profile.
      const exited = new Promise((r) => chrome.once('exit', r));
      try { if (this.cdp) this.cdp.send('Browser.close').catch(() => {}); else chrome.kill('SIGTERM'); } catch {}
      const ok = await Promise.race([exited.then(() => true), sleep(15000).then(() => false)]);
      if (!ok) { console.error('[chromium] did not exit in time; killing'); chrome.kill('SIGKILL'); }
    }
    for (const p of [this.input, this.xvfb]) { try { p && p.kill('SIGTERM'); } catch {} }
  }
}

module.exports = { Browser };
