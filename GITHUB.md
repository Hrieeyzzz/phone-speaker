# 📱🔊 Phone Speaker — Full Project Description & GitHub Setup

> **Turn your phone into a wireless speaker for your PC or laptop.**
> Run a tiny server on your computer, scan a QR code with your phone, and everything your computer plays comes out of your phone — no app install on the phone, no cables, no Bluetooth pairing.

---

## 1. Project overview

| | |
|---|---|
| **Name** | Phone Speaker |
| **Type** | Local-network audio streaming app (web app + Node.js relay) |
| **Runs on** | Computer: Node.js 18+ · Phone: any modern browser (Chrome / Safari / Firefox / Edge) |
| **Connection** | Same Wi-Fi network; phone opens a plain URL (zero install) |
| **Audio format** | 48 kHz · 16-bit · stereo PCM, batched every ~20 ms |
| **Latency** | ≈ 0.2–0.5 s end-to-end (adjustable jitter buffer, default 150 ms) |
| **License** | MIT |

### Features

- 🔊 **Three audio sources** — tab/system audio (via `getDisplayMedia`), audio files (the phone becomes the *only* speaker), or the microphone.
- 📲 **Zero install on the phone** — scan the QR code → tap ▶ Start → done.
- 🎛 **Live controls** — volume (both ends), latency/jitter-buffer slider, pause, loop, seek, "also play on this computer" monitor toggle.
- 📊 **Live diagnostics** — bitrate, bytes sent, network RTT, phone buffer depth, dropped-frame warnings, glitch counter.
- 📡 **Multi-phone** — one computer can stream to several phones at once.
- 🔁 **Adaptive jitter buffer** — AudioWorklet ring buffer with hysteresis priming, underrun recovery and automatic resampling when the two devices' audio clocks differ (44.1 vs 48 kHz).
- 🔒 **HTTPS built in** — auto-generated self-signed certificate (port 3443) so screen/tab capture and microphone work over the LAN.
- 🧪 **Tested** — `npm test` (8 protocol/relay assertions) + `npm run test:e2e` (20 real-Chromium end-to-end assertions covering the full audio pipeline).

### How it works

```
┌─ PC browser ───────────────┐      ┌─ Node server (this PC) ─┐      ┌─ Phone browser ───────────┐
│ tab/system/file/mic audio  │ PCM  │ WebSocket relay         │ PCM  │ jitter buffer + worklet   │
│ → AudioWorklet (48 kHz)    │ ───► │ 1 sender → N receivers  │ ───► │ resample → speakers       │
└────────────────────────────┘ 20ms └─────────────────────────┘ 20ms └─────────────────────────────┘
```

1. The computer captures audio in a Web Audio **AudioWorklet** and converts it to 16-bit PCM batches.
2. Batches travel over a **WebSocket** to a tiny Node.js relay server (HTTP + HTTPS).
3. The phone receives them into a second **AudioWorklet** — a ring "jitter buffer" that smooths Wi-Fi jitter, resamples clock differences, and plays with ~150 ms of buffer.

### Repository structure

```
phone-speaker/
├── server.js              # HTTP/HTTPS static server + WebSocket relay
├── package.json           # dependencies: ws, qrcode, selfsigned
├── start.bat              # Windows one-click launcher
├── start.sh               # macOS/Linux one-click launcher
├── README.md              # user guide & troubleshooting
├── GITHUB.md              # this file — description + GitHub setup
├── .gitignore             # keeps node_modules/ out of the repo
├── relay-test.js          # headless protocol/relay tests (8 checks)
├── tests/
│   ├── e2e.js             # full browser E2E tests (20 checks)
│   ├── make-wav.js        # generates the test audio file
│   └── test.wav
└── public/
    ├── index.html         # computer page (source picker, QR, stats)
    ├── app-pc.js          # capture, sender, UI logic
    ├── pc.css
    ├── phone.html         # phone page (play, meter, controls)
    ├── app-phone.js       # receiver, buffer UI, visualizer
    ├── phone.css
    ├── pcm-capture.js     # AudioWorklet: audio → PCM batches
    └── pcm-player.js      # AudioWorklet: jitter buffer + resampler
```

---

## 2. Quick start (for anyone cloning the repo)

```bash
git clone https://github.com/<USERNAME>/phone-speaker.git
cd phone-speaker
npm install
npm start          # or double-click start.bat on Windows
```

Open the printed URL on the computer, scan the QR code with the phone (same Wi-Fi), tap **▶ Start** on the phone, then pick a source on the computer. Full instructions: [README.md](README.md).

**Environment variables:** `PORT` (default `3000`), `HTTPS_PORT` (default `3443`).

**Tests:**

```bash
npm test           # protocol/relay tests — no extra dependencies
npm run test:e2e   # browser tests — run once: npm i -D playwright && npx playwright install chromium
```

---

## 3. Start a new GitHub repository & connect this project

Follow this once to push the project to GitHub. Two methods — pick one.

### Method A — easiest, with the `gh` CLI

```bash
# 1. Install the GitHub CLI: https://cli.github.com/  (then: gh auth login)

# 2. From inside the project folder — create repo + connect + push in one step:
cd phone-speaker
gh repo create phone-speaker --public --source=. --push
```

Done — the repo now exists at `https://github.com/<USERNAME>/phone-speaker` and is connected (`origin`) with the code pushed.

### Method B — manual, only `git` + the website

```bash
cd phone-speaker

# 1. (One time only) tell git who you are
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"

# 2. Create the repository (empty — no README) on https://github.com:
#    → "+" → "New repository" → name: phone-speaker → Public/Private → "Create repository"
#    ⚠️ do NOT tick "Add a README file" (we already have files)

# 3. Initialise, stage and commit
git init -b main
git add .
git commit -m "Initial commit: Phone Speaker — use your phone as a wireless PC speaker"

# 4. Connect your local project to the GitHub repo ("connect" step)
git remote add origin https://github.com/<USERNAME>/phone-speaker.git

# 5. Push
git push -u origin main
```

**Authentication (first `git push` only):** GitHub no longer accepts account passwords. When prompted:

- *Username:* your GitHub username
- *Password:* a **Personal Access Token** — create one at
  **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**
  with permission **Contents: Read and write** for the `phone-speaker` repository.
  (Classic tokens need the `repo` scope.) Keep it secret; revoke it any time from the same page.

**SSH alternative:** instead of the `https://…` remote you can use `git@github.com:<USERNAME>/phone-speaker.git` after adding an SSH key (`gh auth login` can set this up for you).

### After it's connected — everyday workflow

```bash
git add -A
git commit -m "Describe your change"
git push
```

---

## 4. Section to paste into your README (optional)

After the repo exists, copy this block into **README.md** — right after the intro — and replace the placeholders:

```md
## 🌐 Repository

[![GitHub repo](https://img.shields.io/badge/GitHub-<USERNAME>/phone-speaker-181717?logo=github)](https://github.com/<USERNAME>/phone-speaker)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Source:** https://github.com/<USERNAME>/phone-speaker

### Clone & run

​```bash
git clone https://github.com/<USERNAME>/phone-speaker.git
cd phone-speaker
npm install
npm start
​```

Issues and PRs welcome: https://github.com/<USERNAME>/phone-speaker/issues
```

> Replace `<USERNAME>` with your GitHub username everywhere. The badges render on github.com (they load from shields.io).

---

## 5. Checklist before the first push

- [ ] `node_modules/` excluded — handled by the included `.gitignore`
- [ ] Repo created **without** a README/`.gitignore` (Method B step 2)
- [ ] First push uses a **token** (or SSH), not your account password
- [ ] Secrets never committed — this project ships with none; keep it that way (no tokens, no `.netrc`)
- [ ] CI (optional): add a workflow later, e.g. `on: push → runs-on: ubuntu-latest → npm ci && npm test`
