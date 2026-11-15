'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');

process.env.DECO_LOCAL_CONFIG = path.join(os.tmpdir(), `deco-local-tmp-test-${process.pid}.json`);

const { TmpClient, TmpError, withTmp, OP, tmpFrame, bizPacket } = require('../src/tmp-client');
const { createServer } = require('../src/server');
const { createMockDeco } = require('../tools/mock-deco');

test('ALLOC packet is byte-identical to one captured from the Deco app', () => {
  const packet = tmpFrame(bizPacket(OP.ALLOC, 2, Buffer.alloc(0), 0), 1);
  assert.equal(
    packet.toString('hex'),
    '010105000014000000000001' + '50384e94' + '0102000102000000000000000000000000000000'
  );
});

describe('TmpClient against mock Deco', () => {
  let mock;
  let port;
  const opts = () => ({ host: '127.0.0.1', port, email: 'owner@example.com', password: 'decopass', timeoutMs: 5000 });

  before(async () => {
    // Small fragments force the PULL loop on every response.
    mock = createMockDeco({ password: 'decopass', tmpChunk: 7 });
    port = await mock.listenTmp();
  });
  after(() => mock.close());

  test('signs in, reads the mode across fragments, keep-alives and unrelated pushes', async () => {
    const result = await withTmp(opts(), (c) => c.call(OP.OPERATION_MODE));
    assert.deepEqual(result, { mode: 'Router', modeList: ['Router', 'AP'] });
    assert.deepEqual(mock.tmp.errors, []);
    assert.ok(mock.tmp.pongs >= 2, 'answered keep-alives');
  });

  test('switches mode and reads it back in one session', async () => {
    const after = await withTmp(opts(), async (c) => {
      await c.call(OP.OPERATION_MODE_SET, { mode: 'AP' });
      return c.call(OP.OPERATION_MODE);
    });
    assert.equal(after.mode, 'AP');
    assert.equal(mock.state.mode, 'AP');
    assert.deepEqual(mock.tmp.calls.at(-2), { opcode: OP.OPERATION_MODE_SET, params: { mode: 'AP' } });
    mock.state.mode = 'Router';
  });

  test('Deco-side errors become TmpError', async () => {
    await assert.rejects(
      withTmp(opts(), (c) => c.call(OP.OPERATION_MODE_SET, { mode: 'Bogus' })),
      (err) => err instanceof TmpError && err.code === -1
    );
  });

  test('wrong password: one attempt only, clear error', async () => {
    const attempts = mock.tmp.authAttempts;
    await assert.rejects(
      new TmpClient({ ...opts(), password: 'nope' }).connect(),
      (err) => err.code === 'auth' && /locks out/.test(err.message)
    );
    assert.equal(mock.tmp.authAttempts - attempts, 1);
  });

  test('pinned host key mismatch refuses before sending the password', async () => {
    const attempts = mock.tmp.authAttempts;
    await assert.rejects(new TmpClient({ ...opts(), hostKeySha256: 'ab'.repeat(32) }).connect(), (err) => err.code === 'hostkey');
    assert.equal(mock.tmp.authAttempts, attempts, 'no password was sent');
  });

  test('records the host key fingerprint for pinning', async () => {
    const c = new TmpClient(opts());
    await c.connect();
    c.close();
    assert.match(c.hostKeySha256, /^[0-9a-f]{64}$/);
  });

  test('closed control port is reported as busy', async () => {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const free = srv.address().port;
    await new Promise((r) => srv.close(r));
    await assert.rejects(new TmpClient({ ...opts(), port: free }).connect(), (err) => err.code === 'busy');
  });
});

describe('operation mode through the app API', () => {
  let mock;
  let decoHost;
  let app;
  let base;
  let cookie = '';

  async function call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Deco-Local': '1', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  }

  before(async () => {
    mock = createMockDeco({ password: 'decopass' });
    decoHost = `127.0.0.1:${await mock.listen()}`;
    process.env.DECO_TMP_PORT = String(await mock.listenTmp());
    app = createServer();
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.address().port}`;
    const login = await call('POST', '/api/login', { host: decoHost, password: 'decopass' });
    assert.equal(login.status, 200);
  });
  after(async () => {
    await mock.close();
    app.closeAllConnections?.();
    await new Promise((r) => app.close(r));
    fs.rmSync(process.env.DECO_LOCAL_CONFIG, { force: true });
  });

  test('shows the current mode without needing the TP-Link ID', async () => {
    const { body } = await call('GET', '/api/mode');
    assert.equal(body.mode, 'Router');
    assert.equal(body.label, 'Router');
    assert.equal(body.verified, false);
    assert.equal(body.busySeconds, 0);
  });

  test('switching requires signing in first', async () => {
    const r = await call('POST', '/api/mode', { mode: 'AP' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /TP-Link ID/);
  });

  test('wrong TP-Link ID is rejected and not retried', async () => {
    const attempts = mock.tmp.authAttempts;
    const r = await call('POST', '/api/mode/check', { email: 'someone@else.com' });
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'auth');
    assert.equal(mock.tmp.authAttempts - attempts, 1);
  });

  test('check with a blank password reuses the login password', async () => {
    const r = await call('POST', '/api/mode/check', { email: 'owner@example.com', password: '' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mode, 'Router');
    assert.deepEqual(r.body.options.map((o) => o.mode), ['Router', 'AP']);
    assert.equal((await call('GET', '/api/mode')).body.verified, true);
  });

  test('rejects unknown modes', async () => {
    assert.equal((await call('POST', '/api/mode', { mode: 'Repeater' })).status, 400);
  });

  test('switches to Access Point and then locks out further changes', async () => {
    const r = await call('POST', '/api/mode', { mode: 'AP' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { changed: true, from: 'Router', mode: 'AP', label: 'Access Point', confirmed: true });
    assert.equal(mock.state.mode, 'AP');

    const status = (await call('GET', '/api/mode')).body;
    assert.equal(status.label, 'Access Point');
    assert.ok(status.busySeconds > 60);

    const again = await call('POST', '/api/mode', { mode: 'Router' });
    assert.equal(again.status, 502);
    assert.equal(again.body.code, 'busy');
  });

  test('saves the email and host key, never the password', () => {
    const saved = fs.readFileSync(process.env.DECO_LOCAL_CONFIG, 'utf8');
    const cfg = JSON.parse(saved);
    assert.equal(cfg.tmp[decoHost].email, 'owner@example.com');
    assert.match(cfg.tmp[decoHost].hostKeySha256, /^[0-9a-f]{64}$/);
    assert.ok(!saved.includes('decopass'));
  });
});

describe('internet (WAN) settings', () => {
  let mock;
  let app;
  let base;
  let cookie = '';

  async function call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Deco-Local': '1', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  }
  const wanWrites = () => mock.tmp.calls.filter((c) => c.opcode === OP.WAN_IPV4_SET);
  const lastWanWrite = () => wanWrites().at(-1)?.params.wan;
  const pppoe = (extra = {}) => ({
    type: 'pppoe',
    username: 'user123@isp.example',
    mtu: 1480,
    autoDns: false,
    dns1: '8.8.8.8',
    dns2: '8.8.4.4',
    ...extra,
  });
  const b64 = (s) => Buffer.from(s).toString('base64');

  before(async () => {
    mock = createMockDeco({ password: 'decopass' });
    const decoHost = `127.0.0.1:${await mock.listen()}`;
    process.env.DECO_TMP_PORT = String(await mock.listenTmp());
    process.env.DECO_TMP_LOCKOUT_MS = '0'; // the lockout itself is covered by the operation-mode tests
    app = createServer();
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.address().port}`;
    assert.equal((await call('POST', '/api/login', { host: decoHost, password: 'decopass' })).status, 200);
  });
  after(async () => {
    delete process.env.DECO_TMP_LOCKOUT_MS;
    await mock.close();
    app.closeAllConnections?.();
    await new Promise((r) => app.close(r));
    fs.rmSync(process.env.DECO_LOCAL_CONFIG, { force: true });
  });

  test('HTTP view lists every field with the username decoded', async () => {
    const { status, body } = await call('GET', '/api/internet');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.dialType, 'PPPoE');
    const byPath = Object.fromEntries(body.rows.map((r) => [r.path, r]));
    assert.equal(byPath['user_info.username'].value, 'user123@isp.example');
    assert.equal(byPath['ip_info.gateway'].label, 'Gateway');
    assert.equal(byPath['ip_info.gateway'].group, 'Ip Info');
    assert.equal(byPath['enable_auto_dns'].label, 'Automatic DNS');
  });

  test('editing needs the TP-Link ID sign-in first', async () => {
    const r = await call('POST', '/api/internet', pppoe({ password: 'x' }));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /TP-Link ID/);
  });

  test("the Deco app's view includes the MTU and the values to edit", async () => {
    const { status, body } = await call('POST', '/api/internet/app', { email: 'owner@example.com' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(Object.fromEntries(body.rows.map((r) => [r.path, r.value])).mtu_size, '1480');
    assert.deepEqual(body.current, {
      type: 'pppoe',
      label: 'PPPoE',
      editable: true,
      username: 'user123@isp.example',
      supportMtu: true,
      mtu: 1480,
      autoDns: false,
      dns1: '8.8.8.8',
      dns2: '8.8.4.4',
      ip: '0.0.0.0',
      mask: '255.255.255.255',
      gateway: '10.0.0.1',
    });
  });

  test('changing only the PPPoE password sends just the password, base64-encoded', async () => {
    const r = await call('POST', '/api/internet', pppoe({ password: 'new-isp-pw' }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const wan = lastWanWrite();
    assert.deepEqual(wan.user_info, { password: b64('new-isp-pw'), auto_config: false });
    assert.deepEqual(wan.ip_info, { dns1: '8.8.8.8', dns2: '8.8.4.4' });
    assert.equal(wan.enable_auto_dns, false);
    assert.equal(mock.state.wanPassword, 'new-isp-pw');
  });

  test('unchanged credentials are left out so the Deco keeps the saved password', async () => {
    const r = await call('POST', '/api/internet', pppoe({ mtu: 1460 }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(lastWanWrite().user_info, undefined);
    assert.equal(r.body.current.mtu, 1460);
    assert.equal(mock.state.wanPassword, 'new-isp-pw');
  });

  test('changing the username sends it encoded; automatic DNS drops the DNS fields', async () => {
    const r = await call('POST', '/api/internet', pppoe({ username: 'new.user@isp.example', autoDns: true }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const wan = lastWanWrite();
    assert.deepEqual(wan.user_info, { username: b64('new.user@isp.example'), auto_config: false });
    assert.equal(wan.ip_info, undefined);
    assert.equal(r.body.current.username, 'new.user@isp.example');
  });

  test('validates input before contacting the Deco', async () => {
    const writes = wanWrites().length;
    assert.match((await call('POST', '/api/internet', pppoe({ mtu: 1500 }))).body.error, /576 and 1492/);
    assert.match((await call('POST', '/api/internet', pppoe({ dns1: '8.8.8' }))).body.error, /primary DNS/);
    assert.match((await call('POST', '/api/internet', pppoe({ username: '' }))).body.error, /username/);
    assert.match((await call('POST', '/api/internet', { type: 'l2tp' })).body.error, /PPPoE, Dynamic IP or Static IP/);
    const badStatic = { type: 'static_ip', ip: '1.2.3.4', mask: 'x', gateway: '1.2.3.1', dns1: '1.1.1.1', mtu: 1500 };
    assert.match((await call('POST', '/api/internet', badStatic)).body.error, /subnet mask/);
    assert.equal(wanWrites().length, writes);
  });

  test('switches to Dynamic IP', async () => {
    const r = await call('POST', '/api/internet', { type: 'dynamic_ip', mtu: 1500, autoDns: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(lastWanWrite(), { dial_type: 'dynamic_ip', support_mtu_size: true, mtu_size: 1500, enable_auto_dns: true });
    assert.equal(r.body.current.type, 'dynamic_ip');
  });

  test('switching back to PPPoE requires both username and password', async () => {
    const r = await call('POST', '/api/internet', pppoe());
    assert.equal(r.status, 400);
    assert.match(r.body.error, /password/);
    const ok = await call('POST', '/api/internet', pppoe({ password: 'isp-pw-2' }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(Object.keys(lastWanWrite().user_info).sort(), ['auto_config', 'password', 'username']);
    assert.equal(mock.state.wanPassword, 'isp-pw-2');
  });

  test('static IP sends address, mask, gateway and DNS together', async () => {
    const r = await call('POST', '/api/internet', {
      type: 'static_ip',
      ip: '203.0.113.10',
      mask: '255.255.255.0',
      gateway: '203.0.113.1',
      dns1: '1.1.1.1',
      dns2: '',
      mtu: 1500,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(lastWanWrite(), {
      dial_type: 'static_ip',
      support_mtu_size: true,
      mtu_size: 1500,
      ip_info: { ip: '203.0.113.10', mask: '255.255.255.0', gateway: '203.0.113.1', dns1: '1.1.1.1', dns2: '' },
    });
  });
});

// Starts a mock Deco + app server and logs in; returns helpers for API calls.
async function startStack({ lockoutMs = '0', probeMs } = {}) {
  const mock = createMockDeco({ password: 'decopass' });
  const decoHost = `127.0.0.1:${await mock.listen()}`;
  const tmpPort = await mock.listenTmp();
  process.env.DECO_TMP_PORT = String(tmpPort);
  process.env.DECO_TMP_LOCKOUT_MS = lockoutMs;
  if (probeMs) process.env.DECO_TMP_PROBE_MS = String(probeMs);
  const app = createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Deco-Local': '1', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await call('POST', '/api/login', { host: decoHost, password: 'decopass' })).status, 200);
  const stop = async () => {
    delete process.env.DECO_TMP_LOCKOUT_MS;
    delete process.env.DECO_TMP_PROBE_MS;
    await mock.close();
    app.closeAllConnections?.();
    await new Promise((r) => app.close(r));
    fs.rmSync(process.env.DECO_LOCAL_CONFIG, { force: true });
  };
  return { mock, call, stop, tmpPort };
}

describe('DHCP server and address reservations', () => {
  let stack;
  let call;
  let mock;
  before(async () => {
    stack = await startStack();
    ({ call, mock } = stack);
  });
  after(() => stack.stop());

  const range = (extra = {}) => ({ start: '192.168.68.100', end: '192.168.71.249', dns1: '', dns2: '', ...extra });

  test('needs the TP-Link ID sign-in to change anything', async () => {
    const r = await call('POST', '/api/dhcp/reservations', { action: 'add', ip: '192.168.68.50', mac: '11-22-33-44-55-01' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /TP-Link ID/);
  });

  test('reads server settings, reservations and leases with device names', async () => {
    const { status, body } = await call('POST', '/api/dhcp', { email: 'owner@example.com' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.server, {
      start: '192.168.68.100',
      end: '192.168.71.249',
      gateway: '192.168.68.1',
      mask: '255.255.252.0',
      dns1: '',
      dns2: '',
      leaseTime: null,
      inUse: 5,
    });
    assert.deepEqual(body.reservations, []);
    assert.equal(body.maxReservations, 64);
    assert.equal(body.leases.length, 5);
    assert.deepEqual(body.leases[0], { ip: '192.168.68.101', mac: '11-22-33-44-55-01', name: "Omar's iPhone", reserved: false });
  });

  test('changes the address range and DNS; no lease time when the Deco does not report one', async () => {
    const r = await call('POST', '/api/dhcp/server', range({ start: '192.168.68.50', end: '192.168.68.200', dns1: '1.1.1.1', leaseTime: 60 }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(mock.tmp.calls.filter((c) => c.opcode === OP.DHCP_SERVER_SET).at(-1).params, {
      gateway: '192.168.68.1',
      start_ip: '192.168.68.50',
      end_ip: '192.168.68.200',
      dns1: '1.1.1.1',
      dns2: '',
    });
    assert.equal(r.body.server.start, '192.168.68.50');
    assert.equal(r.body.server.dns1, '1.1.1.1');
  });

  test('lease time is sent and range-checked when the Deco supports it', async () => {
    mock.state.dhcp.lease_time = 120;
    assert.match((await call('POST', '/api/dhcp/server', range({ leaseTime: 2000 }))).body.error, /between 1 and 1440/);
    const r = await call('POST', '/api/dhcp/server', range({ leaseTime: 600 }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(mock.state.dhcp.lease_time, 600);
    assert.equal(r.body.server.leaseTime, 600);
    delete mock.state.dhcp.lease_time;
  });

  test('rejects invalid server settings before contacting the Deco', async () => {
    const writes = () => mock.tmp.calls.filter((c) => c.opcode === OP.DHCP_SERVER_SET).length;
    const before = writes();
    const err = async (b) => (await call('POST', '/api/dhcp/server', b)).body.error;
    assert.match(await err(range({ start: '192.168.68.200', end: '192.168.68.100' })), /come before/);
    assert.match(await err(range({ start: '192.168.68.1' })), /Deco's own address/);
    assert.match(await err(range({ start: '192.168.67.250', end: '192.168.68.10' })), /must be on the Deco's network/);
    assert.match(await err(range({ end: '192.168.71.255' })), /broadcast/);
    assert.match(await err(range({ dns2: '8.8.8.8' })), /primary DNS before/);
    assert.match(await err(range({ dns1: '8.8.8' })), /valid primary DNS/);
    assert.equal(writes(), before);
  });

  test('adds a reservation, normalising the MAC', async () => {
    const r = await call('POST', '/api/dhcp/reservations', { action: 'add', ip: '192.168.68.20', mac: '11:22:33:44:55:01' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(mock.tmp.calls.filter((c) => c.opcode === OP.RESERVATION_ADD).at(-1).params, {
      reservation_list: [{ ip: '192.168.68.20', mac: '11-22-33-44-55-01' }],
    });
    assert.deepEqual(r.body.reservations, [{ ip: '192.168.68.20', mac: '11-22-33-44-55-01', name: "Omar's iPhone" }]);
    assert.equal(r.body.leases.find((l) => l.mac === '11-22-33-44-55-01').reserved, true);
  });

  test('rejects duplicate, malformed and out-of-network reservations', async () => {
    const err = async (b) => (await call('POST', '/api/dhcp/reservations', { action: 'add', ...b })).body.error;
    assert.match(await err({ ip: '192.168.68.21', mac: '11-22-33-44-55-01' }), /already has a reserved address/);
    assert.match(await err({ ip: '192.168.68.20', mac: '11-22-33-44-55-02' }), /already reserved/);
    assert.match(await err({ ip: '192.168.68.21', mac: 'not-a-mac' }), /MAC address like/);
    assert.match(await err({ ip: '10.0.0.5', mac: '11-22-33-44-55-02' }), /must be on the Deco's network/);
  });

  test("modifies a reservation's address", async () => {
    const r = await call('POST', '/api/dhcp/reservations', {
      action: 'modify',
      originalMac: '11-22-33-44-55-01',
      mac: '11-22-33-44-55-01',
      ip: '192.168.68.30',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(mock.tmp.calls.filter((c) => c.opcode === OP.RESERVATION_MODIFY).at(-1).params, {
      original_ip: '192.168.68.20',
      original_mac: '11-22-33-44-55-01',
      ip: '192.168.68.30',
      mac: '11-22-33-44-55-01',
    });
    assert.equal(r.body.reservations[0].ip, '192.168.68.30');
  });

  test('removes reservations by MAC', async () => {
    await call('POST', '/api/dhcp/reservations', { action: 'add', ip: '192.168.68.31', mac: '11-22-33-44-55-02' });
    const r = await call('POST', '/api/dhcp/reservations', { action: 'remove', macs: ['11-22-33-44-55-01', '11-22-33-44-55-02'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(mock.tmp.calls.filter((c) => c.opcode === OP.RESERVATION_REMOVE).at(-1).params, {
      reservation_list: ['11-22-33-44-55-01', '11-22-33-44-55-02'],
    });
    assert.deepEqual(r.body.reservations, []);
    assert.match((await call('POST', '/api/dhcp/reservations', { action: 'remove', mac: '11-22-33-44-55-09' })).body.error, /No reservation/);
  });
});

describe('control-port lock after a write', () => {
  test('releases early when the port never closes', async () => {
    const stack = await startStack({ lockoutMs: '60000', probeMs: 50 });
    try {
      await stack.call('POST', '/api/dhcp', { email: 'owner@example.com' });
      const w = await stack.call('POST', '/api/dhcp/reservations', { action: 'add', ip: '192.168.68.40', mac: '11-22-33-44-55-03' });
      assert.equal(w.status, 200, JSON.stringify(w.body));
      assert.ok((await stack.call('GET', '/api/mode')).body.busySeconds > 0, 'locked right after the write');
      const blocked = await stack.call('POST', '/api/dhcp', {});
      assert.equal(blocked.body.code, 'busy');
      await new Promise((r) => setTimeout(r, 600));
      assert.equal((await stack.call('GET', '/api/mode')).body.busySeconds, 0, 'released after the port stayed up');
    } finally {
      await stack.stop();
    }
  });

  test('waits for the port to come back when the Deco closes it', async () => {
    const stack = await startStack({ lockoutMs: '60000', probeMs: 50 });
    try {
      await stack.call('POST', '/api/dhcp', { email: 'owner@example.com' });
      await stack.call('POST', '/api/dhcp/reservations', { action: 'add', ip: '192.168.68.41', mac: '11-22-33-44-55-04' });
      await new Promise((r) => stack.mock.tmpServer.close(r)); // the Deco restarts its control port
      await new Promise((r) => setTimeout(r, 600));
      assert.ok((await stack.call('GET', '/api/mode')).body.busySeconds > 0, 'still locked while the port is down');
      await stack.mock.listenTmp(stack.tmpPort);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal((await stack.call('GET', '/api/mode')).body.busySeconds, 0, 'released once the port is back');
    } finally {
      await stack.stop();
    }
  });
});
