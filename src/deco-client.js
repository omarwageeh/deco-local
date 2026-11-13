'use strict';

// Client for the TP-Link Deco local HTTP API (the same API the Deco's own
// web UI at https://<deco-ip>/webpages/ uses). Works without internet.
//
// Protocol, as implemented by the firmware's tpEncrypt.js / frame.js:
//   1. POST /login?form=keys  -> RSA key used to encrypt the password
//   2. POST /login?form=auth  -> RSA key used to sign requests, plus `seq`
//   3. Pick a random 16-digit AES-128-CBC key and IV.
//   4. Every request body is `sign=<hex>&data=<base64>` where
//        data = AES(JSON payload)
//        sign = RSA_PKCS1(  "k=<key>&i=<iv>&h=<md5('admin'+pwd)>&s=<seq+len(data)>"  ) for login
//               RSA_PKCS1(  "h=<md5('admin'+pwd)>&s=<seq+len(data)>"  )                otherwise
//      and responses are `{"data": AES(JSON)}`.
//   5. Login returns `stok` (goes into the URL) and a `sysauth` cookie.

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const UNENCRYPTED_PATHS = new Set(['/login?form=keys', '/login?form=auth']);

const ERROR_MESSAGES = {
  '-5002': 'Wrong password.',
  '-5003': 'Too many failed login attempts. The Deco has locked login for a while.',
  '-5007': 'Too many failed login attempts. The Deco has locked login.',
  '-5001': 'Another admin session took over (web UI or another copy of this app).',
  timeout: 'Session expired.',
};

class DecoError extends Error {
  constructor(message, { code, result } = {}) {
    super(message);
    this.name = 'DecoError';
    this.code = code;
    this.result = result;
  }
}

function hexToBase64Url(hex) {
  let h = hex.replace(/^0+/, '');
  if (h.length % 2) h = '0' + h;
  return Buffer.from(h, 'hex').toString('base64url');
}

function rsaEncrypt(text, nHex, eHex) {
  const key = crypto.createPublicKey({
    key: { kty: 'RSA', n: hexToBase64Url(nHex), e: hexToBase64Url(eHex) },
    format: 'jwk',
  });
  const modulusBytes = Math.ceil(BigInt('0x' + nHex).toString(2).length / 8);
  const blockSize = modulusBytes - 11; // PKCS#1 v1.5 overhead
  const input = Buffer.from(text, 'utf8');
  let out = '';
  for (let i = 0; i < input.length; i += blockSize) {
    out += crypto
      .publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, input.subarray(i, i + blockSize))
      .toString('hex');
  }
  return out;
}

function aesEncrypt(text, key, iv) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

function aesDecrypt(b64, key, iv) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  return Buffer.concat([decipher.update(Buffer.from(b64, 'base64')), decipher.final()]).toString('utf8');
}

function randomDigits(n) {
  let s = '';
  while (s.length < n) s += crypto.randomInt(0, 10);
  return s;
}

function httpPost(url, { headers = {}, body = '', timeoutMs = 15000 } = {}) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const lib = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      {
        method: 'POST',
        // Decos use a self-signed certificate.
        rejectUnauthorized: false,
        headers: { 'Content-Length': Buffer.byteLength(body), ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Timed out connecting to ${u.host}`)));
    req.on('error', reject);
    req.end(body);
  });
}

function errorFor(code, result) {
  const msg = ERROR_MESSAGES[String(code)] || `Deco returned error ${code}.`;
  return new DecoError(msg, { code, result });
}

class DecoClient {
  constructor({ host, password, timeoutMs = 15000 }) {
    if (!host) throw new Error('host is required');
    this.host = host.trim().replace(/\/+$/, '');
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.hash = crypto.createHash('md5').update('admin' + password).digest('hex');
    this.baseUrl = /^https?:\/\//i.test(this.host) ? this.host : null;
    this._queue = Promise.resolve();
    this._reset();
  }

  _reset() {
    this.stok = '';
    this.cookie = '';
    this.seq = null;
    this.signKey = null;
    this.pwdKey = null;
    this.aesKey = randomDigits(16);
    this.aesIv = randomDigits(16);
    this.loggedIn = false;
  }

  _url(path) {
    return `${this.baseUrl}/cgi-bin/luci/;stok=${this.stok}${path}`;
  }

  // Newer firmware redirects http -> https; older firmware may only speak http.
  async _resolveBaseUrl() {
    if (this.baseUrl) return;
    for (const scheme of ['https', 'http']) {
      try {
        const res = await httpPost(`${scheme}://${this.host}/cgi-bin/luci/;stok=/login?form=keys`, {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation: 'read' }),
          timeoutMs: this.timeoutMs,
        });
        if (res.status === 200 && res.body.trim().startsWith('{')) {
          this.baseUrl = `${scheme}://${this.host}`;
          return;
        }
      } catch {
        // try next scheme
      }
    }
    throw new DecoError(`Could not reach a Deco at ${this.host}. Check the IP and that you're on its network.`, {
      code: 'unreachable',
    });
  }

  async _plainPost(path, payload) {
    const res = await httpPost(this._url(path), {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: this.timeoutMs,
    });
    let json;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new DecoError(`Unexpected response from ${path} (HTTP ${res.status}).`);
    }
    if (json.error_code !== 0) throw errorFor(json.error_code, json.result);
    return json.result;
  }

  async _encryptedPost(path, payload, { isLogin = false } = {}) {
    const data = aesEncrypt(JSON.stringify(payload), this.aesKey, this.aesIv);
    const signText =
      (isLogin ? `k=${this.aesKey}&i=${this.aesIv}&` : '') + `h=${this.hash}&s=${this.seq + data.length}`;
    const sign = rsaEncrypt(signText, this.signKey[0], this.signKey[1]);
    // The web UI posts form-encoded data while labelling it application/json; mirror that exactly.
    const body = `sign=${sign}&data=${encodeURIComponent(data)}`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.cookie) headers.Cookie = this.cookie;

    const res = await httpPost(this._url(path), { headers, body, timeoutMs: this.timeoutMs });

    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      const auth = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('sysauth='));
      if (auth) this.cookie = auth;
    }

    if (res.status === 401 || res.status === 403) throw errorFor('timeout');
    let json;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new DecoError(`Unexpected response from ${path} (HTTP ${res.status}).`);
    }
    if (typeof json.data === 'string') {
      try {
        json = JSON.parse(aesDecrypt(json.data, this.aesKey, this.aesIv));
      } catch {
        throw errorFor('timeout');
      }
    } else if (json.data === undefined && json.error_code === undefined) {
      throw errorFor('timeout');
    }
    const code = json.error_code ?? json.errorcode;
    if (code !== 0 && json.success !== true) throw errorFor(code, json.result);
    return json.result ?? json.data ?? {};
  }

  async login() {
    this._reset();
    await this._resolveBaseUrl();
    const keys = await this._plainPost('/login?form=keys', { operation: 'read' });
    this.pwdKey = keys.password;
    const auth = await this._plainPost('/login?form=auth', { operation: 'read' });
    this.signKey = auth.key;
    this.seq = parseInt(auth.seq, 10);

    const encryptedPassword = rsaEncrypt(this.password, this.pwdKey[0], this.pwdKey[1]);
    const result = await this._encryptedPost(
      '/login?form=login',
      { operation: 'login', params: { password: encryptedPassword } },
      { isLogin: true }
    );
    if (!result.stok) throw new DecoError('Login succeeded but the Deco returned no session token.');
    this.stok = result.stok;
    this.loggedIn = true;
    return result;
  }

  // Call any admin endpoint, e.g. request('admin/device?form=device_list', 'read').
  // Requests are serialized so a re-login can't race with other requests.
  request(path, operation = 'read', params) {
    const run = this._queue.then(() => this._request(path, operation, params));
    this._queue = run.catch(() => {});
    return run;
  }

  // Re-logs in once if the session expired or was taken over.
  async _request(path, operation, params) {
    const p = '/' + path.replace(/^\/+/, '');
    const payload = { operation };
    if (params !== undefined) payload.params = params;
    if (!this.loggedIn) await this.login();
    try {
      return await this._encryptedPost(p, payload);
    } catch (err) {
      if (err instanceof DecoError && (err.code === 'timeout' || err.code === -5001)) {
        await this.login();
        return this._encryptedPost(p, payload);
      }
      throw err;
    }
  }

  async logout() {
    if (!this.loggedIn) return;
    try {
      await this._encryptedPost('/admin/system?form=logout', { operation: 'logout' });
    } catch {
      // best effort
    }
    this._reset();
  }
}

module.exports = { DecoClient, DecoError, rsaEncrypt, aesEncrypt, aesDecrypt };
