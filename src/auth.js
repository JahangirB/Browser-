'use strict';
// Password login -> signed, HttpOnly session cookie. No database needed.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'rbi_session';

class Auth {
  constructor({ password, dataDir, sessionDays }) {
    if (!password || password.length < 12) {
      throw new Error('RBI_PASSWORD must be set and at least 12 characters long');
    }
    this.pwDigest = crypto.createHash('sha256').update(password).digest();
    this.maxAge = sessionDays * 86400;
    // Random secret persisted on the data volume; mixed with the password so
    // changing RBI_PASSWORD logs out every existing session.
    const keyFile = path.join(dataDir, 'session.key');
    let secret;
    try { secret = fs.readFileSync(keyFile); } catch {
      secret = crypto.randomBytes(32);
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(keyFile, secret, { mode: 0o600 });
    }
    this.key = crypto.createHmac('sha256', secret).update(password).digest();
    this.failures = new Map(); // ip -> {count, until}
  }

  checkPassword(candidate) {
    const d = crypto.createHash('sha256').update(String(candidate || '')).digest();
    return crypto.timingSafeEqual(d, this.pwDigest);
  }

  // Simple brute-force brake: 8 bad attempts per IP -> locked for 15 minutes.
  isLocked(ip) {
    const f = this.failures.get(ip);
    return !!(f && f.count >= 8 && Date.now() < f.until);
  }

  recordFailure(ip) {
    const now = Date.now();
    let f = this.failures.get(ip);
    if (!f || now > f.until) f = { count: 0, until: now + 15 * 60 * 1000 };
    f.count++;
    this.failures.set(ip, f);
    if (this.failures.size > 10000) this.failures.clear();
  }

  clearFailures(ip) { this.failures.delete(ip); }

  sign(payload) {
    return crypto.createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  issue() {
    const payload = Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + this.maxAge,
      n: crypto.randomBytes(8).toString('hex'),
    })).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  verify(token) {
    if (!token || typeof token !== 'string') return false;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return false;
    const expected = Buffer.from(this.sign(payload));
    const got = Buffer.from(sig);
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return false;
    try {
      const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return typeof exp === 'number' && exp > Date.now() / 1000;
    } catch { return false; }
  }

  fromRequest(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return this.verify(decodeURIComponent(v.join('=')));
    }
    return false;
  }

  cookie(value, secure, maxAge) {
    return [
      `${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`,
      secure ? 'Secure' : '',
    ].filter(Boolean).join('; ');
  }
}

module.exports = { Auth };
