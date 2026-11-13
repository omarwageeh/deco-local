'use strict';

// A fake Deco that implements the server side of the real local API protocol:
// RSA-PKCS1 password + signature checks, AES-CBC payloads, stok + sysauth cookie.
// Used by the tests, and runnable on its own as a demo:  npm run mock

const crypto = require('node:crypto');
const http = require('node:http');

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
      'admin/network?form=wan_ipv4': {
        wan: { dial_type: 'dynamic_ip', ip_info: { ip: '0.0.0.0', mask: '0.0.0.0', gateway: '0.0.0.0', dns1: '', dns2: '' } },
        lan: { ip_info: { ip: '192.168.68.1', mask: '255.255.252.0' } },
      },
      'admin/network?form=lan_ip': { mac_addr: 'AA-BB-CC-00-00-01', lan_ip: { ip: '192.168.68.1', mask: '255.255.252.0' } },
    },
    logs: [
      { time: '2026-11-13 13:01:02', level: 'INFO', type: 'System', content: 'Deco started' },
      { time: '2026-11-13 13:02:40', level: 'WARN', type: 'Internet', content: 'WAN link down' },
    ],
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

function createMockDeco({ password = 'decopass', rejectWlanWrites = false } = {}) {
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
    req.on('end', () => {
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
    });
  });

  mock.server = server;
  mock.password = password;
  mock.listen = (port = 0, host = '127.0.0.1') =>
    new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
  mock.close = () => new Promise((resolve) => server.close(resolve));
  return mock;
}

module.exports = { createMockDeco };

if (require.main === module) {
  const port = parseInt(process.env.MOCK_PORT || '8787', 10);
  const mock = createMockDeco({ password: process.env.MOCK_PASSWORD || 'decopass' });
  mock.listen(port).then((p) => {
    console.log(`Mock Deco listening on http://127.0.0.1:${p}`);
    console.log(`In Deco Local, log in with address "127.0.0.1:${p}" and password "${mock.password}".`);
  });
}
