'use strict';
// Client for the myVAILLANT cloud (the service behind the myVAILLANT app).
// Unofficial: Vaillant publishes no API, so this follows what the app does and can break if they change it.
// Zero dependencies: Node's built-in fetch and crypto.

const crypto = require('crypto');

const CLIENT_ID = 'myvaillant';
const REDIRECT_URI = 'enduservaillant.page.link://login';
// The app's own public API key (it is in every copy of the app); not a secret of yours.
const APIM_KEY = '1e0a2f3511fb4c5bbb1c7f9fedd20b1c';
const DEFAULTS = {
  identityBase: 'https://identity.vaillant-group.com',
  apiBase: 'https://api.vaillant-group.com/service-connected-control',
};

function realmOf(brand, country) {
  if (['bulex', 'glow-worm', 'demirdokum'].includes(brand) || !country) return `${brand}-b2c`;
  return `${brand}-${country}-b2c`;
}

function pkce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(128);
  let verifier = '';
  for (let i = 0; i < 128; i++) verifier += chars[bytes[i] % chars.length];
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

// The login page asks the app to prove it did a little work (ALTCHA proof of work).
function solveAltcha(ch, maxMs = 60000) {
  const p = ch.parameters || ch;
  const alg = String(p.algorithm || 'PBKDF2/SHA-256').split('/')[1].toLowerCase().replace('sha-', 'sha');
  const digest = alg === 'sha256' || alg === 'sha384' || alg === 'sha512' ? alg : 'sha256';
  const salt = Buffer.from(p.salt, 'hex');
  const nonce = Buffer.from(p.nonce, 'hex');
  const prefix = Buffer.from(p.keyPrefix, 'hex');
  const started = Date.now();
  for (let counter = 0; ; counter++) {
    const c = Buffer.alloc(4); c.writeUInt32BE(counter);
    const key = crypto.pbkdf2Sync(Buffer.concat([nonce, c]), salt, p.cost, p.keyLength || 32, digest);
    if (key.subarray(0, prefix.length).equals(prefix)) {
      return Buffer.from(JSON.stringify({
        challenge: { parameters: p, signature: ch.signature },
        solution: { counter, derivedKey: key.toString('hex'), time: 0 },
      })).toString('base64');
    }
    if (Date.now() - started > maxMs) throw new Error('could not solve the login check in time');
  }
}

class Jar {
  constructor() { this.c = {}; }
  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const s of list) {
      const [pair] = s.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.c[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }
  header() { return Object.entries(this.c).map(([k, v]) => `${k}=${v}`).join('; '); }
}

const unescapeHtml = (s) => s.replace(/&amp;/g, '&').replace(/&#61;/g, '=').replace(/&quot;/g, '"').replace(/&#x2F;/g, '/');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class VaillantApi {
  constructor(opts) {
    this.username = opts.username;
    this.password = opts.password;
    this.brand = opts.brand || 'vaillant';
    this.country = opts.country || 'unitedkingdom';
    this.log = opts.log || (() => {});
    this.identityBase = opts.identityBase || DEFAULTS.identityBase;
    this.apiBase = opts.apiBase || DEFAULTS.apiBase;
    this.timeoutMs = opts.timeoutMs || 20000;
    this.token = null;
    this.controlIdentifiers = {};
    this.requests = 0;
  }

  get realm() { return realmOf(this.brand, this.country); }
  get authRoot() { return `${this.identityBase}/auth/realms/${this.realm}`; }

  async _fetch(url, init = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
  }

  async login() {
    const jar = new Jar();
    const { verifier, challenge } = pkce();
    const qs = new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, code: 'code_challenge', redirect_uri: REDIRECT_URI,
      code_challenge_method: 'S256', code_challenge: challenge,
    });
    const first = await this._fetch(`${this.authRoot}/protocol/openid-connect/auth?${qs}`, { redirect: 'manual' });
    jar.absorb(first);
    let code;
    const loc0 = first.headers.get('location');
    if (loc0) {
      code = new URL(loc0, this.identityBase).searchParams.get('code');
    } else {
      const html = await first.text();
      const m = html.match(new RegExp(`${esc(this.authRoot)}/login-actions/authenticate\\?([^"]*)`));
      if (!m) throw new Error('could not find the login form (wrong country or brand?)');
      const loginUrl = unescapeHtml(m[0]);
      const form = { username: this.username, password: this.password, credentialId: '' };
      try {
        const ac = await this._fetch(`${this.identityBase}/api/altcha/challenge`);
        if (ac.ok) form.altcha = solveAltcha(await ac.json());
      } catch (e) { this.log(`login check skipped: ${e.message}`); }
      const res = await this._fetch(loginUrl, {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
        body: new URLSearchParams(form),
      });
      jar.absorb(res);
      const loc = res.headers.get('location');
      if (!loc) throw new Error('login failed: check the myVAILLANT email, password, country and brand');
      code = new URL(loc, this.identityBase).searchParams.get('code');
    }
    if (!code) throw new Error('login failed: no code returned');
    const res = await this._fetch(`${this.authRoot}/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: CLIENT_ID, code, code_verifier: verifier, redirect_uri: REDIRECT_URI,
      }),
    });
    if (!res.ok) throw new Error(`token request failed (${res.status})`);
    this._setToken(await res.json());
  }

  _setToken(j) {
    this.token = { ...j, expiresAt: Date.now() + (Number(j.expires_in) || 300) * 1000 };
  }

  async _ensureToken() {
    if (!this.token) return this.login();
    if (Date.now() < this.token.expiresAt - 60000) return;
    try {
      const res = await this._fetch(`${this.authRoot}/protocol/openid-connect/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: this.token.refresh_token }),
      });
      if (!res.ok) throw new Error(String(res.status));
      this._setToken(await res.json());
    } catch (e) {
      this.log(`token refresh failed (${e.message}); logging in again`);
      await this.login();
    }
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.token.access_token}`,
      'x-app-identifier': 'VAILLANT',
      'Accept-Language': 'en-GB',
      Accept: 'application/json, text/plain, */*',
      'x-client-locale': 'en-GB',
      'x-idm-identifier': 'KEYCLOAK',
      'ocp-apim-subscription-key': APIM_KEY,
      'User-Agent': 'okhttp/4.9.2',
      'Content-Type': 'application/json',
    };
  }

  async request(method, url, body, retried = false) {
    await this._ensureToken();
    this.requests++;
    const res = await this._fetch(url, {
      method, headers: this._headers(), body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !retried) { this.token = null; return this.request(method, url, body, true); }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`${method} ${url.replace(this.apiBase, '')} -> ${res.status} ${text.slice(0, 120)}`);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  get tli() { return `${this.apiBase}/end-user-app-api/v1`; }

  async homes() { return this.request('GET', `${this.tli}/homes`); }

  async controlIdentifier(systemId) {
    if (this.controlIdentifiers[systemId]) return this.controlIdentifiers[systemId];
    let ci = 'tli';
    try {
      const j = await this.request('GET', `${this.tli}/systems/${systemId}/tli/meta-info/control-identifier`);
      ci = (j.controlIdentifier || 'tli').toLowerCase();
    } catch (e) { this.log(`control identifier not read (${e.message}); assuming tli`); }
    this.controlIdentifiers[systemId] = ci;
    return ci;
  }

  async systemBase(systemId) {
    const ci = await this.controlIdentifier(systemId);
    if (ci === 'tli') return `${this.tli}/systems/${systemId}/tli`;
    if (ci === 'vrc700') return `${this.apiBase}/vrc700/v1/systems/${systemId}`;
    if (ci === 'scf') return `${this.apiBase}/scf/v1/systems/${systemId}`;
    throw new Error(`unsupported control type "${ci}"`);
  }

  async system(systemId) {
    const base = await this.systemBase(systemId);
    const res = await (async () => { await this._ensureToken(); return this._fetch(base, { headers: this._headers() }); })();
    this.requests++;
    if (!res.ok) throw new Error(`system -> ${res.status}`);
    // VRC700 calls hot water "domesticHotWater" in places and "dhw" in others; make it one name.
    return JSON.parse((await res.text()).replace(/domesticHotWater/g, 'dhw').replace(/DomesticHotWater/g, 'Dhw'));
  }

  currentSystem(id) { return this.request('GET', `${this.tli}/emf/v2/${id}/currentSystem`); }
  troubleCodes(id) { return this.request('GET', `${this.tli}/systems/${id}/tli/diagnostic-trouble-codes`); }
  connection(id) { return this.request('GET', `${this.tli}/systems/${id}/tli/meta-info/connection-status`); }
  rts(id) { return this.request('GET', `${this.tli}/rts/${id}/devices`); }
  mpc(id) { return this.request('GET', `${this.tli}/hem/${id}/mpc`); }
  buckets(id, deviceUuid, { resolution, operationMode, energyType, start, end }) {
    const q = new URLSearchParams({ resolution, operationMode, energyType, startDate: start, endDate: end });
    return this.request('GET', `${this.tli}/emf/v2/${id}/devices/${deviceUuid}/buckets?${q}`);
  }

  // Writes. Only hot water boost is used by the plugin.
  async setBoost(systemId, index, on) {
    const base = await this.systemBase(systemId);
    const url = `${base}/domestic-hot-water/${index}/boost`;
    return on ? this.request('POST', url, {}) : this.request('DELETE', url);
  }
}

module.exports = { VaillantApi, realmOf, pkce, solveAltcha, Jar, APIM_KEY };
