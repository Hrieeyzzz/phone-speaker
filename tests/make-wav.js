#!/usr/bin/env node
'use strict';

/**
 * Generates tests/test.wav — 6 s of 48 kHz / 16-bit / stereo test audio:
 * a 440 Hz tone with vibrato, band-limited sweep and metronome clicks, so the
 * E2E test can prove non-silent audio arrives on the phone.
 *
 *   npm run make:wav        (writes tests/test.wav)
 */

const fs = require('fs');
const path = require('path');

const RATE = 48000;
const SECONDS = 6;
const FRAMES = RATE * SECONDS;

function build() {
  const data = Buffer.alloc(FRAMES * 2 * 2); // stereo, 16-bit
  for (let i = 0; i < FRAMES; i++) {
    const t = i / RATE;
    const vibrato = 1 + 0.004 * Math.sin(2 * Math.PI * 5 * t);
    const sweep = 300 + 900 * (t / SECONDS);
    const tone = 0.5 * Math.sin(2 * Math.PI * 440 * vibrato * t);
    const glide = 0.28 * Math.sin(2 * Math.PI * sweep * t);
    // metronome click every 0.5 s
    const beat = t % 0.5;
    const click = beat < 0.02 ? 0.7 * Math.exp(-beat * 140) * Math.sin(2 * Math.PI * 1800 * beat) : 0;
    const left = clamp(tone + glide * 0.6 + click);
    const right = clamp(tone * 0.9 + glide + click * 0.8);
    data.writeInt16LE(Math.round(left * 32767), i * 4);
    data.writeInt16LE(Math.round(right * 32767), i * 4 + 2);
  }
  return data;
}

function clamp(v) {
  return Math.max(-1, Math.min(1, v));
}

function waveFile(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(2, 22); // channels
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2 * 2, 28); // byte rate
  header.writeUInt16LE(4, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const out = path.join(__dirname, 'test.wav');
const wav = waveFile(build());
fs.writeFileSync(out, wav);
console.log(`Wrote ${out} (${(wav.length / 1024 / 1024).toFixed(2)} MB, ${SECONDS}s @ ${RATE} Hz stereo)`);

module.exports = { build, waveFile };
