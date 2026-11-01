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
    installs on its first `omp say` (into `~/.omp/agent/cache/tts-runtime/`). Optional: an
    NVIDIA GPU with private CUDA 12 / cuDNN 9 libraries makes it about twice as fast (see
    "Engine" under How it works).
  - Live mode: omp logged in to ChatGPT (`/login`, provider `openai-codex`) with an account
    whose plan includes GPT Live (a free account is refused with HTTP 404). Nothing else:
    the call's audio goes straight between the phone and OpenAI.
  - To build the app: `adb` (`android-tools`), a JDK and `bun` (for the web UI). The
    Android SDK is reused from `../phone_synaptic_trackpad/.sdk`.
- Phone: Android 8+ (developed on Android 13), with USB or wireless debugging enabled for
  pairing.

## Setup

```sh
./devdeck.py pair              # builds the app, installs it via adb, shares a random token
./devdeck.py install-service   # systemd user service, starts with the graphical session;
                              # also links the devdeck omp extension (install-ext)
```

**Which phone.** `pair` uses adb's only device. If several are connected it uses
`100.64.0.2:5555`; pass `-s SERIAL` to choose another. `--rebuild` rebuilds the APK first.
The build is `android/build.sh`:
1. It runs the web build (`cd web && bun install --frozen-lockfile && bun run build` →
   `android/assets/web/`).
2. It runs `aapt2` (resources plus `-A assets`), `javac`, `d8`, `zipalign` and `apksigner`
   (debug key), with no Gradle.
3. It writes `devdeck.apk`, and fails loudly if the web build fails.

Live mode's native WebRTC is the pinned libwebrtc AAR `io.github.webrtc-sdk:android`
144.7559.15 (sha256 `fc7c8d02...0cde4071`) from Maven Central. `build.sh` downloads it once
to `${XDG_CACHE_HOME:-~/.cache}/devdeck-build/` (override with `WEBRTC_CACHE`), checks the
checksum on every build, and packages its `classes.jar` plus only
`lib/arm64-v8a/libjingle_peerconnection_so.so`. This adds about 5.9 MB to the APK.

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
- **Overflow menu**: Files, Git, Chat/Terminal view, Sketch, Keep screen awake,
  Notifications, Resync, Voice settings, New terminal, omp settings (global when no omp
  terminal is open), Usage limits and Update omp.

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
  - ```` ```svg ```` blocks are drawn inline;
  - tapping a diagram opens it full screen (status bar hidden): pinch or double-tap to zoom,
    drag to pan (wheel zoom in a desktop browser), back closes it. Turn the phone and accept
    the system's rotate button (or have auto-rotate on) for landscape; the diagram refits.
- **Thinking** sections are collapsible.
- **Tool calls** are compact rows showing status, tool name and intent. Tap one to expand
  its input and output. Long outputs are cut on the PC; "Show full ..." fetches the
  untruncated text.
- **Compaction** shows as a summary card. Errors, aborted turns and `!command` runs show as
  notices.
- **History**: scrolling up loads older history in pages of 60. The view follows the bottom
  unless you scroll up.
- **Working row**: while omp works, an animated row shows its context.
- **Pending sends** appear as dashed bubbles until the PC acknowledges them. A failed send
  offers Retry and Dismiss.
- **Cache**: the last transcript of each terminal is cached, so reopening a terminal is
  instant; live data replaces it when it arrives.

### omp controls in the chat view

A control strip drives the watched omp session natively. Every action runs live (disabled
offline, never queued), one at a time per terminal, and reports omp's own error text.
- **Model chip** (`Opus 5.5 · high`, plus ⚡ for the fast tier), `/model` (also `/models` and
  a bare `/switch`, picked from the palette or typed and sent) and `/modelpreset` (opens on the
  Roles tab) open the native model hub, at parity with omp's own `/model` hub; omp's terminal
  model page and pickers are never opened for these:
  - **Models**: ranked search (`opus55` finds `claude-opus-5-5`), kind chips (Chat, Tiny,
    Image, TTS, STT, Search...) and a provider filter. The list has Current, Recent (used in
    the last 30 days) and Top (by intelligence) sections, with the same model on several
    providers grouped into one row with provider pills. Catalog noise sits behind "Show N
    more". Rows show intelligence 🧠, time to first token, measured tokens/s, context,
    vision, price per M tokens and the roles that use the model.
  - **Model detail**: every fact (max output, cache prices, uses, last use), the same model
    on other providers, "Use in this session" (thinking level including Auto, Fast, then
    omp's `/switch` or `/effort`: session only), role toggles, the model's fallback chain and
    its compaction limit (`90000`, `f90000` or `80%`).
  - **Roles**: chat, custom and model-kind roles with model, level, fallbacks and cycle
    marker. A role opens a detail page: change its model (a picker filtered to the kinds the
    role accepts), its thinking level, clear it, edit its fallback chain and its place in the
    Ctrl+P cycle. Also: new custom roles, fallback chains keyed by model or `provider/*`, cycle
    order, and presets (save current, apply with `/modelpreset switch`, delete).
  - Changes are written to omp's config at once (see "Model roles"). Assigning `default` also
    switches this session, as omp's hub does. A link at the end of Roles opens omp's own model
    page as a live page (for provider logins).
- **Thinking** (`/effort` or `/thinking` in the slash palette): a small sheet with the model's
  levels plus Auto.
- **Context meter** (used/window) and a **plan badge** while plan mode is on.
- **Session menu**: New session, Resume..., Side questions..., Compact (optional focus), Clear
  context, Plan mode on/off, Plan review..., Retry last turn, Rewind..., Session tree...,
  Rename, Session info, Usage limits..., omp settings.... Rename makes omp format the title
  with a small model call (an emoji and a category prefix are added).
- **Resume** (`/resume`): "This folder" lists this directory's sessions (title, recap,
  pinned, live/current markers); tap one to resume it here. "All projects" lists every
  project's sessions with their folder; one from another project opens in a new terminal
  there (`omp --resume`). The trash button deletes a session (never the current or a live
  one): its files move to the PC's trash and the row offers Undo.
- **Stop**: with an empty compose box while omp works, Send becomes Stop (one Escape). With
  text while working, Send steers; "Queue as follow-up" delivers it after the turn.
- **Tasks**: a `Tasks 3/7` chip shows omp's todo list.
- **Slash palette**: typing `/` lists the supported commands. Typed `/model x`, `/models x`
  and `/thinking x` are rewritten to omp's `/switch x` and `/effort x`, because omp would
  send a command with arguments it does not take to the model as a prompt. Your omp prompt
  commands `/diagramify` and `/basic` fill in `/diagramify ` or `/basic ` so you can add a
  `#code`, a path or what to draw, then Send.
- **Keys in chat**: a keyboard toggle shows the quick-key rows inside the chat view.

**Native omp pages.** omp's interactive pages have phone sheets instead. Picked from the
palette or typed and sent, `/btw`, `/plan-review`, `/rewind`, `/branch`, `/tree`,
`/settings`, `/session`, `/usage` and `/resume` (bare) never open omp's terminal page:
- **Side questions** (`/btw`, session menu): ask about the session while the agent keeps
  working. The model sees the conversation but runs no tools, and nothing enters the
  transcript. `/btw your question` + Send asks at once; bare `/btw` opens the sheet: topics
  newest first (Running / Done / Cancelled / Error, "from omp" for ones asked on the PC),
  then a topic's thread with the answer streaming in as markdown, Copy, Cancel while it
  runs, and a follow-up box that keeps the topic's context. One side question runs at a time
  per session. While one runs, a **BTW** chip with a spinner sits in the control strip; an
  answer that finished while the sheet was closed leaves a dot on the chip until you read it.
- **Plan review**: when omp asks to approve a plan, a sheet opens like the ask sheet: the
  plan file as markdown, omp's choices (execute, compact then execute, keep planning,
  refine...), the execution-model tier and, for refine, a feedback box. Closing it leaves a
  "Plan ready for review" banner. `/plan-review` reopens it, or asks omp to open a review of
  the newest plan (omp's reason is shown when it can't). The PC's overlay is not mirrored.
- **Rewind** (`/rewind`, `/branch`): this path's prompts, newest first. Tap one and confirm:
  omp goes back to just before it and the prompt comes back into the compose box (after any
  draft) to edit and resend. Later messages stay in the session as a branch.
- **Session tree** (`/tree`): the whole session file as an outline. Prompts or Everything;
  side branches are indented under their branch point (`2 branches`), the current path has
  a blue edge and the current entry is marked; labels and branch summaries show. Tap an
  entry for Go here, Go here with a summary (of the branch you leave) or, for prompts,
  Rewind before it. Going to a prompt also puts its text into the compose box, as omp does.
- **Settings** (`/settings`, session menu, overflow menu): omp's settings with their
  `/settings` labels, grouped by its tabs and searchable; a blue dot marks values set in your
  config. Booleans toggle in the list; tap a setting for its editor (options, number, text,
  or JSON for lists and maps), its default and Reset. Changes apply to running omp sessions
  at once. Project-config values are read-only; credentials are never shown or changed.
- **Session info** (`/session`): id, folder, file, dates, entries, messages, tokens, cost,
  artifact size, side questions and models used; Copy ID and Show in Files.
- **Usage** (`/usage`, session menu, overflow menu): omp's provider limits. At the top this
  session's spend (cost, tokens in/out/cache; from the session menu or palette only). Then
  one card per account, grouped by provider (this session's provider first): plan, "Limit
  reached", and each quota window as a bar (blue, amber at omp's warning, red when
  exhausted, grey when not reported) with "18% used" (or "0 / 200 requests") and "Resets in
  2 h 14 m · 1:51 PM" in local time. Emails are masked (`a•••@example.com`); tap one to show
  it. Codex and Claude accounts list their saved rate-limit resets (what each restores, when
  it expires, amber within 24 h, and omp's auto-spend setting); **Spend one...** confirms
  with the account, what it restores, the current window usage and the expiry, then runs
  omp's `usage reset` (it can't be undone). **7-day history** adds a usage line per window
  with its peak. The sheet opens at once with the last numbers (offline too, marked as
  such) while the PC refreshes them; **Refresh** asks omp again.
- Rewind and tree moves are refused while the agent works (stop it first), and side
  questions while one runs. An omp started before the DevDeck extension was installed shows
  "restart omp in this terminal" (`/restart`, or exit and start omp again).

**Live omp pages.** Pages DevDeck has no sheet for (the model hub's provider-login link, any
other overlay omp opens on the PC) are mirrored in a live panel inside the chat view: tap a
row to move the selection there, double-tap to also press Enter, use the
arrow/Tab/Enter/Esc bar, or type to filter. The panel closes when omp closes the page.

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

### Live (GPT Live voice calls)

A ChatGPT-voice-like conversation about your terminals: natural replies right away, talk
over it to interrupt, no buttons while it runs. It works phone in hand, with earbuds and the
screen off, or on the speaker at the desk. It uses GPT Live (`gpt-live-1-codex`, the model
behind omp's `/live`) through omp's ChatGPT login.
- **Who you talk to.** By default a quick voice assistant, the **concierge**: a small omp
  session (tmux `devdeck-voice`) that sees every terminal through `ddctl`. Ask it what the
  terminals are doing, give coding tasks ("tell the devdeck agent to ..."), stop or switch
  models, answer an agent's question, open a new terminal, or think out loud. It hands real
  coding work to the right terminal instead of doing it. **Direct mode** talks to one
  terminal's coding agent instead: what you ask goes into that terminal prefixed `[voice] `,
  and its question is read to you; your spoken answer picks the option you name, else it is
  sent as your own answer. Switch with the mode chip, or by voice ("let me talk to main
  directly", "back to the concierge").
- **While agents work** it keeps talking with you, mentions short progress, and tells you the
  result when the turn ends. When another terminal's agent finishes or asks something, it
  says so at the next pause ("main finished: ...", "docs is asking: ..."); these also appear
  as cards in the Live view.
- **Ending.** End (in the view or the notification) hangs up. If the phone's link to the PC
  drops, the call keeps going (audio does not use that link) and ends 60 s later unless the
  link comes back.

**Live view (web).** An orb button in the top bar starts a call with the saved voice and
mode (`dd.live` in localStorage: voice, mode, last direct terminal) and opens the full-screen
Live view: orb driven by `live_local` mic/spk levels and coloured by phase, phase label +
hint, captions (`live_transcript`, partial -> final per role+turn), delegation chips
(`live_delegation`, updated in place by id: sent/done/failed), notice cards (`live_notice`;
tap opens the terminal or its ask), mode chip (Concierge / Talking to <terminal>, picker
sends `live_mode`), voice picker (9 voices; applies from the next call), Mute
(`DD.liveMute`) and End (`DD.liveStop`; native sends `live_stop`). Back closes the view but
keeps the call; a green "Live m:ss" pill in the top bar returns to it (also after a page
reload, from the replayed `live_local`). Voice mode cannot be enabled while a call runs.

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
- breadcrumbs, where the home icon is `~`, plus an Up button (top left; the phone's Back
  closes Files);
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
- `--ctl PATH` (`serve`): the local control socket for `ddctl`. Default
  `<state dir>/ctl.sock` (`~/.local/state/devdeck-plus/ctl.sock` with `--instance plus`).
- Environment:
  - `XDG_CONFIG_HOME` / `XDG_STATE_HOME` move the token and state directories.
  - `DEVDECK_OMP_DIR` (default `~/.omp/agent`) is where omp's `terminal-sessions/`
    breadcrumbs, sessions, `history.db`, `models.db` and `session-pins.json` are read
    (`stats.db` one level up). Useful for tests that must not touch the real ones. omp's
    settings (model roles) are read and written through the `omp config` command, so for
    those also set `PI_CODING_AGENT_DIR` to the same directory.
  - `DEVDECK_TTS_DEVICE` = `auto` (default), `cpu` or `cuda`: where the voice is synthesised
    (see "Engine" under How it works).
  - `DEVDECK_CONCIERGE_MODEL` = `provider/id[:level]` (default
    `anthropic/claude-haiku-4-5:low`): the Live concierge's model and thinking level.
  - `DEVDECK_CONCIERGE_SESSION` (default `devdeck-voice`): the concierge's tmux session, for
    tests that must not touch the real one.

## How it works

### Daemon (`devdeck.py serve`)

**Connections.** The daemon runs a thread per connection. Each control connection has:
- a reader for client messages;
- a writer that owns the zlib stream and sends only what changed against what it last
  *wrote*.

On a slow link the writes block, intermediate states are skipped, and no backlog builds up.
Requests (`ls`, `read`, `git`, `more`, `full`, `models`, `roles`, `roles_set`, `history`, `cmd`) run in small
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

**Models.** `omp models --json --kind all` (omp's own catalog, every kind, no model call;
about 2 s) is run in a thread on first use, cached in memory and in
`~/.local/state/devdeck/models.json`, and refreshed in the background after 6 hours while
the stale copy keeps being served. Two read-only additions:
- omp's provider-model cache `~/.omp/agent/models.db` gives the intelligence score omp's own
  hub shows (for the selector, else the same id on another provider) and which chat models
  have web-search grounding (they can serve the `web` role);
- omp's `~/.omp/stats.db` gives, per model, the replies of the last 30 days, the last use,
  and the medians of output tokens per second (whole reply, as omp's hub computes it) and of
  time to first token over the latest 50 replies with 50+ output tokens (re-read at most
  once a minute).

A row is `hidden` (collapsed behind "Show N more") when it is a dated alias of a same-named
row (`claude-haiku-4-5-20251001`), or a chat model with no score, no known price and no use.

**Model roles.** Read with `omp config list --json` in the pane's omp cwd (so a project
`.omp/config.yml` applies; about 0.15 s, cached until omp's global or that project's config
file changes): `modelRoles`, `modelRoleStorage`, `defaultThinkingLevel`, `cycleOrder`,
`modelTags`, `retry.fallbackChains`, `compaction.modelThresholds`, `modelPresets`. Roles are
omp's built-in chat roles (`default smol slow vision plan commit tiny memory task advisor
widget`), custom roles (named in `modelRoles`, `cycleOrder` or `modelTags`) and model-kind
roles (`image web speech dictation judge`), each with the model kinds it accepts and, when
unset, what omp falls back to (`tiny`/`widget` → `@smol`, `memory` → `@tiny`, `smol`/`slow`
→ `@default` and `advisor` → `@slow` when those are set, else omp's built-in list).

Writes (`roles_set`) replace one whole setting with `omp config set`, which writes omp's
global config under omp's own lock. The daemon first re-reads the setting and refuses when it
no longer equals what the phone edited ("changed on the PC"), checks every changed selector
against the catalog (kind accepted by the role, web grounding for `web`, thinking level
supported, levels only on chat models), then re-reads to confirm. Role writes are refused
with `modelRoleStorage: project`, and a write that a project layer still overrides is
reported. Running omp sessions pick the change up themselves; only assigning `default`
switches a session, which the phone does with `switch` afterwards (as omp's hub does).

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
| `switch` `provider/id[:level]` | `/switch ...` (validated against the models list: a chat model and its levels) | a new `model_change` for that model, or the footer showing it |
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
| `preset` name | `/modelpreset switch name` (must exist in `modelPresets`) | a `model_change`, or omp's roles now equal the preset's |

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

**The devdeck omp extension (`omp-ext/devdeck/`).** What has no CLI and no safe paste route
(streamed side answers, answering plan review, moving the session leaf) goes through a small
omp extension kept in this repo. `./devdeck.py install-ext` (also run by `install-service`)
symlinks it to `~/.omp/agent/extensions/devdeck`; omp processes started afterwards load it
(running ones need a restart; extension-backed requests then fail with
`code:"no_extension"`). On load it serves HTTP on `127.0.0.1` (random port, random token
as `?t=`) and publishes `{pid, port, token, sessionId, planReview}` in
`~/.omp/agent/devdeck/<omp pid>.json` (mode 600, removed on exit, dead ones pruned). The
daemon maps a pane to it like the sketch extension: the registration whose pid runs below
the pane's process (the outermost one, if an agent runs `omp -p` inside). It also writes
`~/.omp/agent/devdeck/settings-schema.json` (omp's settings registry: types, defaults, enum
values, `/settings` tabs and groups) once per process.

**Native omp pages.**
- **/btw.** `btw_ask` opens the extension's event stream (`/events`, server-sent events),
  then `POST /btw`. The extension runs omp's own RPC `/btw` controller
  (`RpcBtwController`) on the main session: one side question at a time, the session's
  context, no tools, never in the transcript, follow-ups by topic id, and every topic
  checkpointed in `<session artifact dir>/btw-history/entry-<id>.json` exactly as the TUI's
  `/btw` does, so omp's own `/btw` history lists phone topics and the phone lists terminal
  ones (verified both ways). Ids of topics asked from the phone are appended to
  `~/.omp/agent/devdeck/btw/<session id>.ids` (`source:"devdeck"`). Deltas and records are
  relayed until that topic's turn ends (at most 15 min). `btw_list` reads the history files
  (no extension needed; omp's `interrupted` shows as cancelled), plus the running topic's
  partial answer from the extension. Cancel aborts the provider request.
- **Plan review.** The extension forwards `plan_review_requested` / `plan_review_resolved`
  (and `getPendingPlanReview()` at start) into its registration; the pane poller turns it
  into the pane's `planReview` (disabled choices dropped, `refine` needs feedback, tiers
  from omp's model slider). `plan_answer` calls `resolvePlanReview` (the terminal overlay
  closes itself), `plan_open` calls `openPlanReview()`, which never aborts work and reports
  why it could not open (plan mode off, omp working, no plan file).
- **Tree, rewind, branch.** `tree` reads the whole session file: every entry but
  bookkeeping (header, title, custom state, usage, credential pins, labels, title changes;
  their children hang on the nearest shown ancestor), labels applied, the leaf by omp's rule
  (the last entry, or its `activeLeafId`). Full text of any entry, off-branch too, comes from
  `full`. `goto` runs PaneCommand `goto` (same checks as `cmd`; refused while working with
  `code:"busy"`): it pastes `/devdeck-goto <nonce> <entryId> [summarize]`, whose handler calls
  `navigateTree` (command context only), clears omp's editor when omp put a rewound prompt
  there (the phone takes it as `draft`), and appends a hidden `dev.devdeck.goto` custom
  entry so the move reaches the session file and the chat view resets on the new branch.
  Confirmed by polling the extension for the nonce's outcome (10 s; 180 s with a summary).
- **Settings.** Three `omp config list --json` runs in parallel in the pane's omp cwd
  (effective values, `--scope global`, `--scope project`) give values and layers; the
  extension's schema adds labels, enum options, defaults and the `/settings` tab and group
  (keys the page does not show follow, grouped by first key segment). Credentials are only
  listed (`secret:true`, no value) and refused for writes. Writes are `omp config set` /
  `reset` on the global layer; running omp sessions watch their config directory and apply
  changes live (verified), so `restartHint` is false. A write a project layer still
  overrides is reported.
- **Session info** reads the session file: entries of the whole file; messages, models,
  tokens and cost of the current branch (as omp's `/session` counts them: replies,
  `model_usage` entries and subagent `task` usage), artifact dir size, `/btw` topic count.
- **Usage.** `omp usage --json` (every account's quota windows; omp serves its own report
  cache, so about a second when warm, a minute or more when cold) and `omp usage reset
  --json` (saved resets with each account's credential id) run in parallel in a thread,
  always with `--no-extensions`: the devdeck and sketch extensions start servers on load, so
  a CLI run with them prints its JSON and then never exits. The daemon reads stdout until
  the first complete JSON object, then gives omp 5 s to exit before killing it. The result
  is kept in memory and in `~/.local/state/devdeck/usage.json`: a copy younger than 60 s is
  answered as is; an older one (or any with `force`) is answered at once with `stale:true`
  while a refresh runs, and the fresh limits follow as a `usage` push (with `error` and the
  old copy when omp failed; after a failure only `force` retries within 30 s). Nothing
  cached: the request waits for the refresh (120 s for `omp usage`). The session line is
  the target's session file counted as for Session info. `autoRedeem` is omp's
  `codexResets.autoRedeem` / `claudeResets.autoRedeem` (`omp config list`). `usage_reset`
  re-lists the saved resets, refuses unknown accounts, ones omp could not load and ones with
  no reset usable now (one spend at a time), runs `omp usage reset <provider>/<credential
  id>`, then lists again: `ok` only when omp's count for that account went down.
  `usage_history` folds `omp usage --history --days N --json` (hourly snapshots, ~100 KB a
  day) into one series per account and window (~40 KB for 7 days).
- **Resume extras.** `history {all:true}` lists every project's sessions (100 newest).
  `session_delete` moves the session file and its artifact dir to
  `~/.local/state/devdeck/trash/<trashId>/` (with `meta.json`), refusing the pane's session
  and any session a terminal's breadcrumb names; `session_restore` moves them back (never
  over an existing file). Trash older than 30 days is dropped on the next delete.
  `new {resume}` starts `omp --resume <id>`.

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
- **Engine.** One sentence is synthesised at a time for all connections (on the CPU Kokoro
  already uses every core). The engine is a persistent worker, `bun tts_worker.ts` (repo
  root), that loads omp's Kokoro runtime (`~/.omp/agent/cache/tts-runtime/kokoro-*`,
  `onnxruntime-node`) and the weights in omp's cache (`~/.omp/agent/cache/tiny-models/`)
  once, then answers one JSON line per sentence with raw PCM. omp itself uses the q8
  weights; when the fp32 ones (`onnx/model.onnx`, 325 MB) are also in that cache the worker
  uses them, because on this laptop's CPU (i7-8650U) they are about 2.7× faster. The worker
  never downloads them; to add them once:
  `curl -L -o ~/.omp/agent/cache/tiny-models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx`
  (sha256 `8fbea51e...a34cb`). The worker starts on the first reading, or ahead of time
  when voice mode is turned on or a voice-mode agent is working, and exits after 10 minutes
  without use to give its memory back (about 0.9 GB with fp32, plus 1.1-1.9 GB of GPU
  memory on CUDA). If bun or the runtime is missing, or the worker fails or hangs (60 s per
  sentence), `omp say --out` (a new process that loads the model on every call) is used for
  the next minute instead.
- **GPU (CUDA).** `DEVDECK_TTS_DEVICE` (environment of `serve`) picks the device:
  - `auto` (default): CUDA when an NVIDIA driver, onnxruntime-node's CUDA provider and the
    private CUDA libraries (below) are all there, else the CPU. A CUDA worker first
    synthesises "Ready." and checks the audio. If it fails to start (it reports the error and
    exits: transformers.js repeats a failed first session for every later one, so the CPU
    needs a new process), crashes, hangs, or reports a CUDA error or out-of-memory later, the
    daemon logs why and uses the CPU for the rest of its life (restart it to try CUDA again).
  - `cpu`: never the GPU (the worker gets no CUDA libraries).
  - `cuda`: CUDA only; when it fails, `omp say` is used for a minute, then CUDA is retried.

  The log says which: `tts worker ready on cuda in 2261 ms (fp32 model loaded in 2119 ms)`,
  or `... ready on cpu ... (...; CUDA not used: <reason>)`, and every reading ends with
  `(worker cuda)` / `(worker cpu)`. For the service: `systemctl --user edit devdeck-plus`,
  add `[Service]` / `Environment=DEVDECK_TTS_DEVICE=cpu`, then restart it.

  What it needs (all outside the system, no root): onnxruntime-node 1.26.0's CUDA provider,
  `libonnxruntime_providers_cuda.so` and `libonnxruntime_providers_shared.so` from NuGet
  `Microsoft.ML.OnnxRuntime.Gpu.Linux` 1.26.0 (the same version as onnxruntime-node; its
  postinstall would normally fetch them), next to `libonnxruntime.so.1` in omp's runtime;
  and CUDA 12.9 (cudart, cuBLAS, cuFFT, cuRAND) plus cuDNN 9.10.2 from NVIDIA's pip wheels,
  unpacked into `~/.local/share/devdeck/cuda12/lib/` (2.3 GB). Only the worker gets that
  directory, on its `LD_LIBRARY_PATH`. This laptop's MX150 is a Pascal GPU (compute 6.1):
  cuDNN dropped Pascal in 9.11 and CUDA 13 (Arch's `cuda` package) dropped it too, so do not
  upgrade those; the provider ships sm_60 kernels, which run on 6.1. Downloads were 225 MB
  (nupkg) and 1.56 GB (wheels), about 10 minutes. To install (adjust `kokoro-1.2.1` and
  `napi-v6` to omp's runtime; a newer onnxruntime-node needs the matching nupkg version):

  ```sh
  L=~/.local/share/devdeck/cuda12/lib; mkdir -p $L; cd /tmp
  pip download --no-deps -d cuda12-wheels nvidia-cuda-runtime-cu12==12.9.79 nvidia-cublas-cu12==12.9.2.10 \
    nvidia-cufft-cu12==11.4.1.4 nvidia-curand-cu12==10.3.10.19 nvidia-cudnn-cu12==9.10.2.21
  for w in cuda12-wheels/*.whl; do unzip -o -j $w 'nvidia/*/lib/lib*.so.*' -x '*nvblas*' '*cufftw*' -d $L; done
  curl -L -o ort-gpu.nupkg https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.gpu.linux/1.26.0/microsoft.ml.onnxruntime.gpu.linux.1.26.0.nupkg
  unzip -j ort-gpu.nupkg runtimes/linux-x64/native/libonnxruntime_providers_cuda.so \
    runtimes/linux-x64/native/libonnxruntime_providers_shared.so \
    -d ~/.omp/agent/cache/tts-runtime/kokoro-1.2.1/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/
  rm -r cuda12-wheels ort-gpu.nupkg
  ```

  To remove the GPU path: `rm -r ~/.local/share/devdeck/cuda12` and delete the two
  `libonnxruntime_providers_*.so` files again; `auto` then uses the CPU without trying.
  - **GPU memory.** The 2 GB MX150 holds 1.1 GB after loading and 1.9 GB after a
    290-character sentence; a 350-character one (or a long one read slowly) fails to
    allocate. The worker then synthesises that sentence in two halves split at a comma near
    the middle (stderr: "out of GPU memory for N characters, splitting it"), and splits
    anything that long up front from then on.
  - **fp16** weights on the MX150 were slower (real-time factor 1.2-1.3; Pascal has little
    fp16 throughput), produced NaN audio and ran out of memory at 290 characters: not used.
- **Measured** on the i7-8650U (8 threads) and its MX150 (2 GB), real-time factor =
  synthesis time / audio length:

  | engine | start | per sentence (~115 chars, 7.5-7.9 s of audio) | real-time factor |
  |---|---|---|---|
  | worker, fp32, CUDA | 2.2 s (load 1.1 s + warm-up) | 2.1 s | 0.26-0.34 |
  | worker, fp32, CPU | 1.2 s (model load 1.0 s) | 3.9-4.7 s | 0.5-0.6 |
  | worker, q8, CPU | 1.1 s (model load 1.0 s) | 12-12.7 s | 1.5-1.6 |
  | `omp say --out` (q8) | every call | 15 s | 1.8 (2.2 for a short sentence) |

  CPU vs CUDA, fp32, warm, mean of 3 runs (2026-10-23):

  | sentence | audio | CPU | CUDA |
  |---|---|---|---|
  | 45 chars | 3.15 s | 1.57 s (RTF 0.50) | 1.08 s (RTF 0.34) |
  | 116 chars | 7.5 s | 3.94 s (RTF 0.53) | 2.15 s (RTF 0.29) |
  | 290 chars | 18.75 s | 11.05 s (RTF 0.59) | 4.90 s (RTF 0.26) |

  Both give the same audio (same length, RMS and peak within 1%). CUDA also leaves the CPU
  free: three 116-character sentences (with model load) took 53 s of CPU time on the CPU
  path and 8.8 s with CUDA. Through the daemon, a fresh CUDA worker's first sentence
  arrived 3.5 s after the `say` (worker start included), 1.1 s with a warm worker.
  With fp32 on the CPU a 1900-character reply (19 sentences, 149 s of audio) took 90 s in
  total, the first sentence arrived after 5.7 s (worker start included) and the phone never
  waits between sentences; with q8 the total was 253 s, so playback would stall. Opus at 24
  kbit/s is about 3 KB per second of speech.
- **Cache.** Encoded sentences are kept in memory per (text, voice, speed) for 30 minutes
  after their last use, at most 50 MB (least recently used dropped first), so replaying a
  reply is instant.

**State on disk.**
- Delivered ids (last 2000) are kept in `~/.local/state/devdeck/seen.json`.
- Partial uploads live in `~/.local/state/devdeck/partial/` until complete.
- Sessions deleted from the phone wait in `~/.local/state/devdeck/trash/` for 30 days.
- The models list is cached in `~/.local/state/devdeck/models.json`, provider usage limits
  in `~/.local/state/devdeck/usage.json`.
- `ddctl`'s control socket is `~/.local/state/devdeck/ctl.sock` (see "Concierge and `ddctl`").

### Live calls (daemon)

This replicates omp 18.12.6's `/live` (`packages/coding-agent/src/live/`), except that the
phone holds the WebRTC peer. The daemon does the rest:
```
phone (WebRTC, foreground service) <-> OpenAI GPT Live         audio, straight over the internet
phone <-> daemon (this link)           offer/answer, state, captions, delegations, notices
daemon <-> OpenAI sideband WebSocket   delegations in; progress, final replies, notices out
daemon -> concierge pane (or the direct terminal) -> ddctl -> daemon
```
- **Login.** omp's ChatGPT OAuth credentials are read from `~/.omp/agent/agent.db`
  (`auth_credentials`, provider `openai-codex`, enabled, valid for at least another minute),
  read-only: refreshing rotates the refresh token, which only omp may do. The login that
  last worked goes first; one that is refused (401/403 expired, 404 for an account without
  GPT Live, such as a free plan) hands over to the next. When all have expired the daemon
  runs `omp token openai-codex` once (omp refreshes the login itself; the printed token is
  discarded), then gives up with "omp's ChatGPT login has expired; open omp once so it
  refreshes".
- **Signalling.** `POST https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`
  with omp's headers (`Authorization`, `OpenAI-Alpha: quicksilver=v2`, `User-Agent: Codex
  Desktop/0.159.0`, `originator`, `version`, `session-id`/`thread-id` (one UUID per call),
  `x-session-id` (another), `chatgpt-account-id`) and `{sdp, session:{model:"gpt-live-1-codex",
  instructions, audio:{output:{voice}}, delegation:{type:"client"}}}`. The answer is `201`
  with the SDP answer as the body and `Location: /v1/realtime/calls/rtc_...` (the call id).
  The instructions are omp's live prompt adapted: the backend is the concierge (or one
  terminal's agent), everything about terminals is delegated, `Notice:` context is told at
  the next pause, `Routing:` context is silent.
- **Sideband.** `wss://api.openai.com/v1/live/<call id>` with the same headers, after the
  answer went to the phone (5 attempts, 15 s each, backoff from 0.5 s). It is a small stdlib
  WebSocket client (TLS, masked frames, fragments, ping/pong, close) driven by one I/O thread
  that also sends everything queued for the call; it pings after 15 s without a frame and
  gives up after 45 s. An `error` event or a close ends the call (`live {phase:"error"}`).
  The sideband also carries both audio streams (`session.input_audio.append`,
  `session.output_audio.delta`), which are ignored. Events used: `session.started`
  (`listening`), `input_transcript.added` / `output_transcript.added` / `turn.done`
  (captions, coalesced like omp: cumulative or delta pieces grow a turn, the piece after a
  final starts the next), `delegation.created`, `error`; acknowledgements
  (`session.context.appended`, `delegation.context.appended`), `turn.created`/`turn.delta`
  and `session.usage.updated` are ignored, anything else is logged once per call.
- **Delegations.** `delegation.created {item:{id, content:[{type:"input_text", text}]}}` is
  pasted (bracketed paste + Enter, so it steers a working agent) into the concierge pane
  verbatim, or into the direct terminal as `[voice] <text>`; the concierge's tmux session is
  created first if missing and the paste waits (up to 30 s) until omp runs in it. A direct
  terminal that is asking gets the text as its answer instead (the option it names, else a
  custom answer; one question only). The newest delegation replaces the previous one, as in
  omp. Every 0.5 s the routed pane's session file is read from where the delegation started:
  each new assistant message with tool calls and visible text goes back as
  `delegation.context.append {channel:"commentary"}` (chunks of at most 500 UTF-8 bytes); the
  turn's last message (any other stop reason) goes back without a channel as `"Agent Final
  Message":\n\n<text>` (at most 6000 characters); an aborted or failed turn, a direct
  terminal's question, a pane that disappears, or a paste that fails also end the delegation
  with a spoken final message. Delegations are routed one at a time, in order.
- **Notices.** The sessions poller (which also runs while a call is up, even with no phone
  connected) watches the other agent panes (not the routed one, not the concierge): working
  → idle with a new final reply (`stop`, with text) gives "`<terminal>` finished: `<first
  sentence>`", a new question "`<terminal>` is asking: `<question>` Options: ...". The
  terminal is named by its session when that has one pane. They go to the phone at once
  (`live_notice`) and to the voice model at most once per 20 s (merged) as
  `session.context.append {channel:"speakable"}` with `Notice: ...`. Verified on a real call:
  the server acknowledges it (`session.context.appended`) and the model speaks it at the next
  pause, even with nobody talking (with or without a channel). The first
  `session.context.append` of a call (the `Routing:` line plus the agent terminals) is a
  probe: an `error` within 5 s would mark it unsupported, and notices would then go as
  commentary on the running delegation, else wait for the next final message.
- **Mode switches** (`live_mode` from the phone, `ddctl live`) change where the next
  delegation goes and tell the model with a silent `Routing:` context line.
- **Lifecycle.** One call per daemon. The phone's link dropping does not end it; when the
  phone has had no connection for 60 s the call is closed (`session.close`). `live_stop`, a
  daemon shutdown and a replaced call close it the same way.

### Concierge and `ddctl`

In concierge mode, Live hands each request to a small omp session, the concierge, which
knows every terminal through `ddctl` and passes coding work on to the right agent.

- **Session**: tmux session `devdeck-voice`, created on the first Live start when missing (no
  other session is touched). Its working directory is `~/.local/share/devdeck/concierge/`; the
  daemon copies `concierge/AGENTS.md` from this repo there whenever it creates the session
  (when the content differs), so edits to the repo file apply to the next concierge.
- **Command**: `env PATH=<this repo>:$PATH DEVDECK_CTL=<socket> omp --model <model> --thinking
  <level> --tools bash,read --no-skills --no-title`, passed to tmux as separate arguments (no
  shell). tmux takes a new pane's `PATH` from the client and fish's startup rewrites it, so
  `-e PATH=...` alone would leave `ddctl` off the concierge's PATH. The model is
  `DEVDECK_CONCIERGE_MODEL` (`provider/id[:level]`, default `anthropic/claude-haiku-4-5:low`).
  Only `bash` and `read` are enabled: the `ask` tool would open a dialog that stalls a voice
  conversation, and a small tool set keeps the prompt short (3% of Haiku's context at start)
  and the replies fast (4 to 10 s per typed test turn). If omp exits, the session ends and the
  next Live start recreates it.
- **AGENTS.md** tells the concierge: what it is (a fast voice concierge, not a coder); to use
  `ddctl` for everything about terminals; to answer in one to three plain spoken sentences
  with no markdown, ids or paths; to write one short sentence before multi-step work (relayed
  as progress) and to report what it did; routing (the terminal the user names, else the omp
  terminal whose directory and title match, else a new omp terminal in the project; clear,
  complete instructions; reply at once instead of waiting, since the daemon announces when an
  agent finishes or asks); when to answer agents' questions itself (only answers the user
  already gave, or mechanical choices) versus asking the user; switching Live mode only when
  asked; safety (never stop or close terminals unless asked, change models only when asked,
  session `main` only read, plus send/queue/answer when explicitly asked).

**`ddctl`** (repo root, Python stdlib) prints short plain text for an LLM; `--json` (first or
last argument) prints the daemon's raw reply. A terminal is a tmux target (`main:1.1`); a bare
session name or `session:window` means its active pane.

| Command | Does |
|---|---|
| `terminals` | every pane: target, omp state (idle/working/asking) or shell, session title, model and thinking, context use, cwd; the pane ddctl runs in (`$TMUX_PANE`, i.e. the concierge itself) is named last and left out of the counts |
| `status <t>` | pane line, last user message, latest assistant text, current turn's tool calls, open question |
| `last <t> [--full]` | last final reply (cut at 6000 characters without `--full`) |
| `send <t> <text>` | sends; steers when the agent is working |
| `queue <t> <text>` | queues for after the current turn (sent at once when idle) |
| `stop <t>` | stops the current turn |
| `new [--omp] [--cwd DIR]` | new terminal (in DIR), optionally starting omp |
| `model <t> <model[:level]>` | exact `provider/id` or words ("sonnet 5:high"): matched against the daemon's model catalog (`models.json` next to the socket, else `omp models --json`), preferring the terminal's current provider, then the providers of omp's `modelRoles`; ties are listed instead of guessed |
| `effort <t> <level>` | thinking level |
| `ask <t>` | the open question with numbered options and the recommended one |
| `answer <t> <answer>` | a label, an option number or own words for a single question; JSON `{qid: label(s)}` or the daemon's answer list for several |
| `diff <t>` | git branch, changed files (25 shown) and `--shortstat` against HEAD in the pane's cwd, computed by ddctl itself |
| `live direct <t>` / `live concierge` | switches Live mode |

**Control socket.** `$DEVDECK_CTL`, else `~/.local/state/devdeck-plus/ctl.sock` (the daemon's
`serve --ctl`, default `<state dir>/ctl.sock`). The socket is mode 600 (its directory is
created 700 when missing), and the daemon also checks the peer's uid (`SO_PEERCRED`). One JSON line request
`{"cmd": ..., ...args}`, one JSON line reply `{"ok": true, ...}` or `{"ok": false, "error":
"..."}`, then the connection closes. ddctl waits up to 150 s (a model switch may wait for the
catalog). Requests (the daemon's side):
- `terminals` → `{terminals:[...]}`: the `sessions` pane list, freshly polled.
- `status {target}` → `{pane, lastUser, lastAssistant, tools:[intent or "name args"] (at
  most 8, newest last), ask}`; `last {target}` → `{text, id}` (the final reply, or nulls);
  `ask {target}` → `{ask}`; `answer {target, answers}` (the phone's `answer` list) → `{}`.
- `send {target, text}` → `{result:"sent"|"steered"}` (refused while the agent asks);
  `queue {target, text}`, `stop {target}`, `model {target, selector}` (exact catalog
  selector, `:level` optional), `effort {target, level}` → `{result?}` (the phone's `cmd`
  commands `queue`, `stop`, `switch`, `effort`).
- `new {omp?, cwd?}` → `{target}` (a `phone-N` session; `omp` types `omp` + Enter into it;
  `cwd` must be an existing absolute directory).
- `live {mode, target?}` → `{mode, target, active}`: routes the running call, or only sets
  the default for the next one (`active:false`).
- An unknown terminal is an error that lists the terminals.

### App (`android/`, `web/`)

- **Shell**: a plain Java shell (no Gradle). A foreground service owns the connection
  (happy-eyeballs dial of all PC addresses), the offline queue, uploads, the wakelock and
  notifications.
- **LiveService** is a foreground service of type microphone. It runs the WebRTC peer
  straight to OpenAI with hardware AEC/NS, `MODE_IN_COMMUNICATION`, and routes to Bluetooth,
  then wired, then the speaker. Its notification has Mute and End. While a call runs,
  LinkService keeps the link up with 10 s pings, even when hidden.
- **UI**: a single-page web app (`web/`, built with bun) shown in a WebView. The assets
  are served from `https://appassets.androidplatform.net/web/index.html`; no remote content
  is loaded and links open externally.
- **Busy indicators**: in a WebView any running CSS animation redraws the whole view every frame
  (about a quarter of a core each for the app and the renderer, per measurement on the
  XCover Pro). The long-lived ones (working and asking badges, running tool rows, the working
  row, unsent items, a pending answer) therefore step at 2 Hz from one shared timer
  (`ticking()` in `web/src/util.ts`). Hidden ones are skipped; the timer stops when none is left
  or the app is hidden.
  Only short-lived loading spinners and the voice/Live visuals use CSS animations.
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
  - Live: `liveStart(opts)` with `{voice, mode:"concierge"|"direct", target?}` starts a call
    (asks for `RECORD_AUDIO` first), `liveStop()` hangs up (and sends `live_stop`),
    `liveMute(bool)`. The shell reports `live_local {active, phase, muted, route, mode,
    target?, error?}` on changes and `live_local {mic, spk}` levels (at most 10 a second),
    and replays the state to a reloaded page.

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
| Live | `watch {target, view}`, `pause`, `resume`, `resync`, `ping {ts}`, `keys {target, keys[]}`, `tap {target, row}`, `type {target, text}`, `new {cwd?, omp?, yolo?, resume?:sessionId}` (→ `created {target:"phone-N:W.P"}`; `resume` needs `omp:true` and starts `omp --resume <id>`) |
| Queued (carry `id`, always answered by `ack {id, ok, error?}`, deduplicated) | `send {target, text, enter}`, `clip {text}`, `answer {target, toolCallId, answers:[{qid, selected[], custom?, note?}]}` |
| Voice (live, never queued) | `voice {target, on, opts}`, `say {req, target?, entryId?, text?, voice?, speed?}`, `say_stop {req?}` (see "Voice messages") |
| Live (never queued) | `live_offer`, `live_mode`, `live_stop` (see "Live messages") |
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
- `models {}` → `models {models:[{selector:"provider/id", provider, id, name, kind, contextWindow, maxTokens, reasoning, thinking:[levels]|null, vision, price:{input, output, cacheRead, cacheWrite}|null, int|null, webSearch, usage:{count, last(ms), tps, ttft(ms)}|null, hidden}], fetchedAt(ms)}`.
  Every catalog kind; served from cache, usage recomputed (see "Models").
- `roles {target?}` → `roles {storage, defaultThinking, roles:[{name, label, group:"chat"|"custom"|"kind", accepts:[kinds], thinking, value|null, selector|null, level|null, auto|null, desc}], cycle, chains:{key:[selectors]}, thresholds:{key: tokens|"f…"|"…%"}, presets:[{name, roles, thinking}]}`:
  omp's settings in the pane's omp cwd (home without `target`; see "Model roles").
- `roles_set {target?, key, value, base}` → `roles {...}`: `key` is one of `modelRoles`,
  `retry.fallbackChains`, `cycleOrder`, `compaction.modelThresholds`, `modelPresets`;
  `value` the whole new value, `base` the value it was edited from. Errors come back as
  `error {req}`.
- `history {target, all?}` → `history {cwd, sessions:[{id, title, recap?, mtime(ms), live, current, pinned, cwd?}]}`:
  the sessions of the pane's omp cwd, pinned first then newest, at most 50, empty ones
  skipped. With `all:true`: every project's sessions (at most 100), each with its `cwd`.
- `cmd {target, cmd, arg?}` → `cmd {ok, error?, info?}`: `cmd` is one of `switch`,
  `effort`, `fast`, `plan`, `compact`, `new`, `clear`, `retry`, `resume`, `rename`, `stop`,
  `queue`, `page`, `preset` (table in "omp commands"). Refusals and failures also come back as
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
- **Live** (see "Live messages" below): `live`, `live_answer`, `live_transcript`,
  `live_delegation`, `live_notice`.
- **Other replies**: `created`, `ack`, `pong`, `error {error, req?}`, `full`, `ls`, `read`,
  `git`, `models`, `roles`, `history`, `cmd`.

**Native omp pages** (requests as above; live only). `error {req, error, code?}`: `code` is
`no_extension` when the pane's omp has not loaded the devdeck extension, `btw_busy`, `busy`
(omp works) or `live` (session open in a terminal).
- `BtwTopic = {id, title, status:"running"|"complete"|"cancelled"|"error", updated(ms),
  turns:[{question, answer, status, error?, ts(ms)}], source:"devdeck"|"omp"}`.
- `btw_list {target}` → `btw_list {target, sessionId, topics:[BtwTopic]}`, newest first.
- `btw_ask {target, question, topicId?}` → `btw_ask {target, topicId}` once started.
- `btw_cancel {target, topicId?}` → `btw_cancel {cancelled}`.
- Pushed to every unpaused client watching `target` in the chat view, and to the asker:
  `btw_delta {target, topicId, delta}`, `btw_record {target, topic}` (each status change).
- Pane field `planReview?: {id, title, choices:[{id, label, needsFeedback?}],
  tiers:[{role, label, model?}]|null, defaultRole?}` (a change wakes paused clients).
- `plan_get {target, id}` → `plan_get {id, path, markdown}`;
  `plan_answer {target, id, choice, feedback?, role?}` → `plan_answer {ok, error?}`;
  `plan_open {target}` → `plan_open {ok, error?}`.
- `tree {target}` → `tree {target, sessionId, leafId, entries:[{id, parentId, kind:"user"|
  "assistant"|"tool"|"compaction"|"branch_summary"|"notice"|"other", preview, ts, label?,
  onPath}]}`.
- `goto {target, entryId, summarize?, rewind?}` → `goto {ok, error?, draft?}` (`draft`: the
  prompt text when the entry is a user prompt; `rewind` requires one).
- `settings {target?}` / `settings_set {target?, key, value}` (`value:null` resets) →
  `settings {items:[{key, group, type, value?, default?, options?, label?, description,
  scope:"global"|"project"|"default", secret?}], restartHint}`.
- `session_info {target}` → `session_info {id, file, cwd, title, created, modified, entries,
  userMessages, assistantMessages, models:[{model, count}], tokens:{input, output, cacheRead,
  cacheWrite}, cost|null, artifactsBytes, btwTopics, parentSession?}`.
- `session_delete {target, id}` → `session_delete {ok, trashId}`;
  `session_restore {trashId}` → `session_restore {ok}`.
- `usage {target?, force?}` → `usage {target?, fetchedAt, generatedAt, reports, unavailable,
  disabled, resets|null, resetsError?, autoRedeem?:{"openai-codex", anthropic}, session?:
  {tokens:{input, output, cacheRead, cacheWrite}, cost|null}, stale?}`. `reports` are omp's
  `omp usage --json` reports (`{provider, fetchedAt, limits:[{id, label, scope, window:{id,
  label, durationMs?, resetsAt?}, amount:{used?, limit?, usedFraction?, unit}, status}],
  metadata:{planType?, email?, accountId?, orgName?, limitReached?}}`), `unavailable` /
  `disabled` its `accountsWithoutUsage` / `disabledCredentials`, `resets` the accounts of
  `omp usage reset --json` (`{provider, credentialId, email, accountId, availableCount,
  redeemableCount, soonestExpiry?, credits:[{title, status, expiresAt}], unavailableReason?,
  error?}`); `session` only with an omp `target`. `stale:true`: a refresh runs and a `usage`
  push without `req` (same shape, `error?` when it failed) follows.
- `usage_reset {account:"provider/credentialId"}` → `usage_reset {ok, account, output,
  left|null}` (spends one saved reset; irreversible, the app confirms first).
- `usage_history {days?:1-30}` (default 7) → `usage_history {days, sinceMs, series:[{provider,
  email?, accountId?, limitId, label, windowLabel, points:[[ms, usedFraction]]}]}`.

**Live messages.** One call per daemon.
- `live_offer {req, sdp, voice, mode:"concierge"|"direct", target?}` → `live_answer {req,
  sdp, callId}` or `error {req, error}` (plus `live {phase:"error", error}` without a
  `callId`). `sdp` is the phone's complete offer (ICE gathered: one Opus send track, receive
  audio, data channel `oai-events`); `voice` is one of `arbor`, `breeze`, `cove`, `ember`,
  `juniper`, `maple`, `sol` (default), `spruce`, `vale`; `mode` defaults to the last one used;
  `target` (direct mode) must be an omp pane. A second offer while a call runs is refused
  unless it comes from the same `client` (or connection), which replaces its own call (the
  old one ends without an `ended` message).
- `live_mode {mode, target?}`: routes the call's next delegations (also the default for the
  next call); refusals come back as `error {error}`.
- `live_stop {}`: hangs up (`session.close` on the sideband), answered by `live
  {phase:"ended"}`.
- `live {phase, mode, target?, callId?, error?}` (PC → client) on every change: `connecting`
  (before and right after `live_answer`), `listening`, `speaking` (from the voice model's
  first output transcript to its `turn.done`), `working` (a delegation is in flight),
  `ended`, `error`. `target` only in direct mode; `callId` once known. Re-sent to a phone
  that reconnects with the same `client` id.
- `live_transcript {role:"user"|"assistant", turn, text, final}`: captions; `turn` is an int
  counted per role, so role+turn identifies a caption; `text` is the whole caption so far.
- `live_delegation {id, text, routedTo, mode, state:"sent"|"done"|"failed", error?}`: the
  same `id` again on each state change. `routedTo` is the pane target (the concierge's or
  the direct terminal's). A newer delegation marks the previous one `done`.
- `live_notice {text, target, kind:"finished"|"asking"}`: another terminal's agent finished
  a turn or asks something; sent to the phone at once (the voice model gets them rate-limited).

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
  written before tool calls is not). Synthesis loads the PC's CPU (with CUDA, mostly the
  GPU) while it speaks. Nothing is read while the app is paused; a reply or question that
  arrived meanwhile is read when it comes back. The spoken-form rules are heuristics for
  English markdown.
