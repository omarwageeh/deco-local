'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');

process.env.DECO_LOCAL_CONFIG = path.join(os.tmpdir(), `deco-local-test-${process.pid}.json`);

const { DecoClient, DecoError } = require('../src/deco-client');
const { createServer, b64 } = require('../src/server');
const { createMockDeco } = require('../tools/mock-deco');

describe('DecoClient against mock Deco', () => {
  let mock;
  let host;
  before(async () => {
    mock = createMockDeco({ password: 'p@ss wörd+1' });
    host = `127.0.0.1:${await mock.listen()}`;
  });
  after(() => mock.close());

  test('logs in (falling back from https to http) and reads the device list', async () => {
    const c = new DecoClient({ host, password: 'p@ss wörd+1' });
    const r = await c.request('admin/device?form=device_list');
    assert.equal(c.baseUrl, `http://${host}`);
    assert.equal(r.device_list.length, 3);
    assert.ok(c.session.stok);
    assert.match(c.session.cookie, /^sysauth=/);
  });

  test('wrong password is reported as -5002', async () => {
    const c = new DecoClient({ host, password: 'nope' });
    await assert.rejects(c.login(), (err) => err instanceof DecoError && err.code === -5002 && /Wrong password/.test(err.message));
  });

  test('re-logs in transparently when the session expires', async () => {
    const c = new DecoClient({ host, password: 'p@ss wörd+1' });
    await c.login();
    const firstStok = c.session.stok;
    await expire(host);
    const r = await c.request('admin/client?form=client_list', 'read', { device_mac: 'default' });
    assert.equal(r.client_list.length, 6);
    assert.notEqual(c.session.stok, firstStok);
  });

  test('parallel requests that all hit an expired session share one re-login', async () => {
    const c = new DecoClient({ host, password: 'p@ss wörd+1' });
    await c.login();
    await expire(host);
    const logins = () => mock.requests.filter((p) => p === 'login?form=login').length;
    const before = logins();
    const results = await Promise.all([
      c.request('admin/device?form=device_list'),
      c.request('admin/network?form=performance'),
      c.request('admin/wireless?form=wlan'),
      c.request('admin/network?form=internet'),
    ]);
    assert.equal(results[0].device_list.length, 3);
    assert.equal(logins() - before, 1);
  });

  test('reads are cached only when asked, and writes clear the cache', async () => {
    const c = new DecoClient({ host, password: 'p@ss wörd+1' });
    const count = () => mock.requests.filter((p) => p === 'admin/device?form=device_list').length;
    const opts = { cacheMs: 5000 };
    await c.request('admin/device?form=device_list', 'read', undefined, opts);
    const before = count();
    await Promise.all([
      c.request('admin/device?form=device_list', 'read', undefined, opts),
      c.request('admin/device?form=device_list', 'read', undefined, opts),
    ]);
    assert.equal(count(), before, 'served from cache');
    await c.request('admin/device?form=device_list');
    await c.request('admin/device?form=device_list');
    assert.equal(count(), before + 2, 'no cacheMs means always fresh');
    await c.request('admin/network?form=igmp_setting', 'write', { enable_join_igmpv3: false });
    await c.request('admin/device?form=device_list', 'read', undefined, opts);
    assert.equal(count(), before + 3, 'a write clears the cache');
  });

  test('concurrent requests share one login', async () => {
    const c = new DecoClient({ host, password: 'p@ss wörd+1' });
    const before = mock.requests.filter((p) => p === 'login?form=login').length;
    const results = await Promise.all([
      c.request('admin/device?form=device_list'),
      c.request('admin/network?form=performance'),
      c.request('admin/wireless?form=wlan'),
    ]);
    assert.equal(results.length, 3);
    assert.equal(mock.requests.filter((p) => p === 'login?form=login').length - before, 1);
  });

  test('unknown endpoint surfaces the Deco error code', async () => {
    const c = new DecoClient({ host, password: 'p@ss wörd+1' });
    await assert.rejects(c.request('admin/nope?form=nothing'), (err) => err.code === -40401);
  });

  test('unreachable host gives a helpful error', async () => {
    const c = new DecoClient({ host: '127.0.0.1:1', password: 'x', timeoutMs: 2000 });
    await assert.rejects(c.login(), /Could not reach a Deco/);
  });
});

describe('performance against a slow Deco', () => {
  const DELAY = 250;
  let mock;
  let host;
  before(async () => {
    mock = createMockDeco({ password: 'decopass', delayMs: DELAY });
    host = `127.0.0.1:${await mock.listen()}`;
  });
  after(() => mock.close());

  test('requests run in parallel instead of queueing', async () => {
    const c = new DecoClient({ host, password: 'decopass', timeoutMs: 5000 });
    await c.login();
    const t = Date.now();
    await Promise.all([
      c.request('admin/device?form=device_list'),
      c.request('admin/network?form=performance'),
      c.request('admin/network?form=internet'),
      c.request('admin/network?form=wan_ipv4'),
      c.request('admin/wireless?form=wlan'),
      c.request('admin/device?form=timesetting'),
    ]);
    const ms = Date.now() - t;
    // Sequential would be 6 x 250 ms = 1500 ms.
    assert.ok(ms < DELAY * 3, `6 requests took ${ms} ms`);
  });

  test('overview API is about one round trip, not six', async () => {
    const app = createServer();
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.address().port}`;
    try {
      const login = await fetch(base + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Deco-Local': '1' },
        body: JSON.stringify({ host, password: 'decopass' }),
      });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const t = Date.now();
      const res = await fetch(base + '/api/overview', { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      const ms = Date.now() - t;
      assert.ok(ms < DELAY * 3, `overview took ${ms} ms`);
      // Switching to the Decos tab right after reuses the cached list.
      const t2 = Date.now();
      await fetch(base + '/api/decos', { headers: { Cookie: cookie } });
      assert.ok(Date.now() - t2 < DELAY, 'decos served from cache');
    } finally {
      app.closeAllConnections?.();
      await new Promise((r) => app.close(r));
    }
  });
});

describe('b64 helper', () => {
  test('decodes base64 and leaves plain strings alone', () => {
    assert.equal(b64(Buffer.from('Office ☕').toString('base64')), 'Office ☕');
    assert.equal(b64('Home'), 'Home');
    assert.equal(b64(''), '');
    assert.equal(b64(undefined), '');
  });
});

describe('Deco Local HTTP API end to end', () => {
  let mock;
  let decoHost;
  let app;
  let base;
  let cookie = '';

  async function call(method, url, body, { headers = {}, raw = false } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Deco-Local': '1', Cookie: cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return raw ? res : { status: res.status, body: await res.json() };
  }

  before(async () => {
    mock = createMockDeco({ password: 'decopass' });
    decoHost = `127.0.0.1:${await mock.listen()}`;
    app = createServer();
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.address().port}`;
  });
  after(async () => {
    await mock.close();
    app.closeAllConnections?.();
    await new Promise((r) => app.close(r));
    fs.rmSync(process.env.DECO_LOCAL_CONFIG, { force: true });
  });

  test('serves the UI', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Deco Local/);
    assert.equal((await fetch(base + '/../src/server.js')).status, 404);
  });

  test('API requires login', async () => {
    const r = await call('GET', '/api/decos');
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'auth');
  });

  test('wrong password is rejected', async () => {
    const r = await call('POST', '/api/login', { host: decoHost, password: 'wrong' });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /Wrong password/);
  });

  test('POST without the app header is blocked (CSRF guard)', async () => {
    const r = await call('POST', '/api/login', { host: decoHost, password: 'decopass' }, { headers: { 'X-Deco-Local': '' } });
    assert.equal(r.status, 403);
  });

  test('logs in and remembers the host', async () => {
    const r = await call('POST', '/api/login', { host: decoHost, password: 'decopass' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(cookie, /^deco_local_session=/);
    const s = await call('GET', '/api/session');
    assert.deepEqual(s.body, { loggedIn: true, host: decoHost });
    assert.equal(JSON.parse(fs.readFileSync(process.env.DECO_LOCAL_CONFIG, 'utf8')).host, decoHost);
  });

  test('overview', async () => {
    const { status, body } = await call('GET', '/api/overview');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.internet.status, 'offline');
    assert.deepEqual(body.decos, { total: 3, online: 2 });
    assert.equal(body.clients.total, 5);
    assert.equal(body.performance.cpu, 0.12);
    assert.equal(body.main.name, 'Living Room');
    assert.equal(body.lan.ip, '192.168.68.1');
    assert.equal(body.wan.dialType, 'dynamic_ip');
  });

  test('decos are normalized with decoded names', async () => {
    const { body } = await call('GET', '/api/decos');
    assert.deepEqual(
      body.decos.map((d) => [d.name, d.role, d.online]),
      [
        ['Living Room', 'master', true],
        ['Bedroom', 'slave', true],
        ['Office ☕', 'slave', false],
      ]
    );
  });

  test('clients include the Deco they are attached to', async () => {
    const { body } = await call('GET', '/api/clients');
    const tv = body.clients.find((c) => c.name === 'Living Room TV');
    assert.equal(tv.deco.name, 'Bedroom');
    assert.equal(tv.downKBps, 7800);
    assert.equal(body.clients.find((c) => c.name === "Omar's iPhone").deco.name, 'Living Room');
    assert.equal(body.clients.find((c) => c.name === 'Old Laptop').online, false);
  });

  test('wifi read decodes SSIDs and passwords', async () => {
    const { body } = await call('GET', '/api/wifi');
    assert.deepEqual(body.bands.map((b) => b.label), ['2.4 GHz', '5 GHz']);
    assert.equal(body.bands[0].host.ssid, 'HomeMesh');
    assert.equal(body.bands[0].host.password, 'supersecret123');
    assert.equal(body.bands[0].guest.enable, false);
    assert.equal(body.power.band2_4, 'high');
  });

  test('wifi write sends base64 values for only the changed fields', async () => {
    const r = await call('POST', '/api/wifi', { band: 'band5_1', network: 'guest', ssid: 'Visitors', enable: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const last = mock.state.writes.at(-1);
    assert.deepEqual(last, {
      path: 'admin/wireless?form=wlan',
      operation: 'write',
      params: { band5_1: { guest: { ssid: b64ToRaw('Visitors'), enable: true } } },
    });
    const { body } = await call('GET', '/api/wifi');
    assert.equal(body.bands[1].guest.ssid, 'Visitors');
    assert.equal(body.bands[1].guest.enable, true);
  });

  test('wifi write validates input', async () => {
    assert.equal((await call('POST', '/api/wifi', { band: 'band2_4', password: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/wifi', { band: 'bogus', ssid: 'x' })).status, 400);
    assert.equal((await call('POST', '/api/wifi', { band: 'band2_4' })).status, 400);
  });

  test('transmit power', async () => {
    assert.equal((await call('POST', '/api/power', { band2_4: 'low' })).status, 200);
    assert.equal(mock.state.forms['admin/wireless?form=power'].band2_4, 'low');
    assert.equal((await call('POST', '/api/power', { band2_4: 'max' })).status, 400);
  });

  test('system toggles read and write', async () => {
    const { body } = await call('GET', '/api/toggles');
    const labels = body.toggles.map((t) => t.label);
    assert.ok(labels.includes('IGMP Feature'));
    assert.ok(labels.includes('2.4 GHz Wi-Fi Network'));
    assert.ok(!labels.includes('6 GHz Wi-Fi Network'), 'unsupported fields are hidden');
    const igmp = body.toggles.find((t) => t.label === 'IGMP Feature');
    assert.equal(igmp.value, false);
    assert.equal((await call('POST', '/api/toggles', { form: igmp.form, field: igmp.field, value: true })).status, 200);
    assert.equal(mock.state.forms['admin/network?form=igmp_setting'].enable_join_igmpv3, true);
    assert.equal((await call('POST', '/api/toggles', { form: 'admin/x?form=y', field: 'z', value: true })).status, 400);
  });

  test('reboot sends the mac list', async () => {
    const r = await call('POST', '/api/reboot', { macs: ['AA-BB-CC-00-00-02'] });
    assert.equal(r.status, 200);
    assert.deepEqual(mock.state.reboots.at(-1), [{ mac: 'AA-BB-CC-00-00-02' }]);
    assert.equal((await call('POST', '/api/reboot', { macs: [] })).status, 400);
  });

  test('system info and logs', async () => {
    const sys = await call('GET', '/api/system');
    assert.equal(sys.body.time.tz_region, 'Africa/Cairo');
    const logs = await call('GET', '/api/logs');
    assert.equal(logs.body.logs.length, 2);
  });

  test('raw API console', async () => {
    const r = await call('POST', '/api/raw', { path: 'admin/network?form=performance', operation: 'read' });
    assert.equal(r.body.result.mem_usage, 0.46);
    assert.equal((await call('POST', '/api/raw', { path: '../../etc/passwd' })).status, 400);
    const bad = await call('POST', '/api/raw', { path: 'admin/nope?form=x' });
    assert.equal(bad.status, 502);
    assert.equal(bad.body.code, -40401);
  });

  test('survives the Deco session expiring', async () => {
    await new Promise((r) => http.get(`http://${decoHost}/__mock/expire`, r));
    const { status, body } = await call('GET', '/api/decos');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.decos.length, 3);
  });

  test('logout', async () => {
    assert.equal((await call('POST', '/api/logout')).status, 200);
    assert.equal((await call('GET', '/api/decos')).status, 401);
    assert.equal(mock.session, null, 'Deco session was logged out too');
  });
});

function expire(host) {
  return new Promise((r) => http.get(`http://${host}/__mock/expire`, (res) => res.resume().on('end', r)));
}

function b64ToRaw(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}
