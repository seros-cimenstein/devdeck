# DevDeck

An Android app for supervising omp AI coding agents (and plain shells) running in tmux on a
Linux PC, from a phone, over a slow and laggy link.

## Why

The phone usually reaches the PC over Tailscale relayed through DERP, with round trips of
0.5 to 5 s. ssh/mosh echo every keystroke across that link and are unusable. DevDeck never
sends keystrokes while you type: you compose a whole message on the phone and it travels in
one piece over one persistent, zlib-compressed TCP connection. The PC sends back only what
changed (new transcript entries read straight from omp's session files, or changed screen
lines). Anything sent while the link is down waits in an offline queue on the phone and is
delivered exactly once when the link returns.

## Features

- **Terminals drawer**: every tmux pane with a status badge (omp working, asking, finished,
  idle, other program, shell); new terminals; restore checklist for sessions cut off mid-turn.
- **Chat view** of omp sessions rendered from the session file: markdown, scrollable tables,
  code with Copy, KaTeX math, mermaid and inline SVG diagrams (full-screen zoom), collapsible
  thinking, compact tool-call rows, paged history, cached per terminal.
- **Native omp controls**: model hub (search, roles, details), thinking level, plan review,
  `/btw`, rewind/tree, session info and settings, without opening omp's terminal pages.
- **Answering questions**: omp's `ask` tool opens a native bottom sheet (single/multi choice,
  "Other", notes); the PC types the answer into omp's dialog.
- **Terminal view**: plain-text screen with scrollback, pinch zoom and quick keys (^C/^D need
  a confirming second tap).
- **Compose bar** with per-terminal drafts that survive app restarts and a flat battery.
- **Voice mode**: Android speech recognition in; replies synthesised on the PC by omp's local
  Kokoro TTS and sent to the phone as Ogg/Opus; spoken answers to questions (English or Turkish).
- **Live calls**: GPT Live voice calls over WebRTC through omp's ChatGPT login,
  talking either to a small "concierge" omp session that oversees all terminals via `ddctl`,
  or directly to one terminal's agent.
- **Notifications** when an agent asks a question or finishes a turn.
- **Files and Git**: read-only file browser (home directory only) and git status, diffs and
  log. DevDeck never stages or commits.
- **Share sheet and uploads**: share files/photos/text from other apps; uploads resume after
  disconnects and land in `~/Downloads/phone/`.

## Architecture

| Part | Path | What it is |
|---|---|---|
| Daemon | `devdeck.py` | Python 3.10+ standard library only. Watches tmux panes and omp session files, serves the phone over TCP, types into panes, handles uploads, voice and Live call relay. Runs as a systemd user service. |
| `ddctl` | `ddctl` | Local CLI over the daemon's Unix control socket (used by the Live concierge). |
| omp extension | `omp-ext/devdeck/` | Links into `~/.omp/agent/extensions/`; exposes `/btw`, plan review and other state to the daemon over `127.0.0.1` with a per-run random token. |
| TTS worker | `tts_worker.ts` | Bun worker running omp's local Kokoro TTS runtime (CPU or CUDA). |
| Android shell | `android/` | Plain Java, no Gradle (`aapt2`, `javac`, `d8`, `apksigner` in `android/build.sh`). Foreground service owns the connection, offline queue, uploads, notifications and the WebRTC call. |
| Web UI | `web/` | TypeScript single-page app built with Bun, shown in a WebView from bundled assets (no remote content). |

The full manual (UI, options, internals, wire protocol, limits) is in
[`docs/manual.md`](docs/manual.md). Code comments that cite `README "<section>"` refer to
sections of that manual.

## Requirements

- PC: Linux, Python 3.10+, tmux, git, omp. `wl-copy` for the clipboard (Wayland);
  `notify-send` optional.
- Voice mode: `ffmpeg` with libopus, `bun`, and omp's Kokoro TTS runtime (installed by omp
  on its first `omp say`). An NVIDIA GPU with CUDA 12 / cuDNN 9 is optional.
- Live mode: omp logged in to ChatGPT (`openai-codex`) with a plan that includes GPT Live.
- Building the app: `adb`, a JDK, `bun`, and Android build-tools plus a platform
  `android.jar`. `android/build.sh` looks for them in `../phone_synaptic_trackpad/.sdk`
  (a sibling project of the author's), downloads them there (~150 MB) if missing, or uses
  `SDK` / `ANDROID_BUILD_TOOLS` / `ANDROID_JAR` if set. A pinned, checksum-verified libwebrtc
  AAR is downloaded from Maven Central on first build.
- Phone: Android 8+ with USB or wireless debugging enabled for pairing.

## Setup

```sh
./devdeck.py pair              # builds the app, installs it via adb, shares a random token
./devdeck.py install-service   # systemd user service; also links the omp extension
```

`pair` uses adb's only connected device, or `-s SERIAL`. It starts the app with the token,
the port and every reachable IPv4 address of the PC; the phone dials them all and keeps the
first that answers. If ufw is active, allow the port on your LAN/Tailscale interfaces only;
`pair` prints the exact lines.

A second, independent install ("DevDeck+", port 47491) can run next to the default one:

```sh
./devdeck.py --instance plus pair --rebuild
./devdeck.py --instance plus install-service
```

Logs: `journalctl --user -u devdeck.service -f`. Options and environment variables are
listed in the manual.

## Security model

- The daemon listens on TCP port 47490 (47491 for `--instance plus`) on **all interfaces**.
- Authentication is a single shared token: 32 random bytes generated by `pair` into
  `~/.config/devdeck/token` (mode 600) and handed to the app over adb. Every connection
  (control and upload) must present it in its first line; it is compared in constant time
  and the connection is closed otherwise.
- There is **no encryption** of its own. The token only authenticates. Transport security
  must come from the network: Tailscale (WireGuard) or a trusted LAN.
- Whoever holds the token can type into your terminals (which is shell access as your user),
  read files under your home directory, and upload files.
- **Do not expose the daemon to the internet.** Do not port-forward it; restrict it with a
  firewall to the LAN or tailnet interfaces.
- The software has not been security-audited.

## Status and limitations

- A personal tool, developed and tested on one setup: a Linux laptop and a Samsung Galaxy
  XCover Pro on Android 13.
- Answering questions and some omp controls read or drive omp's terminal UI and follow omp
  18.x's layout; they may need updating when omp changes.
- The chat view shows only what omp has written to its session file (complete messages, no
  subagent transcripts). The terminal view is plain text without colours.
- The clipboard needs a Wayland session.
- See "Limits" in the [manual](docs/manual.md#limits) for details.

## License

GPL-3.0. See [LICENSE](LICENSE).
