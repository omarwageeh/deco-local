'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DecoClient, DecoError } = require('./deco-client');

const PORT = parseInt(process.env.PORT || '8686', 10);
const BIND = process.env.BIND || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CONFIG_FILE = process.env.DECO_LOCAL_CONFIG || path.join(__dirname, '..', 'deco-config.json');
const SESSION_COOKIE = 'deco_local_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// One Deco session per host: the Deco only allows a single admin session, so
// every browser that logs in with the right password shares it.
const clients = new Map(); // host -> DecoClient
const sessions = new Map(); // token -> { host, expires }

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch {
    // non-fatal
  }
}

// ---------- helpers for Deco data ----------

// Deco base64-encodes names, SSIDs and passwords.
function b64(s) {
  if (typeof s !== 'string' || s === '') return s ?? '';
  if (s.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return s;
  const d = Buffer.from(s, 'base64').toString('utf8');
  return /[\u0000-\u0008\u000e-\u001f�]/.test(d) ? s : d;
}

const toB64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

function prettyKey(s) {
  return String(s || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeDeco(d) {
  const name = d.custom_nickname ? b64(d.custom_nickname) : prettyKey(d.nickname) || d.device_model;
  return {
    mac: d.mac,
    ip: d.device_ip,
    name,
    model: d.device_model,
    hardware: d.hardware_ver,
    firmware: d.software_ver,
    role: d.role, // "master" | "slave"
    online: d.group_status ? d.group_status === 'connected' : d.inet_status !== 'offline',
    internet: d.inet_status,
    signal: d.signal_level || null,
    connection: d.connection_type || [],
    raw: d,
  };
}

function normalizeClient(c) {
  return {
    mac: c.mac,
    ip: c.ip,
    name: b64(c.name) || c.mac,
    type: c.client_type,
    online: c.online !== false,
    connection: c.connection_type, // band2_4 | band5 | wired ...
    interface: c.interface,
    downKBps: Number(c.down_speed) || 0,
    upKBps: Number(c.up_speed) || 0,
    raw: c,
  };
}

const BANDS = ['band2_4', 'band5_1', 'band5_2', 'band6', 'band6_2'];
const BAND_LABELS = {
  band2_4: '2.4 GHz',
  band5_1: '5 GHz',
  band5_2: '5 GHz-2',
  band6: '6 GHz',
  band6_2: '6 GHz-2',
};

function normalizeWlan(w) {
  const bands = [];
  for (const key of BANDS) {
    if (!w[key]) continue;
    const net = (n) =>
      n && {
        enable: !!n.enable,
        ssid: b64(n.ssid),
        password: b64(n.password),
        hidden: n.hidden,
        channel: n.channel,
        channelWidth: n.channel_width,
        mode: n.mode,
      };
    bands.push({ key, label: BAND_LABELS[key], host: net(w[key].host), guest: net(w[key].guest) });
  }
  return { bands, raw: w };
}

// Simple settings the Deco's own web UI lets you toggle (Advanced > System Parameters).
const TOGGLES = [
  { form: 'admin/wireless?form=power', kind: 'power' },
  { form: 'admin/network?form=wifi_network', field: 'enable_wfnetwork', label: 'Wi-Fi Network', warn: 'When disabled, devices cannot connect wirelessly.' },
  { form: 'admin/network?form=erp_setting', field: 'enable_2g', label: '2.4 GHz Wi-Fi Network', warn: 'Devices will not be able to use 2.4 GHz.' },
  { form: 'admin/network?form=erp_setting', field: 'enable_5g', label: '5 GHz Wi-Fi Network', warn: 'Devices will not be able to use 5 GHz.' },
  { form: 'admin/network?form=erp_setting', field: 'enable_6g', label: '6 GHz Wi-Fi Network', warn: 'Devices will not be able to use 6 GHz.' },
  { form: 'admin/network?form=igmp_setting', field: 'enable_join_igmpv3', label: 'IGMP Feature' },
  { form: 'admin/network?form=dhcp_dial', field: 'enable_unicast', label: 'WAN Unicast' },
  { form: 'admin/network?form=flow_control', field: 'enable_flow_control', label: 'Flow Control', warn: 'LAN/WAN ports will restart and the Deco will redial.' },
  { form: 'admin/network?form=fast_xmit_setting', field: 'enable', label: 'Wireless Forward' },
];

// ---------- HTTP plumbing ----------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : headers['Content-Type'] || 'text/plain',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function sessionFor(req) {
  const token = getCookie(req, SESSION_COOKIE);
  const s = token && sessions.get(token);
  if (!s || s.expires < Date.now()) return null;
  const client = clients.get(s.host);
  return client ? { token, ...s, client } : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

// ---------- API ----------

async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
}

const routes = {
  'GET /api/session': async (req) => {
    const s = sessionFor(req);
    const cfg = loadConfig();
    return { loggedIn: !!s, host: s ? s.host : cfg.host || '' };
  },

  'POST /api/login': async (req, res, body) => {
    const host = String(body.host || '').trim();
    const password = String(body.password || '');
    if (!host || !password) throw Object.assign(new Error('Enter the Deco address and password.'), { status: 400 });

    let client = clients.get(host);
    if (!client || client.password !== password) {
      const fresh = new DecoClient({ host, password });
      await fresh.login();
      if (client) client.logout().catch(() => {});
      client = fresh;
      clients.set(host, client);
    } else if (!client.loggedIn) {
      await client.login();
    }

    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { host, expires: Date.now() + SESSION_TTL_MS });
    saveConfig({ ...loadConfig(), host });
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
    );
    return { ok: true, host };
  },

  'POST /api/logout': async (req, res, body, s) => {
    sessions.delete(s.token);
    const stillUsed = [...sessions.values()].some((x) => x.host === s.host);
    if (!stillUsed) {
      await s.client.logout();
      clients.delete(s.host);
    }
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
    return { ok: true };
  },

  'GET /api/overview': async (req, res, body, { client }) => {
    const [internet, wan, lan, perf, decos, clientsList] = await Promise.all([
      settle(client.request('admin/network?form=internet')),
      settle(client.request('admin/network?form=wan_ipv4')),
      settle(client.request('admin/network?form=lan_ip', 'read', { device_mac: 'default' })),
      settle(client.request('admin/network?form=performance')),
      settle(client.request('admin/device?form=device_list')),
      settle(client.request('admin/client?form=client_list', 'read', { device_mac: 'default' })),
    ]);
    const deviceList = decos.ok ? (decos.value.device_list || []).map(normalizeDeco) : [];
    const clientList = clientsList.ok ? (clientsList.value.client_list || []).map(normalizeClient) : [];
    const ipv4 = internet.ok ? internet.value.ipv4 || internet.value : null;
    const wanInfo = wan.ok ? wan.value.wan || {} : {};
    return {
      internet: ipv4 ? { status: ipv4.inet_status, raw: internet.value } : { error: internet.error },
      wan: wan.ok
        ? {
            dialType: wanInfo.dial_type,
            ...(wanInfo.ip_info || {}),
          }
        : { error: wan.error },
      lan: lan.ok ? { ip: lan.value.lan_ip?.ip, mask: lan.value.lan_ip?.mask, mac: lan.value.mac_addr } : { error: lan.error },
      performance: perf.ok ? { cpu: perf.value.cpu_usage, mem: perf.value.mem_usage } : { error: perf.error },
      decos: { total: deviceList.length, online: deviceList.filter((d) => d.online).length },
      clients: { total: clientList.filter((c) => c.online).length },
      main: deviceList.find((d) => d.role === 'master') || deviceList[0] || null,
    };
  },

  'GET /api/decos': async (req, res, body, { client }) => {
    const r = await client.request('admin/device?form=device_list');
    return { decos: (r.device_list || []).map(normalizeDeco) };
  },

  'GET /api/clients': async (req, res, body, { client }) => {
    const all = await client.request('admin/client?form=client_list', 'read', { device_mac: 'default' });
    const list = (all.client_list || []).map(normalizeClient);
    // Ask each Deco for its own clients so we can show which one a device is attached to.
    const decos = await settle(client.request('admin/device?form=device_list'));
    if (decos.ok) {
      const units = (decos.value.device_list || []).map(normalizeDeco);
      const perDeco = await Promise.all(
        units.map((d) => settle(client.request('admin/client?form=client_list', 'read', { device_mac: d.mac })))
      );
      const owner = new Map();
      perDeco.forEach((r, i) => {
        if (!r.ok) return;
        for (const c of r.value.client_list || []) owner.set(c.mac, units[i]);
      });
      // If the firmware ignores device_mac, every Deco returns the full list; don't guess then.
      const sizes = perDeco.filter((r) => r.ok).map((r) => (r.value.client_list || []).length);
      const filterIgnored = units.length > 1 && sizes.length > 1 && sizes.every((n) => n === list.length);
      if (owner.size && !filterIgnored) {
        for (const c of list) {
          const d = owner.get(c.mac);
          if (d) c.deco = { mac: d.mac, name: d.name };
        }
      }
    }
    return { clients: list };
  },

  'GET /api/wifi': async (req, res, body, { client }) => {
    const [wlan, power] = await Promise.all([
      client.request('admin/wireless?form=wlan'),
      settle(client.request('admin/wireless?form=power')),
    ]);
    return { ...normalizeWlan(wlan), power: power.ok ? power.value : null };
  },

  // Experimental: the Deco's local web UI only reads Wi-Fi settings; writing them
  // over this API may or may not be accepted depending on firmware.
  'POST /api/wifi': async (req, res, body, { client }) => {
    const { band, network = 'host', ssid, password, enable } = body;
    if (!BANDS.includes(band) || !['host', 'guest'].includes(network)) {
      throw Object.assign(new Error('Invalid band or network.'), { status: 400 });
    }
    const change = {};
    if (ssid !== undefined) {
      if (!ssid || Buffer.byteLength(ssid) > 32) throw Object.assign(new Error('SSID must be 1–32 bytes.'), { status: 400 });
      change.ssid = toB64(ssid);
    }
    if (password !== undefined) {
      if (password.length < 8 || password.length > 63) {
        throw Object.assign(new Error('Wi-Fi password must be 8–63 characters.'), { status: 400 });
      }
      change.password = toB64(password);
    }
    if (enable !== undefined) change.enable = !!enable;
    if (!Object.keys(change).length) throw Object.assign(new Error('Nothing to change.'), { status: 400 });
    const result = await client.request('admin/wireless?form=wlan', 'write', { [band]: { [network]: change } });
    return { ok: true, result };
  },

  'POST /api/power': async (req, res, body, { client }) => {
    const params = {};
    for (const k of ['band2_4', 'band5_1', 'band5_2', 'band6']) {
      if (body[k] === undefined) continue;
      if (!['low', 'middle', 'high'].includes(body[k])) throw Object.assign(new Error('Invalid power level.'), { status: 400 });
      params[k] = body[k];
    }
    return { ok: true, result: await client.request('admin/wireless?form=power', 'write', params) };
  },

  'GET /api/toggles': async (req, res, body, { client }) => {
    const forms = [...new Set(TOGGLES.filter((t) => t.field).map((t) => t.form))];
    const results = await Promise.all(forms.map((f) => settle(client.request(f))));
    const byForm = Object.fromEntries(forms.map((f, i) => [f, results[i]]));
    const toggles = TOGGLES.filter((t) => t.field)
      .map((t) => {
        const r = byForm[t.form];
        if (!r.ok || !r.value || !(t.field in r.value)) return null;
        if (t.field === 'enable_unicast' && r.value.is_dhcp === false) return null;
        return { form: t.form, field: t.field, label: t.label, warn: t.warn, value: !!r.value[t.field] };
      })
      .filter(Boolean);
    return { toggles };
  },

  'POST /api/toggles': async (req, res, body, { client }) => {
    const t = TOGGLES.find((x) => x.form === body.form && x.field === body.field);
    if (!t) throw Object.assign(new Error('Unknown setting.'), { status: 400 });
    return { ok: true, result: await client.request(t.form, 'write', { [t.field]: !!body.value }) };
  },

  'POST /api/reboot': async (req, res, body, { client }) => {
    const macs = Array.isArray(body.macs) ? body.macs.filter((m) => typeof m === 'string') : [];
    if (!macs.length) throw Object.assign(new Error('Pick at least one Deco.'), { status: 400 });
    const result = await client.request('admin/device?form=system', 'reboot', {
      mac_list: macs.map((mac) => ({ mac })),
    });
    return { ok: true, result };
  },

  'GET /api/system': async (req, res, body, { client }) => {
    const [time, decos] = await Promise.all([
      settle(client.request('admin/device?form=timesetting')),
      settle(client.request('admin/device?form=device_list')),
    ]);
    return {
      time: time.ok ? time.value : { error: time.error },
      decos: decos.ok ? (decos.value.device_list || []).map(normalizeDeco) : [],
    };
  },

  'GET /api/logs': async (req, res, body, { client }) => {
    let r = await settle(client.request('admin/log_export?form=feedback_log'));
    if (!r.ok || !r.value?.logList) {
      await settle(client.request('admin/log_export?form=feedback_log', 'build', {}));
      r = await settle(client.request('admin/log_export?form=feedback_log'));
    }
    if (!r.ok) throw new DecoError(r.error, { code: r.code });
    return { logs: r.value.logList || [] };
  },

  // Power-user escape hatch: call any endpoint the firmware exposes.
  'POST /api/raw': async (req, res, body, { client }) => {
    const p = String(body.path || '').trim();
    if (!/^\/?(admin|login)\/[\w-]+\?form=[\w-]+$/.test(p)) {
      throw Object.assign(new Error('Path must look like admin/device?form=device_list'), { status: 400 });
    }
    const op = String(body.operation || 'read');
    return { result: await client.request(p, op, body.params === undefined ? undefined : body.params) };
  },
};

const PUBLIC_ROUTES = new Set(['GET /api/session', 'POST /api/login']);

async function handleApi(req, res, key) {
  const handler = routes[key];
  if (!handler) return send(res, 404, { error: 'Not found' });
  let s = null;
  if (!PUBLIC_ROUTES.has(key)) {
    s = sessionFor(req);
    if (!s) return send(res, 401, { error: 'Not logged in', code: 'auth' });
  }
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    send(res, 200, await handler(req, res, body, s));
  } catch (err) {
    const status = err.status || (err instanceof DecoError ? 502 : 500);
    send(res, status, { error: err.message, code: err.code ?? null });
  }
}

function createServer() {
  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname.startsWith('/api/')) {
      // Basic CSRF guard: API writes must come from this app's own pages.
      if (req.method === 'POST' && req.headers['x-deco-local'] !== '1') {
        return send(res, 403, { error: 'Forbidden' });
      }
      return handleApi(req, res, `${req.method} ${pathname}`);
    }
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    serveStatic(req, res, pathname);
  });
}

if (require.main === module) {
  createServer().listen(PORT, BIND, () => {
    console.log(`Deco Local is running.`);
    console.log(`  On this PC:   http://localhost:${PORT}`);
    if (BIND === '0.0.0.0') {
      for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) {
          if (a.family === 'IPv4' && !a.internal) console.log(`  On your LAN:  http://${a.address}:${PORT}`);
        }
      }
    }
  });
}

module.exports = { createServer, normalizeDeco, normalizeClient, normalizeWlan, b64 };
