'use strict';
const assert = require('assert');
const { WebSocket } = require('ws');
const { main } = require('../server');
const { selfTest, resolvePreset, findFfmpeg } = require('../capture');
const { spawnSync } = require('child_process');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function run() {
  const preset = resolvePreset({}, 'linux', [], null);
  assert.strictEqual(preset.source, 'preset'); // PcCapture must not silently select the microphone.
  const binary = findFfmpeg();
  if (spawnSync(binary, ['-version'], {stdio: 'ignore'}).status !== 0) {
    console.log('Capture integration skipped: install ffmpeg to run it.'); return;
  }
  const tone = await selfTest({ffmpegPath: binary, useTone: true});
  assert(tone.ok, tone.error);
  assert(tone.batches >= 25 && tone.peak > 0);
  process.env.CAPTURE_FORMAT = 'lavfi';
  process.env.CAPTURE_INPUT = 'sine=frequency=440:sample_rate=48000';
  const app = await main({port: 0, https: false, quiet: true});
  let ws;
  try {
    const base = `http://127.0.0.1:${app.ports.httpPort}`;
    ws = new WebSocket(`ws://127.0.0.1:${app.ports.httpPort}`);
    let batches = 0, output = false;
    ws.on('message', (data, binary) => { if (binary) { assert.strictEqual(data.length, 3840); batches++; } else if (JSON.parse(data).type === 'pc-output') output = true; });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({type:'hello', role:'receiver'}));
    for (let i = 0; i < 60 && (batches < 5 || !output); i++) await delay(100);
    assert(output && batches >= 5, 'receiver should get PC output and PCM');
    const post = body => fetch(base + '/api/capture', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
    const result = await (await post({action:'test', device:true})).json();
    assert(result.ok && result.batches > 0, JSON.stringify(result));
    const reject = await post({action:'device', device:{format:'lavfi', input:'not-a-discovered-loopback'}});
    assert.strictEqual(reject.status, 400);
    await post({action:'stop'});
    assert.strictEqual((await (await fetch(base + '/api/capture')).json()).state, 'idle');
    console.log('Capture integration passed: tone, device test, fan-out, validation, stop.');
  } finally { if (ws) ws.terminate(); await app.close(); }
}
run().catch(e => { console.error(e); process.exitCode = 1; });
