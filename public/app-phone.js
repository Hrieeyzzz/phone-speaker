/* Phone Speaker — phone page: receive PCM over WebSocket, play through AudioWorklet. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const now = () => performance.now();
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  const S = {
    ws: null,
    wsOpen: false,
    reconnectDelay: 600,
    ac: null,
    node: null,
    analyser: null,
    vizBuf: null,
    playing: false,
    ready: false, // worklet module loaded
    targetMs: 150,
    volume: 1,
    muted: false,
    // wire stats
    recvBytes: 0,
    rateBytes: 0,
    bitrate: 0,
    lastRecvAt: 0,
    recvTimeoutTimer: null,
    // worklet stats
    stats: null,
    lastUnderruns: 0,
    glitches: 0,
    // UI timers
    uiTimer: null,
    statsTimer: null,
    wakeLock: null,
  };

  const el = {};

  /* ---------------------------------------------------------------- *
   * UI helpers
   * ---------------------------------------------------------------- */

  function setStatus(state, text) {
    const dot = el.status.querySelector('.dot');
    dot.dataset.state = state;
    el['status-text'].textContent = text;
  }

  function setPlayingUI(playing) {
    S.playing = playing;
    el['big-play'].dataset.state = playing ? 'playing' : 'idle';
    el['play-icon'].setAttribute('d', playing ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z');
    el['big-play'].setAttribute('aria-label', playing ? 'Pause playback' : 'Start playback');
    el.hint.textContent = playing ? 'Playing — tap to pause' : 'Tap to start playing';
  }

  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }

  function warn(text) {
    if (!text) {
      el.warn.hidden = true;
      el.warn.textContent = '';
      return;
    }
    el.warn.hidden = false;
    el.warn.textContent = text;
  }

  /* ---------------------------------------------------------------- *
   * Audio
   * ---------------------------------------------------------------- */

  async function initAudio() {
    if (S.ac && S.node) {
      if (S.ac.state === 'suspended') await S.ac.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio is not available in this browser.');
    S.ac = new AC({ sampleRate: 48000, latencyHint: 'interactive' });
    if (S.ac.state === 'suspended') await S.ac.resume();

    if (S.ac.audioWorklet) {
      try {
        await S.ac.audioWorklet.addModule('/pcm-player.js');
      } catch (err) {
        // Worklet modules need a secure context and a working audio service.
        // Fall back instead of going silent.
        console.warn('AudioWorklet unavailable, using the fallback player:', err.message);
      }
    }

    if (S.ac.audioWorklet && !S.node) {
      S.node = new AudioWorkletNode(S.ac, 'pcm-player', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { targetMs: S.targetMs, outputChannels: 2, channels: 2 },
      });
      S.node.port.onmessage = onWorkletMessage;
      S.engine = 'AudioWorklet · jitter buffer';
    } else {
      // Fallback for browsers/pages without AudioWorklet (e.g. plain HTTP on
      // some platforms): schedule AudioBufferSources on a small queue.
      S.node = new ScriptQueuePlayer(S.ac);
      S.engine = 'fallback queue player';
      warn('This browser/connection cannot run AudioWorklet — using the lower-quality fallback player. Open the HTTPS address for full quality.');
    }

    S.analyser = S.ac.createAnalyser();
    S.analyser.fftSize = 1024;
    S.analyser.smoothingTimeConstant = 0.72;
    // getByteFrequencyData() needs a Uint8Array — a Float32Array throws.
    S.vizBuf = new Uint8Array(S.analyser.frequencyBinCount);

    S.node.connect(S.analyser);
    S.analyser.connect(S.ac.destination);

    el.engine.textContent = S.engine;
    S.ready = true;
    updateAudioParams();
    startWorkletStatsPoll();
  }

  function onWorkletMessage(e) {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'stats') {
      S.stats = msg;
      if (msg.underruns > S.lastUnderruns) {
        // Underruns caused by re-priming are expected at start; only count
        // real glitches after playback was already running.
        S.glitches += msg.underruns - S.lastUnderruns;
        S.lastUnderruns = msg.underruns;
      }
    }
  }

  function updateAudioParams() {
    if (!S.node) return;
    if (S.node.port) {
      S.node.port.postMessage({ type: 'config', targetMs: S.targetMs, volume: S.volume, muted: S.muted });
    } else if (S.node.setVolume) {
      S.node.setVolume(S.volume, S.muted);
    }
  }

  async function play() {
    try {
      await initAudio();
      if (S.ac.state === 'suspended') await S.ac.resume();
      if (S.node.port) S.node.port.postMessage({ type: 'play' });
      else S.node.play();
      setPlayingUI(true);
      /* vibrate is a nice touch where supported */
      if (navigator.vibrate) navigator.vibrate(12);
    } catch (err) {
      setStatus('closed', 'audio failed');
      warn(`Could not start audio: ${err.message}`);
    }
  }

  function pause() {
    if (!S.node) return;
    if (S.node.port) S.node.port.postMessage({ type: 'pause' });
    else S.node.pause();
    setPlayingUI(false);
  }

  /* ---------------------------------------------------------------- *
   * Fallback player — used only if AudioWorklet is missing.
   * ---------------------------------------------------------------- */

  class ScriptQueuePlayer {
    constructor(ac) {
      this.ac = ac;
      this.volume = ac.createGain();
      this.volume.gain.value = 1;
      this.playing = false;
      this.queue = [];
      this.nextTime = 0;
      this.underruns = 0;
      this.framesPlayed = 0;
      this.dropped = 0;
      this.sources = new Set();
      this.timer = setInterval(() => this.pump(), 10);
    }
    get outputNode() {
      return this.volume;
    }
    connect(dest) {
      this.volume.connect(dest);
    }
    disconnect() {
      this.volume.disconnect();
      clearInterval(this.timer);
    }
    setVolume(v, muted) {
      this.volume.gain.setTargetAtTime(muted ? 0 : v, this.ac.currentTime, 0.02);
    }
    play() {
      this.playing = true;
      this.nextTime = Math.max(this.nextTime, this.ac.currentTime);
    }
    pause() {
      this.playing = false;
      this.queue.length = 0;
      this.nextTime = 0;
    }
    push(buffer) {
      const pcm = new Int16Array(buffer);
      if (!pcm.length) return;
      this.queue.push(pcm);
      // Keep the backlog short — this player is a safety net, not the jitter buffer.
      while (this.queue.length > 8) {
        this.queue.shift();
        this.dropped++;
      }
    }
    pump() {
      if (!this.playing || !this.queue.length) return;
      const pcm = this.queue[0];
      const usable = pcm.length - (pcm.length % 2);
      if (!usable) {
        this.queue.shift();
        return;
      }
      this.queue.shift();
      const frames = usable / 2;
      const buf = this.ac.createBuffer(2, frames, this.ac.sampleRate);
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      for (let i = 0; i < frames; i++) {
        L[i] = pcm[i * 2] / 32768;
        R[i] = pcm[i * 2 + 1] / 32768;
      }
      const src = this.ac.createBufferSource();
      src.buffer = buf;
      src.connect(this.volume);
      const t = Math.max(this.ac.currentTime + 0.02, this.nextTime);
      if (t > this.ac.currentTime + 0.4) {
        this.dropped += frames;
        return;
      }
      src.start(t);
      this.nextTime = t + frames / this.ac.sampleRate;
      this.framesPlayed += frames;
      this.sources.add(src);
      src.onended = () => this.sources.delete(src);
    }
  }

  /* ---------------------------------------------------------------- *
   * WebSocket
   * ---------------------------------------------------------------- */

  function connect() {
    if (S.ws && (S.ws.readyState === WebSocket.OPEN || S.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const ws = new WebSocket(proto + location.host);
    ws.binaryType = 'arraybuffer';
    S.ws = ws;

    ws.onopen = () => {
      S.wsOpen = true;
      S.reconnectDelay = 600;
      setStatus('open', 'connected');
      ws.send(JSON.stringify({
        type: 'hello',
        role: 'receiver',
        name: deviceName(),
      }));
      startStatsLoop();
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        handleMessage(ev.data);
        return;
      }
      onAudio(ev.data);
    };

    ws.onclose = () => {
      S.wsOpen = false;
      stopStatsLoop();
      setStatus('closed', 'reconnecting…');
      setTimeout(connect, S.reconnectDelay);
      S.reconnectDelay = Math.min(6000, S.reconnectDelay * 1.6);
    };
    ws.onerror = () => {};

    ws.onopen = ws.onopen.bind(null);
  }

  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android phone';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows PC';
    return 'Browser';
  }

  function send(obj) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    switch (msg.type) {
      case 'welcome':
        S.id = msg.id;
        setStatus('live', 'joined relay');
        break;
      case 'sender':
        if (msg.state === 'live') {
          el.now.textContent = `playing from the computer · ${msg.label || msg.source || ''}`;
          if (S.playing) setStatus('live', 'streaming');
          if (!S.node || !S.playing) el.hint.textContent = 'Source is live — tap to start playing';
        } else {
          el.now.textContent = 'computer is idle';
          setStatus(S.wsOpen ? 'open' : 'closed', S.wsOpen ? 'connected' : 'reconnecting…');
        }
        break;
      case 'format':
        S.sampleRate = msg.sampleRate || 48000;
        el.now.textContent = `${msg.source || 'audio'} · ${(S.sampleRate / 1000).toFixed(1)} kHz from the computer`;
        break;
      case 'control':
        if (Number.isFinite(msg.targetMs)) {
          S.targetMs = msg.targetMs;
          el['latency-chip'].textContent = `buffer ${Math.round(S.targetMs)} ms`;
          el['m-target'].textContent = `${Math.round(S.targetMs)} ms target`;
          updateAudioParams();
        }
        if (Number.isFinite(msg.volume)) {
          S.volume = msg.volume;
          el.volume.value = String(Math.round(msg.volume * 100));
          el['volume-out'].textContent = `${el.volume.value}%`;
          updateAudioParams();
        }
        if (msg.action === 'pause') pause();
        else if (msg.action === 'play') play();
        break;
      default:
        break;
    }
  }

  function onAudio(buf) {
    S.recvBytes += buf.byteLength;
    S.lastRecvAt = now();
    if (!S.node) {
      if (S.pendingStart) S.pendingStart = buf; // remembered so the user hears sound after tapping
      return;
    }
    if (!S.playing) return;
    if (S.node.port) S.node.port.postMessage({ type: 'pcm', buf }, [buf]);
    else S.node.push(buf);
  }

  /* ---------------------------------------------------------------- *
   * Stats + UI
   * ---------------------------------------------------------------- */

  function startStatsLoop() {
    stopStatsLoop();
    S.statsTimer = setInterval(() => {
      const delta = S.recvBytes - S.rateBytes;
      S.rateBytes = S.recvBytes;
      S.bitrate = delta * 8;
      send({
        type: 'stats',
        payload: {
          depthMs: S.stats ? S.stats.depthMs : null,
          targetMs: S.stats ? S.stats.targetMs : S.targetMs,
          underruns: S.stats ? S.stats.underruns : 0,
          glitchCount: S.glitches,
          droppedFrames: S.stats ? (S.stats.droppedFrames || 0) : 0,
          recvBytes: S.recvBytes,
          bitrate: S.bitrate,
          playing: S.playing,
          aw: Boolean(S.ac && S.ac.audioWorklet),
          ua: navigator.userAgent.includes('iPhone') ? 'iPhone' : deviceName(),
          device: deviceName(),
        },
      });
    }, 1000);
  }

  function stopStatsLoop() {
    if (S.statsTimer) clearInterval(S.statsTimer);
    S.statsTimer = null;
  }

  function startWorkletStatsPoll() {
    if (S.uiTimer) return;
    S.uiTimer = setInterval(render, 200);
  }

  function render() {
    if (!S.stats) {
      return;
    }
    const st = S.stats;
    el['m-depth'].textContent = `${Math.round(st.depthMs)} ms`;
    el['m-underruns'].textContent = String(st.underruns);
    el['m-recv'].textContent = fmtBytes(S.recvBytes);
    el['m-rate'].textContent = S.bitrate >= 1000000
      ? `${(S.bitrate / 1e6).toFixed(1)}M`
      : `${Math.round(S.bitrate / 1000)}k`;
    el['m-rate'].title = `${Math.round(S.bitrate / 1000)} kbps`;

    const pct = clamp((st.depthMs / (st.targetMs * 2)) * 100, 0, 100);
    el['depth-fill'].style.width = `${pct}%`;
    el['depth-target'].style.left = '50%';

    if (st.underruns > 0 && S.playing) {
      warn(st.underruns > 10
        ? 'Stuttering — try raising the buffer on the computer page, or move closer to the Wi-Fi router.'
        : null);
    }
  }

  /* ---------------------------------------------------------------- *
   * Spectrum-ish visualiser
   * ---------------------------------------------------------------- */

  function drawViz() {
    const canvas = el.viz;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const bars = 48;
    const gap = 3;
    const barW = (w - gap * (bars - 1)) / bars;

    let data = null;
    if (S.analyser) {
      S.analyser.getByteFrequencyData(S.vizBuf);
      data = S.vizBuf;
    }
    for (let i = 0; i < bars; i++) {
      let v = 0;
      if (data && S.playing) {
        const bin = Math.floor(Math.pow(i / bars, 1.7) * (data.length * 0.7)) + 1;
        v = data[bin] / 255;
      } else if (S.playing) {
        v = 0.06 + 0.05 * Math.sin(i * 0.5 + performance.now() / 400);
      }
      const bh = Math.max(3, v * (h * 0.82));
      const x = i * (barW + gap);
      const y = (h + bh) / 2;
      const grad = ctx.createLinearGradient(0, y - bh, 0, y);
      grad.addColorStop(0, 'rgba(56, 225, 176, 0.95)');
      grad.addColorStop(1, 'rgba(110, 168, 255, 0.35)');
      ctx.fillStyle = grad;
      const r = Math.min(3, barW / 2);
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, h / 2 - bh / 2, barW, bh, r) : ctx.rect(x, h / 2 - bh / 2, barW, bh);
      ctx.fill();
    }
    requestAnimationFrame(drawViz);
  }

  /* ---------------------------------------------------------------- *
   * Wake lock
   * ---------------------------------------------------------------- */

  async function toggleWakeLock() {
    if (S.wakeLock) {
      try { await S.wakeLock.release(); } catch (e) { /* ignore */ }
      S.wakeLock = null;
      el['screen-lock'].setAttribute('aria-pressed', 'false');
      return;
    }
    if (!('wakeLock' in navigator)) {
      warn('This browser cannot keep the screen awake. Set the screen timeout in Settings, or keep the page in the foreground.');
      return;
    }
    try {
      S.wakeLock = await navigator.wakeLock.request('screen');
      el['screen-lock'].setAttribute('aria-pressed', 'true');
      S.wakeLock.addEventListener('release', () => {
        el['screen-lock'].setAttribute('aria-pressed', 'false');
        S.wakeLock = null;
      });
    } catch (e) {
      warn(`Could not keep the screen awake: ${e.message}`);
    }
  }

  /* ---------------------------------------------------------------- *
   * Setup
   * ---------------------------------------------------------------- */

  function setup() {
    for (const id of [
      'status', 'status-text', 'viz', 'big-play', 'play-icon', 'hint', 'now', 'volume', 'volume-out',
      'screen-lock', 'latency-chip', 'm-depth', 'm-underruns', 'm-recv', 'm-rate', 'm-target',
      'depth-fill', 'depth-target', 'warn', 'engine', 'back',
    ]) el[id] = document.getElementById(id);

    el['m-target'].textContent = `${Math.round(S.targetMs)} ms target`;
    el['latency-chip'].textContent = `buffer ${Math.round(S.targetMs)} ms`;

    el['big-play'].addEventListener('click', () => {
      if (S.playing) pause();
      else play();
    });

    el.volume.addEventListener('input', () => {
      S.volume = Number(el.volume.value) / 100;
      el['volume-out'].textContent = `${el.volume.value}%`;
      updateAudioParams();
    });

    el['screen-lock'].addEventListener('click', toggleWakeLock);
    el['latency-chip'].addEventListener('click', () => {
      // cycles through sensible buffer presets; the computer page can override
      const presets = [100, 150, 250, 400];
      S.targetMs = presets[(presets.indexOf(S.targetMs) + 1) % presets.length] || 150;
      el['latency-chip'].textContent = `buffer ${S.targetMs} ms`;
      el['m-target'].textContent = `${S.targetMs} ms target`;
      updateAudioParams();
    });

    // Keep audio alive when the tab is backgrounded or the phone locks — browsers
    // suspend the AudioContext before that, so nudge it back on visibility.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && S.ac && S.ac.state === 'suspended' && S.playing) {
        S.ac.resume().catch(() => {});
      }
    });

    // iOS Safari needs an actual gesture to unlock audio, which the big button is.
    setPlayingUI(false);

    // Compile the worklet during page load (the phone page is opened by a scan
    // and has no other work to do), so the first tap starts sound instantly.
    initAudio()
      .then(() => el.hint.textContent = 'Ready — tap to start playing')
      .catch(() => {});

    // If compilation was blocked, retry on the first interaction.
    const retryInit = () => { initAudio().catch(() => {}); };
    window.addEventListener('pointerdown', retryInit, { once: true, capture: true });

    connect();

    // Diagnostics handle — used by the E2E suite and handy in DevTools.
    window.__phoneSpeaker = { state: S };

    // ?autoplay=1 starts playback as soon as the page loads. Browsers with a
    // strict autoplay policy will refuse without a tap, which is fine — the
    // big button stays available.
    if (new URLSearchParams(location.search).get('autoplay') === '1') {
      const tryPlay = () => (S.wsOpen ? play().catch(() => {}) : setTimeout(tryPlay, 100));
      tryPlay();
    }
    drawViz();
    if (!(window.AudioContext || window.webkitAudioContext)) {
      warn('This browser has no Web Audio support — playback is not possible.');
      el['big-play'].disabled = true;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();
