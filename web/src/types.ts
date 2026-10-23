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
  /** Live omp session facts (agent panes only). */
  omp?: OmpInfo;
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
  selector: string;
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  reasoning?: boolean;
  thinking: string[] | null;
}
export interface ModelsMsg {
  t: "models";
  req: string;
  models: ModelInfo[];
  roles: Record<string, string>;
  fetchedAt?: number;
}
export interface HistorySession {
  id: string;
  title: string;
  recap?: string;
  mtime: number;
  live: boolean;
  current: boolean;
  pinned: boolean;
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

/** Any message crossing the bridge; `t` discriminates, the rest is checked by the consumer. */
export interface Msg {
  t: string;
  req?: string;
  [k: string]: unknown;
}
