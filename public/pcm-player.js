/**
 * pcm-player.js — AudioWorkletProcessor: the phone's jitter buffer + resampler.
 *
 * Incoming 16-bit stereo PCM lands in a ring buffer. A read pointer is steered
 * to sit at a target latency ("the jitter buffer", default 150 ms) behind the
 * write head so Wi-Fi jitter cannot punch holes in the audio:
 *
 *   depth < low  → consumer runs slightly slow  (periodic hold / stretch)
 *   depth > high → consumer runs slightly fast  (periodic skip)
 *   in between   → 1:1 playback
 *
 * The same steering also absorbs clock mismatch between the computer's sound
 * card and the phone's (e.g. 48 000.4 Hz vs 47 998.9 Hz): the ring drifts and
 * the pointer quietly corrects it, so latency stays flat for hours.
 *
 * messages in : {type:'config', targetMs, muted, volume}
 *               {type:'pcm', buf:ArrayBuffer}   Int16 little-endian interleaved
 *               {type:'reset'} / {type:'play'} / {type:'pause'}
 * messages out: {type:'stats', depthMs, targetMs, framesPlayed, underruns,
 *                droppedFrames, playing, sampleRate, primed}
 */

const MAX_SECONDS = 6;
const STEER_PERIOD = 48; // frames between stretch/skip nudges (~1 ms at 48 kHz)

class PcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.vol = 1;
    this.muted = false;
    this.targetMs = clamp(opts.targetMs || 150, 40, 2000);
    this.inChannels = opts.channels === 1 ? 1 : 2;
    this.outChannels = opts.outputChannels || 2;

    this.capFrames = Math.max(Math.round(sampleRate * MAX_SECONDS), 8192);
    this.ring = new Float32Array(this.capFrames * this.inChannels);

    this.written = 0; // frames ever written
    this.readPos = 0; // read head, in frames (mod capFrames)
    this.available = 0; // frames buffered but not consumed
    this.playing = false;
    this.primed = false;
    this.underruns = 0;
    this.dropped = 0;
    this.playedFrames = 0;
    this.steerDir = 0;
    this.steerTick = 0;
    this.statsAccum = 0;
    this.statsEvery = Math.max(128, Math.round(sampleRate * 0.2));
    this.gainSmooth = 0;

    this.port.onmessage = (e) => {
      const msg = e.data || {};
      switch (msg.type) {
        case 'config':
          if (Number.isFinite(msg.targetMs)) this.targetMs = clamp(msg.targetMs, 40, 2000);
          if (typeof msg.muted === 'boolean') this.muted = msg.muted;
          if (Number.isFinite(msg.volume)) this.vol = clamp(msg.volume, 0, 2);
          if (msg.channels === 1 || msg.channels === 2) this.setChannels(msg.channels);
          break;
        case 'pcm':
          this.push(msg.buf);
          break;
        case 'play':
          this.playing = true;
          this.primed = false;
          break;
        case 'pause':
          this.playing = false;
          this.primed = false;
          break;
        case 'reset':
          this.written = 0;
          this.readPos = 0;
          this.available = 0;
          this.primed = false;
          this.playedFrames = 0;
          this.underruns = 0;
          this.dropped = 0;
          this.ring.fill(0);
          break;
        default:
          break;
      }
    };
  }

  setChannels(ch) {
    if (ch === this.inChannels) return;
    this.inChannels = ch;
    this.ring = new Float32Array(this.capFrames * ch);
    this.written = 0;
    this.readPos = 0;
    this.available = 0;
    this.primed = false;
  }

  push(buffer) {
    const pcm = new Int16Array(buffer);
    const ch = this.inChannels;
    const frames = Math.floor(pcm.length / ch);
    if (frames <= 0) return;

    // Cap total latency: a paused phone or a huge burst should not grow the
    // buffer without bound — drop the oldest audio instead.
    const maxFrames = Math.max(this.capFrames - 8192, Math.round((this.targetMs / 1000) * sampleRate * 4));
    let overflow = this.available + frames - maxFrames;
    if (overflow > 0) {
      const drop = Math.min(overflow, this.available);
      this.readPos = (this.readPos + drop) % this.capFrames;
      this.available -= drop;
      this.dropped += drop;
    }

    let w = (this.readPos + this.available) % this.capFrames;
    for (let i = 0; i < frames; i++) {
      const s = i * ch;
      this.ring[w * ch] = pcm[s] / 32768;
      if (ch > 1) this.ring[w * ch + 1] = pcm[s + 1] / 32768;
      w++;
      if (w === this.capFrames) w = 0;
    }
    this.written += frames;
    this.available += frames;

    if (this.available > this.capFrames) {
      // Should be unreachable; hard-resync so a bug cannot wedge playback.
      this.readPos = w;
      this.available = 0;
      this.primed = false;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length || !out[0]) return true;
    const n = out[0].length;

    // Smooth gain so mute / volume changes never click.
    const targetGain = this.muted ? 0 : this.vol;
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : null;

    if (!this.playing) {
      outL.fill(0);
      if (outR) outR.fill(0);
      this.gainSmooth = targetGain;
      this.report(n);
      return true;
    }

    const targetFrames = (this.targetMs / 1000) * sampleRate;
    if (!this.primed) {
      if (this.available >= targetFrames) {
        this.primed = true;
        this.steerDir = 0;
        this.steerTick = 0;
      } else {
        outL.fill(0);
        if (outR) outR.fill(0);
        this.report(n);
        return true;
      }
    }

    const low = targetFrames * 0.55;
    const high = targetFrames * 1.5;
    if (this.available < low) this.steerDir = -1;
    else if (this.available > high) this.steerDir = 1;
    else if (this.steerDir === -1 && this.available > targetFrames * 0.85) this.steerDir = 0;
    else if (this.steerDir === 1 && this.available < targetFrames * 1.2) this.steerDir = 0;

    const ch = this.inChannels;
    const cap = this.capFrames;
    let rp = this.readPos;
    let avail = this.available;
    let i = 0;

    while (i < n) {
      if (avail < 1) {
        // Real underrun — silence the rest of the quantum and wait for the
        // buffer to prime again rather than replaying stale samples.
        this.underruns++;
        this.primed = false;
        for (let k = i; k < n; k++) {
          outL[k] = 0;
          if (outR) outR[k] = 0;
        }
        this.gainSmooth = targetGain;
        this.readPos = rp;
        this.available = avail;
        this.report(n);
        return true;
      }

      this.gainSmooth += (targetGain - this.gainSmooth) * 0.25;
      const g = this.gainSmooth;
      const base = rp * ch;
      const l = this.ring[base] * g;
      outL[i] = l;
      if (outR) outR[i] = (ch > 1 ? this.ring[base + 1] : this.ring[base]) * g;

      let advance = 1;
      if (this.steerDir !== 0) {
        this.steerTick++;
        if (this.steerTick >= STEER_PERIOD) {
          this.steerTick = 0;
          if (this.steerDir === -1) advance = 0; // hold one frame → slow down
          else {
            advance = 2; // skip one frame → catch up
            this.dropped++;
          }
        }
      }

      rp += advance;
      if (rp >= cap) rp -= cap;
      avail -= advance;
      this.playedFrames++;
      i++;
    }

    this.readPos = rp;
    this.available = avail;
    this.report(n);
    return true;
  }

  report(frames) {
    this.statsAccum += frames;
    if (this.statsAccum < this.statsEvery) return;
    this.statsAccum = 0;
    this.port.postMessage({
      type: 'stats',
      depthMs: (this.available / sampleRate) * 1000,
      targetMs: this.targetMs,
      framesPlayed: this.playedFrames,
      underruns: this.underruns,
      droppedFrames: this.dropped,
      playing: this.playing,
      primed: this.primed,
      sampleRate,
      steer: this.steerDir,
    });
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

registerProcessor('pcm-player', PcmPlayer);
