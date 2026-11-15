'use strict';

// Client for the Deco app's own local protocol ("TMP"). The app uses it instead of
// the HTTP API, and some settings (such as Router / Access Point mode) exist only here.
//
// The protocol was reverse-engineered by mthsg/pydeco-tmp and ukbodypilot/deco-local
// (both MIT). Summary:
//   - SSH to the main Deco on port 20001 (dropbear). Username = hex(SHA-1(TP-Link ID email)),
//     password = TP-Link ID password. Make ONE password attempt: the Deco locks out on failures.
//   - Open a direct-tcpip channel to 127.0.0.1:20002, where the TMP daemon listens.
//     Opening the channel is the whole handshake.
//   - TMP frame, big-endian:
//       01 01 <type> 00 | u16 payload length | 00 00 | u32 seq | u32 crc32 | payload
//     type 5 = data; 4 = keep-alive (4 bytes, answer 01 01 04 00); 2 = stray ack (4 bytes).
//     crc32 covers the header (with 0x5A6B7C8D in the crc field) plus the payload.
//   - Business v2 packet inside type 5, big-endian:
//       01 02 | u16 opcode | u8 ptype | u8 err | u16 txid | u32 crc32(body) | u32 total | u32 offset | body
//     ptype 2 = request, 5 = response, 4 = pull the next fragment of a long response.
//   - First request is ALLOC (opcode 1, empty body). Others carry JSON
//     {"config_version": <ms>, "params": {...}}.
//   - After a write, the Deco closes port 20001 for roughly 60-95 seconds.

const crypto = require('node:crypto');
const { Client } = require('ssh2');

const TMP_PORT = 20001;
const TMP_DAEMON = { host: '127.0.0.1', port: 20002 };
const TMP_ORIGIN = { host: '127.0.0.1', port: 54321 };
const CRC_PLACEHOLDER = 0x5a6b7c8d;
const PT_PUSH = 2;
const PT_PULL = 4;
const PT_RESP = 5;

const OP = {
  ALLOC: 0x0001,
  WAN_LAN_STATUS: 0x4004,
  WAN_IPV4_SET: 0x4005,
  RESERVATIONS: 0x40c0,
  RESERVATION_ADD: 0x40c1,
  RESERVATION_MODIFY: 0x40c2,
  RESERVATION_REMOVE: 0x40c3,
  DHCP_SERVER: 0x4213,
  DHCP_SERVER_SET: 0x4214,
  DHCP_LEASES: 0x423d,
  OPERATION_MODE: 0x40a0,
  OPERATION_MODE_SET: 0x40a1,
};

class TmpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TmpError';
    this.code = code;
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// Same as zlib.crc32 (not available in Node 18).
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function tmpFrame(payload, seq) {
  const head = Buffer.alloc(16);
  head.writeUInt8(1, 0);
  head.writeUInt8(1, 1);
  head.writeUInt8(5, 2);
  head.writeUInt16BE(payload.length, 4);
  head.writeUInt32BE(seq >>> 0, 8);
  head.writeUInt32BE(CRC_PLACEHOLDER, 12);
  head.writeUInt32BE(crc32(Buffer.concat([head, payload])), 12);
  return Buffer.concat([head, payload]);
}

function bizPacket(opcode, ptype, body, txid, { total = body.length, offset = 0, err = 0 } = {}) {
  const head = Buffer.alloc(20);
  head.writeUInt8(1, 0);
  head.writeUInt8(2, 1);
  head.writeUInt16BE(opcode, 2);
  head.writeUInt8(ptype, 4);
  head.writeUInt8(err, 5);
  head.writeUInt16BE(txid & 0xffff, 6);
  head.writeUInt32BE(body.length ? crc32(body) : 0, 8);
  head.writeUInt32BE(total >>> 0, 12);
  head.writeUInt32BE(offset >>> 0, 16);
  return Buffer.concat([head, body]);
}

function parseBiz(buf) {
  if (buf.length < 20) throw new TmpError('Short response from the Deco.');
  return {
    opcode: buf.readUInt16BE(2),
    ptype: buf.readUInt8(4),
    err: buf.readUInt8(5),
    txid: buf.readUInt16BE(6),
    crc: buf.readUInt32BE(8),
    total: buf.readUInt32BE(12),
    offset: buf.readUInt32BE(16),
    body: buf.subarray(20),
  };
}

const sha1Hex = (s) => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');

class TmpClient {
  constructor({ host, port = TMP_PORT, email, password, timeoutMs = 15000, hostKeySha256 = null }) {
    this.host = host;
    this.port = port;
    this.email = email;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.expectedHostKey = hostKeySha256 ? hostKeySha256.toLowerCase() : null;
    this.hostKeySha256 = null;
    this._conn = null;
    this._stream = null;
    this._buf = Buffer.alloc(0);
    this._waiter = null;
    this._closedError = null;
    this._seq = 1;
    this._txid = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.close();
        reject(err);
      };
      const conn = new Client();
      this._conn = conn;

      conn.on('ready', () => {
        conn.forwardOut(TMP_ORIGIN.host, TMP_ORIGIN.port, TMP_DAEMON.host, TMP_DAEMON.port, (err, stream) => {
          if (err) return fail(new TmpError(`The Deco refused the control channel: ${err.message}`, 'channel'));
          this._stream = stream;
          stream.on('data', (chunk) => {
            this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
            this._wake();
          });
          const onEnd = () => {
            this._closedError = this._closedError || new TmpError('The Deco closed the control channel.', 'closed');
            this._wake();
          };
          stream.on('close', onEnd);
          stream.on('end', onEnd);
          this._request(OP.ALLOC, null)
            .then(() => {
              settled = true;
              resolve(this);
            })
            .catch(fail);
        });
      });

      conn.on('error', (err) => {
        if (err.level === 'client-authentication') {
          return fail(
            new TmpError(
              'The Deco rejected that TP-Link ID email or password. It locks out after repeated failures, so double-check before trying again.',
              'auth'
            )
          );
        }
        if (err.code === 'ECONNREFUSED') {
          return fail(
            new TmpError(
              "The Deco's control port isn't accepting connections. It closes for 1-2 minutes after a change; try again shortly.",
              'busy'
            )
          );
        }
        if (/verification failed/i.test(err.message)) {
          return fail(
            new TmpError(
              "The Deco's SSH key doesn't match the one seen before. Refusing to send your TP-Link password to it.",
              'hostkey'
            )
          );
        }
        fail(new TmpError(`Could not connect to the Deco's control port: ${err.message}`, err.code || 'connect'));
      });

      conn.connect({
        host: this.host,
        port: this.port,
        username: sha1Hex(this.email),
        password: this.password,
        // Exactly one password attempt; never fall back to other methods.
        authHandler: ['password'],
        tryKeyboard: false,
        readyTimeout: this.timeoutMs,
        hostHash: 'sha256',
        hostVerifier: (hash) => {
          this.hostKeySha256 = String(hash).toLowerCase();
          return !this.expectedHostKey || this.expectedHostKey === this.hostKeySha256;
        },
      });
    });
  }

  _wake() {
    if (this._waiter && this._waiter()) this._waiter = null;
  }

  _readExact(n) {
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (this._buf.length >= n) {
          const out = Buffer.from(this._buf.subarray(0, n));
          this._buf = this._buf.subarray(n);
          resolve(out);
          return true;
        }
        if (this._closedError) {
          reject(this._closedError);
          return true;
        }
        return false;
      };
      if (!attempt()) this._waiter = attempt;
    });
  }

  // Next type-5 payload; answers keep-alives and skips stray acks on the way.
  async _readPayload() {
    for (;;) {
      const head = await this._readExact(4);
      const type = head[2];
      if (type === 4) {
        this._stream.write(Buffer.from([1, 1, 4, 0]));
        continue;
      }
      if (type === 2) continue;
      if (type !== 5) throw new TmpError(`Unexpected TMP frame type ${type}.`);
      const rest = await this._readExact(12);
      const length = Buffer.concat([head, rest]).readUInt16BE(4);
      return length ? this._readExact(length) : Buffer.alloc(0);
    }
  }

  _send(packet) {
    this._stream.write(tmpFrame(packet, this._seq++));
  }

  async _request(opcode, params) {
    if (!this._stream) throw new TmpError('Not connected.');
    const txid = opcode === OP.ALLOC ? 0 : (this._txid = (this._txid + 1) & 0xffff);
    let body = Buffer.alloc(0);
    if (opcode !== OP.ALLOC) {
      const payload = { config_version: Date.now() };
      if (params != null) payload.params = params;
      body = Buffer.from(JSON.stringify(payload), 'utf8');
    }

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this._closedError = new TmpError('The Deco took too long to answer.', 'timeout');
        this._wake();
        reject(this._closedError);
      }, this.timeoutMs);
    });

    const exchange = (async () => {
      this._send(bizPacket(opcode, PT_PUSH, body, txid));
      let data = Buffer.alloc(0);
      for (;;) {
        const p = parseBiz(await this._readPayload());
        if (p.txid !== txid) continue; // asynchronous push for something else
        if (p.err !== 0) throw new TmpError(`The Deco returned error ${p.err} for opcode 0x${opcode.toString(16)}.`, p.err);
        if (p.ptype !== PT_RESP) throw new TmpError(`Unexpected packet type ${p.ptype} from the Deco.`);
        data = Buffer.concat([data, p.body]);
        if (p.total === 0 || data.length >= p.total) return data;
        this._send(bizPacket(opcode, PT_PULL, Buffer.alloc(0), txid, { total: 0, offset: data.length }));
      }
    })();

    try {
      return await Promise.race([exchange, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Sends a request and returns its decoded `result`.
  async call(opcode, params = null) {
    const raw = await this._request(opcode, params);
    if (!raw.length) return null;
    let doc;
    try {
      doc = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new TmpError('The Deco sent a response that is not JSON.');
    }
    const code = doc && doc.error_code;
    if (code != null && code !== 0) throw new TmpError(`The Deco returned error ${code}.`, code);
    return doc && 'result' in doc ? doc.result : doc;
  }

  close() {
    try {
      if (this._stream) this._stream.end();
    } catch {}
    try {
      if (this._conn) this._conn.end();
    } catch {}
    this._stream = null;
    this._conn = null;
  }
}

// Connects, runs fn(client), and always disconnects: the Deco serves one TMP session at a time.
async function withTmp(options, fn) {
  const client = new TmpClient(options);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

module.exports = { TmpClient, TmpError, withTmp, OP, TMP_PORT, crc32, tmpFrame, bizPacket, parseBiz, sha1Hex };
