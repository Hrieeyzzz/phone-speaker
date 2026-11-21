#!/usr/bin/env node
'use strict';

/**
 * Headless protocol + relay tests. No browser needed: spins up the real server
 * on an ephemeral port and talks WebSocket / HTTP to it directly.
 *
 *   npm test
 */

const assert = require('assert');
const http = require('http');
const { WebSocket } = require('ws');
const { main } = require('./server');

let passed = 0;
let failed = 0;

function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`      ${err.message.split('\n')[0]}`);
    });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolve with the next JSON frame, optionally skipping types we don't care about. */
const nextJson = (ws, wanted) =>
  new Promise((resolve) => {
    const onMsg = (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      if (wanted && !wanted.includes(msg.type)) return;
      ws.off('message', onMsg);
      resolve(msg);
    };
    ws.on('message', onMsg);
  });

const nextBinary = (ws) =>
  new Promise((resolve) => {
    const onMsg = (data, isBinary) => {
      if (!isBinary) return;
      ws.off('message', onMsg);
      resolve(Buffer.from(data));
    };
    ws.on('message', onMsg);
  });

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

async function run() {
  const app = await main({ port: 0, https: false, quiet: true });
  const port = app.ports.httpPort;
  const base = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;

  console.log(`\n  Phone Speaker — relay & protocol tests (port ${port})\n`);

  await ok('server answers /api/info with version and phone URLs', async () => {
    const res = await get(`${base}/api/info`);
    assert.strictEqual(res.status, 200);
    const info = JSON.parse(res.body.toString());
    assert.strictEqual(info.name, 'phone-speaker');
    assert.ok(/^\d+\.\d+\.\d+/.test(info.version), 'version looks semver-ish');
    assert.ok(Array.isArray(info.phones) && info.phones.length >= 1, 'has at least one phone URL');
    assert.ok(info.phones.some((p) => /\/phone\.html$/.test(p.url)), 'phone URL points at phone.html');
    assert.strictEqual(info.port, port);
  });

  await ok('static pages are served and /phone is an alias', async () => {
    const index = await get(`${base}/`);
    assert.strictEqual(index.status, 200);
    assert.match(index.headers['content-type'], /text\/html/);
    assert.match(index.body.toString(), /Phone Speaker/);

    const phone = await get(`${base}/phone`);
    assert.strictEqual(phone.status, 200);
    assert.match(phone.body.toString(), /app-phone\.js/);

    const worklet = await get(`${base}/pcm-player.js`);
    assert.strictEqual(worklet.status, 200);
    assert.match(worklet.headers['content-type'], /javascript/);

    const missing = await get(`${base}/nope.html`);
    assert.strictEqual(missing.status, 404);
  });

  await ok('path traversal cannot escape public/', async () => {
    const res = await get(`${base}/..%2Fserver.js`);
    assert.ok(res.status === 400 || res.status === 404, `expected 400/404, got ${res.status}`);
    assert.ok(!res.body.toString().includes('WebSocketServer'), 'server source must not leak');
  });

  await ok('QR endpoint renders a PNG for a LAN URL and rejects junk', async () => {
    const good = await get(`${base}/api/qr?url=${encodeURIComponent('http://192.168.1.23:3000/phone.html')}`);
    assert.strictEqual(good.status, 200);
    assert.strictEqual(good.headers['content-type'], 'image/png');
    assert.strictEqual(good.body[0], 0x89);
    assert.strictEqual(good.body.slice(1, 4).toString(), 'PNG');

    const bad = await get(`${base}/api/qr?url=${encodeURIComponent('javascript:alert(1)')}`);
    assert.strictEqual(bad.status, 400);
  });

  await ok('handshake returns welcome with a role and a client id', async () => {
    const ws = await openWs(wsBase);
    ws.send(JSON.stringify({ type: 'hello', role: 'receiver', name: 'test phone' }));
    const welcome = await nextJson(ws);
    assert.strictEqual(welcome.type, 'welcome');
    assert.strictEqual(welcome.role, 'receiver');
    assert.match(welcome.id, /^[a-z0-9]{4,8}$/i);
    assert.strictEqual(typeof welcome.receivers, 'number');
    ws.close();
  });

  await ok('binary PCM from a sender reaches every receiver byte-for-byte', async () => {
    const sender = await openWs(wsBase);
    sender.send(JSON.stringify({ type: 'hello', role: 'sender', name: 'pc' }));
    await nextJson(sender);

    const a = await openWs(wsBase);
    const b = await openWs(wsBase);
    const welcomeA = nextJson(a);
    a.send(JSON.stringify({ type: 'hello', role: 'receiver', name: 'phone A' }));
    await welcomeA;
    const welcomeB = nextJson(b);
    b.send(JSON.stringify({ type: 'hello', role: 'receiver', name: 'phone B' }));
    await welcomeB;

    const payload = Buffer.alloc(1920 * 2 * 2);
    for (let i = 0; i < payload.length; i += 2) payload.writeInt16LE(((i * 7919) % 65536) - 32768, i);

    const gotA = nextBinary(a);
    const gotB = nextBinary(b);
    sender.send(payload);
    const [pa, pb] = await Promise.all([gotA, gotB]);
    assert.strictEqual(pa.length, payload.length);
    assert.ok(pa.equals(payload), 'receiver A must get the identical batch');
    assert.ok(pb.equals(payload), 'receiver B must get the identical batch');

    // A receiver that injects audio must not be relayed (phones are consumers).
    const notRelayed = new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 400);
      a.once('message', (data, isBinary) => {
        if (isBinary) {
          clearTimeout(t);
          resolve('leaked');
        }
      });
    });
    a.send(payload);
    assert.strictEqual(await notRelayed, 'timeout', 'receiver audio must never be fanned out');

    a.close();
    b.close();
    sender.close();
    await sleep(30);
  });

  await ok('peers count updates as phones join and leave', async () => {
    const sender = await openWs(wsBase);
    sender.send(JSON.stringify({ type: 'hello', role: 'sender' }));
    await nextJson(sender);

    const peersAfterSender = nextJson(sender);
    const phone = await openWs(wsBase);
    phone.send(JSON.stringify({ type: 'hello', role: 'receiver' }));
    const peers = await peersAfterSender;
    assert.strictEqual(peers.type, 'peers');
    assert.strictEqual(peers.receivers, 1);
    assert.strictEqual(peers.senders, 1);

    const gone = nextJson(sender);
    phone.close();
    const after = await gone;
    assert.strictEqual(after.receivers, 0);
    sender.close();
    await sleep(30);
  });

  await ok('ping → pong echoes the timestamp and control frames reach phones', async () => {
    const sender = await openWs(wsBase);
    sender.send(JSON.stringify({ type: 'hello', role: 'sender' }));
    await nextJson(sender);

    const phone = await openWs(wsBase);
    const welcome = nextJson(phone, ['welcome']);
    phone.send(JSON.stringify({ type: 'hello', role: 'receiver' }));
    await welcome;

    const t = 123456789;
    sender.send(JSON.stringify({ type: 'ping', t }));
    const pong = await nextJson(sender, ['pong']);
    assert.strictEqual(pong.type, 'pong');
    assert.strictEqual(pong.t, t);
    assert.ok(Math.abs(pong.serverTime - Date.now()) < 5000);

    const control = nextJson(phone, ['control']);
    sender.send(JSON.stringify({ type: 'control', targetMs: 260, volume: 0.42 }));
    const ctl = await control;
    assert.strictEqual(ctl.type, 'control');
    assert.strictEqual(ctl.targetMs, 260);
    assert.strictEqual(ctl.volume, 0.42);

    // Junk control values are clamped rather than forwarded blindly.
    const clamped = nextJson(phone, ['control']);
    sender.send(JSON.stringify({ type: 'control', targetMs: -5, volume: 17 }));
    const c2 = await clamped;
    assert.strictEqual(c2.targetMs, 40);
    assert.strictEqual(c2.volume, 1);

    phone.close();
    sender.close();
    await sleep(30);
  });

  await app.close();
  await sleep(50);
}

run()
  .then(() => {
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error('\n  Test harness crashed:', err);
    process.exit(1);
  });
