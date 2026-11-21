#!/usr/bin/env node
'use strict';

/**
 * Phone Speaker — local-network audio relay.
 *
 * Serves the web app (public/) over HTTP and HTTPS, and relays 16-bit PCM audio
 * batches from one "sender" browser (the computer) to any number of "receiver"
 * browsers (phones) over a single WebSocket endpoint.
 *
 *   node server.js                 # HTTP :3000 + HTTPS :3443
 *   PORT=8080 HTTPS_PORT=8443 node server.js
 *   NO_HTTPS=1 node server.js      # skip the self-signed HTTPS listener
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const NO_HTTPS = process.env.NO_HTTPS === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, '.certs');
const VERSION = require('./package.json').version;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------------------------------------------ *
 * HTTP(S) static file server
 * ------------------------------------------------------------------ */

function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch (e) {
    return null;
  }
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(root, normalized);
  const rel = path.relative(root, full);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : full;
}

function sendFile(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const etag = '"' + stat.size.toString(16) + '-' + Math.round(stat.mtimeMs).toString(16) + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache' });
      res.end();
      return;
    }
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      etag,
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
      // Permissive on purpose: lets the pages be embedded in previews/iframes.
      'x-content-type-options': 'nosniff',
      'permissions-policy': 'display-capture=(self), microphone=(self)',
    };
    if (ext === '.html') headers['cache-control'] = 'no-store';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': MIME['.json'],
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(data);
}

function makeRequestHandler(relay, getPorts) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/info') {
      const ports = getPorts();
      json(res, 200, {
        name: 'phone-speaker',
        version: VERSION,
        addresses: relay.addressList(),
        phones: relay.phoneUrls(ports.httpPort, ports.httpsPort),
        port: ports.httpPort,
        httpsPort: ports.httpsPort,
        receivers: relay.receiverCount(),
        senders: relay.senderCount(),
        bytes: relay.bytes,
        uptime: Math.round((Date.now() - relay.startedAt) / 1000),
      });
      return;
    }

    if (url.pathname === '/api/qr') {
      const target = url.searchParams.get('url') || '';
      if (!/^https?:\/\/[\w.:\[\]-]+(:\d+)?(\/\S*)?$/.test(target) || target.length > 2048) {
        json(res, 400, { error: 'invalid url' });
        return;
      }
      let qrcode;
      try {
        qrcode = require('qrcode');
      } catch (e) {
        json(res, 503, { error: 'qrcode module is not installed — run npm install' });
        return;
      }
      qrcode
        .toBuffer(target, { type: 'png', width: 640, margin: 1, errorCorrectionLevel: 'M' })
        .then((png) => {
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'max-age=600' });
          res.end(png);
        })
        .catch(() => json(res, 500, { error: 'could not render qr code' }));
      return;
    }

    let urlPath = url.pathname;
    if (urlPath === '/') urlPath = '/index.html';
    else if (urlPath === '/phone' || urlPath === '/phone/') urlPath = '/phone.html';
    const filePath = safeJoin(PUBLIC_DIR, urlPath);
    if (!filePath) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('400 Bad Request');
      return;
    }
    sendFile(req, res, filePath);
  };
}

/* ------------------------------------------------------------------ *
 * WebSocket relay — 1 sender → N receivers
 *
 * client → server   {type:'hello', role:'sender'|'receiver', id?, name?}
 * server → client   {type:'welcome', id, role, receivers, senders, serverTime}
 * client → server   {type:'format', sampleRate, source, label}   (sender)
 * client → server   {type:'sender-state', state, source, label}  (sender)
 * client → server   {type:'stats', payload:{...}}                (sender → phones)
 * client → server   {type:'receiver-stats', payload:{...}}       (phone → computer)
 * client → server   {type:'ping', t}   ·   server → client {type:'pong', t, serverTime}
 * server → all      {type:'peers', receivers, senders}
 * binary frame      raw little-endian Int16 stereo PCM, 20 ms batches
 * ------------------------------------------------------------------ */

class Relay {
  constructor() {
    this.sockets = new Set(); // every raw TCP socket, for a fast shutdown
    this.clients = new Map(); // ws → {role, id, name, connectedAt, ua}
    this.startedAt = Date.now();
    this.bytes = 0;
    this.batches = 0;
    this.heartbeat = null;
  }

  addressList() {
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const net of ifaces[name] || []) {
        if (net.family === 'IPv4' && !net.internal) out.push({ iface: name, address: net.address });
      }
    }
    return out;
  }

  phoneUrls(httpPort, httpsPort) {
    const list = [];
    if (httpsPort) {
      for (const a of this.addressList()) {
        list.push({ label: a.address, url: `https://${a.address}:${httpsPort}/phone.html`, secure: true });
      }
    }
    for (const a of this.addressList()) {
      list.push({ label: a.address, url: `http://${a.address}:${httpPort}/phone.html`, secure: false });
    }
    if (!list.length) {
      list.push({
        label: 'localhost',
        url: `http${httpsPort ? 's' : ''}://localhost:${httpsPort || httpPort}/phone.html`,
        secure: Boolean(httpsPort),
      });
    }
    // Prefer the secure URL for the QR code: AudioWorklet and low latency need it.
    const pick = list.find((p) => p.secure) || list[0];
    pick.primary = true;
    return list;
  }

  senderCount() {
    let n = 0;
    for (const c of this.clients.values()) if (c.role === 'sender') n++;
    return n;
  }

  receiverCount() {
    let n = 0;
    for (const c of this.clients.values()) if (c.role === 'receiver') n++;
    return n;
  }

  *receivers() {
    for (const entry of this.clients) if (entry[1].role === 'receiver') yield entry;
  }

  send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  broadcast(obj, exceptWs) {
    const data = JSON.stringify(obj);
    for (const [ws] of this.clients) {
      if (ws !== exceptWs && ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  announcePeers() {
    this.broadcast({ type: 'peers', receivers: this.receiverCount(), senders: this.senderCount() });
  }

  /** Wire one WebSocketServer (plain or TLS) to the same client pool. */
  attach(wss) {
    wss.on('connection', (ws, req) => {
      ws.isAlive = true;
      const client = {
        role: null,
        id: crypto.randomBytes(3).toString('hex'),
        name: '',
        connectedAt: Date.now(),
        ua: String(req.headers['user-agent'] || '').slice(0, 200),
      };
      this.clients.set(ws, client);

      ws.on('pong', () => { ws.isAlive = true; });

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          if (client.role !== 'sender') return; // phones never inject audio
          this.bytes += data.length;
          this.batches++;
          for (const [peer] of this.receivers()) {
            if (peer.readyState === peer.OPEN) peer.send(data, { binary: true });
          }
          return;
        }

        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch (e) {
          return;
        }
        if (!msg || typeof msg.type !== 'string') return;

        switch (msg.type) {
          case 'hello': {
            client.role = msg.role === 'sender' ? 'sender' : 'receiver';
            if (typeof msg.id === 'string' && /^[a-z0-9-]{4,40}$/i.test(msg.id)) client.id = msg.id;
            if (typeof msg.name === 'string') client.name = msg.name.slice(0, 40);
            this.send(ws, {
              type: 'welcome',
              id: client.id,
              role: client.role,
              receivers: this.receiverCount(),
              senders: this.senderCount(),
              serverTime: Date.now(),
            });
            this.announcePeers();
            break;
          }
          case 'format': {
            if (client.role !== 'sender') break;
            const rate = Number(msg.sampleRate);
            this.broadcast({
              type: 'format',
              sampleRate: Number.isFinite(rate) ? Math.max(8000, Math.min(192000, Math.round(rate))) : 48000,
              source: typeof msg.source === 'string' ? msg.source.slice(0, 20) : 'unknown',
              label: typeof msg.label === 'string' ? msg.label.slice(0, 80) : '',
              senderId: client.id,
            }, ws);
            break;
          }
          case 'sender-state': {
            if (client.role !== 'sender') break;
            this.broadcast({
              type: 'sender',
              state: msg.state === 'live' ? 'live' : 'idle',
              source: typeof msg.source === 'string' ? msg.source.slice(0, 20) : 'unknown',
              label: typeof msg.label === 'string' ? msg.label.slice(0, 80) : '',
              senderId: client.id,
            }, ws);
            break;
          }
          case 'control': {
            // Live tweaks from the computer page → every phone.
            const out = { type: 'control', senderId: client.id };
            if (Number.isFinite(msg.targetMs)) out.targetMs = Math.max(40, Math.min(2000, Math.round(msg.targetMs)));
            if (Number.isFinite(msg.volume)) out.volume = Math.max(0, Math.min(1, msg.volume));
            if (msg.action === 'pause' || msg.action === 'play') out.action = msg.action;
            this.broadcast(out, ws);
            break;
          }
          case 'ping':
            this.send(ws, { type: 'pong', t: msg.t, serverTime: Date.now() });
            break;
          case 'stats': {
            if (client.role === 'sender') {
              this.broadcast({ type: 'stats', senderId: client.id, payload: msg.payload || {} }, ws);
            } else {
              this.broadcast({ type: 'receiver-stats', from: client.id, payload: msg.payload || {} }, ws);
            }
            break;
          }
          default:
            break;
        }
      });

      ws.on('close', () => {
        const wasSender = client.role === 'sender';
        this.clients.delete(ws);
        if (wasSender) this.broadcast({ type: 'sender', state: 'idle', senderId: client.id });
        this.announcePeers();
      });
      ws.on('error', () => {});
    });
  }

  /** Terminate sockets that stopped answering pings (phones that went to sleep). */
  startHeartbeat(intervalMs = 30000) {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const [ws] of this.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch (e) {
          /* socket already gone */
        }
      }
    }, intervalMs);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  /** Drop every live connection so Node can exit immediately. */
  destroyAll() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const ws of [...this.clients.keys()]) {
      try {
        ws.terminate();
      } catch (e) {
        /* ignore */
      }
    }
    this.clients.clear();
    for (const socket of [...this.sockets]) {
      try {
        socket.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    this.sockets.clear();
  }
}

/* ------------------------------------------------------------------ *
 * Self-signed HTTPS — required for AudioWorklet, tab capture and the mic
 * ------------------------------------------------------------------ */

async function loadOrCreateCert() {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  try {
    const [key, cert] = await Promise.all([fs.promises.readFile(keyPath, 'utf8'), fs.promises.readFile(certPath, 'utf8')]);
    if (key.includes('BEGIN') && cert.includes('BEGIN')) return { key, cert };
  } catch (e) {
    /* not generated yet */
  }

  let selfsigned;
  try {
    selfsigned = require('selfsigned');
  } catch (e) {
    console.warn('! selfsigned is not installed — HTTPS disabled (run npm install to enable it)');
    return null;
  }

  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, { type: 2, value: 'phone-speaker.local' }];
  for (const net of Object.values(os.networkInterfaces()).flat()) {
    if (net && net.family === 'IPv4' && !net.internal) altNames.push({ type: 7, ip: net.address });
  }

  const notBefore = new Date(Date.now() - 86400000);
  const notAfter = new Date(notBefore.getTime() + 5 * 365 * 86400000);

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'phone-speaker.local' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  try {
    await fs.promises.mkdir(CERT_DIR, { recursive: true });
    await fs.promises.writeFile(keyPath, pems.private, { mode: 0o600 });
    await fs.promises.writeFile(certPath, pems.cert);
  } catch (e) {
    console.warn('! Could not cache the certificate in .certs/:', e.message);
  }
  return { key: pems.private, cert: pems.cert };
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function main(options = {}) {
  const httpPort = options.port != null ? options.port : PORT;
  const httpsPort = options.httpsPort != null ? options.httpsPort : HTTPS_PORT;
  const wantHttps = options.https !== undefined ? options.https : !NO_HTTPS;
  const quiet = Boolean(options.quiet);

  const relay = new Relay();
  const ports = { httpPort, httpsPort: null };
  const handler = makeRequestHandler(relay, () => ({ httpPort: ports.httpPort, httpsPort: ports.httpsPort }));

  const httpServer = http.createServer(handler);
  const trackSockets = (server) =>
    server.on('connection', (socket) => {
      relay.sockets.add(socket);
      socket.on('close', () => relay.sockets.delete(socket));
    });
  trackSockets(httpServer);

  const wss = new WebSocketServer({ server: httpServer, maxPayload: 1024 * 1024 });
  relay.attach(wss);
  relay.startHeartbeat();

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(httpPort, '0.0.0.0', resolve);
  });
  ports.httpPort = httpServer.address().port;

  let httpsServer = null;
  if (wantHttps) {
    const pems = await loadOrCreateCert();
    if (pems) {
      httpsServer = https.createServer(pems, handler);
      trackSockets(httpsServer);
      relay.attach(new WebSocketServer({ server: httpsServer, maxPayload: 1024 * 1024 }));
      try {
        await new Promise((resolve, reject) => {
          httpsServer.once('error', reject);
          httpsServer.listen(httpsPort, '0.0.0.0', resolve);
        });
        ports.httpsPort = httpsServer.address().port;
      } catch (e) {
        console.warn(`! HTTPS port ${httpsPort} unavailable (${e.code || e.message}) — continuing with HTTP only`);
        httpsServer = null;
      }
    }
  }

  const lan = relay.addressList();
  const lanIPv4 = lan.length ? lan[0].address : 'localhost';
  const phones = relay.phoneUrls(ports.httpPort, ports.httpsPort);
  const primary = phones.find((p) => p.primary) || phones[0];

  if (!quiet) {
    const line = '─'.repeat(66);
    console.log('');
    console.log(`  🔈  Phone Speaker`);
    console.log(`  ${line}`);
    console.log(`  Computer   http://localhost:${ports.httpPort}/`);
    if (httpsServer) {
      console.log(`             https://localhost:${ports.httpsPort}/   ← use this one for tab / mic capture`);
      console.log(`             https://${lanIPv4}:${ports.httpsPort}/`);
    }
    console.log('');
    console.log(`  Phone      ${primary.url}`);
    for (const p of phones.filter((x) => x !== primary && x.secure)) {
      console.log(`             ${p.url}`);
    }
    console.log('');
    console.log('  1. Open the Computer URL here, pick a source, press Start.');
    console.log('  2. Scan the QR code with the phone (same Wi-Fi).');
    console.log('  3. Tap ▶ Start on the phone. Accept the certificate warning.');
    if (!httpsServer) console.log('\n  ⚠  HTTPS is off: AudioWorklet, tab capture and the mic will not work.');
    console.log(`  ${line}`);
    console.log('');
  }

  if (process.env.PHONE_SPEAKER_URL_FILE) {
    try {
      fs.writeFileSync(process.env.PHONE_SPEAKER_URL_FILE, JSON.stringify({
        http: `http://localhost:${ports.httpPort}`,
        https: httpsServer ? `https://localhost:${ports.httpsPort}` : null,
        phone: primary.url,
        phones,
        port: ports.httpPort,
        httpsPort: ports.httpsPort,
        lan: lanIPv4,
      }, null, 2));
    } catch (e) {
      /* best effort */
    }
  }

  let closed = false;
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise((resolve) => {
      const finish = () => resolve();
      const timer = setTimeout(finish, 500);
      if (timer.unref) timer.unref();
      try {
        wss.close();
        if (httpsServer) httpsServer.close();
        httpServer.close();
      } catch (e) {
        /* already closed */
      }
      relay.destroyAll();
      setTimeout(finish, 30);
    });
  };

  return { httpServer, httpsServer, relay, wss, ports, phones, close };
}

if (require.main === module) {
  main()
    .then((app) => {
      const stop = () => {
        console.log('\n  Shutting down…');
        app.close().then(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500).unref();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err) => {
      console.error('Fatal:', err);
      process.exit(1);
    });
}

module.exports = { main, Relay, safeJoin, PORT, HTTPS_PORT, PUBLIC_DIR };
