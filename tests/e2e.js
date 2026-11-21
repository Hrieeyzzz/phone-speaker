#!/usr/bin/env node
'use strict';

/**
 * End-to-end tests with a real Chromium.
 *
 *   npm run test:e2e
 *
 * Prerequisites (once):
 *   npm install --no-save playwright-core
 *   npx playwright-core install chromium   # or: npx playwright install chromium
 *
 * The suite boots the real server, opens the computer page and two phone pages
 * with a fake microphone device, and asserts 20 things about the full pipeline:
 * page wiring, AudioWorklet modules, PCM framing, the relay hop, the phone's
 * jitter buffer, live controls and a graceful shutdown.
 *
 * Environment overrides:
 *   CHROME_PATH  path to a Chromium/Chrome binary (skips the Playwright download)
 *   HEADFUL=1    watch the test run in a visible browser window
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { main } = require('../server');

/* ------------------------------------------------------------------ *
 * Tiny test harness
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`      ${String(err.message).split('\n').join('\n      ')}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 12000, interval = 200, label = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label} (${timeout} ms)`);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

/* ------------------------------------------------------------------ *
 * Browser discovery — works with Playwright, a system Chrome, or a
 * Chromium bundled in another package (handy on servers & CI images).
 * ------------------------------------------------------------------ */

function findChromium() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);

  try {
    // playwright / playwright-core (regular install)
    const { chromium } = require('playwright');
    const p = chromium.executablePath();
    if (p) candidates.push(p);
  } catch (e) {
    /* not installed */
  }
  try {
    const { chromium } = require('playwright-core');
    const p = chromium.executablePath();
    if (p) candidates.push(p);
  } catch (e) {
    /* not installed */
  }

  candidates.push(
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  );

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (e) {
      /* keep looking */
    }
  }
  // Last resort: a Chromium bundled by @sparticuz/chromium (Lambda-style images)
  try {
    // eslint-disable-next-line global-require
    const bundled = require('@sparticuz/chromium');
    if (typeof bundled.executablePathSync === 'function') return bundled.executablePathSync();
  } catch (e) {
    /* not installed */
  }
  return null;
}

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    /* fall through */
  }
  try {
    return require('playwright-core');
  } catch (e) {
    /* fall through */
  }
  return null;
}

/**
 * Playwright's default (pipe-based) launch can leave the audio service unable
 * to load AudioWorklet modules on headless Linux CI images. Launching Chromium
 * ourselves with a TCP debugging port and connecting over CDP is reliable.
 */
async function launchBrowser(pw, exePath, { headless }) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-speaker-e2e-'));
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--mute-audio',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    headless === false ? 'about:blank' : '--headless=new',
  ].filter(Boolean);
  if (headless === false) args.splice(args.indexOf('--headless=new'), 1);

  const out = fs.openSync(path.join(profile, 'chromium.log'), 'w');
  const child = spawn(exePath, args, { stdio: ['ignore', out, out], detached: process.platform !== 'win32' });
  const wsUrl = `http://127.0.0.1:${port}`;

  const browser = await waitFor(
    async () => {
      try {
        return await pw.chromium.connectOverCDP(wsUrl);
      } catch (e) {
        return null;
      }
    },
    { timeout: 15000, interval: 250, label: 'Chromium DevTools endpoint' }
  );

  return {
    browser,
    port,
    async close() {
      try {
        await browser.close();
      } catch (e) {
        /* ignore */
      }
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (e) {
        /* ignore */
      }
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch (e) {
        /* ignore */
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * The suite
 * ------------------------------------------------------------------ */

async function run() {
  const pw = loadPlaywright();
  if (!pw) {
    console.error(
      '\n  Playwright is not installed. Run:\n' +
        '    npm install --no-save playwright-core\n' +
        '    npx playwright-core install chromium\n' +
        '  …or set CHROME_PATH to an existing Chrome/Chromium binary.\n'
    );
    process.exit(2);
  }
  const exePath = findChromium();
  if (!exePath) {
    console.error(
      '\n  No Chromium binary found. Either run `npx playwright-core install chromium`\n' +
        '  or point CHROME_PATH at Chrome/Chromium.\n'
    );
    process.exit(2);
  }

  const headless = process.env.HEADFUL !== '1';
  const app = await main({ port: 0, https: false, quiet: true });
  const port = app.ports.httpPort;
  const base = `http://127.0.0.1:${port}`;

  const launched = await launchBrowser(pw, exePath, { headless });
  const { browser } = launched;

  console.log(`\n  Phone Speaker — end-to-end tests`);
  console.log(`  server :${port} · chromium ${browser.version()} · ${headless ? 'headless' : 'headful'}\n`);

  const ctx = browser.contexts()[0];
  const pageErrors = [];
  const wire = (page, tag) => {
    page.on('pageerror', (e) => pageErrors.push(`${tag}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(`${tag} console: ${m.text()}`);
    });
    return page;
  };

  let pc;
  let phoneA;
  let phoneB;

  try {
    /* ---------------- 1–4: pages load ---------------- */
    await check('computer page loads with its UI and connects to the relay', async () => {
      pc = wire(await ctx.newPage(), 'pc');
      const res = await pc.goto(base + '/', { waitUntil: 'domcontentloaded' });
      assert.strictEqual(res.status(), 200);
      assert.strictEqual(await pc.title(), 'Phone Speaker');
      assert.ok(await pc.locator('.source').count() >= 3, 'three source buttons');
      await waitFor(() => pc.evaluate(() => window.__phoneSpeaker && window.__phoneSpeaker.state.wsOpen), {
        label: 'relay WebSocket to open',
      });
    });

    await check('the capture worklet module loads and pre-warms', async () => {
      const ready = await waitFor(() => pc.evaluate(() => window.__phoneSpeaker.state.workletReady), {
        label: 'workletReady',
      });
      assert.strictEqual(ready, true);
      assert.strictEqual(await pc.evaluate(() => Boolean(window.__phoneSpeaker.state.captureNode)), true);
    });

    await check('the phone page loads and its jitter-buffer worklet is ready', async () => {
      phoneA = wire(await ctx.newPage(), 'phoneA');
      const res = await phoneA.goto(base + '/phone.html', { waitUntil: 'domcontentloaded' });
      assert.strictEqual(res.status(), 200);
      await waitFor(() => phoneA.evaluate(() => window.__phoneSpeaker && window.__phoneSpeaker.state.wsOpen), {
        label: 'phone WebSocket',
      });
      const engine = await waitFor(() => phoneA.evaluate(() => window.__phoneSpeaker.state.engine), {
        label: 'worklet engine',
      });
      assert.match(engine, /AudioWorklet/);
    });

    await check('QR code renders as a real PNG for the phone URL', async () => {
      const src = await pc.getAttribute('#qr', 'src');
      assert.match(src, /^\/api\/qr\?url=/);
      const buf = await pc.evaluate(async (s) => {
        const r = await fetch(s);
        const b = await res_array(r);
        return b;
        async function res_array(res) {
          const ab = await res.arrayBuffer();
          return Array.from(new Uint8Array(ab).slice(0, 8));
        }
      }, src);
      assert.deepStrictEqual(buf.slice(0, 4), [0x89, 0x50, 0x4e, 0x47]);
      const phoneUrl = await pc.evaluate(() => document.getElementById('phone-url').textContent);
      assert.match(phoneUrl, /\/phone\.html$/);
    });

    await check('picking the microphone source enables Start', async () => {
      await pc.click('#src-mic');
      await waitFor(() => pc.evaluate(() => !document.getElementById('btn-start').disabled), { label: 'Start enabled' });
      assert.match(await pc.textContent('#src-pill'), /mic/);
    });

    await check('Start captures the mic and sends PCM batches', async () => {
      await pc.click('#btn-start');
      await waitFor(() => pc.evaluate(() => window.__phoneSpeaker.state.live), { label: 'live state' });
      await waitFor(() => pc.evaluate(() => window.__phoneSpeaker.state.bytesSent > 48000 * 2 * 2), {
        label: 'PCM bytes to be sent',
      });
      const st = await pc.evaluate(() => ({ bytes: window.__phoneSpeaker.state.bytesSent, batches: window.__phoneSpeaker.state.batchesSent }));
      assert.ok(st.bytes > 100000, `sent ${st.bytes} bytes`);
      assert.ok(st.batches > 20, `sent ${st.batches} batches`);
    });

    await check('the phone receives the stream and reports AudioWorklet playback', async () => {
      await phoneA.click('#big-play');
      const stats = await waitFor(
        () => phoneA.evaluate(() => {
          const s = window.__phoneSpeaker.state;
          return s.stats && s.stats.framesPlayed > 48000 ? { ...s.stats, recv: s.recvBytes } : null;
        }),
        { label: 'phone playback stats' }
      );
      assert.ok(stats.recv > 200000, `received ${stats.recv} bytes`);
      assert.strictEqual(stats.playing, true);
      assert.strictEqual(stats.sampleRate, 48000);
      assert.deepStrictEqual([stats.type, typeof stats.underruns], ['stats', 'number']);
    });

    await check('the jitter buffer primes at the configured 150 ms target', async () => {
      const st = await phoneA.evaluate(() => window.__phoneSpeaker.state.stats);
      assert.ok(st.depthMs > 90 && st.depthMs < 400, `depth ${st.depthMs.toFixed(1)} ms`);
      assert.strictEqual(Math.round(st.targetMs), 150);
    });

    await check('the phone reports live stats back to the computer', async () => {
      await waitFor(() => pc.evaluate(() => window.__phoneSpeaker.state.phones.size > 0), {
        label: 'receiver-stats from the phone',
      });
      const entry = await pc.evaluate(() => [...window.__phoneSpeaker.state.phones.values()][0]);
      assert.ok(entry.depthMs > 0, 'depth is reported');
      assert.strictEqual(entry.aw, true, 'phone reports AudioWorklet support');
      assert.strictEqual(await pc.textContent('#phone-count'), '1 connected');
    });

    await check('diagnostics tiles show bitrate, buffered latency and RTT', async () => {
      await waitFor(async () => (await pc.textContent('#st-bitrate')) !== '—', { label: 'bitrate tile' });
      assert.match(await pc.textContent('#st-bitrate'), /kbps|Mbps/);
      assert.match(await pc.textContent('#st-format'), /48 kHz · 16-bit stereo/);
      assert.match(await pc.textContent('#st-depth'), /\d+ ms/);
      await waitFor(async () => (await pc.textContent('#st-rtt')) !== '—', { label: 'RTT tile' });
    });

    await check('a second phone joins and both buffers stay healthy', async () => {
      phoneB = wire(await ctx.newPage(), 'phoneB');
      await phoneB.goto(base + '/phone.html', { waitUntil: 'domcontentloaded' });
      await waitFor(() => phoneB.evaluate(() => window.__phoneSpeaker && window.__phoneSpeaker.state.engine), {
        label: 'second phone audio',
      });
      await phoneB.click('#big-play');
      await waitFor(async () => (await pc.textContent('#phone-count')) === '2 connected', { label: '2 phones' });
      const both = await waitFor(
        () => phoneB.evaluate(() => {
          const s = window.__phoneSpeaker.state;
          return s.stats && s.stats.framesPlayed > 48000 ? s.stats : null;
        }),
        { label: 'second phone playing' }
      );
      assert.ok(both.framesPlayed > 48000);
      const first = await phoneA.evaluate(() => window.__phoneSpeaker.state.stats);
      assert.ok(first.playing, 'first phone still playing');
    });

    await check('the latency slider retargets the phone jitter buffer', async () => {
      await pc.evaluate(() => {
        const el = document.getElementById('latency');
        el.value = '320';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await waitFor(
        () => phoneA.evaluate(() => Math.round(window.__phoneSpeaker.state.targetMs) === 320),
        { label: 'phone targetMs = 320' }
      );
      const st = await waitFor(
        () => phoneA.evaluate(() => {
          const s = window.__phoneSpeaker.state.stats;
          return s && s.depthMs > 250 ? s : null;
        }),
        { timeout: 6000, label: 'buffer to grow toward 320 ms' }
      );
      assert.ok(st.depthMs > 250, `depth ${st.depthMs.toFixed(1)} ms`);
    });

    await check('the volume slider reaches the phone', async () => {
      await pc.evaluate(() => {
        const el = document.getElementById('phone-vol');
        el.value = '40';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await waitFor(() => phoneA.evaluate(() => Math.abs(window.__phoneSpeaker.state.volume - 0.4) < 0.01), {
        label: 'phone volume = 0.4',
      });
      assert.strictEqual(await phoneA.inputValue('#volume'), '40');
    });

    await check('the phone pause button stops consuming audio', async () => {
      await phoneA.click('#big-play');
      await waitFor(() => phoneA.evaluate(() => !window.__phoneSpeaker.state.playing), { label: 'phone paused' });
      // The worklet reports stats every 200 ms, so read a stable value first.
      await sleep(400);
      const before = await phoneA.evaluate(() => window.__phoneSpeaker.state.stats.framesPlayed);
      await sleep(700);
      const after = await phoneA.evaluate(() => window.__phoneSpeaker.state.stats.framesPlayed);
      assert.strictEqual(after, before, 'framesPlayed must not advance while paused');
      assert.strictEqual(await phoneA.evaluate(() => window.__phoneSpeaker.state.stats.playing), false);

      await phoneA.click('#big-play');
      await waitFor(() => phoneA.evaluate(() => window.__phoneSpeaker.state.stats.playing), { label: 'phone resumed' });
    });

    await check('Stop sends the idle state and halts the PCM stream', async () => {
      await pc.click('#btn-start');
      await waitFor(() => pc.evaluate(() => !window.__phoneSpeaker.state.live), { label: 'sender stopped' });
      const bytesAtStop = await pc.evaluate(() => window.__phoneSpeaker.state.bytesSent);
      await sleep(700);
      const bytesLater = await pc.evaluate(() => window.__phoneSpeaker.state.bytesSent);
      assert.strictEqual(bytesLater, bytesAtStop, 'no bytes after stop');
      assert.match(await pc.textContent('#src-pill'), /idle/);
    });

    await check('the audio-file source streams a local file to the phone', async () => {
      const wav = path.join(__dirname, 'test.wav');
      assert.ok(fs.existsSync(wav), 'tests/test.wav exists (npm run make:wav)');
      // Reset the latency slider the previous test moved.
      await pc.evaluate(() => {
        const el = document.getElementById('latency');
        el.value = '150';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await pc.setInputFiles('#file-input', wav);
      await waitFor(() => pc.evaluate(() => window.__phoneSpeaker.state.fileName === 'test.wav'), { label: 'file selected' });
      await pc.click('#btn-start');
      await waitFor(() => pc.evaluate(() => window.__phoneSpeaker.state.live), { label: 'file stream started' });
      // Start resets the byte counters, so take the baseline after it flipped.
      const bytesBefore = await pc.evaluate(() => window.__phoneSpeaker.state.bytesSent);
      try {
        await waitFor(() => pc.evaluate((b) => window.__phoneSpeaker.state.bytesSent > b + 96000, bytesBefore), {
          timeout: 4000,
          interval: 100,
          label: 'PCM from the file to be sent',
        });
      } catch (err) {
        const dbg = await pc.evaluate(() => ({
          live: window.__phoneSpeaker.state.live,
          bytes: window.__phoneSpeaker.state.bytesSent,
          batches: window.__phoneSpeaker.state.batchesSent,
          sr: window.__phoneSpeaker.state.sampleRate,
          src: window.__phoneSpeaker.state.source,
          ct: window.__phoneSpeaker.state.mediaEl && window.__phoneSpeaker.state.mediaEl.currentTime,
          paused: window.__phoneSpeaker.state.mediaEl && window.__phoneSpeaker.state.mediaEl.paused,
          log: document.getElementById('log').innerText.slice(-500),
        }));
        throw new Error(err.message + '\n' + JSON.stringify(dbg));
      }
      const media = await pc.evaluate(() => ({
        duration: window.__phoneSpeaker.state.mediaEl.duration,
        rate: window.__phoneSpeaker.state.sampleRate,
      }));
      assert.ok(media.duration > 5.5 && media.duration < 6.5, `duration ${media.duration}`);
      assert.strictEqual(media.rate, 48000);

      // Stop, then start again: a finished file must rewind and play again.
      await pc.click('#btn-start');
      await waitFor(() => pc.evaluate(() => !window.__phoneSpeaker.state.live), { label: 'file stream stopped' });
      await pc.evaluate(() => {
        const S = window.__phoneSpeaker.state;
        S.mediaEl.currentTime = S.mediaEl.duration; // pretend it ran to the end
      });
      await sleep(200);
      const beforeReplay = await pc.evaluate(() => window.__phoneSpeaker.state.bytesSent);
      await pc.click('#btn-start');
      await waitFor(() => pc.evaluate((b) => window.__phoneSpeaker.state.bytesSent > b + 48000, beforeReplay), {
        label: 'replay after the file ended',
      });
      assert.ok(await pc.evaluate(() => window.__phoneSpeaker.state.mediaEl.currentTime < 3), 'replay starts from the top');

      // Loop and pause survive the transport controls.
      await pc.click('#btn-loop');
      assert.strictEqual(await pc.getAttribute('#btn-loop', 'aria-pressed'), 'true');
      assert.strictEqual(await pc.evaluate(() => window.__phoneSpeaker.state.mediaEl.loop), true);
      await pc.click('#btn-pause');
      await waitFor(() => pc.evaluate(() => window.__phoneSpeaker.state.mediaEl.paused), { label: 'file paused' });
      await pc.click('#btn-pause');
      await waitFor(() => pc.evaluate(() => !window.__phoneSpeaker.state.mediaEl.paused), { label: 'file resumed' });
      await pc.click('#btn-start'); // stop
    });

    await check('reloading the phone page reconnects to the relay automatically', async () => {
      await phoneB.reload({ waitUntil: 'domcontentloaded' });
      await waitFor(() => phoneB.evaluate(() => window.__phoneSpeaker && window.__phoneSpeaker.state.wsOpen), {
        label: 'reconnected WebSocket',
      });
      await waitFor(async () => (await pc.textContent('#phone-count')) === '2 connected', { label: '2 phones again' });
    });

    await check('the /api/info endpoint reports both peers and a phone URL', async () => {
      const info = await getJson(base + '/api/info');
      assert.strictEqual(info.receivers, 2);
      assert.strictEqual(info.senders, 1);
      assert.ok(info.bytes > 0, 'relay counted bytes');
      assert.ok(info.phones.some((p) => /\/phone\.html$/.test(p.url)));
    });

    await check('phone index endpoint marks the secure URL as the QR target', async () => {
      const info = await getJson(base + '/api/info');
      const primary = info.phones.find((p) => p.primary);
      assert.ok(primary, 'one primary phone URL');
      if (info.httpsPort) assert.strictEqual(primary.url.split(':')[0], 'https', 'prefers https when available');
      else assert.match(primary.url, /^http:\/\//);
    });

    await check('the server shuts down cleanly and frees its port', async () => {
      await app.close();
      await sleep(150);
      await assert.rejects(
        () =>
          new Promise((resolve, reject) => {
            const req = http.get(base + '/api/info', () => resolve());
            req.on('error', reject);
            req.setTimeout(1500, () => reject(new Error('timeout')));
          }),
        /ECONNREFUSED|timeout|socket hang up/
      );
    });

    await check('no page threw an uncaught error during the run', async () => {
      const relevant = pageErrors.filter((e) => !/favicon/i.test(e));
      assert.deepStrictEqual(relevant, []);
    });
  } finally {
    await launched.close();
  }
}

run()
  .then(() => {
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error('\n  Harness crashed:', err);
    process.exit(1);
  });
