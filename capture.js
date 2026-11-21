'use strict';

/**
 * capture.js — "PC output" capture.
 *
 * Reads the computer's own speaker mix with ffmpeg and turns it into 16-bit
 * stereo PCM, so the phone behaves like a real speaker output for
 * *everything* — games, video, music, browser tabs, any app at all — with no
 * source picker anywhere in the UI.
 *
 * How the mix is obtained depends on the OS:
 *
 *   Windows   DirectShow loopback device (VB-CABLE, screen-capture-recorder,
 *             "Stereo Mix", …) — `-f dshow -i audio="<device>"`
 *   macOS     BlackHole / Soundflower — `-f avfoundation -i ":<index>"`
 *   Linux     PulseAudio/PipeWire default sink monitor — `-f pulse -i <sink>.monitor`
 *   any       CAPTURE_FORMAT / CAPTURE_INPUT env vars override everything
 *
 * There is no feedback path: a loopback device carries the computer's own
 * mix, and the phone's speaker is not part of that mix, so the stream this
 * module reads can never contain the audio we sent to the phone.
 */

const { spawn, execFile } = require('child_process');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_FRAME = CHANNELS * 2; // s16 stereo
const BATCH_MS = 20;

/* ------------------------------------------------------------------ *
 * Platform presets
 * ------------------------------------------------------------------ */

const PLATFORMS = {
  win32: {
    id: 'win32',
    label: 'Windows — DirectShow loopback',
    format: 'dshow',
    input: 'audio=AudioScreencapture',
    extraIn: ['-audio_buffer_size', '50'],
    // Device names that mean "whatever the speakers are playing".
    match: /loopback|stereo mix|what u hear|wave out mix|virtual-audio-capturer|audio_screencapture|cable output|voicemeeter out/i,
    needs:
      'Windows has no built-in ffmpeg loopback device. Install VB-CABLE (free) or the screen-capture-recorder bundle, then pick it once in the device list — the app remembers your choice.',
    note: 'ffmpeg can only read DirectShow devices on Windows, so one virtual loopback device is required.',
  },
  darwin: {
    id: 'darwin',
    label: 'macOS — BlackHole / Soundflower',
    format: 'avfoundation',
    input: ':0',
    match: /blackhole|soundflower|loopback|aggregate/i,
    needs:
      'Install BlackHole 2ch (brew install blackhole-2ch), then create a "Multi-Output Device" (speakers + BlackHole) in Audio MIDI Setup and select it as the system output so you still hear the audio.',
    note: 'macOS has no built-in loopback; BlackHole is the standard free driver.',
  },
  linux: {
    id: 'linux',
    label: 'Linux — PulseAudio / PipeWire monitor',
    format: 'pulse',
    input: 'default',
    match: /monitor|\.monitor$/i,
    needs: null,
    note: 'Records the default output sink monitor — exactly what the speakers play. PipeWire works through its pulse server.',
  },
};

/* ------------------------------------------------------------------ *
 * Small process helpers
 * ------------------------------------------------------------------ */

function run(cmd, args, { timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code == null ? -1 : err.code) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

/* ------------------------------------------------------------------ *
 * ffmpeg discovery
 * ------------------------------------------------------------------ */

/**
 * Locate an ffmpeg binary: FFMPEG_PATH → `ffmpeg` on PATH (best — current
 * builds carry every capture device) → @ffmpeg-installer/ffmpeg →
 * ffmpeg-static → the literal name (spawn reports it if missing).
 */
function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const { spawnSync } = require('child_process');
  try {
    const probe = spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 5000 });
    if (!probe.error && probe.status === 0) return 'ffmpeg';
  } catch (e) {
    /* no PATH ffmpeg */
  }
  try {
    // eslint-disable-next-line global-require
    return require('@ffmpeg-installer/ffmpeg').path;
  } catch (e) {
    /* not installed */
  }
  try {
    // eslint-disable-next-line global-require
    const p = require('ffmpeg-static');
    if (p) return p;
  } catch (e) {
    /* not installed */
  }
  return 'ffmpeg';
}

/** Names of the filters a given build offers. */
function filters(ffmpegPath = findFfmpeg()) {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn(ffmpegPath, ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      return resolve([]);
    }
    proc.stdout.on('data', (c) => {
      out += c.toString();
    });
    proc.on('error', () => resolve([]));
    proc.on('close', () => {
      resolve(
        out
          .split('\n')
          .map((l) => l.trim().split(/\s+/)[1])
          .filter(Boolean)
      );
    });
  });
}

/** ffmpeg's own version banner (first line), '' when it cannot run. */
async function version(ffmpegPath = findFfmpeg()) {
  const r = await run(ffmpegPath, ['-hide_banner', '-version']);
  return r.ok ? r.stdout.split('\n')[0].trim() : '';
}

/* ------------------------------------------------------------------ *
 * Device discovery
 * ------------------------------------------------------------------ */

/**
 * Every capture device this machine offers, normalised to
 * `{format, input, label, kind, default?}`.
 *
 * Windows/macOS ask ffmpeg itself; Linux asks pactl for the default sink so
 * we can record its `.monitor` (recording "default" would grab the mic).
 */
async function listDevices(ffmpegPath = findFfmpeg(), platform = process.platform) {
  if (process.env.CAPTURE_INPUT) {
    return [
      {
        format: process.env.CAPTURE_FORMAT || null,
        input: process.env.CAPTURE_INPUT,
        label: `CAPTURE_INPUT (${process.env.CAPTURE_INPUT})`,
        kind: 'env',
        default: true,
      },
    ];
  }

  if (platform === 'linux') return listPulseDevices();

  if (platform === 'win32') {
    const r = await run(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { timeout: 8000 });
    const devices = [];
    let section = '';
    for (const line of r.stderr.split('\n')) {
      if (/DirectShow video devices/i.test(line)) section = 'video';
      else if (/DirectShow audio devices/i.test(line)) section = 'audio';
      else if (/Alternative name/i.test(line)) {
        // "  Alternative name "Audio Wentbackward""
        const m = line.match(/Alternative name\s+"([^"]+)"/i);
        const last = devices[devices.length - 1];
        if (m && last && last.kind === 'audio') last.aliases.push(m[1]);
        continue;
      } else if (section === 'audio') {
        const m = line.match(/"([^"]+)"/);
        if (m) devices.push({ format: 'dshow', input: `audio=${m[1]}`, label: m[1], kind: 'audio', aliases: [] });
      }
    }
    for (const d of devices) {
      const hay = [d.label, ...(d.aliases || [])].join(' | ');
      d.loopback = PLATFORMS.win32.match.test(hay);
    }
    return devices;
  }

  if (platform === 'darwin') {
    const r = await run(ffmpegPath, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { timeout: 8000 });
    const devices = [];
    let section = '';
    for (const line of r.stderr.split('\n')) {
      if (/AVFoundation video devices/i.test(line)) section = 'video';
      else if (/AVFoundation audio devices/i.test(line)) section = 'audio';
      else if (section === 'audio') {
        const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
        if (m) {
          devices.push({ format: 'avfoundation', input: `:${m[1]}`, label: m[2], kind: 'audio', index: Number(m[1]) });
        }
      }
    }
    for (const d of devices) d.loopback = PLATFORMS.darwin.match.test(d.label);
    return devices;
  }

  return [];
}

/** Linux: default sink's monitor, plus every other sink monitor. */
async function listPulseDevices() {
  const devices = [];
  let def = '';
  const g = await run('pactl', ['get-default-sink']);
  if (g.ok) def = g.stdout.trim();
  if (!def) {
    const info = await run('pactl', ['info']);
    const m = info.stdout.match(/Default Sink:\s*(.+)/);
    if (m) def = m[1].trim();
  }
  if (def) {
    devices.push({ format: 'pulse', input: `${def}.monitor`, label: `${def} (monitor)`, kind: 'monitor', default: true, loopback: true });
  }
  const short = await run('pactl', ['list', 'short', 'sinks']);
  if (short.ok) {
    for (const line of short.stdout.split('\n')) {
      const cols = line.trim().split('\t');
      const name = cols[1];
      if (!name) continue;
      if (devices.some((d) => d.input === `${name}.monitor`)) continue;
      devices.push({ format: 'pulse', input: `${name}.monitor`, label: `${name} (monitor)`, kind: 'monitor', loopback: true });
    }
  }
  return devices;
}

/* ------------------------------------------------------------------ *
 * PcmStream — ffmpeg child process → 20 ms batches
 * ------------------------------------------------------------------ */

class PcmStream {
  /**
   * @param {object} opts
   * @param {string} [opts.ffmpegPath]
   * @param {string|null} [opts.format]  ffmpeg input format (-f), e.g. 'dshow'
   * @param {string} opts.input          ffmpeg input url/device
   * @param {string[]} [opts.extraIn]    extra args before -i
   * @param {number} [opts.rate=48000]
   * @param {number} [opts.gain=1]       linear volume applied to the mix
   */
  constructor(opts = {}) {
    this.opts = {
      ffmpegPath: opts.ffmpegPath || findFfmpeg(),
      format: opts.format || null,
      input: opts.input,
      extraIn: opts.extraIn || [],
      rate: opts.rate || SAMPLE_RATE,
      gain: Number.isFinite(opts.gain) ? opts.gain : 1,
    };
    this.batchBytes = (this.opts.rate * BYTES_PER_FRAME * BATCH_MS) / 1000;
    this.proc = null;
    this.buffer = Buffer.alloc(0);
    this.batches = 0;
    this.frames = 0;
    this.startedAt = 0;
    this.stderr = '';
    this.closed = false;
    this.onBatch = null;
    this.onError = null;
  }

  /** ffmpeg argv for one capture source. */
  static argsFor({ format, input, extraIn = [], rate = SAMPLE_RATE, gain = 1 }) {
    const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];
    if (format) args.push('-f', format);
    if (format === 'lavfi') args.push('-re'); // pace synthetic sources like a device
    args.push(...extraIn, '-i', input);
    args.push('-af', `volume=${gain},aformat=sample_fmts=s16:sample_rates=${rate}:channel_layouts=stereo`);
    args.push('-ac', String(CHANNELS), '-ar', String(rate), '-f', 's16le', 'pipe:1');
    return args;
  }

  start() {
    if (this.proc) return this;
    const args = PcmStream.argsFor(this.opts);
    this.startedAt = Date.now();
    this.proc = spawn(this.opts.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this.proc.stdout.on('data', (chunk) => this.consume(chunk));
    this.proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    this.proc.on('error', (err) => {
      this.proc = null;
      this.emitError(`could not start ffmpeg (${this.opts.ffmpegPath}): ${err.message}`);
    });
    this.proc.on('close', (code, signal) => {
      this.proc = null;
      if (this.closed) return;
      const hint = this.diagnose();
      this.emitError(`capture stopped (ffmpeg exit ${code}${signal ? ' ' + signal : ''})${hint ? ' — ' + hint : ''}`);
    });
    return this;
  }

  /** Re-cut the byte stream into exact batches. */
  consume(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= this.batchBytes) {
      const batch = this.buffer.subarray(0, this.batchBytes);
      this.buffer = this.buffer.subarray(this.batchBytes);
      this.frames += this.batchBytes / BYTES_PER_FRAME;
      this.batches++;
      if (this.onBatch) this.onBatch(batch);
    }
    // A consumer that stops reading must not balloon memory.
    if (this.buffer.length > this.batchBytes * 250) this.buffer = Buffer.alloc(0);
  }

  /** Translate the tail of ffmpeg's stderr into an actionable hint. */
  diagnose() {
    const raw = this.stderr;
    const s = raw.toLowerCase();
    if (s.includes('filter') && (s.includes('not found') || s.includes('no such filter'))) {
      return 'this ffmpeg build lacks a required filter — update ffmpeg or set FFMPEG_PATH';
    }
    if (s.includes("unknown input format: 'pulse'")) return 'This ffmpeg build lacks PulseAudio input; install a system ffmpeg with pulse support and set FFMPEG_PATH.';
    if (s.includes('pulse') && (s.includes('connection refused') || s.includes('no such file'))) {
      return 'no PulseAudio/PipeWire server reachable';
    }
    if (s.includes('could not find audio only device') || s.includes('no such device') || s.includes('device not found')) {
      return 'audio device not found — pick another device or install a loopback driver';
    }
    if (s.includes('permission') || s.includes('denied')) {
      return 'the OS denied audio access (give ffmpeg screen/audio recording permission)';
    }
    if (s.includes('busy')) return 'the audio device is busy — close the app that holds it';
    if (s.trim()) return raw.trim().split('\n').pop().slice(0, 180);
    return '';
  }

  emitError(message) {
    if (this.onError) this.onError(message);
  }

  stop() {
    this.closed = true;
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch (e) {
        /* already gone */
      }
      this.proc = null;
    }
    return this;
  }

  /** Peak level of a PCM batch, 0..1. */
  static peakOf(buf) {
    const samples = buf.length >> 1;
    let peak = 0;
    for (let i = 0; i < samples; i += 8) {
      const v = Math.abs(buf.readInt16LE(i * 2));
      if (v > peak) peak = v;
    }
    return peak / 32768;
  }
}

/* ------------------------------------------------------------------ *
 * Self-test — works on any machine, even one without a sound card
 * ------------------------------------------------------------------ */

/**
 * Push a synthetic tone (or the real device) through exactly the same
 * pipeline and report whether clean 20 ms PCM batches came out. Backs the
 * "Test capture" button and the test suites.
 */
function selfTest({ ffmpegPath = findFfmpeg(), format = null, input, extraIn = [], useTone = true, timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const src = useTone
      ? { format: 'lavfi', input: `sine=frequency=440:sample_rate=${SAMPLE_RATE}:duration=3` }
      : { format, input, extraIn };

    const stream = new PcmStream({ ffmpegPath, ...src });
    const t0 = Date.now();
    let bytes = 0;
    let peak = 0;
    let done = false;

    const finish = (ok, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.onBatch = null;
      stream.onError = null;
      stream.stop();
      resolve({
        ok,
        error: error || null,
        tone: Boolean(useTone),
        device: useTone ? null : input,
        ms: Date.now() - t0,
        batches: stream.batches,
        frames: Math.round(bytes / BYTES_PER_FRAME),
        peak: Number(peak.toFixed(3)),
        batchMs: BATCH_MS,
        stderr: stream.stderr.slice(-600),
      });
    };

    const timer = setTimeout(() => finish(false, stream.stderr ? stream.diagnose() || 'timed out waiting for audio' : 'timed out waiting for audio'), timeoutMs);

    stream.onBatch = (buf) => {
      bytes += buf.length;
      const p = PcmStream.peakOf(buf);
      if (p > peak) peak = p;
      if (stream.batches >= 25) finish(true, null); // ~0.5 s is plenty
    };
    stream.onError = (msg) => finish(false, msg);
    stream.start();
  });
}

/* ------------------------------------------------------------------ *
 * Presets & config
 * ------------------------------------------------------------------ */

/** The raw preset for a platform. */
function detectPreset(platform = process.platform) {
  const base = PLATFORMS[platform] || PLATFORMS.linux;
  return { ...base, gain: 1 };
}

/**
 * Pick the device the server should record: an explicit override, the saved
 * choice, or the best loopback-looking device the machine offers.
 *
 * @param {object}  [env]
 * @param {string}  [platform]
 * @param {Array}   [devices]   result of listDevices()
 * @param {object}  [saved]     last working device ({format,input,label})
 */
function resolvePreset(env = process.env, platform = process.platform, devices = [], saved = null) {
  const preset = detectPreset(platform);

  if (env.CAPTURE_INPUT) {
    const extra = env.CAPTURE_EXTRA ? env.CAPTURE_EXTRA.split(/\s+/).filter(Boolean) : [];
    return {
      ...preset,
      custom: true,
      source: 'env',
      label: `Custom — ${env.CAPTURE_FORMAT || 'auto'} ${env.CAPTURE_INPUT}`.slice(0, 120),
      format: env.CAPTURE_FORMAT || null,
      input: env.CAPTURE_INPUT,
      extraIn: extra,
    };
  }

  if (saved && saved.input && devices.some((d) => d.input === saved.input)) {
    return { ...preset, ...saved, source: 'saved', needs: preset.needs };
  }

  const loopbacks = devices.filter((d) => d.loopback);
  const auto = loopbacks.find((d) => d.default) || loopbacks[0];
  if (auto) {
    return {
      ...preset,
      format: auto.format || preset.format,
      input: auto.input,
      extraIn: auto.extraIn || preset.extraIn || [],
      label: `${preset.label} · ${auto.label}`,
      device: auto,
      source: 'auto',
      needs: null,
    };
  }

  return { ...preset, source: 'preset', label: preset.label };
}

/** Per-install settings (which device to record), kept next to the server. */
function loadConfig(dir) {
  try {
    // eslint-disable-next-line global-require
    const fs = require('fs');
    // eslint-disable-next-line global-require
    const path = require('path');
    const raw = fs.readFileSync(path.join(dir, '.capture.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch (e) {
    return {};
  }
}

function saveConfig(dir, cfg) {
  try {
    // eslint-disable-next-line global-require
    const fs = require('fs');
    // eslint-disable-next-line global-require
    const path = require('path');
    fs.writeFileSync(path.join(dir, '.capture.json'), JSON.stringify(cfg, null, 2) + '\n');
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * PcCapture — the long-lived capture the server runs for the phones
 * ------------------------------------------------------------------ */

/**
 * Owns one PcmStream for the lifetime of the process. Every 20 ms batch is
 * handed to `onBatch` (the relay broadcasts it) and to a level meter.
 * Failures never throw: they set `state`/`error` and schedule a retry, so a
 * missing driver shows up as an explanation in the UI instead of a crash.
 */
class PcCapture {
  constructor(opts = {}) {
    this.dir = opts.dir || process.cwd();
    this.platform = opts.platform || process.platform;
    this.env = opts.env || process.env;
    this.ffmpegPath = opts.ffmpegPath || findFfmpeg();
    this.config = loadConfig(this.dir);
    this.devices = [];
    this.preset = null;
    this.stream = null;
    this.state = 'idle'; // idle | starting | live | error | unavailable | stopped
    this.error = null;
    this.startedAt = 0;
    this.bytes = 0;
    this.batches = 0;
    this.frames = 0;
    this.peak = 0;
    this.lastBatchAt = 0;
    this.retryTimer = null;
    this.retryDelay = 2000;
    this.retries = 0;
    this.onBatch = null;
    this.onChange = null;
    this.wantRunning = false;
    this.generation = 0;
    this.ffmpegVersion = '';
    this.available = true;
  }

  get live() {
    return this.state === 'live';
  }

  /** Human summary for the API and the computer page. */
  status() {
    return {
      state: this.state,
      live: this.live,
      error: this.error,
      platform: this.platform,
      ffmpegPath: this.ffmpegPath,
      ffmpegVersion: this.ffmpegVersion,
      available: this.available,
      preset: this.preset
        ? { label: this.preset.label, format: this.preset.format, input: this.preset.input, source: this.preset.source, needs: this.preset.needs }
        : null,
      devices: this.devices,
      sampleRate: SAMPLE_RATE,
      batchMs: BATCH_MS,
      bytes: this.bytes,
      batches: this.batches,
      frames: this.frames,
      peak: Number(this.peak.toFixed(3)),
      startedAt: this.startedAt,
      lastBatchAt: this.lastBatchAt,
      retries: this.retries,
    };
  }

  changed() {
    if (this.onChange) this.onChange(this.status());
  }

  async refreshDevices() {
    this.devices = await listDevices(this.ffmpegPath, this.platform);
    return this.devices;
  }

  async start() {
    this.wantRunning = true;
    if (this.stream || this.state === 'starting') return this.status();
    const generation = ++this.generation;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.state = 'starting';
    this.error = null;
    this.changed();

    if (!this.ffmpegVersion) {
      this.ffmpegVersion = await version(this.ffmpegPath);
      if (generation !== this.generation) return this.status();
      if (!this.ffmpegVersion) {
        // Windows/macOS users often have ffmpeg only through npm; try again.
        this.available = false;
        this.state = 'unavailable';
        this.error =
          'ffmpeg was not found. Install it (winget install ffmpeg · brew install ffmpeg · sudo apt install ffmpeg) and restart the server, or set FFMPEG_PATH.';
        this.changed();
        return this.status();
      }
    }
    this.available = true;

    try {
      await this.refreshDevices();
    } catch (e) {
      this.devices = [];
    }
    if (generation !== this.generation) return this.status();
    const saved = this.config.device || null;
    this.preset = resolvePreset(this.env, this.platform, this.devices, saved);

    if (this.preset.source === 'preset') {
      this.state = 'unavailable';
      this.error = this.platform === 'linux'
        ? 'No output monitor found. Install pactl and ensure PulseAudio or PipeWire is running.'
        : 'No loopback device found. ' + (this.preset.needs || 'Install an output loopback driver.');
      this.changed();
      this.scheduleRetry();
      return this.status();
    }

    const stream = new PcmStream({
      ffmpegPath: this.ffmpegPath,
      format: this.preset.format,
      input: this.preset.input,
      extraIn: this.preset.extraIn || [],
      rate: SAMPLE_RATE,
      gain: this.preset.gain,
    });
    stream.onBatch = (buf) => this.handleBatch(buf);
    stream.onError = (msg) => this.handleError(msg);
    this.stream = stream;
    this.bytes = 0;
    this.batches = 0;
    this.frames = 0;
    this.peak = 0;
    this.startedAt = Date.now();

    // ffmpeg only confirms a bad device by exiting, so treat "still alive and
    // producing audio" as the live state and everything else as an error.
    this.liveTimer = setTimeout(() => {
      if (this.stream === stream && this.batches > 0) {
        this.state = 'live';
        this.changed();
      }
    }, 700);

    stream.start();
    return this.status();
  }

  handleBatch(buf) {
    this.bytes += buf.length;
    this.batches++;
    this.frames += buf.length / BYTES_PER_FRAME;
    this.lastBatchAt = Date.now();
    const p = PcmStream.peakOf(buf);
    this.peak = p > this.peak ? p : this.peak * 0.92;
    if (this.state !== 'live' && this.batches >= 3) {
      this.state = 'live';
      this.changed();
    }
    if (this.onBatch) this.onBatch(buf);
  }

  handleError(msg) {
    this.error = msg;
    this.state = this.batches ? 'error' : 'error';
    this.stream = null;
    clearTimeout(this.liveTimer);
    this.changed();
    if (this.wantRunning) this.scheduleRetry();
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retries++;
    const delay = Math.min(30000, this.retryDelay);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.wantRunning) return;
      // A retry re-discovers devices, so plugging in a driver is enough.
      this.start();
    }, delay);
    if (this.retryTimer.unref) this.retryTimer.unref();
    this.retryDelay = Math.min(30000, Math.round(this.retryDelay * 1.8));
  }

  stop() {
    this.wantRunning = false;
    this.generation++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.liveTimer);
    this.retryTimer = null;
    this.retries = 0;
    if (this.stream) this.stream.stop();
    this.stream = null;
    this.state = 'idle';
    this.error = null;
    this.changed();
    return this.status();
  }

  /** Use a specific device (from the UI) and remember it. */
  async useDevice(device) {
    if (!device || typeof device.input !== 'string' || !device.input) throw new Error('device.input is required');
    const choice = {
      format: typeof device.format === 'string' ? device.format : null,
      input: device.input.slice(0, 200),
      label: typeof device.label === 'string' ? device.label.slice(0, 120) : device.input.slice(0, 120),
    };
    this.config.device = choice;
    saveConfig(this.dir, this.config);
    this.stop();
    this.retryDelay = 2000;
    return this.start();
  }

  async test(useTone = true) {
    if (!useTone) {
      if (!this.live) return { ok: false, error: this.error || 'Computer output is not live yet.' };
      const start = this.batches;
      await new Promise(resolve => setTimeout(resolve, 600));
      return { ok: this.live && this.batches > start, error: this.live ? null : this.error || 'Output stopped', batches: this.batches - start, peak: Number(this.peak.toFixed(3)) };
    }
    return selfTest({
      ffmpegPath: this.ffmpegPath,
      useTone,
      format: useTone ? null : this.preset && this.preset.format,
      input: useTone ? undefined : this.preset && this.preset.input,
      extraIn: useTone ? [] : (this.preset && this.preset.extraIn) || [],
    });
  }

  destroy() {
    this.wantRunning = false;
    this.generation++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.liveTimer);
    if (this.stream) this.stream.stop();
    this.stream = null;
    this.state = 'idle';
  }
}

module.exports = {
  PcmStream,
  PcCapture,
  findFfmpeg,
  filters,
  version,
  listDevices,
  listPulseDevices,
  inputArgs: resolvePreset,
  selfTest,
  detectPreset,
  resolvePreset,
  loadConfig,
  saveConfig,
  PLATFORMS,
  SAMPLE_RATE,
  CHANNELS,
  BATCH_MS,
  BYTES_PER_FRAME,
};
