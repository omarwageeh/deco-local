'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { DecoClient, DecoError } = require('./deco-client');
const { withTmp, TmpError, OP, TMP_PORT } = require('./tmp-client');

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

// Several tabs need these lists; a short cache lets switching tabs reuse them.
const listDecos = (client) => client.request('admin/device?form=device_list', 'read', undefined, { cacheMs: 5000 });
const listClients = (client, mac = 'default') =>
  client.request('admin/client?form=client_list', 'read', { device_mac: mac }, { cacheMs: 3000 });

// ---------- Operation mode (via the Deco app's TMP protocol) ----------

// The HTTP API can only read the mode; switching needs TMP, which logs in with the
// TP-Link ID email + password. Credentials stay in memory; only the email and the
// Deco's SSH key fingerprint are saved.
const SWITCHABLE_MODES = ['Router', 'AP'];
const MODE_LABELS = { Router: 'Router', AP: 'Access Point', Repeater: 'Repeater', RE: 'Repeater' };
// After a write the Deco may close its control port for ~60-95 s, and connecting during
// that time keeps it closed longer. Like ukbodypilot/deco-local, we block new TMP
// sessions and watch the port: release once it's back, or after 25 s if it never closed.
const tmpLockoutMs = () => parseInt(process.env.DECO_TMP_LOCKOUT_MS || String(150 * 1000), 10);
const tmpProbeMs = () => parseInt(process.env.DECO_TMP_PROBE_MS || '5000', 10); // faster probing prolongs the outage
const tmpNeverClosedMs = () => 5 * tmpProbeMs();
const tmpCreds = new Map(); // host -> { email, password }
const tmpBusyUntil = new Map(); // host -> timestamp
const tmpWatchers = new Map(); // host -> watcher id

function portOpen({ host, port }) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(2000, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function markTmpWrite(host) {
  const cap = tmpLockoutMs();
  if (!cap) return;
  const started = Date.now();
  tmpBusyUntil.set(host, started + cap);
  const id = Symbol(host);
  tmpWatchers.set(host, id);
  let wentDown = false;
  const release = () => {
    if (tmpWatchers.get(host) !== id) return;
    tmpWatchers.delete(host);
    tmpBusyUntil.delete(host);
  };
  const probe = async () => {
    if (tmpWatchers.get(host) !== id || Date.now() >= started + cap) return release();
    const open = await portOpen(tmpTarget(host));
    if (!open) wentDown = true;
    else if (wentDown || Date.now() - started >= tmpNeverClosedMs()) {
      // Back up (or never went down): confirm once more so a brief flap doesn't release early.
      await new Promise((r) => setTimeout(r, tmpProbeMs()).unref());
      if (await portOpen(tmpTarget(host))) return release();
    }
    setTimeout(probe, tmpProbeMs()).unref();
  };
  setTimeout(probe, tmpProbeMs()).unref();
}

const modeLabel = (m) => (m ? MODE_LABELS[m] || m : null);

function tmpTarget(host) {
  const hostname = host
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
  return { host: hostname, port: parseInt(process.env.DECO_TMP_PORT || TMP_PORT, 10) };
}

function busySeconds(host) {
  return Math.max(0, Math.ceil(((tmpBusyUntil.get(host) || 0) - Date.now()) / 1000));
}

function modeList(result) {
  const list = Array.isArray(result?.modeList) ? result.modeList : [];
  return list
    .map((x) => (typeof x === 'string' ? x : x && (x.mode ?? x.name ?? x.value)))
    .filter((x) => typeof x === 'string');
}

function tmpConfigFor(host) {
  return (loadConfig().tmp || {})[host] || {};
}

function saveTmpConfig(host, patch) {
  const cfg = loadConfig();
  cfg.tmp = cfg.tmp || {};
  cfg.tmp[host] = { ...cfg.tmp[host], ...patch };
  saveConfig(cfg);
}

async function tmpSession(s, body, fn) {
  const wait = busySeconds(s.host);
  if (wait) throw new TmpError(`The Deco is still applying the last change. Try again in about ${wait} s.`, 'busy');
  const known = tmpCreds.get(s.host) || {};
  const email = String(body.email || known.email || '').trim();
  // Leaving the password blank reuses the one used to log in to this app.
  const password = String(body.password || (body.email ? '' : known.password) || s.client.password || '');
  if (!email) throw Object.assign(new Error('Enter your TP-Link ID email.'), { status: 400 });

  const pinned = tmpConfigFor(s.host).hostKeySha256 || null;
  try {
    return await withTmp({ ...tmpTarget(s.host), email, password, hostKeySha256: pinned }, async (c) => {
      const result = await fn(c);
      tmpCreds.set(s.host, { email, password });
      saveTmpConfig(s.host, { email, hostKeySha256: c.hostKeySha256 || pinned });
      return result;
    });
  } catch (err) {
    // Never retry rejected credentials automatically: the Deco locks out on repeated failures.
    if (err.code === 'auth') tmpCreds.delete(s.host);
    throw err;
  }
}

// ---------- Internet (WAN) settings ----------

// Field names differ between firmware and protocols and aren't documented, so we show
// every field the Deco reports, labelling the ones we recognise.
const FIELD_LABELS = {
  dial_type: 'Connection type',
  ip: 'IP address',
  mask: 'Subnet mask',
  gateway: 'Gateway',
  dns1: 'Primary DNS',
  dns2: 'Secondary DNS',
  mtu: 'MTU',
  mtu_size: 'MTU',
  enable_auto_dns: 'Automatic DNS',
  enable_ping: 'Respond to ping',
  username: 'Username',
  user_name: 'Username',
  account: 'Username',
  password: 'Password',
  pwd: 'Password',
  service_name: 'Service name',
  server: 'Server',
  mac: 'MAC address',
  mac_addr: 'MAC address',
  inet_status: 'Status',
};
const DIAL_TYPES = {
  dynamic_ip: 'Dynamic IP',
  static_ip: 'Static IP',
  pppoe: 'PPPoE',
  l2tp: 'L2TP',
  pptp: 'PPTP',
  dslite: 'DS-Lite',
  lte: 'Mobile',
};
const SECRET_KEY = /pass|pwd|secret/i;
const USER_TEXT_KEY = /pass|pwd|secret|user|account|service_name/i;

// Flattens nested objects into labelled rows: { path, label, value, secret }.
function wanRows(obj, prefix = '') {
  const rows = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      rows.push(...wanRows(v, path));
      continue;
    }
    if (Array.isArray(v) && v.some((x) => x && typeof x === 'object')) continue;
    let value = Array.isArray(v) ? v.join(', ') : v;
    // The Deco base64-encodes user-entered text like names and passwords.
    if (typeof value === 'string' && USER_TEXT_KEY.test(k)) value = b64(value);
    if (k === 'dial_type') value = DIAL_TYPES[value] || value;
    rows.push({
      path,
      group: prefix ? prefix.split('.').map(prettyKey).join(' › ') : '',
      label: FIELD_LABELS[k] || prettyKey(k),
      value: value == null ? '' : String(value),
      secret: SECRET_KEY.test(k),
    });
  }
  return rows;
}

// Editing follows the Deco app's internet settings screen (IPv4ConnectionDetailFragment in
// app 3.10.666): opcode 0x4005 with {"wan": {...}}, user text base64-encoded, and PPPoE
// credentials sent only when changed so the Deco keeps the saved password otherwise.
const EDITABLE_WAN = {
  dynamic_ip: { label: 'Dynamic IP', mtu: [576, 1500] },
  static_ip: { label: 'Static IP', mtu: [576, 1500] },
  pppoe: { label: 'PPPoE', mtu: [576, 1492] },
};
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const strictB64Decode = (s) =>
  typeof s === 'string' && s && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0
    ? Buffer.from(s, 'base64').toString('utf8')
    : s || '';

function wanCurrent(wan = {}) {
  const ip = wan.ip_info || {};
  return {
    type: wan.dial_type || null,
    label: DIAL_TYPES[wan.dial_type] || wan.dial_type || null,
    editable: !!EDITABLE_WAN[wan.dial_type],
    username: strictB64Decode(wan.user_info?.username),
    supportMtu: wan.support_mtu_size !== false,
    mtu: wan.mtu_size ?? null,
    autoDns: wan.enable_auto_dns !== false,
    dns1: ip.dns1 || '',
    dns2: ip.dns2 || '',
    ip: ip.ip || '',
    mask: ip.mask || '',
    gateway: ip.gateway || '',
  };
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });

function buildWanWrite(cur, body) {
  const type = String(body.type || '');
  const spec = EDITABLE_WAN[type];
  if (!spec) throw bad('Choose PPPoE, Dynamic IP or Static IP.');
  const wan = { dial_type: type, support_mtu_size: cur.supportMtu };

  if (cur.supportMtu) {
    const mtu = Number(body.mtu);
    if (!Number.isInteger(mtu) || mtu < spec.mtu[0] || mtu > spec.mtu[1]) {
      throw bad(`MTU must be between ${spec.mtu[0]} and ${spec.mtu[1]} for ${spec.label}.`);
    }
    wan.mtu_size = mtu;
  }

  const dns = () => {
    const dns1 = String(body.dns1 || '').trim();
    const dns2 = String(body.dns2 || '').trim();
    if (!IPV4.test(dns1)) throw bad('Enter a valid primary DNS address.');
    if (dns2 && !IPV4.test(dns2)) throw bad('Enter a valid secondary DNS address.');
    return { dns1, dns2 };
  };

  if (type === 'static_ip') {
    const ip = {};
    for (const [k, name] of [['ip', 'IP address'], ['mask', 'subnet mask'], ['gateway', 'gateway']]) {
      ip[k] = String(body[k] || '').trim();
      if (!IPV4.test(ip[k])) throw bad(`Enter a valid ${name}.`);
    }
    wan.ip_info = { ...ip, ...dns() };
    return wan;
  }

  wan.enable_auto_dns = body.autoDns !== false;
  if (!wan.enable_auto_dns) wan.ip_info = dns();

  if (type === 'pppoe') {
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    if (!username) throw bad('Enter the PPPoE username from your ISP.');
    const switching = cur.type !== 'pppoe';
    if (switching && !password) throw bad('Enter the PPPoE password from your ISP.');
    const userInfo = {};
    if (switching || username !== cur.username) userInfo.username = Buffer.from(username, 'utf8').toString('base64');
    if (password) userInfo.password = Buffer.from(password, 'utf8').toString('base64');
    if (Object.keys(userInfo).length) wan.user_info = { ...userInfo, auto_config: false };
  }
  return wan;
}

// ---------- DHCP (via TMP) ----------

// Follows the Deco app 3.10.666: server settings via 0x4213/0x4214 (DHCPServerBean),
// reservations via 0x40C0-0x40C3 (removed by MAC), leases via 0x423D.
const DHCP_LEASE_MAX_MIN = 1440; // the app's limit; lease_time is in minutes
const TMP_READ_GAP_MS = 300; // back-to-back reads have been seen to upset the control port
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const ipToInt = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0) >>> 0;
const sameSubnet = (a, b, mask) => ((ipToInt(a) & ipToInt(mask)) >>> 0) === ((ipToInt(b) & ipToInt(mask)) >>> 0);

function normalizeMac(s) {
  const hex = String(s || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) throw bad('Enter a MAC address like AA-BB-CC-DD-EE-FF.');
  return hex.match(/../g).join('-');
}

// A usable host address on the Deco's LAN that isn't the Deco itself.
function checkLanAddress(ip, server, mask, what) {
  ip = String(ip || '').trim();
  if (!IPV4.test(ip)) throw bad(`Enter a valid ${what}.`);
  if (!sameSubnet(ip, server.gateway, mask)) throw bad(`The ${what} must be on the Deco's network (${server.gateway} / ${mask}).`);
  const host = (ipToInt(ip) & ~ipToInt(mask)) >>> 0;
  if (host === 0 || host === ~ipToInt(mask) >>> 0) throw bad(`The ${what} can't be the network or broadcast address.`);
  if (ip === server.gateway) throw bad(`The ${what} can't be the Deco's own address.`);
  return ip;
}

async function lanMask(client) {
  const r = await settle(client.request('admin/network?form=wan_ipv4'));
  return (r.ok && r.value.lan?.ip_info?.mask) || '255.255.255.0';
}

async function readDhcp(c) {
  const server = (await c.call(OP.DHCP_SERVER)) || {};
  await pause(TMP_READ_GAP_MS);
  const reservations = (await c.call(OP.RESERVATIONS)) || {};
  await pause(TMP_READ_GAP_MS);
  const leases = (await c.call(OP.DHCP_LEASES)) || {};
  return { server, reservations, leases };
}

async function dhcpView(client, raw, mask) {
  const r = await settle(listClients(client));
  const names = new Map(r.ok ? (r.value.client_list || []).map((c) => [c.mac, b64(c.name)]) : []);
  const reservations = (raw.reservations.reservation_list || []).map((x) => ({ ip: x.ip, mac: x.mac, name: names.get(x.mac) || '' }));
  const reserved = new Set(reservations.map((x) => x.mac));
  const sv = raw.server;
  return {
    server: {
      start: sv.start_ip || '',
      end: sv.end_ip || '',
      gateway: sv.gateway || '',
      mask,
      dns1: sv.dns1 || '',
      dns2: sv.dns2 || '',
      leaseTime: sv.lease_time ?? null,
      inUse: sv.ip_amount_in_use ?? null,
    },
    reservations,
    maxReservations: raw.reservations.reservation_list_max_count ?? null,
    leases: (raw.leases.client_lease || [])
      .map((x) => ({ ip: x.ip, mac: x.mac, name: names.get(x.mac) || '', reserved: reserved.has(x.mac) }))
      .sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip)),
  };
}

function buildDhcpServerWrite(sv, mask, body) {
  const start = checkLanAddress(body.start, sv, mask, 'start address');
  const end = checkLanAddress(body.end, sv, mask, 'end address');
  if (ipToInt(start) > ipToInt(end)) throw bad('The start address must come before the end address.');
  if (ipToInt(start) <= ipToInt(sv.gateway) && ipToInt(sv.gateway) <= ipToInt(end)) {
    throw bad(`The address range can't include the Deco's own address (${sv.gateway}).`);
  }
  const dns1 = String(body.dns1 || '').trim();
  const dns2 = String(body.dns2 || '').trim();
  if (dns1 && !IPV4.test(dns1)) throw bad('Enter a valid primary DNS address, or leave it blank.');
  if (dns2 && !IPV4.test(dns2)) throw bad('Enter a valid secondary DNS address, or leave it blank.');
  if (dns2 && !dns1) throw bad('Set a primary DNS before a secondary one.');
  const params = { gateway: sv.gateway, start_ip: start, end_ip: end, dns1, dns2 };
  // Only Decos that report a lease time let it be changed (the app hides it otherwise).
  if (sv.lease_time != null) {
    const lease = Number(body.leaseTime);
    if (!Number.isInteger(lease) || lease < 1 || lease > DHCP_LEASE_MAX_MIN) {
      throw bad(`Lease time must be between 1 and ${DHCP_LEASE_MAX_MIN} minutes.`);
    }
    params.lease_time = lease;
  }
  return params;
}

// Returns [opcode, params] for a reservation change, mirroring the app's requests.
function buildReservationWrite(raw, mask, body) {
  const list = raw.reservations.reservation_list || [];
  const sv = raw.server;
  if (body.action === 'remove') {
    const macs = (Array.isArray(body.macs) ? body.macs : [body.mac]).map(normalizeMac);
    const missing = macs.filter((m) => !list.some((r) => r.mac === m));
    if (missing.length) throw bad(`No reservation for ${missing.join(', ')}.`);
    return [OP.RESERVATION_REMOVE, { reservation_list: macs }];
  }
  const mac = normalizeMac(body.mac);
  const ip = checkLanAddress(body.ip, sv, mask, 'reserved address');
  if (body.action === 'add') {
    if (list.some((r) => r.mac === mac)) throw bad(`${mac} already has a reserved address.`);
    if (list.some((r) => r.ip === ip)) throw bad(`${ip} is already reserved for another device.`);
    const max = raw.reservations.reservation_list_max_count;
    if (max != null && list.length >= max) throw bad(`The Deco allows at most ${max} reservations.`);
    return [OP.RESERVATION_ADD, { reservation_list: [{ ip, mac }] }];
  }
  if (body.action === 'modify') {
    const originalMac = normalizeMac(body.originalMac || body.mac);
    const original = list.find((r) => r.mac === originalMac);
    if (!original) throw bad(`No reservation for ${originalMac}.`);
    if (list.some((r) => r.ip === ip && r.mac !== originalMac)) throw bad(`${ip} is already reserved for another device.`);
    if (list.some((r) => r.mac === mac && r.mac !== originalMac)) throw bad(`${mac} already has a reserved address.`);
    return [OP.RESERVATION_MODIFY, { original_ip: original.ip, original_mac: original.mac, ip, mac }];
  }
  throw bad('Unknown reservation action.');
}

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
      tmpCreds.delete(s.host);
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
      settle(listDecos(client)),
      settle(listClients(client)),
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
    const r = await listDecos(client);
    return { decos: (r.device_list || []).map(normalizeDeco) };
  },

  'GET /api/clients': async (req, res, body, { client }) => {
    const [all, decos] = await Promise.all([listClients(client), settle(listDecos(client))]);
    const list = (all.client_list || []).map(normalizeClient);
    // Ask each Deco for its own clients so we can show which one a device is attached to.
    if (decos.ok) {
      const units = (decos.value.device_list || []).map(normalizeDeco);
      const perDeco = await Promise.all(units.map((d) => settle(listClients(client, d.mac))));
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

  'GET /api/internet': async (req, res, body, { client }) => {
    const r = await client.request('admin/network?form=wan_ipv4');
    return { dialType: DIAL_TYPES[r.wan?.dial_type] || r.wan?.dial_type || null, rows: wanRows(r.wan || r) };
  },

  // The Deco app's view of the WAN (TMP wan_lan_status), which may include more than the HTTP API.
  'POST /api/internet/app': async (req, res, body, s) => {
    const r = await tmpSession(s, body, (c) => c.call(OP.WAN_LAN_STATUS));
    return { rows: wanRows(r?.wan || r || {}), current: wanCurrent(r?.wan) };
  },

  'POST /api/internet': async (req, res, body, s) => {
    if (!tmpCreds.has(s.host)) throw bad('Confirm your TP-Link ID first.');
    let wrote = false;
    try {
      return await tmpSession(s, {}, async (c) => {
        // Build from a fresh read, so "unchanged" is judged against what the Deco has now.
        const cur = wanCurrent((await c.call(OP.WAN_LAN_STATUS))?.wan);
        const wan = buildWanWrite(cur, body);
        wrote = true;
        await c.call(OP.WAN_IPV4_SET, { wan });
        let after = null;
        try {
          after = wanCurrent((await c.call(OP.WAN_LAN_STATUS))?.wan);
        } catch {}
        s.client._cache.clear();
        return { ok: true, current: after };
      });
    } finally {
      if (wrote) markTmpWrite(s.host);
    }
  },

  'POST /api/dhcp': async (req, res, body, s) => {
    const [mask, raw] = await Promise.all([lanMask(s.client), tmpSession(s, body, readDhcp)]);
    return dhcpView(s.client, raw, mask);
  },

  'POST /api/dhcp/server': async (req, res, body, s) => {
    if (!tmpCreds.has(s.host)) throw bad('Confirm your TP-Link ID first.');
    const mask = await lanMask(s.client);
    let wrote = false;
    try {
      const raw = await tmpSession(s, {}, async (c) => {
        const params = buildDhcpServerWrite((await c.call(OP.DHCP_SERVER)) || {}, mask, body);
        wrote = true;
        await c.call(OP.DHCP_SERVER_SET, params);
        await pause(TMP_READ_GAP_MS);
        return readDhcp(c);
      });
      return dhcpView(s.client, raw, mask);
    } finally {
      if (wrote) markTmpWrite(s.host);
    }
  },

  // body: { action: 'add' | 'modify' | 'remove', ip, mac, originalMac, macs }
  'POST /api/dhcp/reservations': async (req, res, body, s) => {
    if (!tmpCreds.has(s.host)) throw bad('Confirm your TP-Link ID first.');
    const mask = await lanMask(s.client);
    let wrote = false;
    try {
      const raw = await tmpSession(s, {}, async (c) => {
        const server = (await c.call(OP.DHCP_SERVER)) || {};
        await pause(TMP_READ_GAP_MS);
        const reservations = (await c.call(OP.RESERVATIONS)) || {};
        const [opcode, params] = buildReservationWrite({ server, reservations }, mask, body);
        wrote = true;
        await c.call(opcode, params);
        await pause(TMP_READ_GAP_MS);
        return readDhcp(c);
      });
      return dhcpView(s.client, raw, mask);
    } finally {
      if (wrote) markTmpWrite(s.host);
    }
  },

  'GET /api/mode': async (req, res, body, s) => {
    const r = await settle(s.client.request('admin/device?form=mode'));
    const mode = r.ok ? r.value.sysmode ?? r.value.mode ?? null : null;
    return {
      mode,
      label: modeLabel(mode),
      error: r.ok ? null : r.error,
      email: (tmpCreds.get(s.host) || {}).email || tmpConfigFor(s.host).email || '',
      verified: tmpCreds.has(s.host),
      busySeconds: busySeconds(s.host),
    };
  },

  // Logs in over TMP and reads the mode and the modes this Deco supports.
  'POST /api/mode/check': async (req, res, body, s) => {
    const result = await tmpSession(s, body, (c) => c.call(OP.OPERATION_MODE));
    const list = modeList(result);
    return {
      mode: result?.mode ?? null,
      label: modeLabel(result?.mode),
      options: SWITCHABLE_MODES.filter((m) => !list.length || list.includes(m)).map((m) => ({ mode: m, label: modeLabel(m) })),
    };
  },

  'POST /api/mode': async (req, res, body, s) => {
    const target = String(body.mode || '');
    if (!SWITCHABLE_MODES.includes(target)) throw Object.assign(new Error('Unknown operation mode.'), { status: 400 });
    if (!tmpCreds.has(s.host)) {
      throw Object.assign(new Error('Confirm your TP-Link ID first.'), { status: 400 });
    }
    let wrote = false;
    try {
      return await tmpSession(s, {}, async (c) => {
        const before = await c.call(OP.OPERATION_MODE);
        const list = modeList(before);
        if (list.length && !list.includes(target)) {
          throw Object.assign(new Error(`This Deco doesn't offer ${modeLabel(target)} mode.`), { status: 400 });
        }
        if (before?.mode === target) return { changed: false, mode: target, label: modeLabel(target) };
        wrote = true;
        await c.call(OP.OPERATION_MODE_SET, { mode: target });
        // The Deco may restart before it answers a read-back; that's expected.
        let after = null;
        try {
          after = (await c.call(OP.OPERATION_MODE))?.mode ?? null;
        } catch {}
        return { changed: true, from: before?.mode ?? null, mode: target, label: modeLabel(target), confirmed: after === target };
      });
    } finally {
      if (wrote) markTmpWrite(s.host);
    }
  },

  'GET /api/system': async (req, res, body, { client }) => {
    const [time, decos] = await Promise.all([
      settle(client.request('admin/device?form=timesetting')),
      settle(listDecos(client)),
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
    const status = err.status || (err instanceof DecoError || err instanceof TmpError ? 502 : 500);
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
