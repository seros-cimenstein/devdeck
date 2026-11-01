# Native `/btw`, `/usage` and the other omp pages in DevDeck+ (design notes)

Status: implemented (2026-11-01). `/model`, `/modelpreset`, `/btw`, `/plan-review`, `/rewind`,
`/branch`, `/tree`, `/settings`, `/session`, `/resume`, `/restore` and `/usage` all open phone-native sheets;
the live terminal mirror (`page.ts`) remains only for pages without one (provider logins). The
sections below are the original design; the "Wire contract" section is kept current and the
README documents the shipped behaviour.

Order (most useful first): 1 `/btw` → 2 `/plan-review` → 3 `/rewind` + `/branch` → 4 `/tree`
→ 5 `/settings` → 6 `/session` → 7 `/resume` extras. Each step ships on its own.

## 0. Shared foundation: a `devdeck` omp extension

Today the daemon drives omp only by pasting slash commands into tmux and reading the session
JSONL. That cannot do: streamed side answers, moving the session leaf to an entry, or answering
plan review. omp extensions can (`omp://extensions.md`):
`ctx.runEphemeralTurn` (the `/btw` pipeline, with `onTextDelta` streaming),
`navigateTree(entryId, {summarize})` (command context only), `getPendingPlanReview()` /
`resolvePlanReview(id, choice, input)`, `plan_review_requested`/`plan_review_resolved` events.

- New extension `~/.omp/agent/extensions/devdeck/`, copying the sketch extension's pattern
  (`~/.omp/agent/extensions/sketch/registry.ts` + `server.ts`): on load it starts a localhost
  HTTP server with a random token and publishes `{pid, port, token}` to
  `~/.omp/agent/devdeck/<omp pid>.json`; the daemon maps a pane to its omp pid exactly as for
  sketch (`sketch_reg` in `devdeck.py`).
- Session-control actions that need command context go through hidden slash commands the
  daemon pastes with the existing `PaneCommand` machinery (paste + Enter + confirmation):
  `/devdeck-goto <entryId> [summarize]`. Everything else is HTTP to the extension.
- Keep the extension's source in this repo (`omp-ext/devdeck/`) and have `devdeck.py
  install-service` symlink it into `~/.omp/agent/extensions/`, so it is versioned with the app.
  (Optionally move the sketch extension the same way.)
- Missing extension → each native sheet shows "omp in this terminal hasn't loaded the devdeck
  extension; restart omp", like `SKETCH_MISSING`.

## 1. `/btw` (side questions)

omp: `/btw <q>` = one ephemeral turn over the session's context, no tools, never in the
transcript, runs while the agent works; bare `/btw` = history; follow-ups per topic; history
saved per topic under the session's artifact dir `btw-history/` (JSON per entry, seen on disk as
`entry-<id>.json` with `question, answer, status, createdAt, updatedAt, id, leafId`; re-check the
current 18.x topic format before coding).

Native UI (new `web/src/btw.ts`):
- Palette `/btw` and typed `/btw …` + Send are intercepted in `compose.ts` (like `/model`).
  `/btw question` asks at once; bare `/btw` opens the BTW sheet.
- BTW sheet: topic list (newest first, status chip running/complete/cancelled/error) →
  topic view with the Q/A thread rendered by the chat markdown renderer, live streaming text,
  Copy, Follow-up input at the bottom, Cancel while running.
- Also reachable from the session menu ("Side questions…") and a small chip in the control
  strip while one is running.

Mechanism:
- Ask/follow-up: daemon → extension `POST /btw {question, topicId?}`; the extension calls
  `ctx.runEphemeralTurn({promptText, history, conversationKey: topicId, onTextDelta})`,
  streams deltas back (SSE or long-poll), and writes the finished topic into omp's
  `btw-history/` format so the TUI's own `/btw` history shows it too (verify omp tolerates a
  sidecar written by an extension; if not, keep DevDeck topics in
  `~/.local/state/devdeck/btw/<sessionId>/` and show omp's own topics read-only).
- Cancel: `POST /btw/cancel` → abort signal.
- History: daemon reads `btw-history/` from disk (no extension needed), so topics asked in the
  terminal appear too.
- Wire: new client msgs `btw` / `btw_cancel` / `btw_list`; server msgs `btw_delta`,
  `btw_record` (mirror omp RPC's names and shapes from `omp://rpc.md` "Side questions").
- Don't paste `/btw` into the TUI: its inline panel would be detected as a "page" and Esc to
  close it is dangerous while the agent works (Esc = stop).

Acceptance: ask while the agent is working, answer streams on the phone, transcript unchanged,
follow-up keeps context, topic visible in omp's own `/btw` history.

## 2. `/plan-review`

Native sheet like the ask sheet: plan markdown (newest plan file; path from
`plan_review_requested`), choices (execute / compact / keep / refine…), the execution-model tier
slider (`tiers`), feedback box for refine. Extension forwards `plan_review_requested` to the
daemon (pushes a pane flag like `ask`), answers with `resolvePlanReview`; `plan_review_resolved`
clears it. "Open plan review" = extension `openPlanReview()` (never aborts work, unlike the
slash command). Acceptance: approve/refine a plan entirely from the phone; terminal overlay
closes itself.

## 3. `/rewind` and `/branch` (transcript rewind)

Native list of this branch's user prompts (from the session JSONL path root → leaf, which the
daemon already parses), newest first, with time and first lines. Tap → confirm → daemon pastes
`/devdeck-goto <parentOfPrompt>` (handler: `navigateTree(id, {summarize:false})`) and puts the
prompt text back in the DevDeck compose box (omp puts it in its own editor; mirror that).
Acceptance: rewind two prompts from the phone, chat view reloads at that point, draft restored.

## 4. `/tree`

Native tree of the whole session file: entries with `parentId`, branch points expanded,
current leaf marked, labels and branch summaries shown, filters (user prompts only / all).
Tap an entry → sheet: "Go here" / "Go here with summary" (`/devdeck-goto <id> summarize`).
Large sessions: daemon sends a compact skeleton (id, parentId, role, 80-char preview, ts) and
the full text on demand. Acceptance: switch between two branches from the phone.

## 5. `/settings`

Data: `omp config list --json` (values + layer) and `omp config get/set/reset` for writes (the
CLI writes `~/.omp/agent/config.yml`, as `/settings` does). Native sheet grouped like omp's
page, search box, typed editors (toggle / enum select / number / text / JSON for lists),
"Reset" per key, project-layer keys shown read-only. Check during build: whether `list --json`
carries descriptions/types/enum values (else extract omp's settings schema once and ship it),
and whether a running omp picks up `config set` without restart (show "restart omp" when not).
Acceptance: flip a boolean and an enum from the phone; `omp config get` shows it.

## 6. `/session`

Read-only native sheet: id, file, cwd, title, created, entries, model history, tokens/cost
(session JSONL usage + `~/.omp/stats.db`), artifacts size, BTW topic count; Copy id, open folder
in Files. Acceptance: matches omp's `/session` page facts.

## 7. `/resume` extras

The native Resume sheet already exists (`openHistorySheet`). Missing vs omp's picker: delete a
session and the all-projects tab. Delete = daemon moves the session file and its artifact dir to
`~/.local/state/devdeck/trash/` (never the live session), with Undo. Acceptance: delete and
restore a session from the phone.

## Cleanup when done

Remove each migrated command from `PAGE_CMDS` and the "omp pages..." menu; keep `page.ts` only
for the provider-login link; update README ("omp controls in the chat view", "Live omp pages",
wire tables) and `ddctl` if it exposes any of these.

## Wire contract (daemon ⇄ app), binding for both sides

Conventions as in README "Wire protocol": requests carry `req` and are answered with the same
`req` (same `t` as the request unless noted) or `error {req, error, code?}`. All of these are
live-only (the UI disables them offline). `target` is an omp pane. When the pane's omp has not
loaded the devdeck extension, extension-backed requests fail with
`error {req, code:"no_extension", error:"omp in this terminal hasn't loaded the devdeck extension; restart omp"}`.

### BTW
`BtwTopic = {id, title, status:"running"|"complete"|"cancelled"|"error", updated(ms),
turns:[{question, answer, status, error?, ts(ms)}], source:"devdeck"|"omp"}` (`title` = first
question, ≤120 chars).
- `btw_list {target}` → `btw_list {target, sessionId, topics:[BtwTopic]}` newest first (topics
  asked from the phone and from omp's own `/btw`). No extension needed.
- `btw_ask {target, question, topicId?}` → `btw_ask {target, topicId}` once started (`topicId`
  given = follow-up in that topic). Refused with `error {code:"btw_busy"}` while a side question
  runs in that session.
- `btw_cancel {target, topicId?}` → `btw_cancel {cancelled:bool}`.
- Pushed (PC → client) to every client watching `target` in chat view, plus the asker:
  `btw_delta {target, topicId, delta}` and `btw_record {target, topic:BtwTopic}` (full topic on
  each status change; last one wins). Not sent while paused; a resumed client re-fetches with
  `btw_list`.

### Plan review
- Pane (in `sessions`) gains `planReview?: {id, title, choices:[{id, label, description?,
  needsFeedback?:bool}], tiers:[{role, label, model?}]|null, defaultRole?}` while omp's plan
  review awaits an answer (like `ask`; a change wakes paused clients).
- `plan_get {target, id}` → `plan_get {id, path, markdown}`.
- `plan_answer {target, id, choice, feedback?, role?}` → `plan_answer {ok, error?}`.
- `plan_open {target}` → `plan_open {ok, error?}` (opens the review on the newest plan file;
  `ok:false` with omp's reason when not possible).

### Tree / rewind
- `tree {target}` → `tree {target, sessionId, leafId, entries:[{id, parentId|null,
  kind:"user"|"assistant"|"tool"|"compaction"|"branch_summary"|"notice"|"other", preview,
  ts(ms), label?, onPath:bool}]}` (`preview` ≤ 160 chars, one line; `onPath` = on root→leaf).
- `goto {target, entryId, summarize?:bool, rewind?:bool}` → `goto {ok, error?, draft?}`.
  `rewind:true` with a user entry = transcript rewind (lands before that prompt; `draft` is
  the prompt text for the compose box). Refused while the agent works
  (`error {code:"busy"}`).

### Settings
- `settings {target?}` → `settings {items:[{key, group, type:"boolean"|"enum"|"number"|
  "string"|"array"|"record", value?, default?, options?:[string], description, scope:"global"|
  "project"|"default"}], restartHint:bool}` (`group` = first key segment or omp's page group;
  `restartHint` = running omp sessions only pick up changes after restart).
- `settings_set {target?, key, value}` → `settings {...}`; `value:null` resets the key.

### Session info
- `session_info {target}` → `session_info {id, file, cwd, title, created(ms), modified(ms),
  entries, userMessages, assistantMessages, models:[{model, count}], tokens:{input, output,
  cacheRead, cacheWrite}, cost:number|null, artifactsBytes, btwTopics, parentSession?}`.

### Resume extras
- `history {target, all?:true}`: with `all`, sessions of every project; each session then
  also has `cwd` (and `target` becomes optional, `cwd` "" without it).
- `session_delete {target, id}` → `session_delete {ok, trashId}` (refuses the pane's live
  session and sessions open in any pane: `error {code:"live"}`).
- `session_restore {trashId}` → `session_restore {ok}`.
- `new {cwd, omp:true, yolo?, resume?:sessionId}`: opens a terminal running
  `omp --resume <id>` in `cwd` (for sessions of another project).

### Restore (`/restore`, sessions cut off mid-turn or closed with their terminal)
- Every `history` session has `interrupted:bool` and `terminated:bool`, both false while a
  running omp has it open. `interrupted`: omp's `--restore` rule holds (the branch's last
  turn was cut off with no normal `session_exit` after it, or the last process died without
  a normal exit while a revivable subagent was mid-turn). `terminated`: its last omp ended
  without a normal exit (SIGKILL, or SIGHUP when tmux/the terminal went away) and the
  daemon's terminals record (`STATE_DIR/terminals.json`) saw it open in a tmux pane; files
  older than that record count when modified in the last 48 h.
  `history {all:true, restorable:true, target?}` lists only sessions that are either.
- `new {cwd, omp:true, yolo?, resume:sessionId, restore:true}` → `created {target, view:"chat"}`:
  a new terminal in `cwd` (the session's recorded folder is accepted even outside home)
  running `omp --restore <id>`; `error` when a running omp has the session open.
- `restore_many {items:[{id, cwd?}]}` → `restore_many {results:[{id, target?, restored?,
  error?}]}`: one terminal per item, `omp --restore <id>` when interrupted (`restored:true`),
  else `omp --resume <id>`, `--yolo` when the record says its pane had it; per-item errors
  do not stop the rest; no `created`, the client keeps watching what it watched.
- PC → client `restore_offer {sessions:[HistorySession with cwd]}`: once the daemon has
  started, to each connecting client, the interrupted or terminated sessions modified in the
  last 24 h (at most 20), minus ones restored, reopened or finished since; pushed again to
  every client (possibly empty = withdraw) when some are restored (`new {restore}`,
  `restore_many`) or the offer is dismissed.
- Client → PC `restore_dismiss {}`: drops the offer for this daemon run.
- App: Resume sheet rows show "⚡ Interrupted" (first in their section, Restore on tap plus
  Resume) or "Closed"; `/restore` (palette or typed) and the banner's Restore... open a
  checklist of every interrupted or terminated session of every project (tag "⚡ Interrupted"
  = continues the cut-off turn, "Closed" = just reopens; "No sessions to restore" when
  empty) with Select all and "Restore N" → `restore_many`, then the toast "Opened N
  terminals" without leaving the current view.

### Usage (`/usage`)
Data: `omp usage --json` and `omp usage reset --json`, always with `--no-extensions` (with
extensions loaded the CLI prints its JSON and never exits). No extension needed; `target` is
optional (the limits are global; it only adds the session line).
- `usage {target?, force?}` → `usage {target?, fetchedAt(ms), generatedAt(ms), reports:[omp
  report], unavailable:[{provider, label?, email?}], disabled:[...], resets:[ResetAccount]|null,
  resetsError?, autoRedeem?:{"openai-codex"|"anthropic": "yes"|"no"|"unset"}, session?:{tokens:
  {input, output, cacheRead, cacheWrite}, cost|null}, stale?:true}`. A report is omp's own
  (`{provider, fetchedAt, limits:[{id, label, scope:{windowId?, sharedGroup?}, window:{id, label,
  durationMs?, resetsAt?}, amount:{used?, limit?, usedFraction?, unit}, status:"ok"|"warning"|
  "exhausted"|"unknown"}], metadata:{planType?, plan?, email?, accountId?, orgId?, orgName?,
  limitReached?}}`); `ResetAccount = {provider, credentialId, email?, accountId?, orgId?,
  orgName?, availableCount, redeemableCount, soonestExpiry?, credits:[{id, title, status,
  grantedAt, expiresAt}], unavailableReason?, error?}`. Copies older than 60 s (any with
  `force`) are answered at once with `stale:true`; the refreshed copy then arrives as a pushed
  `usage` without `req` (same shape, `error?` when omp failed, then with the previous copy).
  Clients keep the copy with the newest `fetchedAt` (a push can overtake its stale reply).
- `usage_reset {account:"provider/credentialId"}` → `usage_reset {ok, account, output,
  left|null}`. Irreversible: the app confirms with the account, what the reset restores, the
  current window usage and the soonest expiry. Refused (`error {req}`) for malformed or
  unlisted accounts, accounts omp could not load and ones with no reset usable now. `ok` =
  omp's saved-reset count for the account went down. (`account`, not `target`: `target` is
  always an omp pane.)
- `usage_history {days?:1-30}` → `usage_history {days, sinceMs, series:[{provider, email?,
  accountId?, limitId, label, windowLabel, points:[[ms, usedFraction]]}]}` (default 7 days).
