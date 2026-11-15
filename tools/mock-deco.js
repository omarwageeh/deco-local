'use strict';

// A fake Deco that implements the server side of the real local API protocol:
// RSA-PKCS1 password + signature checks, AES-CBC payloads, stok + sysauth cookie.
// It also runs the Deco app's TMP protocol over SSH (see src/tmp-client.js).
// Used by the tests, and runnable on its own as a demo:  npm run mock

const crypto = require('node:crypto');
const http = require('node:http');
const { Server: SshServer } = require('ssh2');
const { crc32, tmpFrame, bizPacket, parseBiz, sha1Hex, OP } = require('../src/tmp-client');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function makeRsa(bits) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
  const jwk = privateKey.export({ format: 'jwk' });
  const hex = (v) => Buffer.from(v, 'base64url').toString('hex').toUpperCase();
  return { n: hex(jwk.n), e: hex(jwk.e), d: hex(jwk.d), bytes: bits / 8 };
}

function modPow(base, exp, mod) {
  let r = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return r;
}

// Raw RSA + PKCS#1 v1.5 type-2 unpadding (avoids relying on Node's privateDecrypt padding support).
function rsaDecrypt(hex, key) {
  const n = BigInt('0x' + key.n);
  const d = BigInt('0x' + key.d);
  const chunk = key.bytes * 2;
  if (!hex || hex.length % chunk) throw new Error(`bad ciphertext length ${hex.length}`);
  let out = '';
  for (let i = 0; i < hex.length; i += chunk) {
    const m = modPow(BigInt('0x' + hex.slice(i, i + chunk)), d, n);
    const buf = Buffer.from(m.toString(16).padStart(key.bytes * 2, '0'), 'hex');
    if (buf[0] !== 0 || buf[1] !== 2) throw new Error('bad PKCS#1 padding');
    const sep = buf.indexOf(0, 2);
    if (sep < 10) throw new Error('bad PKCS#1 padding');
    out += buf.subarray(sep + 1).toString('utf8');
  }
  return out;
}

function aes(mode, input, key, iv) {
  const f = mode === 'enc' ? crypto.createCipheriv : crypto.createDecipheriv;
  const c = f('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  return mode === 'enc'
    ? Buffer.concat([c.update(input, 'utf8'), c.final()]).toString('base64')
    : Buffer.concat([c.update(Buffer.from(input, 'base64')), c.final()]).toString('utf8');
}

function initialState() {
  const decos = [
    {
      mac: 'AA-BB-CC-00-00-01', device_ip: '192.168.68.1', nickname: 'living_room', custom_nickname: b64('Living Room'),
      device_model: 'X55', hardware_ver: '1.0', software_ver: '1.2.3 Build 20240501', role: 'master',
      inet_status: 'online', group_status: 'connected', connection_type: ['wired'], signal_level: { band2_4: '0', band5: '0' },
    },
    {
      mac: 'AA-BB-CC-00-00-02', device_ip: '192.168.68.2', nickname: 'bedroom', device_model: 'X55',
      hardware_ver: '1.0', software_ver: '1.2.3 Build 20240501', role: 'slave', inet_status: 'online',
      group_status: 'connected', connection_type: ['band5'], signal_level: { band2_4: '2', band5: '3' },
    },
    {
      mac: 'AA-BB-CC-00-00-03', device_ip: '192.168.68.3', nickname: 'office', custom_nickname: b64('Office ☕'),
      device_model: 'X20', hardware_ver: '4.0', software_ver: '1.1.9', role: 'slave', inet_status: 'offline',
      group_status: 'disconnected', connection_type: ['wired'],
    },
  ];
  const client = (mac, name, ip, conn, deco, extra = {}) => ({
    mac, name: b64(name), ip, connection_type: conn, online: true, client_type: 'other',
    up_speed: 0, down_speed: 0, deco, ...extra,
  });
  return {
    decos,
    clients: [
      client('11-22-33-44-55-01', "Omar's iPhone", '192.168.68.101', 'band5', decos[0].mac, { client_type: 'phone', down_speed: 2350, up_speed: 120 }),
      client('11-22-33-44-55-02', 'Desktop-PC', '192.168.68.102', 'wired', decos[0].mac, { client_type: 'pc', down_speed: 512, up_speed: 64 }),
      client('11-22-33-44-55-03', 'Living Room TV', '192.168.68.103', 'band5', decos[1].mac, { client_type: 'tv', down_speed: 7800, up_speed: 30 }),
      client('11-22-33-44-55-04', 'Smart Plug', '192.168.68.104', 'band2_4', decos[1].mac, { client_type: 'iot_device' }),
      client('11-22-33-44-55-05', '<script>alert(1)</script>', '192.168.68.105', 'band2_4', decos[0].mac),
      client('11-22-33-44-55-06', 'Old Laptop', '192.168.68.106', 'band2_4', decos[0].mac, { online: false, client_type: 'laptop' }),
    ],
    wlan: {
      band2_4: {
        host: { enable: true, ssid: b64('HomeMesh'), password: b64('supersecret123'), channel: 0, channel_width: '20/40MHz', mode: '11bgnax' },
        guest: { enable: false, ssid: b64('HomeMesh-Guest'), password: b64('guestpass1') },
      },
      band5_1: {
        host: { enable: true, ssid: b64('HomeMesh'), password: b64('supersecret123'), channel: 36, channel_width: '80MHz', mode: '11anacax' },
        guest: { enable: false, ssid: b64('HomeMesh-Guest'), password: b64('guestpass1') },
      },
    },
    forms: {
      'admin/wireless?form=power': { band2_4: 'high', band5_1: 'high', support_dfs: false },
      'admin/network?form=wifi_network': { enable_wfnetwork: true },
      'admin/network?form=erp_setting': { enable_2g: true, enable_5g: true },
      'admin/network?form=igmp_setting': { enable_join_igmpv3: false },
      'admin/network?form=dhcp_dial': { is_dhcp: true, enable_unicast: false },
      'admin/network?form=flow_control': { enable_flow_control: true },
      'admin/network?form=fast_xmit_setting': { enable: true },
      'admin/device?form=timesetting': { date: '2026-11-13', time: '13:45:10', timezone: 'GMT+02:00', tz_region: 'Africa/Cairo' },
      'admin/network?form=performance': { cpu_usage: 0.12, mem_usage: 0.46 },
      'admin/network?form=internet': { ipv4: { inet_status: 'offline', dial_type: 'dynamic_ip' } },
      'admin/network?form=lan_ip': { mac_addr: 'AA-BB-CC-00-00-01', lan_ip: { ip: '192.168.68.1', mask: '255.255.252.0' } },
    },
    logs: [
      { time: '2026-11-13 13:01:02', level: 'INFO', type: 'System', content: 'Deco started' },
      { time: '2026-11-13 13:02:40', level: 'WARN', type: 'Internet', content: 'WAN link down' },
    ],
    mode: 'Router',
    // Shaped like a real Deco X-series on PPPoE (as read over TMP 0x4004). The password is
    // never returned by the Deco; the mock keeps it separately so tests can check writes.
    wan: {
      enable_ping: false,
      support_mtu_size: true,
      user_info: { username: b64('user123@isp.example') },
      mtu_size: 1480,
      ip_info: { mac: 'AA-BB-CC-00-00-0F', dns2: '8.8.4.4', dns1: '8.8.8.8', mask: '255.255.255.255', gateway: '10.0.0.1', ip: '0.0.0.0' },
      dial_type: 'pppoe',
      service_info: { enable: false },
      enable_auto_dns: false,
    },
    wanPassword: 'isp-secret-pw',
    // Like a real Deco that doesn't report lease_time (so it can't be changed).
    dhcp: { ip_amount_in_use: 5, end_ip: '192.168.71.249', dns2: '', dns1: '', start_ip: '192.168.68.100', gateway: '192.168.68.1' },
    reservations: [],
    reboots: [],
    writes: [],
  };
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

// Server side of the TMP protocol on one direct-tcpip stream.
function serveTmp(stream, mock, { chunk }) {
  let buf = Buffer.alloc(0);
  let seq = 1;
  const send = (packet) => stream.write(tmpFrame(packet, seq++));
  const pending = new Map(); // txid -> { opcode, body } for responses sent in fragments
  const reply = (opcode, txid, obj) => {
    const body = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
    // Exercise the client: a keep-alive and an unrelated push before each response.
    stream.write(Buffer.from([1, 1, 4, 0]));
    send(bizPacket(0x4015, 5, Buffer.from('{"result":{}}'), (txid + 7) & 0xffff));
    const first = chunk ? body.subarray(0, chunk) : body;
    if (chunk && body.length > chunk) pending.set(txid, { opcode, body });
    send(bizPacket(opcode, 5, first, txid, { total: body.length }));
  };

  const handle = (payload) => {
    const p = parseBiz(payload);
    if (p.body.length && crc32(p.body) !== p.crc) return mock.tmp.errors.push('bad business crc');
    if (p.ptype === 4) {
      const r = pending.get(p.txid);
      if (!r) return mock.tmp.errors.push('pull without pending response');
      const part = r.body.subarray(p.offset, p.offset + chunk);
      if (p.offset + chunk >= r.body.length) pending.delete(p.txid);
      return send(bizPacket(r.opcode, 5, part, p.txid, { total: r.body.length, offset: p.offset }));
    }
    if (p.ptype !== 2) return mock.tmp.errors.push(`unexpected ptype ${p.ptype}`);
    if (p.opcode === OP.ALLOC) return reply(p.opcode, p.txid, Buffer.from(crypto.randomBytes(16).toString('hex')));
    const req = JSON.parse(p.body.toString('utf8'));
    if (typeof req.config_version !== 'number') mock.tmp.errors.push('missing config_version');
    mock.tmp.calls.push({ opcode: p.opcode, params: req.params });
    if (p.opcode === OP.WAN_LAN_STATUS) {
      return reply(p.opcode, p.txid, {
        error_code: 0,
        result: { wan: mock.state.wan, lan: { ip_info: { mac: 'AA-BB-CC-00-00-01', mask: '255.255.252.0', ip: '192.168.68.1' } } },
      });
    }
    if (p.opcode === OP.WAN_IPV4_SET) {
      const wan = req.params && req.params.wan;
      const decode = (v) => Buffer.from(v, 'base64').toString('utf8');
      if (!wan || !['dynamic_ip', 'static_ip', 'pppoe'].includes(wan.dial_type)) return reply(p.opcode, p.txid, { error_code: -1 });
      if (wan.dial_type === 'pppoe') {
        const ui = wan.user_info || {};
        const switching = mock.state.wan.dial_type !== 'pppoe';
        if (switching && (!ui.username || !ui.password)) return reply(p.opcode, p.txid, { error_code: -1 });
        if (ui.username) mock.state.wan.user_info = { username: ui.username };
        if (ui.password) mock.state.wanPassword = decode(ui.password);
        mock.state.wanUsernamePlain = decode(mock.state.wan.user_info.username);
      } else {
        delete mock.state.wan.user_info;
      }
      const { user_info, ...rest } = wan;
      Object.assign(mock.state.wan, rest);
      if (wan.ip_info) mock.state.wan.ip_info = { ...mock.state.wan.ip_info, ...wan.ip_info };
      return reply(p.opcode, p.txid, { error_code: 0 });
    }
    const s = mock.state;
    const ok = (result) => reply(p.opcode, p.txid, result === undefined ? { error_code: 0 } : { error_code: 0, result });
    const fail = () => reply(p.opcode, p.txid, { error_code: -1 });
    if (p.opcode === OP.DHCP_SERVER) return ok(s.dhcp);
    if (p.opcode === OP.DHCP_SERVER_SET) {
      const v = req.params || {};
      if (!v.start_ip || !v.end_ip || v.gateway !== s.dhcp.gateway) return fail();
      if ('lease_time' in v && !('lease_time' in s.dhcp)) return fail();
      Object.assign(s.dhcp, v);
      return ok();
    }
    if (p.opcode === OP.RESERVATIONS) return ok({ reservation_list_max_count: 64, reservation_list: s.reservations });
    if (p.opcode === OP.RESERVATION_ADD) {
      const add = req.params?.reservation_list || [];
      if (!add.length || add.some((r) => !r.ip || !r.mac || s.reservations.some((x) => x.mac === r.mac))) return fail();
      s.reservations.push(...add.map(({ ip, mac }) => ({ ip, mac })));
      return ok();
    }
    if (p.opcode === OP.RESERVATION_MODIFY) {
      const v = req.params || {};
      const r = s.reservations.find((x) => x.mac === v.original_mac && x.ip === v.original_ip);
      if (!r) return fail();
      Object.assign(r, { ip: v.ip, mac: v.mac });
      return ok();
    }
    if (p.opcode === OP.RESERVATION_REMOVE) {
      const macs = req.params?.reservation_list || [];
      if (!macs.length) return fail();
      s.reservations = s.reservations.filter((x) => !macs.includes(x.mac));
      return ok();
    }
    if (p.opcode === OP.DHCP_LEASES) {
      return ok({ client_lease: s.clients.filter((c) => c.online).map((c) => ({ mac: c.mac, ip: c.ip })) });
    }
    if (p.opcode === OP.OPERATION_MODE) {
      return reply(p.opcode, p.txid, { error_code: 0, result: { mode: mock.state.mode, modeList: ['Router', 'AP'] } });
    }
    if (p.opcode === OP.OPERATION_MODE_SET) {
      if (!['Router', 'AP'].includes(req.params?.mode)) return reply(p.opcode, p.txid, { error_code: -1 });
      mock.state.mode = req.params.mode;
      return reply(p.opcode, p.txid, { error_code: 0 });
    }
    reply(p.opcode, p.txid, { error_code: -40401 });
  };

  stream.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    for (;;) {
      if (buf.length < 4) return;
      if (buf[2] === 4) {
        mock.tmp.pongs++;
        buf = buf.subarray(4);
        continue;
      }
      if (buf.length < 16) return;
      const len = buf.readUInt16BE(4);
      if (buf.length < 16 + len) return;
      const frame = buf.subarray(0, 16 + len);
      buf = buf.subarray(16 + len);
      const check = Buffer.from(frame);
      check.writeUInt32BE(0x5a6b7c8d, 12);
      if (crc32(check) !== frame.readUInt32BE(12)) {
        mock.tmp.errors.push('bad TMP crc');
        continue;
      }
      handle(frame.subarray(16));
    }
  });
}

function createMockDeco({
  password = 'decopass',
  email = 'owner@example.com',
  tmpPassword = password,
  tmpChunk = 0,
  rejectWlanWrites = false,
  delayMs = 0,
} = {}) {
  const pwdKey = makeRsa(1024);
  const signKey = makeRsa(512);
  const seq = crypto.randomInt(1e8, 9e8);
  const hash = crypto.createHash('md5').update('admin' + password).digest('hex');
  const mock = { state: initialState(), session: null, loginAttempts: 0, requests: [] };

  function handleAdmin(path, payload) {
    const { operation, params = {} } = payload;
    const s = mock.state;
    if (operation !== 'read') s.writes.push({ path, operation, params });

    switch (path) {
      case 'admin/device?form=device_list':
        return { device_list: s.decos };
      case 'admin/client?form=client_list': {
        const mac = params.device_mac || 'default';
        const list = mac === 'default' ? s.clients : s.clients.filter((c) => c.deco === mac);
        return { client_list: list.map(({ deco, ...c }) => c) };
      }
      case 'admin/wireless?form=wlan':
        if (operation === 'write') {
          if (rejectWlanWrites) return { __error: -40210 };
          deepMerge(s.wlan, params);
        }
        return s.wlan;
      case 'admin/device?form=system':
        if (operation !== 'reboot') return { __error: -1 };
        s.reboots.push(params.mac_list);
        return {};
      case 'admin/network?form=wan_ipv4': {
        // The HTTP view omits the MTU and service fields, like real firmware.
        const { dial_type, user_info, ip_info, enable_auto_dns } = s.wan;
        return {
          wan: { user_info, ip_info, dial_type, info: {}, enable_auto_dns },
          lan: { ip_info: { mac: 'AA-BB-CC-00-00-01', mask: '255.255.252.0', ip: '192.168.68.1' } },
        };
      }
      case 'admin/device?form=mode':
        if (operation !== 'read') return { __error: -40210 }; // read-only over HTTP, like the real web UI
        return { sysmode: s.mode, workmode: s.mode === 'AP' ? 'AP' : 'Router' };
      case 'admin/log_export?form=feedback_log':
        return { logList: s.logs };
      case 'admin/system?form=logout':
        mock.session = null;
        return {};
    }
    if (s.forms[path]) {
      if (operation === 'write') deepMerge(s.forms[path], params);
      return s.forms[path];
    }
    return { __error: -40401 };
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    // `delayMs` simulates a real Deco's per-request latency.
    req.on('end', () => setTimeout(handle, delayMs));
    function handle() {
      const m = req.url.match(/^\/cgi-bin\/luci\/;stok=([^/]*)\/(.+)$/);
      const reply = (obj, headers = {}) => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/__mock/expire') {
        mock.session = null;
        return reply({ ok: true });
      }
      if (!m || req.method !== 'POST') {
        res.writeHead(404);
        return res.end();
      }
      const [, stok, path] = m;
      mock.requests.push(path);

      if (path === 'login?form=keys') return reply({ result: { username: '', password: [pwdKey.n, pwdKey.e] }, error_code: 0 });
      if (path === 'login?form=auth') return reply({ result: { key: [signKey.n, signKey.e], seq }, error_code: 0 });

      let form;
      try {
        form = new URLSearchParams(raw);
      } catch {
        return reply({ error_code: -1 });
      }
      const sign = form.get('sign');
      const data = form.get('data');
      if (!sign || !data) return reply({ error_code: -1 });

      let signText;
      try {
        signText = Object.fromEntries(new URLSearchParams(rsaDecrypt(sign, signKey)));
      } catch (err) {
        return reply({ error_code: -1, msg: 'bad sign: ' + err.message });
      }
      if (signText.h !== hash) {
        // Wrong password changes the hash, so the signature check fails like on a real Deco.
        if (path !== 'login?form=login') return reply({ error_code: 'timeout' });
      }
      if (Number(signText.s) !== seq + data.length) return reply({ error_code: -1, msg: 'bad seq' });

      if (path === 'login?form=login') {
        if (!signText.k || !signText.i) return reply({ error_code: -1, msg: 'login sign missing key' });
        const key = signText.k;
        const iv = signText.i;
        const payload = JSON.parse(aes('dec', data, key, iv));
        const enc = (obj) => ({ data: aes('enc', JSON.stringify(obj), key, iv) });
        let given = '';
        try {
          given = rsaDecrypt(payload.params.password, pwdKey);
        } catch {}
        if (payload.operation !== 'login' || given !== password || signText.h !== hash) {
          mock.loginAttempts++;
          return reply(enc({ error_code: -5002, result: { failureCount: mock.loginAttempts, attemptsAllowed: 10 } }));
        }
        mock.loginAttempts = 0;
        mock.session = { stok: crypto.randomBytes(16).toString('hex'), cookie: crypto.randomBytes(8).toString('hex'), key, iv };
        return reply(enc({ error_code: 0, result: { stok: mock.session.stok } }), {
          'Set-Cookie': `sysauth=${mock.session.cookie}; path=/cgi-bin/luci; HttpOnly`,
        });
      }

      const sess = mock.session;
      const cookieOk = sess && (req.headers.cookie || '').includes(`sysauth=${sess.cookie}`);
      if (!sess || stok !== sess.stok || !cookieOk) return reply({ error_code: 'timeout' });
      if (signText.k) return reply({ error_code: -1, msg: 'unexpected key in non-login sign' });

      const payload = JSON.parse(aes('dec', data, sess.key, sess.iv));
      const result = handleAdmin(path, payload);
      const out = result.__error ? { error_code: result.__error } : { error_code: 0, result };
      reply({ data: aes('enc', JSON.stringify(out), sess.key, sess.iv) });
    }
  });

  // TMP over SSH, like port 20001 on a real Deco.
  mock.tmp = { authAttempts: 0, calls: [], errors: [], pongs: 0 };
  const hostKey = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
  const tmpServer = new SshServer({ hostKeys: [hostKey] }, (conn) => {
    conn.on('authentication', (ctx) => {
      if (ctx.method !== 'password') return ctx.reject(['password']);
      mock.tmp.authAttempts++;
      if (ctx.username === sha1Hex(email) && ctx.password === tmpPassword) ctx.accept();
      else ctx.reject(['password']);
    });
    conn.on('ready', () => {
      conn.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== '127.0.0.1' || info.destPort !== 20002) return reject();
        serveTmp(accept(), mock, { chunk: tmpChunk });
      });
    });
    conn.on('error', () => {});
  });

  mock.server = server;
  mock.tmpServer = tmpServer;
  mock.password = password;
  mock.email = email;
  mock.listen = (port = 0, host = '127.0.0.1') =>
    new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
  mock.listenTmp = (port = 0, host = '127.0.0.1') =>
    new Promise((resolve) => tmpServer.listen(port, host, () => resolve(tmpServer.address().port)));
  mock.close = async () => {
    await new Promise((resolve) => server.close(resolve));
    if (tmpServer.address()) await new Promise((resolve) => tmpServer.close(resolve));
  };
  return mock;
}

module.exports = { createMockDeco };

if (require.main === module) {
  const port = parseInt(process.env.MOCK_PORT || '8787', 10);
  const mock = createMockDeco({
    password: process.env.MOCK_PASSWORD || 'decopass',
    delayMs: parseInt(process.env.MOCK_DELAY_MS || '0', 10),
  });
  const tmpPort = parseInt(process.env.MOCK_TMP_PORT || '20001', 10);
  Promise.all([mock.listen(port), mock.listenTmp(tmpPort)]).then(([p, t]) => {
    console.log(`Mock Deco listening on http://127.0.0.1:${p} (TMP/SSH on port ${t})`);
    console.log(`In Deco Local, log in with address "127.0.0.1:${p}" and password "${mock.password}".`);
    console.log(`For operation mode, use TP-Link ID "${mock.email}" (same password).`);
    if (t !== 20001) console.log(`Start Deco Local with DECO_TMP_PORT=${t} so it finds the TMP port.`);
  });
}
