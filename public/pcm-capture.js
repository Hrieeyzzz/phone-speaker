/**
 * pcm-capture.js — AudioWorkletProcessor: float32 audio → 16-bit stereo PCM.
 *
 * Runs on the audio render thread of the computer's page. Whatever is wired
 * into the node (tab / system capture, a file, or the microphone) is converted
 * to little-endian Int16 stereo and posted to the page in batches that match
 * the buffer size chosen on the main thread (~20 ms by default), so network
 * sends are paced by real audio instead of a JS timer.
 *
 * messages in : {type:'config', batchMs, channels, mute} / {type:'reset'}
 * messages out: {type:'batch', sequence, frames, sampleRate, channels, buf}
 *               {type:'level', peak, clipped, framesSent, sampleRate}
 */

class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.channels = opts.channels === 1 ? 1 : 2;
    this.muted = false;
    this.setBatch(opts.batchMs || 20);
    this.sequence = 0;
    this.framesSent = 0;
    this.clipped = 0;
    this.fill = 0;
    this.peak = 0;
    this.levelAccum = 0;
    this.levelEvery = Math.max(128, Math.round(sampleRate * 0.02));

    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'config') {
        if (msg.channels === 1 || msg.channels === 2) this.channels = msg.channels;
        if (Number.isFinite(msg.batchMs)) this.setBatch(msg.batchMs);
        if (typeof msg.mute === 'boolean') this.muted = msg.mute;
      } else if (msg.type === 'reset') {
        this.sequence = 0;
        this.framesSent = 0;
        this.clipped = 0;
        this.fill = 0;
        this.peak = 0;
      }
    };
  }

  setBatch(batchMs) {
    this.batchMs = Math.min(200, Math.max(5, batchMs));
    this.batchFrames = Math.max(128, Math.round((sampleRate * this.batchMs) / 1000) & ~1);
    // Two batches of headroom so the flush loop can never overflow mid-quantum.
    this.pcm = new Int16Array(this.batchFrames * this.channels * 2);
    this.limit = this.batchFrames * this.channels;
    this.fill = 0;
  }

  flush() {
    if (!this.fill) return;
    const out = new Int16Array(this.fill);
    out.set(this.pcm.subarray(0, this.fill));
    this.port.postMessage(
      {
        type: 'batch',
        sequence: this.sequence++,
        frames: this.fill / this.channels,
        sampleRate,
        channels: this.channels,
        buf: out.buffer,
      },
      [out.buffer]
    );
    this.framesSent += this.fill / this.channels;
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const frames = input && input.length && input[0] ? input[0].length : 128;

    if (!input || !input.length || !input[0]) {
      // No source connected (or the track ended): keep emitting silence so the
      // phone's buffer stays topped up instead of draining into underruns.
      this.emitSilence(frames);
      return true;
    }

    const left = input[0];
    const right = input.length > 1 && input[1] ? input[1] : null;
    const ch = this.channels;
    let peak = this.peak;

    for (let i = 0; i < frames; i++) {
      const l = this.muted ? 0 : left[i];
      const r = this.muted ? 0 : right ? right[i] : l;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > peak) peak = al;
      if (ar > peak) peak = ar;
      if (al >= 1 || ar >= 1) this.clipped++;

      this.pcm[this.fill++] = l < 0 ? l * 0x8000 : l * 0x7fff;
      if (ch === 2) this.pcm[this.fill++] = r < 0 ? r * 0x8000 : r * 0x7fff;

      if (this.fill >= this.limit) this.flush();
    }

    this.peak = peak;
    this.reportLevel(frames);
    return true;
  }

  emitSilence(frames) {
    for (let i = 0; i < frames; i++) {
      this.pcm[this.fill++] = 0;
      if (this.channels === 2) this.pcm[this.fill++] = 0;
      if (this.fill >= this.limit) this.flush();
    }
    this.reportLevel(frames);
  }

  reportLevel(frames) {
    this.levelAccum += frames;
    if (this.levelAccum < this.levelEvery) return;
    this.levelAccum = 0;
    this.port.postMessage({
      type: 'level',
      peak: this.peak,
      clipped: this.clipped,
      framesSent: this.framesSent,
      sampleRate,
    });
    this.peak = 0;
  }
}

registerProcessor('pcm-capture', PcmCapture);
