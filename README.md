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
  - Voice mode: `ffmpeg` with libopus, `bun`, and omp's local Kokoro TTS runtime, which omp
    installs on its first `omp say` (into `~/.omp/agent/cache/tts-runtime/`).
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

**Running a second instance ("DevDeck+").** `--instance NAME` (or `DEVDECK_INSTANCE=NAME`)
installs and runs a separate copy next to the normal one, sharing nothing but the tmux
sessions and omp:

```sh
./devdeck.py --instance plus pair --rebuild   # builds with DEVDECK_VARIANT=plus, installs "DevDeck+"
./devdeck.py --instance plus install-service  # devdeck-plus.service on port 47491
```

| | default | `--instance plus` |
|---|---|---|
| app package | `dev.devdeck` | `dev.devdeckplus` (activity `dev.devdeckplus/dev.devdeck.MainActivity`) |
| APK | `devdeck.apk` | `devdeck-plus.apk` (`DEVDECK_VARIANT=plus android/build.sh`) |
| token, state | `~/.config/devdeck`, `~/.local/state/devdeck` | `~/.config/devdeck-plus`, `~/.local/state/devdeck-plus` |
| unit, port | `devdeck.service`, 47490 | `devdeck-plus.service`, 47491 (unless `--port`) |

Uploads still go to `~/Downloads/phone/`. Without `--instance` everything behaves exactly as
before.

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

### omp controls in the chat view

A control strip drives the watched omp session natively. Every action runs live (disabled
offline, never queued), one at a time per terminal, and reports omp's own error text.
- **Model chip** (`Opus 5.5 · high`, plus ⚡ for the fast tier) opens the model sheet: search,
  your configured roles, every model grouped by provider. Pick a model, a thinking level it
  supports and Fast, then "Switch for this session" (omp's `/switch`: session only, the
  configuration is untouched). Changing only the level uses `/effort`. A link opens omp's
  own full model page (roles and defaults) as a live page.
- **Context meter** (used/window) and a **plan badge** while plan mode is on.
- **Session menu**: New session, Resume... (this directory's sessions with title, recap,
  live/current markers), Compact (optional focus), Clear context, Plan mode on/off, Retry
  last turn, Rename. Rename makes omp format the title with a small model call (an emoji and
  a category prefix are added).
- **Stop**: with an empty compose box while omp works, Send becomes Stop (one Escape). With
  text while working, Send steers; "Queue as follow-up" delivers it after the turn.
- **Tasks**: a `Tasks 3/7` chip shows omp's todo list.
- **Slash palette**: typing `/` lists the supported commands. Typed `/model x`, `/models x`
  and `/thinking x` are rewritten to omp's `/switch x` and `/effort x`, because omp would
  send a command with arguments it does not take to the model as a prompt.
- **Keys in chat**: a keyboard toggle shows the quick-key rows inside the chat view.

**Live omp pages.** omp's own interactive pages (the `/model` hub, `/settings`, the
`/resume` picker, `/tree`, the `/effort` picker, plan review, any overlay) can be opened from
the palette and are mirrored in a live panel inside the chat view: tap a row to move the
selection there, double-tap to also press Enter, use the arrow/Tab/Enter/Esc bar, or type to
filter. The panel closes when omp closes the page. Changes you make there (role
assignments, settings) are saved by omp as usual.

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
  Enter, except while omp works: a bare Enter would abort the turn, so the PC refuses it
  (use Stop).

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

### Voice mode

Talk to the agent and hear its replies, spoken on the PC by omp's local Kokoro voice.
- **Toggle**: the headset button in the compose bar (agent panes, chat view). A voice panel
  replaces the compose bar; its X or Back leaves voice mode. The screen stays on meanwhile.
- **Loop**: Listening (live transcript and a mic level ring) → Sending → Agent working
  (elapsed time and current activity) → Reply coming → Speaking (the current sentence is
  highlighted; tap the text or Stop to stop) → listening again ("Listen again" setting),
  else Your turn. Tap the mic any time to talk: while it speaks this stops the voice and
  listens; while it listens it finishes your utterance (as "Done" does). Recognised text is
  sent like a typed message; the spoken-style hint (on by default) appends "(voice mode:
  reply in short plain spoken sentences; no tables or code unless I ask)".
- **Questions**: the question sheet opens as usual, the question is read aloud ("omp asks:
  ... Options: one, ... two, ...") and then it listens. Say a number or ordinal (English or
  Turkish: "two", "the second one", "last", "recommended", "ikinci", ...), part of an
  option's label, several options joined by "and"/"ve"/commas, or "other ..." / "diğer
  ..." for your own answer; "cancel"/"iptal" stops answering by voice. The pick is ticked
  in the sheet, read back ("Picked X. Sending.") and sent as a normal answer. When nothing
  or several options match, the options are read again (three tries, then "answer on
  screen"). Several questions go one at a time.
- **Listen** button under every assistant reply (also outside voice mode) reads that reply.
- **Voice settings** (sliders icon on the panel, or the "..." menu): 12 voices, each with a
  sample; speed 0.75-1.5× (default 1×); recognition language English (default) or Türkçe;
  read replies aloud, read questions aloud, listen again and spoken-style replies (all on by
  default). Saved on the phone.

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

- `--port`: TCP port, default 47490 (47491 with `--instance`). Global options go before the
  subcommand, e.g. `./devdeck.py --port 47499 serve`.
- `--instance NAME`: a side-by-side install (see Setup). Environment `DEVDECK_INSTANCE`.
- `--dest DIR` (`serve`, `install-service`): where uploads go. Default `~/Downloads/phone`.
- Environment:
  - `XDG_CONFIG_HOME` / `XDG_STATE_HOME` move the token and state directories.
  - `DEVDECK_OMP_DIR` (default `~/.omp/agent`) is where omp's `terminal-sessions/`
    breadcrumbs, sessions, `config.yml` (model roles), `history.db` and
    `session-pins.json` are read. Useful for tests that must not touch the real ones.

## How it works

### Daemon (`devdeck.py serve`)

**Connections.** The daemon runs a thread per connection. Each control connection has:
- a reader for client messages;
- a writer that owns the zlib stream and sends only what changed against what it last
  *wrote*.

On a slow link the writes block, intermediate states are skipped, and no backlog builds up.
Requests (`ls`, `read`, `git`, `more`, `full`, `models`, `history`, `cmd`) run in small
worker threads, at most 3 per connection.

**Panes** are polled once every 2 s, for all clients together, and only while a client is
connected. One poll is a single `tmux list-panes -a`:
- An agent pane is recognised by omp's terminal title `π[-profile] [spinner] <context>`.
  It is working while the braille spinner is present.
- `asking` comes from the session file: an `ask` tool call has a `tool_execution_start`
  marker but no result yet, and nothing newer is on the branch. When there is no session
  file, the daemon falls back to looking for omp's question box at the bottom of the
  screen.
- The pending question itself is included in the pane as `ask`.
- The omp settings of the session are included as `omp` (see below).

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

**omp settings of a pane (`omp`).** Taken from the transcript engine's parse: each entry's
node remembers what it changes, and the branch walk keeps the latest values, so a poll costs
no file reads (only the newest todo result's line is read, once).
- model: the last `model_change`, else the last assistant `provider/model`;
- thinking: the last `thinking_level_change`; fast: the last `service_tier_change` is
  non-null; mode: the last `mode_change` (`plan`, `plan_paused`, `none`, ...);
- context: the last assistant `usage` (input + cacheRead + cacheWrite + output), cleared by
  a compaction or `/clear`; the window comes from the models list;
- todo: the latest `todo` tool result (text capped at 4000, counts from its
  `Overall: x/y done` line);
- cwd and session id from the session header and the breadcrumb.

A brand-new omp session has no file until its first reply, and omp may write a file
without a `model_change`. Only then the daemon reads omp's footer from the screen
(`π > ◒ Opus 5.5 ⚡ > 🗺 Plan > ...`): the glyph is the thinking level (⦸ off, ○ minimal,
◔ low, ◑ medium, ◒ high, ◕ xhigh, ◉ max, ⟳ auto), ⚡ the fast tier, `🗺 Plan [⏸]` plan
mode, and the name (catalog name without `Claude `) is mapped back to a model, preferring
the model this daemon last switched the pane to, then the default role's.

**Models and roles.** `omp models --json` (omp's own catalog, no model call; about 2 s) is
run in a thread on first use, cached in memory and in `~/.local/state/devdeck/models.json`,
and refreshed in the background after 6 hours while the stale copy keeps being served.
Roles are read from the `modelRoles:` block of `~/.omp/agent/config.yml` on every request.

**Session history.** The session files directly under `~/.omp/agent/sessions/*/` whose
header `cwd` is the pane's omp cwd. Only the first lines (title slot and header) are read,
cached by inode/size/mtime; a session counts as non-empty when it contains a user message
(memory-mapped search). Titles fall back to `history.db` `session_titles`, then the first
user line; recaps are the latest `session_recaps` row; pins come from
`session-pins.json`; live means an open `/dev/pts/N` has a breadcrumb naming the file.

**omp commands (`cmd`).** One command at a time per pane. Before acting the daemon checks
that the pane runs omp, is not asking, shows no page/picker, has no draft trap and no unsent
text in omp's prompt (the `╰─` line under the footer; a pasted command would be appended
to it and the whole line sent to the model). Each command is a bracketed paste of the
exact slash command plus one Enter, then a confirmation:

| cmd | sends | confirmed by |
|---|---|---|
| `switch` `provider/id[:level]` | `/switch ...` (validated against the models list and the model's levels) | a new `model_change` for that model, or the footer showing it |
| `effort` level | `/effort level` | `thinking_level_change`, or the footer glyph |
| `fast` `on`/`off` | `/fast on/off` | `service_tier_change`, or footer ⚡; "unavailable" fails |
| `plan` | `/plan` | `mode_change` or the footer badge (info: new mode); the "Exit plan mode?" dialog fails |
| `compact` [focus] | `/compact [focus]` | compaction entry or status, else 3 s without an error (info `compacting`) |
| `new` | `/new` | breadcrumb path changes (info: new session id) |
| `clear` | `/clear` (refused while working) | `reset_boundary` or "Context reset" |
| `retry` | `/retry` (refused while working) | 2 s without "Nothing to retry" |
| `resume` uuid | `/resume uuid` (must be in this cwd's history) | breadcrumb path changes (info: `resumed`, or the id of the copy omp forks when the session is live elsewhere) |
| `rename` title | `/rename title` (one line, at most 120 chars) | `title_change` (info: omp's final title) |
| `stop` | one Escape (only while working; never two within 600 ms) | the spinner leaves the title, or an aborted reply |
| `queue` text | working: paste + Ctrl+Q (follow-up); idle: paste + Enter | sent |
| `page` `/model` ... | the bare page command | omp shows a page within 4 s (info: its title) |

Any new `Error: ...` status line fails the command at once with that text; a timeout
(6 s) fails with omp's latest status lines and footer.

**Live pages.** omp draws its full-screen pages (`/model`, `/settings`, ...) on the
terminal's alternate screen, and inline pickers (`/effort`, `/switch`) as a box at column 0
that replaces the footer and prompt. Either one is a page; omp's ask dialog is not. While a
chat-view client watches an omp pane, its writer checks the visible screen every 0.6 s; while
a page is open it streams the visible rows as `screen` frames tagged `page:true` (at most
4/s) and sends one `page:false` frame when it closes. The pane poller reports `omp.page`
for panes watched in the chat view. `tap {row}` finds omp's `❯` selection marker nearest to
the row and presses Up/Down for the rows in between, skipping rules and blank rows.

**Messages, keys, clipboard.**
- Messages go in with `tmux load-buffer` and `paste-buffer -p`, plus `send-keys Enter`.
  On omp panes `/model x`, `/models x` become `/switch x` and `/thinking x` becomes
  `/effort x`, and an empty Enter is refused while omp works.
- Quick keys use `send-keys`; key names are validated. `type` text goes in with
  `send-keys -l` (control characters removed).
- The clipboard is set with `wl-copy`.

**Files and git.**
- Paths are resolved with symlinks followed and must stay inside `$HOME`.
- git runs with `--no-optional-locks`: `status --porcelain=v2 --branch -z`,
  `diff [--cached] [-- file]` (untracked files as `--no-index` against `/dev/null`), and
  `log -n 50`.

**Voice mode (speech).** Replies and questions are spoken with omp's local Kokoro-82M voice,
synthesised on the PC and streamed per sentence (protocol: "Voice messages").
- **Spoken form.** The markdown is turned into what a person would read out: heading, bold,
  italic and list markers dropped (list items and headings become sentences), links read as
  their text, bare URLs as "a link", inline code as words (`webApp.render_list()` → "web
  App dot render list"), each fenced code block as one "Python code block omitted." (with
  its language), tables as "A table with N rows. Columns: ...", mermaid/svg/dot blocks as
  "A diagram.", `$$` math as "A formula.", paths shortened to the file name, file names
  read with "dot", UUIDs as "an ID", hashes as their first 4 characters, numbers of 8+
  digits as "a long number", emoji dropped. Over 2500 characters it stops at a sentence and
  adds "The rest is on screen.". Questions are read as "omp asks: <question>. Options: one,
  <label>. two, <label>. You can also say other, then your answer." (several: "omp asks
  three questions. Question one of three: ...").
- **Streaming.** The text is split into sentences; ones shorter than 25 characters are
  merged with the next, ones longer than 280 are split at a comma (Kokoro reads at most ~510
  phonemes at a time), and a first sentence longer than 80 characters is split at a comma
  so speech starts sooner. Each is synthesised, encoded to Ogg/Opus with ffmpeg (mono,
  24 kbit/s, `-application voip`) and queued as one `audio` message as soon as it is ready,
  so the phone plays the first sentence while the rest is synthesised. Every reading runs
  in its own thread; the pane poller only starts them, so synthesis never delays the
  poller, other requests or other connections. `say_stop` cancels between sentences and
  drops the audio still waiting in the connection's send queue.
- **Engine.** One sentence is synthesised at a time for all connections (Kokoro already
  uses every core). The engine is a persistent worker, `bun tts_worker.ts` (repo root),
  that loads omp's Kokoro runtime (`~/.omp/agent/cache/tts-runtime/kokoro-*`, CPU
  `onnxruntime-node`) and the weights in omp's cache (`~/.omp/agent/cache/tiny-models/`)
  once, then answers one JSON line per sentence with raw PCM. omp itself uses the q8
  weights; when the fp32 ones (`onnx/model.onnx`, 325 MB) are also in that cache the worker
  uses them, because on this laptop's CPU (i7-8650U) they are about 2.7× faster. The worker
  never downloads them; to add them once:
  `curl -L -o ~/.omp/agent/cache/tiny-models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx`
  (sha256 `8fbea51e...a34cb`). The worker starts on the first reading, or ahead of time
  when voice mode is turned on or a voice-mode agent is working, and exits after 10 minutes
  without use to give its memory back (about 0.9 GB with fp32). If bun or the runtime is
  missing, or the worker fails or hangs (60 s per sentence), `omp say --out` (a new process
  that loads the model on every call) is used for the next minute instead.
- **Measured** on the i7-8650U (8 threads, no GPU), real-time factor = synthesis time /
  audio length:

  | engine | start | per sentence (~115 chars, 7.9 s of audio) | real-time factor |
  |---|---|---|---|
  | worker, fp32 | 1.2 s (model load 1.0 s) | 4.2-4.7 s | 0.55-0.6 |
  | worker, q8 | 1.1 s (model load 1.0 s) | 12-12.7 s | 1.5-1.6 |
  | `omp say --out` (q8) | every call | 15 s | 1.8 (2.2 for a short sentence) |

  With fp32 a 1900-character reply (19 sentences, 149 s of audio) took 90 s in total, the
  first sentence arrived after 5.7 s (worker start included) and the phone never waits
  between sentences; with q8 the total was 253 s, so playback would stall. Opus at 24
  kbit/s is about 3 KB per second of speech.
- **Cache.** Encoded sentences are kept in memory per (text, voice, speed) for 30 minutes
  after their last use, at most 50 MB (least recently used dropped first), so replaying a
  reply is instant.

**State on disk.**
- Delivered ids (last 2000) are kept in `~/.local/state/devdeck/seen.json`.
- Partial uploads live in `~/.local/state/devdeck/partial/` until complete.
- The models list is cached in `~/.local/state/devdeck/models.json`.

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
  - Voice: `listen(opts)` with `{lang:"en-US"|"tr-TR", partial:true, preferOffline:true}`
    starts Android's `SpeechRecognizer` (asks for `RECORD_AUDIO` on first use, and stops
    playback); `stopListening()` finalises the utterance; `stopSpeaking()` stops local
    playback only (the UI sends `say_stop` itself); `setVoiceMode(bool)` keeps the screen on
    (`FLAG_KEEP_SCREEN_ON`) while voice mode is active.
  - Local voice events to `window.dd.receive`:
    - `stt {phase:"ready"|"partial"|"final"|"error"|"end"|"rms", text?, error?, rms?}`:
      `end` exactly once per listening session; `rms` about 15 times a second.
    - `tts {phase:"start"|"chunk"|"end"|"stopped"|"error", seq?, text?, req?, target?,
      entryId?, auto?, ask?, error?}`.
  - The shell sniffs `audio` and `voice_error` itself and still forwards them to the UI. It
    plays each reading's chunks in `seq` order from temporary `.ogg` files (cache dir
    `tts/`) with `MediaPlayer`, holding transient audio focus with ducking. It remembers the
    UI's last `voice {...}` per target while on and re-sends it after every reconnect; a
    page reload or the activity's destruction sends `voice {target, on:false}` for those and
    stops everything.
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
| Live | `watch {target, view}`, `pause`, `resume`, `resync`, `ping {ts}`, `keys {target, keys[]}`, `tap {target, row}`, `type {target, text}`, `new {}` (→ `created {target:"phone-N:W.P"}`) |
| Queued (carry `id`, always answered by `ack {id, ok, error?}`, deduplicated) | `send {target, text, enter}`, `clip {text}`, `answer {target, toolCallId, answers:[{qid, selected[], custom?, note?}]}` |
| Voice (live, never queued) | `voice {target, on, opts}`, `say {req, target?, entryId?, text?, voice?, speed?}`, `say_stop {req?}` (see "Voice messages") |
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
- `models {}` → `models {models:[{selector:"provider/id", provider, id, name, contextWindow, reasoning, thinking:[levels]|null}], roles:{role:"provider/id[:level]"}, fetchedAt(ms)}`.
  Chat models only; served from cache (see "Models and roles").
- `history {target}` → `history {cwd, sessions:[{id, title, recap?, mtime(ms), live, current, pinned}]}`:
  the sessions of the pane's omp cwd, pinned first then newest, at most 50, empty ones
  skipped.
- `cmd {target, cmd, arg?}` → `cmd {ok, error?, info?}`: `cmd` is one of `switch`,
  `effort`, `fast`, `plan`, `compact`, `new`, `clear`, `retry`, `resume`, `rename`, `stop`,
  `queue`, `page` (table in "omp commands"). Refusals and failures also come back as
  `cmd {ok:false, error}` (omp's own error text when it printed one); `error {req}` only
  for malformed requests. Live only: the UI disables these offline.

Live messages for omp pages: `tap {target, row}` moves the selection of the open page to
`row` (index into the last page frame's `lines`) with Up/Down only, and answers
`error {error}` when no `❯` marker is found. `type {target, text}` types one line (at most
200 chars) literally. `keys` (e.g. `Escape`, `Enter`) presses keys as usual.

`send` on omp panes: `/model x`, `/models x` → `/switch x`, `/thinking x` → `/effort x`
(single-line text), and `ack ok:false, error:"An empty Enter would stop the agent; use Stop"`
for an empty `enter:true` send while the pane is working.

**Voice messages.** All live; failures come back as `voice_error`.
- `voice {target, on:bool, opts:{autoRead, readAsks, voice, speed}}` subscribes this
  connection to `target` (off: unsubscribes and stops its auto/ask readings). `autoRead` and
  `readAsks` default to true, `voice` to `af_heart` (one of the 12 voices below), `speed` to
  1 (clamped to 0.5-2). Re-sending it with on:true only updates the options. The shell
  re-sends it after every reconnect. While subscribed (and not paused):
  - when the pane finishes a turn (idle, with a new final assistant message whose
    `stopReason` is `stop` and that has text), that text is read: `audio {auto:true, entryId}`.
    Replies that were already there when voice mode was turned on are not read. A phone that
    reconnects (same `client` id) within 15 minutes still gets the reply that finished while
    the link was down, and one that was read to the old connection without the phone being
    heard from after it (a half-open link) is read again; the old connection's subscription
    is taken over and stops reading.
  - when it asks (`ask` tool), the question(s) are read once per `toolCallId` per connection:
    `audio {ask:true, toolCallId}`. An ask that is open when voice mode turns on is read
    right away.
  - while it works, the TTS engine is kept loaded so the reply starts quickly.
- `say {req, target?, entryId?, text?, voice?, speed?}` reads an entry of the target's
  transcript (`entryId`, needs `target`; its full text, not the 50 000-char display cap) or a
  literal `text`. `voice`/`speed` may also come as `opts:{voice, speed}`; missing ones are
  taken from the target's `voice` options, else the defaults. An unknown voice is an error.
  At most 4 `say` streams run per connection. A new `say` does not stop earlier ones.
- `say_stop {req?}` stops that `say` (without `req`: every reading of this connection,
  auto and ask included). Nothing more is sent for a stopped reading: audio still waiting
  in the PC's send queue is dropped, and no `last` chunk follows.

Voices: `af_heart`, `af_bella`, `af_nicole`, `af_aoede`, `af_kore`, `af_sarah`,
`am_michael`, `am_fenrir`, `am_puck`, `bf_emma`, `bm_george`, `bm_fable`.

**PC → client**

- **`sessions {list}`**: on connect and on change. While paused, it is sent only when a
  pane's `state` or `ask` changes. Each pane has:
  - `target`, `session`, `window`, `pane`, `name`, `cmd`, `cwd`;
  - `title`: the spinner glyph is frozen to `⠿`, so animation does not resend the list;
  - `state`: `working`, `asking` or `idle` for omp; `shell` or `running` otherwise;
  - `context`, `agent`, `sessionId?`;
  - `ask?`: `{toolCallId, questions:[{id, header?, question, options:[{label, description?, preview?}], multi, recommended?}]}`;
  - `omp` (agent panes): `{model:"provider/id"|null, modelName:string|null, thinking:string|null, fast:bool, mode:"none"|"plan"|"plan_paused"|..., ctx:{used, window}|null, todo:{done, total, text}|null, cwd, sessionId, page:{title?}|null}`.
    `modelName` is the catalog name (e.g. `Claude Opus 5.5`); `ctx` is null when unknown
    (fresh session, after `/clear` or a compaction until the next reply); `page` is only
    reported for panes some client watches in the chat view. Changes of `omp` alone never
    wake a paused client.
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
  - In the chat view, while omp shows a page in the watched pane, the same frames carry
    `page:true` and hold only the visible rows (no scrollback; diffs are against the
    previous page frame). When the page closes one `{t:"screen", target, page:false}` is
    sent. `resync` sends a full page frame again.
- **`audio {req?, auto?, ask?, target, entryId?, toolCallId?, seq, last, mime, data, text, dur}`**:
  one sentence (or a few short ones merged) of a reading, sent as soon as it is synthesised.
  `seq` counts from 0 per reading, `last:true` is on the final sentence (always with data),
  `mime` is `audio/ogg; codecs=opus` (mono, about 24 kbit/s), `data` the base64
  file, `text` the words spoken, `dur` its length in ms. `req` echoes the `say`; `auto`
  readings carry the reply's `entryId`, `ask` readings the ask's `toolCallId`; `target` is
  null for a `say` of a text without a target.
- **`voice_error {error, req?, target?, entryId?, auto?, ask?, toolCallId?}`**: a reading
  failed or a voice message was malformed; it ends that reading (no `last` chunk follows).
- **Other replies**: `created`, `ack`, `pong`, `error {error, req?}`, `full`, `ls`, `read`,
  `git`, `models`, `history`, `cmd`.

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
- **omp controls read omp's screen** for things the session file does not have yet (a
  brand-new session's model and thinking level, error lines, pages and the selection
  marker). This follows omp 18.12's footer, status lines and pages and may need updating
  when omp changes them. Tapping a page row assumes each row below the marker is one step
  (rules and blank rows excepted); section headers some pages show can make it land one
  row off; the arrow keys always work.
- **Rename** makes omp format the title with a small model call (emoji and category).
- **One watched pane per connection.** The clipboard needs a Wayland session.
- **Voice mode**: a finished reply is noticed by the 2 s pane poll, so reading starts 2-4 s
  after the turn ends (plus the link). Only the final message of a turn is read (text
  written before tool calls is not). Synthesis loads the PC's CPU while it speaks. Nothing
  is read while the app is paused; a reply or question that arrived meanwhile is read when
  it comes back. The spoken-form rules are heuristics for English markdown.
