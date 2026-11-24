# Private RBI: your own remote browser

A real, headful Chromium runs on your server. You see it in a tab on your laptop and control it with your own mouse, keyboard, scroll wheel and clipboard. Websites only ever see the server.

```
 Laptop browser                         Your VM (Docker)
┌──────────────────┐  HTTPS / WSS   ┌──────────────────────────────────────────────────┐
│ login page       │ ─────────────▶ │ Caddy (Let's Encrypt, :443)                      │
│ tabs + URL bar   │                │   │                                              │
│ <canvas> stream  │ ◀── JPEG ───── │   ▼                                              │
│ mouse/keys/clip  │ ─── JSON ────▶ │ Node server (auth, WebSocket)                    │
└──────────────────┘                │   ├─ ffmpeg x11grab ──▶ JPEG frames              │
                                    │   ├─ input.py (XTEST) ─▶ real X11 key/mouse      │
                                    │   └─ CDP on 127.0.0.1 ─▶ tabs, URL, back/fwd     │
                                    │ Xvfb :99 ◀── Chromium (kiosk, headful)           │
                                    │                 profile on /data volume          │
                                    └──────────────────────────────────────────────────┘
```

About 1,400 lines of app code (server, helper and UI), with one npm dependency (`ws`). No third-party proxy services.

| File | What it does |
|---|---|
| `src/server.js` | HTTP routes, login, WebSocket control channel, URL normalising |
| `src/auth.js` | Password check, signed HttpOnly session cookie, brute-force lockout |
| `src/browser.js` | Starts and supervises Xvfb, Chromium and the input helper; DevTools client for tabs and navigation |
| `src/capture.js` | ffmpeg screen grab → JPEG frames; unchanged frames are dropped |
| `src/input.py` | Injects mouse, keyboard and wheel input through X11 XTEST; reads the remote clipboard |
| `public/*` | Login page and the browser UI (tabs, back/forward/reload, URL bar, copy/paste, full screen) |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile` | Container image, the app + Caddy stack, and HTTPS |
| `scripts/setup-host.sh` | One-time VM preparation: firewall, Docker, swap, auto-updates |

---

## 1. Picking a free host (November 2026)

Chromium needs about 1–2 GB of RAM to browse modern apps comfortably. It also needs a long-lived WebSocket, and a disk that survives restarts so your logins persist. That rules out most "free container" tiers.

| | **Oracle Cloud Always Free (winner)** | **Google Cloud Run (runner-up)** |
|---|---|---|
| CPU / RAM | Ampere A1 ARM VM. **2 OCPU / 12 GB** since Oracle's 18 Aug 2026 change (was 4 / 24) | Up to 4 vCPU / 16 GiB per instance, billed per second |
| Free allowance | Runs 24/7 within the cap; 200 GB block storage; 10 TB/month egress | ~180k–240k vCPU-s and 360k–450k GiB-s per month (Google's pages disagree). At 2 vCPU / 4 GiB that's **only about 30 hours of browsing a month** |
| WebSockets | Unlimited: it's your VM | Supported, but **every connection is cut at the 60-minute request timeout** |
| Persistent profile | Real disk; cookies and logins survive restarts | **No local disk.** Cloud Storage FUSE is unsafe for Chromium's SQLite cookie DB, so logins get lost |
| Sleep / cold start | Never sleeps | Scales to zero; Chromium cold-starts in 5–10 s |
| Card required | Yes, for identity verification (temporary hold) | Yes, a billing account |
| Main caveat | Idle reclamation (below); A1 "out of capacity" in busy regions | Hourly disconnects, lost logins, hard usage cap |

Rejected:
- **Render free**: 512 MB, sleeps after 15 minutes, no persistent disk. Chromium runs out of memory.
- **Hugging Face Spaces (CPU Basic)**: plenty of RAM, but no persistent storage on the free tier, and it sleeps when unused.
- **Northflank, SnapDeploy and similar**: free quotas are a fraction of a vCPU with ≤512 MB. Too small. I couldn't verify their exact current 2026 limits, so check if you're curious.

**Why Oracle wins:** it's the only option with enough RAM, a disk that keeps your logins, no WebSocket limits and no sleep. Even the halved 2 OCPU / 12 GB allowance is plenty for one Chromium.

**Oracle caveats, stated plainly:**
1. **Idle reclamation.** Oracle may reclaim Always Free instances that sit idle for 7 days (95th-percentile CPU under 20%). A personal browser is idle most of the time. The usual fix is to upgrade the account to **Pay As You Go** while staying inside the Always Free shapes, and to set a **$1 budget alert**. Reports in 2026 disagree on how PAYG accounts are treated after the August change, so keep the budget alert on.
2. **Limits changed in August 2026.** Anything above 2 OCPU / 12 GB on A1 is now terminated or disabled. Create the VM at exactly **2 OCPU / 12 GB** (or smaller), and confirm the "Always Free-eligible" label in the console.
3. **Your home region is permanent.** If you see "Out of host capacity", retry later or in another availability domain.
4. **Card verification** is required, even though you won't be charged.

---

## 2. Anti-bot and login reliability: what's done and why

| Measure | Where |
|---|---|
| **Real headful Chromium** on an Xvfb display, not headless. No `HeadlessChrome` UA and normal window metrics | `browser.js`, `chromiumArgs()` |
| **Not launched by Playwright or Puppeteer.** No `--enable-automation`, so no automation infobar and `navigator.webdriver === false` | `browser.js` |
| **DevTools on an explicit random localhost port.** Both `--remote-debugging-pipe` and `--remote-debugging-port=0` make Chromium set `navigator.webdriver = true`; I confirmed this while testing. A fixed port number doesn't | `browser.js`, `freePort()` |
| **No `Runtime.enable`**, the CDP leak Cloudflare and others probe for. The server only uses `Target.*` / `Page.navigate` / history. Anything read from a page runs in an isolated world | `browser.js` |
| **OS-level input** through X11 XTEST, the same path a physical keyboard and mouse take. Events are `isTrusted`, and native popups work: `<select>` menus, JS dialogs, context menus, HTTP-auth prompts | `input.py` |
| **Persistent profile** on a Docker volume: cookies, localStorage, saved logins and open tabs survive restarts. Chromium is closed gracefully so cookies get flushed | `browser.js`, `stop()`; `stop_grace_period` in Compose |
| **Clean restart.** Stale `SingletonLock` files are removed and the last exit is marked clean, so there's no "Restore pages?" bubble | `prepareProfile()` |
| **Consistent locale.** Set `TZ` and `BROWSER_LANG` to match you; fonts include Liberation, Noto, CJK and emoji | `.env`, `Dockerfile` |
| **Real screen size.** Kiosk window fills a 1600×900 screen (configurable); `screen.*` and `window.*` agree | `.env` |

**Limits no code can fix:** sites see a **datacenter IP** (Oracle), and WebGL is software-rendered (SwiftShader) because there's no GPU. Expect Cloudflare to sometimes show the "Verify you are human" checkbox. Click it; that's what the interactive design is for. Google and Microsoft OAuth logins normally work in a real headful Chromium like this one. If Google says "This browser may not be secure", wait a bit and sign in again, or sign in through a different Google flow (for example accounts.google.com directly).

---

## 3. Deployment: zero to a live HTTPS URL

### Step 1: Create the Oracle account
1. Sign up at oracle.com/cloud/free and choose your **home region** carefully (it can't be changed).
2. Recommended: in **Billing → Upgrade and Manage Payment**, upgrade to **Pay As You Go**. Then create a budget in **Billing → Budgets** with a $1 alert.

### Step 2: Create the VM
1. **Compute → Instances → Create instance.**
2. **Image:** Canonical Ubuntu 24.04 (pick the **aarch64** build). **Shape:** Ampere → `VM.Standard.A1.Flex`, **2 OCPU, 12 GB**.
3. **Networking:** create a new VCN with a public subnet; **assign a public IPv4 address**.
4. **SSH keys:** upload your public key (`~/.ssh/id_ed25519.pub`), or download the generated one.
5. Create the instance and note its **public IP**.

### Step 3: Open ports 80/443 in Oracle's network firewall
**Networking → Virtual Cloud Networks → your VCN → Subnet → Default Security List → Add Ingress Rules:**
- Source `0.0.0.0/0`, TCP, destination port **80**
- Source `0.0.0.0/0`, TCP, destination port **443**
- (optional, for HTTP/3) Source `0.0.0.0/0`, UDP, destination port **443**

### Step 4: Get a free domain name (DuckDNS, no card)
1. Sign in at duckdns.org, create a subdomain (for example `yourname-rbi`), and set its IP to your VM's public IP.
2. You now have `yourname-rbi.duckdns.org`. Let's Encrypt needs a real hostname; a bare IP won't get a certificate.
3. Check it: `ping yourname-rbi.duckdns.org` should show your VM's IP.

### Step 5: Prepare the VM
```bash
ssh ubuntu@YOUR_VM_IP
git clone https://github.com/JahangirB/Browser-.git rbi && cd rbi
git checkout ccr-404a0a3f-t5worg      # or main, once merged
bash scripts/setup-host.sh            # firewall, Docker, swap, auto-updates
exit                                  # log out and back in for the docker group
```

### Step 6: Configure and launch
```bash
ssh ubuntu@YOUR_VM_IP && cd rbi
cp .env.example .env
openssl rand -base64 24               # copy this as your password
nano .env                             # set DOMAIN, RBI_PASSWORD, TZ, BROWSER_LANG
docker compose up -d --build          # first build: ~5–10 min on ARM
docker compose logs -f                # wait for "[chromium] ready" and Caddy's "certificate obtained"
```

### Step 7: Open it
Go to `https://yourname-rbi.duckdns.org`, enter your password, and browse.

---

## 4. Verifying it works

```bash
docker compose ps                                   # both services "running", rbi "healthy"
curl -sI https://yourname-rbi.duckdns.org/login     # HTTP/2 200 with a valid certificate
curl -s  https://yourname-rbi.duckdns.org/healthz   # "ok"
curl -so /dev/null -w '%{http_code}\n' https://yourname-rbi.duckdns.org/   # 303 → /login (protected)
```

In the UI:
1. **Stream and input:** click a search box and type. Text appears within about 100 ms.
2. **Native popups:** open any `<select>` dropdown or right-click; the menu should appear.
3. **Stealth:** visit `https://bot.sannysoft.com` and check that the WebDriver row reads *missing (passed)*. Also try `https://abrahamjuliot.github.io/creepjs/`.
4. **Cloudflare:** visit `https://nowsecure.nl`; pass the checkbox if one appears.
5. **Persistence:** log in to a site, run `docker compose restart rbi`, reload your tab. You should still be logged in and your tabs should be back.
6. **Clipboard:** select text remotely and press Ctrl/⌘+C; it lands in your laptop clipboard. Ctrl/⌘+V pastes your laptop clipboard into the remote page.

---

## 5. Daily use

- **Keyboard:** everything is forwarded. On a Mac, ⌘ acts as Ctrl remotely, so ⌘C, ⌘V and ⌘A work. Shortcuts your own browser reserves (Ctrl+W, Ctrl+T, Ctrl+N) can't be captured; use the tab bar buttons instead.
- **Full screen** (⛶) gives the canvas the whole display. Set `SCREEN_WIDTH` and `SCREEN_HEIGHT` in `.env` to your window size for 1:1 sharpness.
- **One controller at a time:** opening the app in a second window takes over; the first shows "Take control here".
- **Update Chromium** (do this monthly, since Debian ships security fixes):
  `git pull && docker compose build --pull && docker compose up -d`
- **Reset the profile** (log out of everything): `docker compose down && docker volume rm rbi_rbi-data && docker compose up -d`. The volume name is `<folder>_rbi-data`; check with `docker volume ls`.

---

## 6. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Browser can't reach the site at all | Check both firewalls: the Oracle Security List (step 3) **and** the VM's iptables (`sudo iptables -L INPUT -n --line-numbers`; ACCEPT rules for 80/443 must come before the REJECT rule). Re-run `scripts/setup-host.sh` if needed |
| Caddy logs `challenge failed` / no certificate | DuckDNS isn't pointing at the VM yet, or port 80 is blocked. Let's Encrypt needs **port 80** open. Check with `dig +short yourname-rbi.duckdns.org` |
| Page loads but stays on "Disconnected / Reconnecting" | The WebSocket is blocked. A corporate proxy or antivirus "HTTPS inspection" can kill WSS; try another network. Check the browser console for `/ws` errors. A 401 on `/ws` means your session expired; sign in again |
| Login always says "Wrong password" | `RBI_PASSWORD` has quotes or trailing spaces in `.env`. Edit it, then `docker compose up -d` |
| "Too many attempts" | 8 failures from one IP lock it for 15 minutes. Wait, or `docker compose restart rbi` |
| Black screen, `[chromium] crashing repeatedly` in logs | Run `docker compose logs rbi`. Usually `/dev/shm` is too small (keep `shm_size: 1gb`) or the profile is corrupt (reset the profile, see above) |
| Logs say `sandbox start failed; retrying with --no-sandbox` | The host blocks the user namespaces Chromium's sandbox needs (common on Ubuntu 24.04 because of an AppArmor restriction). It still works; the non-root, capability-free container is then the isolation boundary. To re-enable the sandbox: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (persist it in `/etc/sysctl.d/`), then set `CHROMIUM_SANDBOX=on` |
| High memory use | Check `docker stats`. Each tab is a separate process, so close tabs you don't need. `mem_limit: 8g` stops Chromium from taking down the VM, and swap cushions spikes. Heavy SPAs such as Gmail or Figma use 500 MB+ each |
| Stream is laggy or choppy | Lower `FPS` (10) or raise `JPEG_QUALITY` (10–12) for slow links. Use a smaller screen (1280×720). CPU cost is about 0 when the page is still, because unchanged frames are dropped |
| Typed accented or emoji characters | Characters missing from the US keymap are inserted as text automatically. Dead-key compositions (for example ´ then e) aren't supported; type the final character or paste it |
| Cloudflare loops on "Verify you are human" | The IP reputation is the limiting factor. Click the checkbox, wait, and avoid hammering reloads. Matching `TZ` and `BROWSER_LANG` to your real location helps |
| Oracle "Out of host capacity" | A1 capacity is scarce in some regions. Retry at off-peak hours or try another availability domain; PAYG accounts get capacity more readily |

---

## 7. Security model

- **Only Caddy is reachable** (80/443). The app's port 8080 is on the internal Docker network only; DevTools listens on a random `127.0.0.1` port inside the container.
- **Auth:** one password from `.env`, compared in constant time. The session is an HMAC-signed `HttpOnly; Secure; SameSite=Strict` cookie, valid for 7 days. The signing key lives on the data volume and is mixed with the password, so **changing the password logs out every session**. Lockout: 8 failures per IP per 15 minutes.
- **WebSocket:** requires the session cookie **and** a same-origin `Origin` header, which blocks cross-site WebSocket hijacking.
- **Headers:** strict CSP (no inline scripts), `frame-ancestors 'none'`, HSTS, `nosniff`, and a same-origin referrer policy.
- **Container:** runs as the non-root `node` user with all Linux capabilities dropped and `no-new-privileges`. Memory and PID limits are set.
- **Address bar:** only `http(s)://` and `about:blank` are accepted, so `file://`, `javascript:` and `chrome://` can't be typed.
- **Your data:** the Chromium profile holds live session cookies for every site you log in to. Protect the VM's SSH key, and treat the `rbi-data` volume as sensitive.

## 8. Known limitations

- No audio and no file upload/download passthrough. Downloads stay inside the container.
- One user and one controller at a time, by design.
- The screen size is fixed per deployment; the client scales it to fit your window.
