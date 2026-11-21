'use strict';
// Requires ffmpeg, playwright-core, and Chromium. Uses a synthetic output so
// it doesn't depend on audio hardware or OS-specific drivers.
const assert = require('assert');
const { main } = require('../server');
async function run() {
  const { chromium } = require('playwright-core');
  process.env.CAPTURE_FORMAT = 'lavfi';
  process.env.CAPTURE_INPUT = 'sine=frequency=440:sample_rate=48000';
  const app = await main({port: 0, https: false, quiet: true});
  let browser;
  try {
    browser = await chromium.launch({headless: process.env.HEADFUL !== '1', executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']});
    const context = await browser.newContext();
    const base = `http://127.0.0.1:${app.ports.httpPort}`;
    const pc = await context.newPage();
    const errors = [];
    pc.on('pageerror', e => errors.push(e.message));
    await pc.goto(base);
    await pc.waitForFunction(() => document.querySelector('#capture-state').textContent === 'live', null, {timeout: 15000});
    assert.strictEqual(await pc.locator('#src-tab').isVisible(), false);
    const phones = await Promise.all([context.newPage(), context.newPage()]);
    for (const phone of phones) {
      phone.on('pageerror', e => errors.push(e.message));
      await phone.goto(base + '/phone.html');
      await phone.locator('#big-play').click();
    }
    for (const phone of phones) {
      await phone.waitForFunction(() => window.__phoneSpeaker && window.__phoneSpeaker.state.recvBytes > 10000, null, {timeout: 15000});
      assert(await phone.evaluate(() => window.__phoneSpeaker.state.playing));
    }
    await pc.locator('#capture-test').click();
    await pc.waitForFunction(() => document.querySelector('#capture-test-result').textContent.includes('passed'), null, {timeout: 5000});
    assert.deepStrictEqual(errors, []);
    console.log('Browser integration passed: output, two phones, playback and test.');
  } finally { if (browser) await browser.close(); await app.close(); }
}
run().catch(e => { console.error(e); process.exitCode = 1; });
