# DevDeck

Drive the omp coding agents and shells running in tmux on this PC from an Android phone,
over a slow, laggy link. Read the agents' conversations as a chat, answer their questions
with native controls, watch the raw terminal when needed, browse files and git changes,
and send the PC files, photos and shared text.

The phone usually reaches the PC over Tailscale relayed through DERP (UDP blocked): round
trips of 0.5 to 5 s. ssh/mosh echo every keystroke across that link and are unusable. DevDeck never
sends keystrokes while you type. You compose a whole message on the phone, and it travels
in one piece over one persistent TCP connection. The PC sends back only what changed:
- new transcript entries, read straight from omp's session files;
- or changed screen lines.

Everything is zlib-compressed. Whatever you send while the link is down waits in an offline
queue on the phone and is delivered exactly once when the link returns.

DevDeck is the successor of PhoneDeck (`../phonedeck`). The two are independent: different
port (47490 vs 47480), package (`dev.devdeck` vs `dev.phonedeck`), token, state directory
and systemd unit. Both can run at the same time.

## Requirements

- PC:
  - Linux with Python 3.10+ (stdlib only), tmux and git.
  - `wl-copy` (wl-clipboard) for the clipboard; `notify-send` is optional.
  - omp for the agents.
  - To build the app: `adb` (`android-tools`), a JDK and `bun` (for the web UI). The
    Android SDK is reused from `../phone_synaptic_trackpad/.sdk`.
- Phone: Android 8+ (developed on Android 13), with USB or wireless debugging enabled for
  pairing.

## Setup

```sh
./devdeck.py pair              # builds the app, installs it via adb, shares a random token
./devdeck.py install-service   # systemd user service, starts with the graphical session
```

**Which phone.** `pair` uses adb's only device. If several are connected it uses
`100.64.0.2:5555`; pass `-s SERIAL` to choose another. `--rebuild` rebuilds the APK first.
The build is `android/build.sh`:
1. It runs the web build (`cd web && bun install --frozen-lockfile && bun run build` →
   `android/assets/web/`).
2. It runs `aapt2` (resources plus `-A assets`), `javac`, `d8`, `zipalign` and `apksigner`
   (debug key), with no Gradle.
3. It writes `devdeck.apk`, and fails loudly if the web build fails.

**Token and addresses.** On first run `pair` creates `~/.config/devdeck/token` (mode 600).
It starts the app with the token, the port and every reachable IPv4 address of the PC: LAN
addresses first, the Tailscale address last. The equivalent command is
`am start -n dev.devdeck/.MainActivity --es token T --es hosts a,b --ei port 47490`. The
phone dials all addresses in parallel and keeps whichever answers first.

**Firewall.** If ufw is active, allow the port on the LAN interfaces once, e.g.
`sudo ufw allow in on wlan0 to any port 47490 proto tcp`. `pair` prints the exact lines.

**Permissions.** `pair` also:
- grants the notification permission;
- exempts DevDeck from battery optimisation (`dumpsys deviceidle whitelist +dev.devdeck`),
  so Doze does not cut its network or delay its alarms while the screen is off. Background
  notifications depend on this.

Logs: `journalctl --user -u devdeck.service -f`

## Using it on the phone

### Top bar

From left to right:
- **Hamburger**: opens the terminals drawer. It shows a red dot when another terminal is
  asking or finished unseen.
- **Status badge and terminal name**, with the terminal's context line underneath. Tap it
  to open the drawer.
- **Chat/terminal toggle**: only on agent panes.
- **Link pill**: the dot is green when online, amber and pulsing while connecting, red when
  offline, grey when idle and hollow when unpaired. The pill also shows the round-trip time
  and an amber count of queued items. Tap it for details.
- **Overflow menu**: Files, Git, Chat/Terminal view, Keep screen awake, Notifications,
  Resync and New terminal.

A thin progress bar under the top bar shows a running upload.

### Terminals drawer

Open it by swiping right from the left edge, or by tapping the hamburger or the title. Close
it by swiping left, tapping outside it, or pressing Back.

Every tmux pane gets one row:
- its badge;
- session and window name, and the `W.P` index;
- its context (the title omp or the shell sets, e.g. `📋 PROC: List running apps`);
- its working directory.

| Badge | Meaning |
|---|---|
| spinner | omp is working |
| red **?** | omp is asking you something |
| green check | omp finished while you were looking elsewhere (clears when you open it) |
| **π** | omp is idle |
| **▶** | some other program is running |
| **$** | plain shell |

"New terminal" creates its own tmux session (`phone-1`, `phone-2`, …, lowest free number)
running your shell in `~`, and opens it in the terminal view. Close it by typing `exit`.

### Chat view

This is the default for agent panes. It renders omp's own session file, not the screen.
- **Your messages** appear as bubbles on the right.
- **Assistant text** is rendered as markdown:
  - tables scroll sideways;
  - code blocks have a Copy button;
  - KaTeX math is rendered;
  - mermaid diagrams render lazily;
  - ```` ```svg ```` blocks are drawn inline.
- **Thinking** sections are collapsible.
- **Tool calls** are compact rows showing status, tool name and intent. Tap one to expand
  its input and output. Long outputs are cut on the PC; "Show full ..." fetches the
  untruncated text.
- **Compaction** shows as a summary card. Errors, aborted turns and `!command` runs show as
  notices.
- **History**: scrolling up loads older history in pages of 60. The view follows the bottom
  unless you scroll up; a "Latest" / "N new" pill jumps back.
- **Working row**: while omp works, an animated row shows its context.
- **Pending sends** appear as dashed bubbles until the PC acknowledges them. A failed send
  offers Retry and Dismiss.
- **Cache**: the last transcript of each terminal is cached, so reopening a terminal is
  instant. A "Cached" chip shows until live data arrives.

### Terminal view

Used for shells, or toggled on for agent panes. It shows the plain monospace screen with
300 lines of scrollback:
- no wrapping; scroll sideways;
- pinch to zoom (the font size is remembered).

The quick keys are ↑ ↓ ␣ ⏎ Esc Tab, then ← → ^C ^D PgUp PgDn. ^C and ^D need a second tap
within 1 s (the button turns red when armed). Quick keys are sent immediately and never
queued: a stale ^C delivered minutes later would be harmful.

### Compose bar

- **Paperclip**: picks files, which are uploaded to `~/Downloads/phone/`.
- **Input**: multi-line, with a separate draft for each terminal.
- **Send**: pastes the text (as a bracketed paste, so newlines do not submit early) and then
  presses Enter. Long-press Send to paste without Enter. Send with an empty box just presses
  Enter.

### Answering questions

When the watched agent calls omp's `ask` tool, a bottom sheet opens. For each question it
shows:
- the header chip and the question text;
- the options with their descriptions, and a Recommended badge;
- radio buttons (single choice) or checkboxes (multi choice);
- "Other" with free text, and an optional "Add note".

Submit is enabled once every question has an answer. It shows "Answering in the
terminal...", then closes with "Answer sent", or shows the PC's error with Retry.

A dismissed sheet leaves a red "? question ... Answer" banner above the compose bar. Agents
asking in other terminals show a red ? in the drawer; tapping one opens the terminal and the
sheet.

The answer is typed into omp's question dialog by the PC (see "How it works"). It is
refused when:
- the question is no longer open (answered on the PC, cancelled, or the turn moved on);
- the omp prompt on the PC holds an unsent draft. omp then shows "Finish or clear the
  current prompt to answer", and every key would go into that draft. Clear the draft on the
  PC (or from the terminal view) and retry.

### Notifications

While DevDeck is in the background (or you are looking at another terminal), it notifies
you when:
- **an agent asks a question**: high priority, "‹session› needs you" plus the first
  question;
- **an agent finishes a turn** (working → idle): "‹session› finished" plus its context.

Each terminal has at most one notification, and it is cancelled when you open that
terminal. Tapping it opens the terminal. The channels are "Connection" (low, ongoing),
"Agent questions" (high) and "Agent finished" (default). Notifications can be switched off
in the overflow menu.

### Files and Git

**Files** (overflow menu) starts in the watched pane's working directory:
- breadcrumbs, where the home icon is `~`, plus an Up button;
- an eye icon toggles hidden files;
- text files open syntax-highlighted with line numbers, a wrap toggle and Copy;
- Markdown is rendered (with a toggle to the source);
- images and SVG are shown (tap to zoom 1:1).

Only paths inside your home directory are reachable. Text views are capped at 1 MB and
images at 8 MB.

**Git** opens from the overflow menu, or from the git icon in the Files header inside a
repo. It shows the branch, upstream and ahead/behind counts, plus two tabs:
- **Changes**: Staged, Changes and Untracked lists. Tap a file for a unified diff with line
  numbers and colours, with an Unstaged/Staged switch; untracked files open in the viewer.
  "All changes" and "All staged" show repo-wide diffs, capped at 1.5 MB.
- **Log**: the last 50 commits.

Git access is read-only: DevDeck never stages, commits or takes git's index lock.

### Share sheet, uploads and the offline queue

- **Sharing to DevDeck**:
  - Files and photos are queued for upload to `~/Downloads/phone/`. A desktop notification
    announces each one, and name clashes get ` (2)`, ` (3)`, ...
  - Text offers "Paste" or "Paste + Enter" into a terminal you pick, or "PC clipboard".
    Pasting also makes that terminal the one DevDeck shows next.
- **Offline queue**: messages, answers, clipboard texts and uploads stay on the phone until
  the PC acknowledges them, and are resent in order after every reconnect. The PC
  remembers delivered ids, so a resend after a lost acknowledgement is never executed
  twice. Uploads resume where they stopped.

### Battery and the screen-off link

- **While DevDeck is visible** the link is live (the PC drops a visible client after 75 s
  of silence). The app holds a
  partial CPU wakelock and a Wi-Fi lock so the link survives the screen turning off. Turn
  this off with "Keep screen awake" in the overflow menu (on by default). The locks are
  also held while something is uploading or queued.
- **When you leave the app** it sends `pause` and releases the locks (unless uploading or
  queued). The PC then stops streaming screens and transcripts.
  - With notifications on, the link stays open. The PC sends `sessions` only when some
    terminal's state or question changes, which is what notifications need. The app pings
    every 10 minutes with an exact alarm that works in Doze. The phone considers the link
    dead after 25 minutes of silence; the PC drops a paused client after 30 minutes.
  - With notifications off, the link closes 2 minutes after you leave. Nothing runs
    until you return or queue something.
- **Reopening** shows the cached transcript or screen at once, and catches up with just the
  difference.

## Options

- `--port`: TCP port, default 47490. It goes before the subcommand, e.g.
  `./devdeck.py --port 47499 serve`.
- `--dest DIR` (`serve`, `install-service`): where uploads go. Default `~/Downloads/phone`.
- Environment:
  - `XDG_CONFIG_HOME` / `XDG_STATE_HOME` move the token and state directories.
  - `DEVDECK_OMP_DIR` (default `~/.omp/agent`) is where omp's `terminal-sessions/`
    breadcrumbs are read. Useful for tests that must not touch the real ones.

## How it works

### Daemon (`devdeck.py serve`)

**Connections.** The daemon runs a thread per connection. Each control connection has:
- a reader for client messages;
- a writer that owns the zlib stream and sends only what changed against what it last
  *wrote*.

On a slow link the writes block, intermediate states are skipped, and no backlog builds up.
Requests (`ls`, `read`, `git`, `more`, `full`) run in small worker threads, at most 3 per
connection.

**Panes** are polled once every 2 s, for all clients together, and only while a client is
connected. One poll is a single `tmux list-panes -a`:
- An agent pane is recognised by omp's terminal title `π[-profile] [spinner] <context>`.
  It is working while the braille spinner is present.
- `asking` comes from the session file: an `ask` tool call has a `tool_execution_start`
  marker but no result yet, and nothing newer is on the branch. When there is no session
  file, the daemon falls back to looking for omp's question box at the bottom of the
  screen.
- The pending question itself is included in the pane as `ask`.

**Finding a pane's session.**
1. `#{pane_tty}` `/dev/pts/N` leads to omp's breadcrumb `~/.omp/agent/terminal-sessions/pts-N`.
2. Line 2 of the breadcrumb is the session JSONL path.
3. The breadcrumb only counts if it was written after the pane's shell started, because pts
   numbers are recycled.
4. It is re-read on every poll, so `/new` or `/resume` in omp switches the chat view
   (with a reset).

**Transcript engine.** One parser per session file is shared by every connection and the
pane poller.
- It tails the JSONL incrementally, keyed by (inode, size). A changed inode or a shrink
  means a full reparse and a client reset. Only complete lines are consumed.
- It keeps one small node per entry (id, parent, file offset, kind), not the content.
  Entries are converted on demand by re-reading their line, with a small cache.
- The current branch is the `parentId` walk from the last line. Only entries after the last
  `reset_boundary` (`/clear`) are shown.
- Appends extend the branch. Moving to another branch (`/tree`), a `/clear`
  or a rewrite bumps a generation counter, and clients get `reset:true` with the last 60
  entries.
- Tool results are folded into the assistant entry that made the call. When a result
  arrives later, that entry is sent again with the same `seq`.
- Caps: text 50 000 chars, thinking 4000, tool arguments 600, tool results 3000. The
  `full` request returns untruncated text, up to 2 MB.
- Not shown: usage, credential, title, label, model and thinking-level entries, the system
  prompt digest, todo HUD state, developer messages and hidden custom messages.

**Answering a question.** The daemon types the answer into omp's dialog with
`tmux send-keys`, so it works with any running omp and needs no omp extension.
1. **Checks.** The tool-call id must still be the pending ask in the session file, and the
   screen must not show the draft trap or an open text box.
2. **Keystrokes.** Each question is answered in order:
   - The daemon first reaches the wanted row with Up × (options+1), then Down × index, so
     the result does not depend on where the cursor started.
   - Single choice: optional note (`n`, text, Enter), then Enter.
   - Multi choice: Space on each selected row, then Enter.
   - Custom answer: the "Other" row, then Enter/Space, the text, Enter.
   - With several questions, or a multi-choice question, a final Enter on the Submit tab.
3. **Pacing.** Keys go in batches of up to 6 with 40 ms pauses, and 150 ms around text
   boxes, because omp opens and closes those asynchronously.
4. **Result.** Success means the `toolResult` for that call appears in the session file
   within 8 s. Otherwise the answer fails with the last 15 screen lines.

**Messages, keys, clipboard.**
- Messages go in with `tmux load-buffer` and `paste-buffer -p`, plus `send-keys Enter`.
- Quick keys use `send-keys`; key names are validated.
- The clipboard is set with `wl-copy`.

**Files and git.**
- Paths are resolved with symlinks followed and must stay inside `$HOME`.
- git runs with `--no-optional-locks`: `status --porcelain=v2 --branch -z`,
  `diff [--cached] [-- file]` (untracked files as `--no-index` against `/dev/null`), and
  `log -n 50`.

**State on disk.**
- Delivered ids (last 2000) are kept in `~/.local/state/devdeck/seen.json`.
- Partial uploads live in `~/.local/state/devdeck/partial/` until complete.

### App (`android/`, `web/`)

- **Shell**: a plain Java shell (no Gradle). A foreground service owns the connection
  (happy-eyeballs dial of all PC addresses), the offline queue, uploads, the wakelock and
  notifications.
- **UI**: a single-page web app (`web/`, built with bun) shown in a WebView. The assets
  are served from `https://appassets.androidplatform.net/web/index.html`; no remote content
  is loaded and links open externally.
- **Bridge**:
  - The UI talks to the shell through `window.DD`: `send` for live messages, `enqueue` for
    queued ones, plus `pickFiles`, `setWakelock`, `setNotify`, `copyText`, `openUrl`,
    `haptic`, `ready` and `backResult`.
  - The shell delivers every server message, plus local `link`/`toast`/`open`/`back`
    events, to `window.dd.receive`.
  - Hardware Back closes, in order: the menu, the question sheet, viewers and panels, the
    drawer. Otherwise the app goes to the background.

## Wire protocol

TCP port 47490, one JSON object per `\n`-terminated line.

**Framing.** The client sends
`{"t":"hello","token","client","target","view":"chat"|"term","paused","have"?}`. The PC
answers `{"t":"welcome","server":"devdeck","version":1}` in plain text. After that,
everything from the PC is one zlib stream, flushed (`Z_SYNC_FLUSH`) after every message.
Client → PC lines stay plain.

**Client → PC**

| Group | Messages |
|---|---|
| Live | `watch {target, view}`, `pause`, `resume`, `resync`, `ping {ts}`, `keys {target, keys[]}`, `new {}` (→ `created {target:"phone-N:W.P"}`) |
| Queued (carry `id`, always answered by `ack {id, ok, error?}`, deduplicated) | `send {target, text, enter}`, `clip {text}`, `answer {target, toolCallId, answers:[{qid, selected[], custom?, note?}]}` |
| Requests (carry `req`, answered with the same `req`, or `error {req, error}`) | see below |

Requests:
- `more {target, before}` → `transcript {prepend:true, entries, hasMore}`.
- `full {target, entryId}` → `full {entryId, text}`. `entryId` is one of:
  - a tool call id: its result;
  - `<toolCallId>:args`: the call's arguments;
  - `<entryId>:thinking`: the entry's thinking;
  - an entry id: its text.
- `ls {path}` → `ls {path, parent, entries:[{name, type, size, mtime(ms), linkTo?}]}`.
- `read {path}` → `read {path, size, mime, kind:"text"|"image"|"binary", text?|data?, truncated}`.
- `git {path, op:"status"|"diff"|"log", file?, staged?}`.

**PC → client**

- **`sessions {list}`**: on connect and on change. While paused, it is sent only when a
  pane's `state` or `ask` changes. Each pane has:
  - `target`, `session`, `window`, `pane`, `name`, `cmd`, `cwd`;
  - `title`: the spinner glyph is frozen to `⠿`, so animation does not resend the list;
  - `state`: `working`, `asking` or `idle` for omp; `shell` or `running` otherwise;
  - `context`, `agent`, `sessionId?`;
  - `ask?`: `{toolCallId, questions:[{id, header?, question, options:[{label, description?, preview?}], multi, recommended?}]}`.
- **`transcript {target, sessionId, reset, entries, hasMore}`**: chat view only, not while
  paused.
  - Every entry has `{seq, id, kind, ts(ms)}`.
  - `user` adds `text`.
  - `assistant` adds `text?`, `thinking?`, `tools[{id, name, intent?, args, result?{text, truncated, isError}}]`,
    `model?`, `stopReason?` and `errorMessage?`.
  - `compaction` adds `summary`.
  - `notice` adds `text`.
  - Truncation is flagged by `textTruncated`, `thinkingTruncated` and `argsTruncated`.
- **`screen`**: term view only, not while paused, at most 4/s. It is either `full` with all
  `lines`, or a diff against `base` rev: the new `len` plus changed `[index, text]` pairs.
  `have` in `hello` lets a reconnect continue with a diff.
- **Other replies**: `created`, `ack`, `pong`, `error {error, req?}`, `full`, `ls`, `read`,
  `git`.

**Upload** (separate connection):
1. The client sends `{"t":"upload","token","id","name","size"}`.
2. The PC answers `{"t":"resume","offset":N}`.
3. The client sends the raw bytes from N to `size`.
4. The PC answers `{"t":"done","path":...}`.

## Limits

- **No extra encryption**: rely on Tailscale (WireGuard) or a trusted LAN. The token only
  authenticates.
- **Answering assumes a fresh dialog.** It assumes omp's dialog shows its first question,
  as when it opens:
  - If someone already switched tabs or ticked options on the PC, the typed answer can land
    wrong; answer there instead.
  - Newlines and tabs in custom answers and notes become spaces, because Enter would
    submit the text box early.
  - The keystroke recipe follows omp v18.12's `ask` dialog and may need updating if omp
    changes it.
- **Chat view coverage**: it shows what omp has written to its session file. omp writes
  complete messages only, so a streaming reply appears when it is finished; meanwhile the
  working row and the terminal view show progress. Subagent transcripts are not shown.
- **Terminal view**: plain text only, without colours or attributes, and wrapped lines are
  joined. Full-screen TUIs that redraw everything work, but every redraw costs a full
  screen.
- **One watched pane per connection.** The clipboard needs a Wayland session.
