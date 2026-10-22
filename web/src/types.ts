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

/** Any message crossing the bridge; `t` discriminates, the rest is checked by the consumer. */
export interface Msg {
  t: string;
  req?: string;
  [k: string]: unknown;
}
