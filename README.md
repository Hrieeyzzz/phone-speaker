# Phone Speaker

Turn a phone into a speaker for the computer on the same network. The server reads the computer's **output mix**, so games, music, videos and other applications all use the same stream. There is no browser source picker. The phone needs no app, but browsers require a tap to start playback.

## Get started

1. Install Node.js 18+ and a system **ffmpeg with the appropriate input devices**. Configure your operating system's output monitor as described below.
2. On the computer, run:
   ```sh
   git clone https://github.com/Hrieeyzzz/phone-speaker.git
   cd phone-speaker
   npm install
   npm start
   ```
   `start.bat` and `start.sh` are also available.
3. Open the computer URL printed in the terminal. Check that **Computer output** is live, and play something on the computer.
4. Connect the phone to the same Wi-Fi, scan the QR code, accept the local certificate warning if prompted, and tap Play. Adjust the phone's volume and jitter buffer as needed.

The capture runs on the machine running Node, not on a remote browser visiting the computer page. The phone receives 48 kHz, 16-bit stereo PCM over WebSocket. Typical latency is hundreds of milliseconds and depends on the OS, network and phone; it is not synchronized with the computer's speakers.

## Operating system setup

FFmpeg must be installed separately; it is not bundled. Check `ffmpeg -version` and `ffmpeg -devices`. A build without the relevant input device cannot capture audio.

- **Windows:** FFmpeg's DirectShow input needs a loopback device. Install [screen-capture-recorder](https://github.com/rdp/screen-capture-recorder-to-video-windows-free) (its `virtual-audio-capturer`) or enable Stereo Mix if your driver supports it. Alternatively install VB-CABLE and configure Windows output routing so the mix is sent to the cable; use Windows Listen/monitoring or a mixer if you also want local speaker playback. Ensure the device is enabled and visible to FFmpeg. Restart the server or use Retry output after setup.
- **macOS:** Install [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole), then use Audio MIDI Setup to create a Multi-Output Device containing BlackHole and your speakers. Select that as the system output; grant audio access if macOS prompts. FFmpeg must include `avfoundation`.
- **Linux:** Run PulseAudio or PipeWire's PulseAudio compatibility server, install `pactl` (often `pulseaudio-utils`) and an FFmpeg build with `pulse` input. The default output sink's monitor is selected automatically. The default microphone is never used as a fallback.

If automatic discovery doesn't find your monitor, open **Output setup and troubleshooting** and refresh the device list. Only recognized output monitors/loopbacks are offered. The selection is stored locally in `.capture.json`. Test output checks the live stream; a silent peak can simply mean nothing is currently playing.

## Troubleshooting

- **Output unavailable:** Read the message on the computer page, verify ffmpeg and OS setup above, then retry. Some static FFmpeg builds omit PulseAudio or other input devices. Use a full system build instead.
- **No sound:** Play audio on the computer, check the output level and routing, tap Play on the phone and check its volume. Some virtual drivers need explicit routing as described above.
- **QR or connection fails:** Both devices must be able to reach one another on the same network; allow the Node process through the computer's firewall. Guest Wi-Fi and client isolation can prevent this.
- **Certificate warning:** HTTPS uses a locally generated self-signed certificate. The phone must accept it. HTTP may work with a less capable audio fallback; HTTPS is recommended for AudioWorklet.
- **Glitches:** Improve Wi-Fi reception or increase the phone buffer. PCM uses approximately 1.5 Mbit/s per phone.

## Configuration

| Variable | Meaning |
| --- | --- |
| `PORT`, `HTTPS_PORT` | Listener ports (defaults 3000 and 3443) |
| `NO_HTTPS=1` | Disable HTTPS |
| `FFMPEG_PATH` | Path to an FFmpeg executable |
| `CAPTURE_FORMAT`, `CAPTURE_INPUT` | Override automatic device discovery with an FFmpeg input format and input. Intended for advanced setups and testing. |
| `CAPTURE_EXTRA` | Whitespace-separated FFmpeg input options (advanced) |
| `PHONE_SPEAKER_URL_FILE` | Write startup URLs to a JSON file |

For a hardware-free pipeline test, start with `CAPTURE_FORMAT=lavfi CAPTURE_INPUT=sine=frequency=440:sample_rate=48000 npm start`. This produces a test tone, **not** the computer's audio.

## Privacy and security

The server listens on all network interfaces. Audio is available to clients that connect to the relay, and there is no authentication or end-to-end encryption. Use only on a trusted private network; do not expose the service to the public internet. HTTPS protects transport when the certificate is accepted, but does not restrict who can connect. Stop the server when not in use.

## Tests

`npm test` runs relay and synthetic FFmpeg capture integration tests; the capture test skips when FFmpeg is missing. These do not validate real OS audio routing or drivers. For browser tests, run `npm install --no-save playwright-core`, then `npx playwright-core install chromium` (or set `CHROME_PATH` to an existing Chromium executable), and run `npm run test:e2e`. Real device behavior must be verified on each target OS.

MIT License. Copyright (c) 2026 Hrieeyzzz.
