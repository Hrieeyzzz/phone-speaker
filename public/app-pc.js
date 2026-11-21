/* Phone Speaker — computer page: capture audio, ship PCM to the relay, show stats. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const now = () => performance.now();

  const S = {
    source: null, // 'tab' | 'file' | 'mic'
    filePhase: 0, // file picker: 0 = pick, 1 = file chosen → next click starts
    live: false,
    ws: null,
    wsOpen: false,
    wsStartedAt: 0,
    ac: null,
    captureNode: null,
    mediaStream: null,
    mediaEl: null,
    fileUrl: null,
    fileName: '',
    monitorGain: null,
    analyser: null,
    levelBuf: null,
    sampleRate: 48000,
    batchMs: 20,
    latencyMs: 150,
    phoneVolume: 1,
    loop: false,
    paused: false,
    // counters
    bytesSent: 0,
    batchesSent: 0,
    framesSent: 0,
    peak: 0,
    clipped: 0,
    rtt: null,
    rttTimer: null,
    pingSentAt: 0,
    // stats from the relay / phones
    receivers: 0,
    receiversSecure: 0,
    phones: new Map(), // id → {depthMs, targetMs, underruns, dropped, lastSeen, ua, secure}
    lastRateAt: 0,
    lastRateBytes: 0,
    bitrate: 0,
    relays: [],
    relayIndex: 0,
    reconnectDelay: 500,
  };

  const els = {};
  const bind = () => {
    const ids = [
      'net-dot', 'net-text', 'server-url', 'src-tab', 'src-file', 'src-mic', 'file-picker', 'drop',
      'file-input', 'file-name', 'transport', 'btn-pause', 'seek', 'time', 'btn-loop', 'btn-start',
      'btn-start-label', 'monitor', 'phone-count', 'qr', 'phone-url', 'alt-urls', 'secure-note',
      'https-link', 'src-pill', 'peak-db', 'peak-bar', 'st-bitrate', 'st-format', 'st-sent',
      'st-batches', 'st-rtt', 'st-depth', 'st-target', 'st-glitch', 'st-dropped', 'st-phones',
      'st-phones-secure', 'latency', 'latency-out', 'phone-vol', 'vol-out', 'batch', 'batch-out',
      'log', 'phone-list', 'version',
    ];
    for (const id of ids) els[id] = document.getElementById(id);
  };

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  function log(msg, kind = '') {
    if (!els.log) return;
    const row = document.createElement('div');
    if (kind) row.dataset.kind = kind;
    const t = new Date().toLocaleTimeString([], { hour12: false });
    row.textContent = `${t}  ${msg}`;
    els.log.appendChild(row);
    while (els.log.children.length > 120) els.log.firstChild.remove();
    els.log.scrollTop = els.log.scrollHeight;
  }

  function fmtBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }

  function fmtDb(peak) {
    if (!peak || peak < 1e-5) return '-∞ dB';
    return `${(20 * Math.log10(peak)).toFixed(1)} dB`;
  }

  function fmtMs(v) {
    if (v == null || Number.isNaN(v)) return '—';
    return `${Math.round(v)} ms`;
  }

  function isSecure() {
    return window.isSecureContext;
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host;
  }

  /* ---------------------------------------------------------------- *
   * Relay connection
   * ---------------------------------------------------------------- */

  function connect() {
    if (S.ws && (S.ws.readyState === WebSocket.OPEN || S.ws.readyState === WebSocket.CONNECTING)) return;
    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      log('WebSocket failed: ' + e.message, 'error');
      return;
    }
    ws.binaryType = 'arraybuffer';
    S.ws = ws;

    const connectTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        try { ws.close(); } catch (e) { /* ignore */ }
      }
    }, 4000);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      S.wsOpen = true;
      S.wsStartedAt = now();
      S.reconnectDelay = 500;
      els['net-dot'].dataset.state = 'open';
      els['net-text'].textContent = 'relay connected';
      ws.send(JSON.stringify({ type: 'hello', role: 'sender', name: 'computer' }));
      startPing();
      if (S.live) {
        ws.send(JSON.stringify({ type: 'sender-state', state: 'live', source: S.source, label: sourceLabel() }));
        sendFormat();
      }
      log('Connected to relay', 'ok');
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      handleMessage(msg);
    };

    ws.onclose = () => {
      clearTimeout(connectTimeout);
      S.wsOpen = false;
      stopPing();
      els['net-dot'].dataset.state = 'closed';
      els['net-text'].textContent = 'relay offline — retrying';
      if (S.live) els['net-dot'].dataset.state = 'closed';
      setTimeout(connect, S.reconnectDelay);
      S.reconnectDelay = Math.min(8000, S.reconnectDelay * 1.7);
    };

    ws.onerror = () => {
      /* onclose handles retry */
    };
  }

  function send(obj) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        S.receivers = msg.receivers;
        renderPhones();
        break;
      case 'peers':
        S.receivers = msg.receivers;
        S.receiversSecure = Math.min(S.receiversSecure, msg.receivers);
        if (msg.receivers === 0) S.phones.clear();
        renderPhones();
        break;
      case 'sender':
        // Another computer page took over / stopped — drop our state quietly.
        if (S.live && msg.senderId !== undefined) log('Another sender page is active on this relay', 'warn');
        break;
      case 'pong': {
        const rtt = now() - (msg.t != null ? msg.t : S.pingSentAt);
        S.rtt = rtt;
        els['st-rtt'].textContent = fmtMs(rtt);
        break;
      }
      case 'receiver-stats': {
        const p = S.phones.get(msg.from) || {};
        Object.assign(p, msg.payload || {}, { lastSeen: now() });
        p.id = msg.from;
        S.phones.set(msg.from, p);
        updatePhonePanels();
        break;
      }
      default:
        break;
    }
  }

  function startPing() {
    stopPing();
    S.rttTimer = setInterval(() => {
      S.pingSentAt = now();
      send({ type: 'ping', t: S.pingSentAt });
    }, 2000);
    S.pingSentAt = now();
    send({ type: 'ping', t: S.pingSentAt });
  }

  function stopPing() {
    if (S.rttTimer) clearInterval(S.rttTimer);
    S.rttTimer = null;
  }

  /* ---------------------------------------------------------------- *
   * Server info / QR
   * ---------------------------------------------------------------- */

  async function loadInfo() {
    let info;
    try {
      const res = await fetch('/api/info', { cache: 'no-store' });
      info = await res.json();
    } catch (e) {
      log('Could not reach /api/info: ' + e.message, 'error');
      return;
    }
    S.relays = info.phones || [];
    els['version'].textContent = `v${info.version}`;
    els['server-url'].textContent = `:${info.port}${info.httpsPort ? ` · tls :${info.httpsPort}` : ''}`;
    els['secure-note'].hidden = isSecure() || !info.httpsPort;
    if (info.httpsPort) {
      els['https-link'].href = `https://${info.addresses[0] ? info.addresses[0].address : 'localhost'}:${info.httpsPort}/`;
    }

    const pick = S.relays.find((p) => p.primary) || S.relays[0];
    if (!pick) return;
    els['phone-url'].textContent = pick.url;
    els.qr.src = `/api/qr?url=${encodeURIComponent(pick.url)}`;
    els.qr.alt = `QR code for ${pick.url}`;

    // Alternate URLs (HTTP variants, localhost) under the QR.
    els['alt-urls'].textContent = '';
    for (const p of S.relays) {
      if (p.url === pick.url) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p.url;
      b.title = 'Use this one';
      b.onclick = () => {
        els['phone-url'].textContent = p.url;
        els.qr.src = `/api/qr?url=${encodeURIComponent(p.url)}`;
      };
      els['alt-urls'].appendChild(b);
    }

    for (const src of ['tab', 'mic']) {
      const btn = document.getElementById(`src-${src}`);
      if (!isSecure()) {
        btn.disabled = true;
        btn.title = 'Needs HTTPS — open the secure page';
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Source selection
   * ---------------------------------------------------------------- */

  function sourceLabel() {
    if (S.source === 'file') return S.fileName || 'audio file';
    if (S.source === 'tab') return 'tab / system audio';
    if (S.source === 'mic') return 'microphone';
    return '';
  }

  function pickSource(src) {
    if (S.live) stopSending();
    S.source = src;
    for (const b of document.querySelectorAll('.source')) {
      b.setAttribute('aria-pressed', String(b.dataset.source === src));
    }
    els['file-picker'].hidden = src !== 'file';
    els['btn-start'].disabled = false;
    els['btn-start-label'].textContent = 'Start sending';
    els['src-pill'].textContent = `source: ${src}`;
    log(`Source selected: ${sourceLabel() || src}`);
  }

  /* ---------------------------------------------------------------- *
   * Audio graph
   * ---------------------------------------------------------------- */

  async function ensureContext() {
    const rate = 48000;
    if (!S.ac) {
      S.ac = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
    }
    if (S.ac.state === 'suspended') await S.ac.resume();
    S.sampleRate = S.ac.sampleRate;
    return S.ac;
  }

  /**
   * Load the capture worklet early (right after the first user gesture) so
   * pressing Start only has to open the source, not compile code.
   */
  async function preloadWorklet() {
    if (S.workletReady) return true;
    if (S.workletPromise) return S.workletPromise;
    S.workletPromise = (async () => {
      try {
        const ac = await ensureContext();
        if (!ac.audioWorklet) throw new Error('AudioWorklet is unavailable — open the HTTPS URL.');
        await ac.audioWorklet.addModule('/pcm-capture.js');
        S.workletReady = true;
        prewarmCaptureNode();
        return true;
      } catch (err) {
        S.workletPromise = null; // allow a retry on the next click
        throw err;
      }
    })();
    return S.workletPromise;
  }

  /** Create the node early, wired straight to the silent monitor path. */
  function prewarmCaptureNode() {
    const ac = S.ac;
    if (!ac || S.captureNode) return;
    try {
      S.captureNode = new AudioWorkletNode(ac, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { batchMs: S.batchMs, channels: 2 },
      });
      S.captureNode.port.onmessage = onCaptureMessage;
      S.captureNode.port.postMessage({ type: 'config', batchMs: S.batchMs, channels: 2 });
      S.monitorGain = ac.createGain();
      S.monitorGain.gain.value = els.monitor.checked ? 1 : 0;
      S.captureNode.connect(S.monitorGain).connect(ac.destination);
    } catch (e) {
      S.captureNode = null;
    }
  }

  async function buildCaptureNode() {
    const ac = await ensureContext();
    if (!S.captureNode) {
      await ac.audioWorklet.addModule('/pcm-capture.js');
      S.captureNode = new AudioWorkletNode(ac, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { batchMs: S.batchMs, channels: 2 },
      });
      S.captureNode.port.onmessage = onCaptureMessage;
      S.captureNode.port.postMessage({ type: 'config', batchMs: S.batchMs, channels: 2 });

      // Monitoring path: worklet → gain (0 by default) → speakers.
      S.monitorGain = ac.createGain();
      S.monitorGain.gain.value = els.monitor.checked ? 1 : 0;
      S.captureNode.connect(S.monitorGain).connect(ac.destination);
    }
    return S.captureNode;
  }

  let lastOverheadLog = 0;

  function onCaptureMessage(e) {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'batch') {
      const ws = S.ws;
      if (!S.live || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(msg.buf);
      S.bytesSent += msg.buf.byteLength;
      S.batchesSent++;
      S.framesSent += msg.frames;
      return;
    }
    if (msg.type === 'level') {
      if (msg.peak > S.peak) S.peak = msg.peak;
      S.clipped = msg.clipped;
      S.framesSent = msg.framesSent != null ? msg.framesSent : S.framesSent;
    }
  }

  function sendFormat() {
    send({ type: 'format', sampleRate: S.sampleRate, source: S.source, label: sourceLabel() });
  }

  /* ---------------------------------------------------------------- *
   * Start / stop
   * ---------------------------------------------------------------- */

  async function start() {
    if (S.live) return stopSending();
    if (!S.source) return log('Pick a source first', 'warn');

    try {
      const ac = await ensureContext();
      let node = null;
      try {
        await preloadWorklet();
        node = S.captureNode || (prewarmCaptureNode(), S.captureNode);
      } catch (e) {
        S.workletReady = false;
      }
      if (!node) node = await buildCaptureNode();
      S.bytesSent = 0;
      S.batchesSent = 0;
      S.framesSent = 0;
      S.clipped = 0;

      if (S.source === 'tab') await startTabCapture(ac, node);
      else if (S.source === 'file') await startFileSource(ac, node);
      else if (S.source === 'mic') await startMicSource(ac, node);

      S.live = true;
      els['btn-start'].dataset.live = 'true';
      els['btn-start-label'].textContent = 'Stop';
      els['net-dot'].dataset.state = 'live';
      els['src-pill'].textContent = `live: ${S.source}`;
      node.port.postMessage({ type: 'reset' });
      node.port.postMessage({ type: 'config', batchMs: S.batchMs, channels: 2, mute: S.paused });
      send({ type: 'sender-state', state: 'live', source: S.source, label: sourceLabel() });
      sendFormat();
      node.port.postMessage({ type: 'config', targetMs: S.latencyMs });
      log(`Streaming ${sourceLabel()} at ${S.sampleRate} Hz`, 'ok');
      startStatsLoop();
    } catch (err) {
      log(errorText(err), 'error');
      stopSending();
    }
  }

  function errorText(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError') return 'Permission denied (or you cancelled the picker).';
    if (name === 'NotSupportedError') return 'This browser does not support that capture mode.';
    if (name === 'AbortError') return 'Capture was cancelled.';
    return (err && err.message) || String(err);
  }

  async function startTabCapture(ac, node) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error('getDisplayMedia is unavailable — this page must be HTTPS or localhost.');
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // required by Chrome to offer the "share tab audio" checkbox
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000,
      },
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      systemAudio: 'include',
    });
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('No audio track — in Chrome, tick “Also share tab audio” (or “Share system audio”) in the picker.');
    }
    // Video is only needed to satisfy the picker; drop it right away.
    stream.getVideoTracks().forEach((t) => t.stop());
    S.mediaStream = stream;
    const src = ac.createMediaStreamSource(new MediaStream(audioTracks));
    src.connect(node);
    S.tabTrack = audioTracks[0];
    S.tabTrack.addEventListener('ended', () => {
      log('Tab capture ended (source closed or stop shared from Chrome bar)', 'warn');
      stopSending();
    });
    S.tabSourceNode = src;
  }

  async function startMicSource(ac, node) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('getUserMedia is unavailable — this page must be HTTPS or localhost.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: 48000,
      },
    });
    S.mediaStream = stream;
    const src = ac.createMediaStreamSource(stream);
    src.connect(node);
    S.micSourceNode = src;
  }

  async function startFileSource(ac, node) {
    if (!S.fileName) throw new Error('Choose an audio file first.');
    if (!S.mediaEl) {
      S.mediaEl = new Audio();
      S.mediaEl.preload = 'auto';
      S.mediaEl.crossOrigin = 'anonymous';
      S.mediaEl.addEventListener('ended', onFileEnded);
      S.mediaEl.addEventListener('timeupdate', onTimeUpdate);
      S.mediaEl.addEventListener('loadedmetadata', onTimeUpdate);
    }
    if (!S.fileSourceNode) {
      S.fileSourceNode = ac.createMediaElementSource(S.mediaEl);
      S.fileSourceNode.connect(node);
    }
    S.mediaEl.loop = S.loop;
    // A file that ran to the end stays paused at its last sample; rewind so the
    // next press of Start plays it from the beginning.
    if (S.mediaEl.ended || (S.mediaEl.paused && S.mediaEl.currentTime >= (S.mediaEl.duration || Infinity) - 0.05)) {
      S.mediaEl.currentTime = 0;
    }
    if (S.mediaEl.paused) await S.mediaEl.play();
    S.paused = false;
    updateTransport();
  }

  function onFileEnded() {
    if (!S.live || !S.mediaEl) return;
    if (S.loop) {
      S.mediaEl.currentTime = 0;
      const p = S.mediaEl.play();
      if (p && p.catch) p.catch(() => {});
      return;
    }
    log('File finished');
    stopSending();
  }

  function onTimeUpdate() {
    updateTransport();
  }

  function stopSending() {
    S.live = false;
    S.paused = false;
    stopStatsLoop();
    if (S.mediaEl && !S.mediaEl.paused) S.mediaEl.pause();
    if (S.mediaStream) {
      S.mediaStream.getTracks().forEach((t) => t.stop());
      S.mediaStream = null;
    }
    for (const key of ['tabSourceNode', 'micSourceNode']) {
      if (S[key]) {
        try { S[key].disconnect(); } catch (e) { /* ignore */ }
        S[key] = null;
      }
    }
    els['btn-start'].dataset.live = 'false';
    els['btn-start-label'].textContent = 'Start sending';
    els['net-dot'].dataset.state = S.wsOpen ? 'open' : 'closed';
    els['src-pill'].textContent = 'idle';
    els['st-depth'].textContent = '—';
    send({ type: 'sender-state', state: 'idle', source: S.source, label: sourceLabel() });
    log('Stopped sending');
  }

  /* ---------------------------------------------------------------- *
   * Stats loop
   * ---------------------------------------------------------------- */

  let statsTimer = null;
  let uiTimer = null;

  function startStatsLoop() {
    stopStatsLoop();
    statsTimer = setInterval(() => {
      const delta = S.bytesSent - S.lastRateBytes;
      S.bitrate = delta * 8;
      S.lastRateBytes = S.bytesSent;
      send({
        type: 'stats',
        payload: {
          bytesSent: S.bytesSent,
          bitrate: S.bitrate,
          batches: S.batchesSent,
          frames: S.framesSent,
          rtt: S.rtt,
          sampleRate: S.sampleRate,
          source: S.source,
          label: sourceLabel(),
        },
      });
    }, 1000);
    uiTimer = setInterval(renderStats, 250);
    renderStats();
  }

  function stopStatsLoop() {
    if (statsTimer) clearInterval(statsTimer);
    if (uiTimer) clearInterval(uiTimer);
    statsTimer = null;
    uiTimer = null;
  }

  function renderStats() {
    els['st-bitrate'].textContent = S.live ? `${(S.bitrate / 1000).toFixed(0)} kbps` : '—';
    els['st-format'].textContent = `${S.sampleRate / 1000} kHz · 16-bit stereo`;
    els['st-sent'].textContent = fmtBytes(S.bytesSent);
    els['st-batches'].textContent = `${S.batchesSent.toLocaleString()} batches`;
    els['st-phones'].textContent = String(S.receivers);
    els['st-phones-secure'].textContent = `${S.receiversSecure} AudioWorklet`;

    // Level meter: peak-hold on the worklet's report, decaying ~6 dB/s.
    const db = 20 * Math.log10(Math.max(S.peak, 1e-6));
    const pct = Math.min(100, Math.max(0, ((db + 60) / 60) * 100));
    els['peak-bar'].style.width = (S.live ? pct : 0) + '%';
    els['peak-db'].textContent = S.live ? fmtDb(S.peak) : '-∞ dB';
    S.peak *= 0.94;
  }

  /* ---------------------------------------------------------------- *
   * Phones
   * ---------------------------------------------------------------- */

  function renderPhones() {
    els['phone-count'].textContent = `${S.receivers} connected`;
    els['phone-count'].dataset.zero = String(S.receivers === 0);
  }

  function updatePhonePanels() {
    const list = els['phone-list'];
    const entries = [...S.phones.entries()].filter(([, p]) => now() - (p.lastSeen || 0) < 15000);
    let secure = 0;
    for (const [, p] of entries) if (p.aw) secure++;
    S.receiversSecure = secure;
    els['st-phones-secure'].textContent = `${secure} AudioWorklet`;

    if (!entries.length) {
      list.innerHTML = '<p class="muted small">No phones connected yet.</p>';
      els['st-depth'].textContent = '—';
      els['st-glitch'].textContent = '0';
      return;
    }

    // Show the newest phone in the headline tiles.
    let newest = null;
    for (const [, p] of entries) if (!newest || (p.lastSeen || 0) > (newest.lastSeen || 0)) newest = p;
    if (newest) {
      els['st-depth'].textContent = fmtMs(newest.depthMs);
      els['st-target'].textContent = `target ${Math.round(newest.targetMs || S.latencyMs)} ms`;
      const glitches = (newest.glitchCount != null ? newest.glitchCount : 0);
      els['st-glitch'].textContent = String(glitches);
      els['st-dropped'].textContent = `${newest.droppedFrames || 0} dropped`;
      els['st-glitch'].closest('.stat').dataset.warn = String(glitches > 0);
      const depthStat = els['st-depth'].closest('.stat');
      depthStat.dataset.bad = String(newest.depthMs > (newest.targetMs || 150) * 3);
    }

    list.textContent = '';
    for (const [id, p] of entries) {
      const row = document.createElement('div');
      row.className = 'phone-row';
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = p.name || `phone ${id}`;
      const ua = document.createElement('small');
      ua.textContent = (p.ua || '').includes('iPhone') ? 'iPhone · Safari' : p.device || p.ua || 'browser';
      who.appendChild(ua);
      row.appendChild(who);
      const cells = [
        ['depth', fmtMs(p.depthMs)],
        ['buffer', `${Math.round(p.targetMs || 0)} ms`],
        ['underruns', String(p.underruns || 0)],
        ['dropped', String(p.droppedFrames || 0)],
      ];
      for (const [k, v] of cells) {
        const c = document.createElement('div');
        const kk = document.createElement('small');
        kk.textContent = k;
        const vv = document.createElement('b');
        vv.textContent = v;
        c.append(kk, vv);
        row.appendChild(c);
      }
      list.appendChild(row);
    }
  }

  /* ---------------------------------------------------------------- *
   * Transport / sliders
   * ---------------------------------------------------------------- */

  function updateTransport() {
    if (!S.mediaEl) return;
    els.transport.hidden = S.source !== 'file' || !S.fileName;
    els['btn-pause'].innerHTML = S.mediaEl.paused
      ? '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
    els['btn-loop'].setAttribute('aria-pressed', String(S.loop));
    if (S.mediaEl.duration && Number.isFinite(S.mediaEl.duration)) {
      els.seek.value = String(Math.round((S.mediaEl.currentTime / S.mediaEl.duration) * 1000));
    }
    els.time.textContent = `${fmtTime(S.mediaEl.currentTime)} / ${fmtTime(S.mediaEl.duration)}`;
  }

  function fmtTime(sec) {
    if (!Number.isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function setFile(file) {
    if (!file) return;
    if (S.fileUrl) URL.revokeObjectURL(S.fileUrl);
    S.fileUrl = URL.createObjectURL(file);
    S.fileName = file.name;
    els['file-name'].textContent = `${file.name} · ${fmtBytes(file.size)}`;
    if (S.mediaEl) {
      S.mediaEl.pause();
      S.mediaEl.src = S.fileUrl;
      S.mediaEl.load();
    } else {
      S.mediaEl = new Audio();
      S.mediaEl.preload = 'auto';
      S.mediaEl.src = S.fileUrl;
      S.mediaEl.addEventListener('ended', onFileEnded);
      S.mediaEl.addEventListener('timeupdate', onTimeUpdate);
      S.mediaEl.addEventListener('loadedmetadata', onTimeUpdate);
    }
    S.mediaEl.loop = S.loop;
    S.source = 'file';
    els['file-picker'].hidden = false;
    els.transport.hidden = false;
    els['btn-start'].disabled = false;
    els['btn-start-label'].textContent = 'Start sending';
    els['src-pill'].textContent = 'source: file';
    updateTransport();
    log(`File ready: ${file.name}`);
  }

  /* ---------------------------------------------------------------- *
   * Wire everything up
   * ---------------------------------------------------------------- */

  function disabledFeatureNote(what) {
    log(`${what} needs a secure context — open https://<this-ip>:port/ instead of http://`, 'warn');
  }

  function setup() {
    bind();

    for (const btn of document.querySelectorAll('.source')) {
      btn.addEventListener('click', () => pickSource(btn.dataset.source));
    }
    els['src-file'].addEventListener('click', () => {
      if (S.live) stopSending();
      if (S.source !== 'file' || !S.fileName) pickSource('file');
      if (!S.fileName) setTimeout(() => els['file-input'].click(), 0);
    });
    for (const id of ['src-tab', 'src-mic']) {
      const btn = document.getElementById(id);
      btn.addEventListener('click', () => {
        if (btn.disabled) disabledFeatureNote(btn.dataset.source === 'tab' ? 'Tab capture' : 'Microphone capture');
      });
    }

    els['file-input'].addEventListener('change', (e) => setFile(e.target.files && e.target.files[0]));
    els.drop.addEventListener('click', (e) => {
      e.preventDefault();
      els['file-input'].click();
    });
    els.drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      els.drop.classList.add('drag');
    });
    els.drop.addEventListener('dragleave', () => els.drop.classList.remove('drag'));
    els.drop.addEventListener('drop', (e) => {
      e.preventDefault();
      els.drop.classList.remove('drag');
      setFile(e.dataTransfer.files && e.dataTransfer.files[0]);
    });

    els['btn-start'].addEventListener('click', start);

    // Compile the capture worklet while the user is reading the page, so the
    // Start button only has to open the source. Creating an AudioContext
    // before a gesture is allowed (it starts suspended); resuming happens on
    // Start. If the browser refuses, the first gesture retries.
    preloadWorklet().catch(() => {});
    const warmUp = () => {
      preloadWorklet().catch(() => {});
    };
    window.addEventListener('pointerdown', warmUp, { capture: true });
    window.addEventListener('keydown', warmUp, { capture: true });

    els.monitor.addEventListener('change', () => {
      if (S.monitorGain) {
        S.monitorGain.gain.setTargetAtTime(els.monitor.checked ? 1 : 0, S.ac.currentTime, 0.02);
      }
    });

    els.seek.addEventListener('input', () => {
      if (!S.mediaEl || !S.mediaEl.duration) return;
      S.mediaEl.currentTime = (Number(els.seek.value) / 1000) * S.mediaEl.duration;
    });
    els['btn-pause'].addEventListener('click', () => {
      if (!S.mediaEl) return;
      if (S.mediaEl.paused) {
        S.mediaEl.play().catch(() => {});
        S.paused = false;
        if (S.captureNode) S.captureNode.port.postMessage({ type: 'config', mute: false });
      } else {
        S.mediaEl.pause();
        S.paused = true;
        // Silence the stream instead of tearing it down, so the phone's
        // buffer simply runs dry of new audio and playback stops cleanly.
        if (S.captureNode) S.captureNode.port.postMessage({ type: 'config', mute: true });
      }
      updateTransport();
    });
    els['btn-loop'].addEventListener('click', () => {
      S.loop = !S.loop;
      if (S.mediaEl) S.mediaEl.loop = S.loop;
      els['btn-loop'].setAttribute('aria-pressed', String(S.loop));
    });

    els.latency.addEventListener('input', () => {
      S.latencyMs = Number(els.latency.value);
      els['latency-out'].textContent = `${S.latencyMs} ms`;
      send({ type: 'control', targetMs: S.latencyMs });
    });
    els['phone-vol'].addEventListener('input', () => {
      S.phoneVolume = Number(els['phone-vol'].value) / 100;
      els['vol-out'].textContent = `${els['phone-vol'].value}%`;
      send({ type: 'control', volume: S.phoneVolume });
    });
    els.batch.addEventListener('input', () => {
      S.batchMs = Number(els.batch.value);
      els['batch-out'].textContent = `${S.batchMs} ms`;
      if (S.captureNode) S.captureNode.port.postMessage({ type: 'config', batchMs: S.batchMs });
    });

    document.addEventListener('visibilitychange', () => {
      // Audio keeps running in a background tab; nothing to pause.
    });

    // OSC-style control from the relay is out of scope; keep settings local but
    // mirror them on the phone page through the query string when scanning.
    connect();
    loadInfo();

    // Diagnostics handle — used by the E2E suite and handy in DevTools.
    window.__phoneSpeaker = { state: S, log };

    // ?source=mic|tab|file&autostart=1 lets you open a pre-configured page
    // (handy as a desktop shortcut / kiosk link, and for automated tests).
    const params = new URLSearchParams(location.search);
    const wantSource = params.get('source');
    if (wantSource && ['mic', 'tab', 'file'].includes(wantSource)) {
      pickSource(wantSource);
      if (params.get('autostart') === '1' && wantSource !== 'file') {
        // Wait for the relay socket, then start.
        const tryStart = () => (S.wsOpen ? start() : setTimeout(tryStart, 100));
        tryStart();
      }
    }
    els['net-dot'].dataset.state = 'idle';
    els['net-text'].textContent = 'connecting…';
    renderStats();
    updatePhonePanels();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();
