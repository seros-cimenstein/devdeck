// Wire types from the DevDeck contract (server messages arrive as parsed JSON).

export type PaneState = "working" | "asking" | "idle" | "shell" | "running";

export interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}
export interface AskQuestion {
  id: string;
  header?: string;
  question: string;
  options: AskOption[];
  multi: boolean;
  recommended?: number;
}
export interface Ask {
  toolCallId: string;
  questions: AskQuestion[];
}

export interface Pane {
  target: string;
  session: string;
  window: number;
  pane: number;
  name: string;
  cmd: string;
  cwd: string;
  title: string;
  state: PaneState;
  context: string;
  agent: boolean;
  sessionId?: string;
  ask?: Ask;
  /** Pending `request_sketch` of the omp sketch extension (the agent waits for a drawing). */
  sketch?: { toolCallId: string; prompt: string };
  /** omp's plan review waiting for an answer (devdeck extension). */
  planReview?: PlanReview;
  /** Live omp session facts (agent panes only). */
  omp?: OmpInfo;
}

export interface PlanChoice {
  id: string;
  label: string;
  description?: string;
  needsFeedback?: boolean;
}
export interface PlanTier {
  role: string;
  label: string;
  model?: string;
}
export interface PlanReview {
  id: string;
  title: string;
  choices: PlanChoice[];
  tiers: PlanTier[] | null;
  defaultRole?: string;
}
export interface PlanGetMsg {
  t: "plan_get";
  req: string;
  id: string;
  path: string;
  markdown: string;
}
/** Reply of `plan_answer` and `plan_open`. */
export interface OkMsg {
  t: string;
  req: string;
  ok: boolean;
  error?: string;
}

// ---- side questions (/btw)
export type BtwStatus = "running" | "complete" | "cancelled" | "error";
export interface BtwTurn {
  question: string;
  answer: string;
  status: BtwStatus;
  error?: string;
  ts: number;
}
export interface BtwTopic {
  id: string;
  title: string;
  status: BtwStatus;
  updated: number;
  turns: BtwTurn[];
  source: "devdeck" | "omp";
}
export interface BtwListMsg {
  t: "btw_list";
  req: string;
  target: string;
  sessionId: string;
  topics: BtwTopic[];
}
export interface BtwAskMsg {
  t: "btw_ask";
  req: string;
  target: string;
  topicId: string;
}
export interface BtwDeltaMsg {
  t: "btw_delta";
  target: string;
  topicId: string;
  delta: string;
}
export interface BtwRecordMsg {
  t: "btw_record";
  target: string;
  topic: BtwTopic;
}

// ---- session tree (/tree, /rewind, /branch)
export type TreeKind = "user" | "assistant" | "tool" | "compaction" | "branch_summary" | "notice" | "other";
export interface TreeEntry {
  id: string;
  parentId: string | null;
  kind: TreeKind;
  preview: string;
  ts: number;
  label?: string;
  onPath: boolean;
}
export interface TreeMsg {
  t: "tree";
  req: string;
  target: string;
  sessionId: string;
  leafId: string;
  entries: TreeEntry[];
}
export interface GotoMsg {
  t: "goto";
  req: string;
  ok: boolean;
  error?: string;
  draft?: string;
}

// ---- omp settings (/settings)
export type SettingType = "boolean" | "enum" | "number" | "string" | "array" | "record";
export interface SettingItem {
  key: string;
  group: string;
  type: SettingType;
  value?: unknown;
  default?: unknown;
  options?: string[];
  description: string;
  scope: "global" | "project" | "default";
  /** omp's /settings label, when the key is on its settings page. */
  label?: string;
  /** A credential: no value or default is sent and writes are refused. */
  secret?: boolean;
}
export interface SettingsMsg {
  t: "settings";
  req: string;
  items: SettingItem[];
  restartHint: boolean;
}

// ---- session info (/session)
export interface SessionInfoMsg {
  t: "session_info";
  req: string;
  id: string;
  file: string;
  cwd: string;
  title: string;
  created: number;
  modified: number;
  entries: number;
  userMessages: number;
  assistantMessages: number;
  models: { model: string; count: number }[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number | null;
  artifactsBytes: number;
  btwTopics: number;
  parentSession?: string;
}
export interface SessionDeleteMsg {
  t: "session_delete";
  req: string;
  ok: boolean;
  trashId: string;
}

// ---- provider usage limits (/usage); reports are omp's `omp usage --json` reports
export interface UsageLimit {
  id: string;
  label: string;
  scope: { provider: string; windowId?: string; shared?: boolean; sharedGroup?: string };
  window?: { id: string; label: string; durationMs?: number; resetsAt?: number };
  amount: { used?: number; limit?: number; remaining?: number; usedFraction?: number; remainingFraction?: number; unit: string };
  /** omp: `ok`, `warning`, `exhausted` or `unknown`. */
  status: string;
  notes?: string[];
}
export interface UsageReport {
  provider: string;
  fetchedAt?: number;
  limits: UsageLimit[];
  metadata?: {
    planType?: string;
    plan?: string;
    email?: string;
    accountId?: string;
    orgId?: string;
    orgName?: string;
    limitReached?: boolean;
    daybreak?: boolean;
  };
  notes?: string[];
}
/** One account of `omp usage reset --json`: its saved rate-limit resets. */
export interface ResetAccount {
  provider: string;
  credentialId: number;
  email?: string;
  accountId?: string;
  orgId?: string;
  orgName?: string;
  availableCount: number;
  redeemableCount: number;
  soonestExpiry?: string;
  credits?: { id?: string; title?: string; status: string; grantedAt?: string; expiresAt?: string }[];
  unavailableReason?: string;
  error?: string;
}
/** An account omp has credentials for but no usage report (`accountsWithoutUsage`, `disabledCredentials`). */
export interface UsageAccountNote {
  provider: string;
  label?: string;
  email?: string;
}
export interface UsageMsg {
  t: "usage";
  /** Absent on the push that follows a `stale` reply. */
  req?: string;
  target?: string;
  fetchedAt: number;
  generatedAt: number;
  reports: UsageReport[];
  unavailable: UsageAccountNote[];
  disabled: UsageAccountNote[];
  resets: ResetAccount[] | null;
  resetsError?: string;
  /** omp's `codexResets.autoRedeem` / `claudeResets.autoRedeem`: `yes`, `no` or `unset`. */
  autoRedeem?: Record<string, string>;
  /** The `target` session's spend (current branch, as /session counts it). */
  session?: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost: number | null };
  /** A refresh is running; a `usage` push without `req` follows when it ends. */
  stale?: boolean;
  /** On a push: the refresh failed (the data is the previous copy). */
  error?: string;
}
export interface UsageResetMsg {
  t: "usage_reset";
  req: string;
  ok: boolean;
  account: string;
  output: string;
  left: number | null;
}
export interface UsageSeries {
  provider: string;
  email?: string;
  accountId?: string;
  limitId: string;
  label: string;
  windowLabel: string;
  /** [recordedAt ms, usedFraction 0..1], oldest first. */
  points: [number, number][];
}
export interface UsageHistoryMsg {
  t: "usage_history";
  req: string;
  days: number;
  sinceMs: number | null;
  series: UsageSeries[];
}

export interface OmpInfo {
  model: string | null;
  modelName: string | null;
  thinking: string | null;
  fast: boolean;
  mode: string;
  ctx: { used: number; window: number } | null;
  todo: { done: number; total: number; text: string } | null;
  cwd: string | null;
  sessionId: string | null;
  /** omp shows a full-screen page/picker/overlay instead of the transcript. */
  page?: { title?: string } | null;
}

export interface ModelInfo {
  /** "provider/id"; the id may itself contain "/". */
  selector: string;
  provider: string;
  id: string;
  name: string;
  /** Catalog kind: "chat" | "tiny" | "image" | "tts" | "stt" | "search" | "judge" | "embedding" | ... */
  kind: string;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  /** The model's own efforts; "off" is always allowed too. */
  thinking: string[] | null;
  vision: boolean;
  /** $ per M tokens; null = unknown. */
  price: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  /** omp's intelligence score. */
  int: number | null;
  /** Chat model that can serve the `web` role. */
  webSearch: boolean;
  /** This machine's omp usage over 30 days: messages, last use (ms), median tokens/s and time-to-first-token (ms). */
  usage: { count: number; last: number; tps: number | null; ttft: number | null } | null;
  /** Catalog noise: collapsed behind "Show N more"; search still finds it. */
  hidden: boolean;
}
export interface ModelsMsg {
  t: "models";
  req: string;
  models: ModelInfo[];
  fetchedAt: number;
}
export interface RoleState {
  name: string;
  label: string;
  group: "chat" | "custom" | "kind";
  /** Model kinds the role accepts. */
  accepts: string[];
  /** Whether a ":level" suffix applies. */
  thinking: boolean;
  /** Raw configured value ("p/id:high", "@smol", "a/x,b/y"); null = unset. */
  value: string | null;
  /** First concrete selector after alias resolution. */
  selector: string | null;
  level: string | null;
  /** When unset: what omp falls back to ("@default", "@smol", ..., "built-in"). */
  auto: string | null;
  desc: string;
}
export interface Preset {
  name: string;
  roles: Record<string, string>;
  thinking: string | null;
}
export interface RolesMsg {
  t: "roles";
  req: string;
  storage: "global" | "project";
  defaultThinking: string | null;
  roles: RoleState[];
  cycle: string[];
  /** retry.fallbackChains as configured; [] = explicitly no fallback. */
  chains: Record<string, string[]>;
  /** compaction.modelThresholds: 90000 | "f90000" | "80%". */
  thresholds: Record<string, string | number>;
  presets: Preset[];
}
export type RolesKey = "modelRoles" | "retry.fallbackChains" | "cycleOrder" | "compaction.modelThresholds" | "modelPresets";
export interface HistorySession {
  id: string;
  title: string;
  recap?: string;
  mtime: number;
  live: boolean;
  current: boolean;
  pinned: boolean;
  /** The session's project folder (`history {all:true}` only). */
  cwd?: string;
}
export interface HistoryMsg {
  t: "history";
  req: string;
  cwd: string;
  sessions: HistorySession[];
}
export interface CmdMsg {
  t: "cmd";
  req: string;
  ok: boolean;
  error?: string;
  info?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  intent?: string;
  args: string;
  argsTruncated?: boolean;
  result?: { text: string; truncated?: boolean; isError?: boolean };
}

interface EntryBase {
  seq: number;
  id: string;
  ts: number;
  textTruncated?: boolean;
}
export interface UserEntry extends EntryBase {
  kind: "user";
  text: string;
}
export interface AssistantEntry extends EntryBase {
  kind: "assistant";
  text?: string;
  thinking?: string;
  thinkingTruncated?: boolean;
  tools: ToolCall[];
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}
export interface CompactionEntry extends EntryBase {
  kind: "compaction";
  summary: string;
}
export interface NoticeEntry extends EntryBase {
  kind: "notice";
  text: string;
  /** omp's customType for custom_message notices (e.g. "async-result"). */
  source?: string;
}
export type Entry = UserEntry | AssistantEntry | CompactionEntry | NoticeEntry;

export interface LinkMsg {
  t: "link";
  state: "unpaired" | "offline" | "connecting" | "online" | "idle";
  host?: string | null;
  rtt?: number | null;
  queued?: number;
  uploading?: { name: string; pct: number } | null;
  wakelock?: boolean;
  notify?: boolean;
}
export interface SessionsMsg {
  t: "sessions";
  list: Pane[];
}
export interface TranscriptMsg {
  t: "transcript";
  target: string;
  sessionId?: string;
  reset?: boolean;
  entries: Entry[];
  hasMore?: boolean;
  req?: string;
  prepend?: boolean;
}
export interface ScreenMsg {
  t: "screen";
  target: string;
  rev: number;
  full: boolean;
  base?: number;
  cols: number;
  rows: number;
  cursor?: [number, number];
  lines?: string[];
  len?: number;
  set?: [number, string][];
  /** Frame of an omp page mirrored into chat view; `false` once the page closed. */
  page?: boolean;
}
export interface AckMsg {
  t: "ack";
  id: string;
  ok: boolean;
  error?: string;
}
export interface FullMsg {
  t: "full";
  req: string;
  entryId: string;
  text: string;
}
export interface LsEntry {
  name: string;
  type: "dir" | "file" | "link";
  size: number;
  mtime: number;
  /** For links: what the target is (null when dangling). */
  linkTo?: "dir" | "file" | null;
}
export interface LsMsg {
  t: "ls";
  req: string;
  path: string;
  parent?: string | null;
  entries: LsEntry[];
}
export interface ReadMsg {
  t: "read";
  req: string;
  path: string;
  size: number;
  mime?: string;
  kind: "text" | "image" | "binary";
  text?: string;
  data?: string;
  truncated?: boolean;
}
export interface GitFile {
  path: string;
  index: string;
  worktree: string;
  orig?: string;
}
export interface GitStatusMsg {
  t: "git";
  op: "status";
  repo: string;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFile[];
}
export interface GitDiffMsg {
  t: "git";
  op: "diff";
  repo: string;
  file?: string;
  staged: boolean;
  diff: string;
  truncated?: boolean;
}
export interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string | number;
}
export interface GitLogMsg {
  t: "git";
  op: "log";
  repo: string;
  commits: GitCommit[];
}

/** One synthesised sentence of an utterance (server `audio`, forwarded by the shell after it queued playback). */
export interface AudioMsg {
  t: "audio";
  req?: string;
  auto?: boolean;
  ask?: boolean;
  toolCallId?: string;
  target: string;
  entryId?: string;
  seq: number;
  last: boolean;
  text: string;
  dur?: number;
}
/** Native speech recognizer events. */
export interface SttMsg {
  t: "stt";
  phase: "ready" | "partial" | "final" | "error" | "end" | "rms";
  text?: string;
  error?: string;
  rms?: number;
}
/** Native player events; `stopped` carries the utterance that was playing. */
export interface TtsMsg {
  t: "tts";
  phase: "start" | "chunk" | "end" | "stopped" | "error";
  seq?: number;
  text?: string;
  req?: string;
  entryId?: string;
  target?: string;
  auto?: boolean;
  ask?: boolean;
  error?: string;
}
export interface VoiceErrorMsg {
  t: "voice_error";
  req?: string;
  auto?: boolean;
  ask?: boolean;
  entryId?: string;
  toolCallId?: string;
  target?: string;
  error: string;
}

// ---- Live (GPT Live realtime voice; audio is native, the daemon streams state and transcripts)
export type LivePhase = "connecting" | "listening" | "working" | "speaking" | "ended" | "error";
export type LiveMode = "concierge" | "direct";
/** Server call state; `target` is the pane talked to directly in direct mode. */
export interface LiveMsg {
  t: "live";
  phase: LivePhase;
  mode?: LiveMode;
  target?: string;
  error?: string;
  callId?: string;
}
/** Native call state (replayed on page load while a call runs), or levels when `mic` is present. */
export interface LiveLocalMsg {
  t: "live_local";
  active?: boolean;
  phase?: "connecting" | "connected" | "ended" | "error";
  muted?: boolean;
  route?: "speaker" | "earpiece" | "bluetooth" | "wired";
  error?: string;
  callId?: string;
  mic?: number;
  spk?: number;
}
/** Live caption; `role`+`turn` identify a bubble, `text` is its whole current text, `final` closes it. */
export interface LiveTranscriptMsg {
  t: "live_transcript";
  role: "user" | "assistant";
  turn: number;
  text: string;
  final: boolean;
}
/** A delegation from the voice model; re-sent with the same id when its state changes. */
export interface LiveDelegationMsg {
  t: "live_delegation";
  id: string;
  text: string;
  routedTo: string;
  mode?: LiveMode;
  state?: "sent" | "done" | "failed";
  error?: string;
}
/** Another terminal finished or started asking while live. */
export interface LiveNoticeMsg {
  t: "live_notice";
  text: string;
  target: string;
  kind: "finished" | "asking";
}

// ---- Sketch (the omp sketch extension's canvas page, relayed by the daemon)
export interface SketchOpenMsg {
  t: "sketch";
  op: "open";
  target: string;
  html: string;
}
export interface SketchHttpMsg {
  t: "sketch";
  op: "http";
  status: number;
  type: string;
  body: string;
}
/** `open`/`down`/`closed` track the relay; other events are the page's own (`data`: JSON text). */
export interface SketchEventMsg {
  t: "sketch_event";
  target: string;
  event: string;
  data?: string;
}

/** Any message crossing the bridge; `t` discriminates, the rest is checked by the consumer. */
export interface Msg {
  t: string;
  req?: string;
  [k: string]: unknown;
}
