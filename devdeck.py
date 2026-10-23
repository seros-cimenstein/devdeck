#!/usr/bin/env python3
"""DevDeck: drive this PC's omp coding agents and shells in tmux from an Android phone.

The phone runs the DevDeck app (android/ + web/): a chat view of each omp session (read
from omp's own session files, so it is cheap to stream over a slow link), a terminal view
(changed screen lines only), native answers to omp's questions, files, git and uploads.
Everything goes over one persistent zlib-compressed TCP connection; the phone queues what
you send while offline and resends it on reconnect.

  devdeck.py pair             build+install the app via adb and share the token
  devdeck.py serve            run the daemon (what the systemd service runs)
  devdeck.py install-service  run the daemon automatically in every graphical session
"""

from __future__ import annotations

import argparse
import base64
import bisect
import collections
import datetime
import hmac
import json
import mimetypes
import mmap
import os
import re
import secrets
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
APK = HERE / "devdeck.apk"
APP_PACKAGE = "dev.devdeck"
APP_ACTIVITY = f"{APP_PACKAGE}/.MainActivity"
CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "devdeck"
TOKEN_FILE = CONFIG_DIR / "token"
STATE_DIR = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "devdeck"
SEEN_FILE = STATE_DIR / "seen.json"
PARTIAL_DIR = STATE_DIR / "partial"
DEFAULT_DEST = Path.home() / "Downloads" / "phone"
UNIT_NAME = "devdeck.service"
DEFAULT_PORT = 47490
DEFAULT_SERIAL = "100.64.0.2:5555"
# Where omp keeps its terminal breadcrumbs; overridable so tests never touch the real ones.
OMP_DIR = Path(os.environ.get("DEVDECK_OMP_DIR", Path.home() / ".omp" / "agent"))
HOME = os.path.realpath(Path.home())

# Wire protocol; must match android/src/dev/devdeck/ and web/src/.
PROTOCOL_VERSION = 1
HISTORY_LINES = 300
SCREEN_POLL_S = 0.1
MIN_FRAME_S = 0.25        # at most 4 screens/s: spinners and timers would otherwise stream ~10/s
CHAT_POLL_S = 0.3         # stat() of the watched session file
PANE_INFO_TTL_S = 2.0
SESSIONS_POLL_S = 2.0
HELLO_TIMEOUT_S = 30.0
IDLE_DROP_S = 75.0        # visible app pings every 10 s
PAUSED_DROP_S = 30 * 60.0  # hidden app pings every 10 min
KEEPALIVE = (120, 30, 4)  # TCP keepalive idle, interval, count
MAX_LINE = 8 << 20
SEEN_MAX = 2000
KEY_RE = re.compile(r"^(C-|M-|S-)*([A-Za-z0-9]|[A-Z][A-Za-z]+|F[0-9]{1,2})$")
MAX_KEYS = 64
UPLOAD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
TMUX_TIMEOUT_S = 5.0
MAX_REQUESTS = 3          # concurrent ls/read/git/more/full per connection

PAGE = 60
TEXT_CAP = 50_000
THINKING_CAP = 4000
ARGS_CAP = 600
RESULT_CAP = 3000
FULL_CAP = 2 << 20
LS_CAP = 5000
READ_TEXT_CAP = 1 << 20
READ_IMAGE_CAP = 8 << 20
DIFF_CAP = 1536 << 10
GIT_FILES_CAP = 5000
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}

ANSWER_WAIT_S = 8.0
KEY_BATCH = 6
KEY_PAUSE_S = 0.04
BOX_PAUSE_S = 0.15       # around text typed into the dialog's note / custom answer boxes
DRAFT_TRAP = "Finish or clear the current prompt to answer"

# omp controls (models, history, cmd) and live pages
MODELS_FILE = STATE_DIR / "models.json"
MODELS_TTL_S = 6 * 3600.0
MODELS_TIMEOUT_S = 90.0
CMD_WAIT_S = 6.0
CMD_QUEUE_S = 20.0        # how long a command waits for the previous one on the same pane
CMD_SETTLE_S = 0.8        # footer-confirmed commands wait this long for an error line first
ESCAPE_GAP_S = 0.6        # two Escapes closer than 500 ms open omp's rewind picker
PAGE_WAIT_S = 4.0
PAGE_CHECK_S = 0.6        # chat view: how often the watched pane is checked for an open page
TODO_CAP = 4000
HISTORY_MAX = 50
TITLE_MAX = 120
TYPE_MAX = 200
TAP_MAX = 200
THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max", "auto")
# Footer model segment, e.g. "◒ Opus 5.5", "◔ Sonnet 4.5 ⚡", "⬢ GPT-5·high"; the glyph is the thinking level.
FOOTER_MODEL_RE = re.compile(r"^([○◔◑◒◕◉⟳⬢⦸])\s+(.+?)(\s⚡)?(·.*)?$")
FOOTER_GLYPHS = {"⦸": "off", "○": "minimal", "◔": "low", "◑": "medium", "◒": "high", "◕": "xhigh",
                 "◉": "max", "⟳": "auto"}
PAGE_COMMANDS = ("/model", "/models", "/switch", "/effort", "/settings", "/resume", "/tree", "/branch",
                 "/rewind", "/modelpreset", "/plan-review", "/session")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SEND_REWRITES = ((re.compile(r"^/models?\s+(\S.*)$"), "/switch "), (re.compile(r"^/thinking\s+(\S+)$"), "/effort "))

SKIP_IFACES = ("lo", "docker", "virbr", "br-", "veth", "CloudflareWARP")

INSTANCE_RE = re.compile(r"^[a-z][a-z0-9]{0,15}$")
INSTANCE = ""
LABEL = "DevDeck"


def apply_instance(name: str) -> None:
    """Point every per-install path and name at a side-by-side instance `name` (e.g. "plus":
    app dev.devdeckplus, ~/.config/devdeck-plus, devdeck-plus.service, port 47491)."""
    global INSTANCE, LABEL, APK, APP_PACKAGE, APP_ACTIVITY, CONFIG_DIR, TOKEN_FILE, STATE_DIR, SEEN_FILE
    global PARTIAL_DIR, MODELS_FILE, UNIT_NAME, DEFAULT_PORT
    if not INSTANCE_RE.match(name):
        sys.exit(f"bad instance name {name!r}: lowercase letters and digits, starting with a letter")
    INSTANCE = name
    LABEL = "DevDeck+" if name == "plus" else f"DevDeck {name}"
    APK = HERE / f"devdeck-{name}.apk"
    APP_PACKAGE = f"dev.devdeck{name}"
    APP_ACTIVITY = f"{APP_PACKAGE}/dev.devdeck.MainActivity"  # the Java classes keep package dev.devdeck
    CONFIG_DIR = CONFIG_DIR.with_name(f"devdeck-{name}")
    TOKEN_FILE = CONFIG_DIR / "token"
    STATE_DIR = STATE_DIR.with_name(f"devdeck-{name}")
    SEEN_FILE = STATE_DIR / "seen.json"
    PARTIAL_DIR = STATE_DIR / "partial"
    MODELS_FILE = STATE_DIR / "models.json"
    UNIT_NAME = f"devdeck-{name}.service"
    DEFAULT_PORT = 47491


def log(msg: str) -> None:
    print(msg, flush=True)


def load_token() -> str:
    try:
        return TOKEN_FILE.read_text().strip()
    except OSError:
        return ""


class RequestError(Exception):
    """A readable failure of one client request."""


# ---------------------------------------------------------------- persistent state

class Seen:
    """Ids of delivered queued items (and completed uploads, with their final path),
    persisted so a resend after reconnect or daemon restart is acked, not re-executed."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.items: collections.OrderedDict[str, str | None] = collections.OrderedDict()
        try:
            for ident, value in json.loads(path.read_text()):
                self.items[str(ident)] = value
        except (OSError, ValueError, TypeError) as ex:
            if path.exists():
                log(f"ignoring unreadable {path}: {ex}")

    def has(self, ident: str) -> bool:
        with self.lock:
            return ident in self.items

    def get(self, ident: str) -> str | None:
        with self.lock:
            return self.items.get(ident)

    def add(self, ident: str, value: str | None = None) -> None:
        with self.lock:
            self.items[ident] = value
            self.items.move_to_end(ident)
            while len(self.items) > SEEN_MAX:
                self.items.popitem(last=False)
            data = json.dumps(list(self.items.items()))
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(data)
            os.replace(tmp, self.path)
        except OSError as ex:
            log(f"cannot persist {self.path}: {ex}")


# ---------------------------------------------------------------- tmux

def tmux(*args: str, stdin: bytes | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["tmux", *args], input=stdin, capture_output=True, timeout=TMUX_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired) as ex:
        return subprocess.CompletedProcess(["tmux", *args], 1, b"", str(ex).encode())


def tmux_error(r: subprocess.CompletedProcess) -> str:
    err = r.stderr.decode(errors="replace").strip() or f"tmux exited {r.returncode}"
    if "can't find" in err:
        return "no such pane"
    if "no server running" in err or "error connecting" in err:
        return "tmux server not running"
    return err


# omp titles its terminal "π[-profile] [spinner] <context>": the braille spinner glyph is there
# only while a turn runs. Without a session file, its question dialog (ask tool) is recognised
# on screen by these boxes.
AGENT_TITLE_RE = re.compile(r"^π(?:-\S+)?(?:\s+|$)")
SPINNER_RE = re.compile(r"^[\u2800-\u28ff]\s*")
# The spinner animates every frame; reporting it as is would resend `sessions` on every poll.
TITLE_SPINNER_RE = re.compile(r"^(π(?:-\S+)?\s+)[\u2800-\u28ff]")
ASK_MARKERS = ("╭─ Ask ", "╭─ Custom answer:")
TEXT_BOX_MARKERS = ("╭─ Custom answer", "╭─ Note")
SHELLS = {"fish", "bash", "zsh", "sh", "dash", "ksh", "nu", "tcsh", "csh", "elvish", "xonsh"}
HOSTNAME = socket.gethostname()


def title_status(cmd: str, title: str) -> tuple[bool, bool, str]:
    """(agent, working, context) from a pane's command and title."""
    agent = AGENT_TITLE_RE.match(title)
    if not agent:
        return False, False, ("" if title in ("", HOSTNAME, cmd) else title)
    rest = title[agent.end():]
    working = SPINNER_RE.match(rest)
    # omp 18.12 shows "π > <context>" while idle, the spinner in place of ">" while working.
    rest = rest[working.end():] if working else re.sub(r"^>(\s+|$)", "", rest)
    return True, bool(working), rest.strip()


def visible_lines(target: str) -> list[str] | None:
    r = tmux("capture-pane", "-p", "-t", target)
    if r.returncode != 0:
        return None
    return r.stdout.decode(errors="replace").splitlines()


def last_box_top(lines: list[str]) -> str:
    # The open dialog is the last box drawn from column 0; quoted copies sit inside other
    # boxes ("│ ╭─ Ask"), and finished asks render as "╭─── Ask".
    tops = [ln for ln in lines if ln.startswith("╭─")]
    return tops[-1] if tops else ""


_btime: float | None = None
_pid_start: dict[int, float] = {}


def process_start(pid: int) -> float:
    """Epoch start time of a process (0 if unknown)."""
    global _btime
    if pid in _pid_start:
        return _pid_start[pid]
    try:
        if _btime is None:
            with open("/proc/stat") as f:
                _btime = next(float(ln.split()[1]) for ln in f if ln.startswith("btime "))
        with open(f"/proc/{pid}/stat") as f:
            fields = f.read().rsplit(")", 1)[1].split()
        start = _btime + int(fields[19]) / os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError, IndexError, StopIteration):
        return 0.0
    if len(_pid_start) > 512:
        _pid_start.clear()
    _pid_start[pid] = start
    return start


def breadcrumb(tty: str, pane_pid: int) -> tuple[str, str] | None:
    """(cwd, session JSONL path) omp recorded for this pane's terminal, if written during the pane's
    life (pts numbers are recycled, so an older breadcrumb belongs to some earlier terminal)."""
    if not tty.startswith("/dev/pts/"):
        return None
    crumb = OMP_DIR / "terminal-sessions" / f"pts-{tty[len('/dev/pts/'):]}"
    try:
        with open(crumb) as f:
            mtime = os.fstat(f.fileno()).st_mtime
            lines = f.read(8192).splitlines()
    except OSError:
        return None
    if len(lines) < 2 or not lines[1].startswith("/") or mtime < process_start(pane_pid) - 2:
        return None
    return lines[0], lines[1]


def breadcrumb_session(tty: str, pane_pid: int) -> str | None:
    crumb = breadcrumb(tty, pane_pid)
    return crumb[1] if crumb else None


def session_id_of(path: str) -> str:
    stem = os.path.basename(path).removesuffix(".jsonl")
    return stem.split("_", 1)[1] if "_" in stem else stem


def capture(target: str, scrollback: bool = True) -> dict | str:
    """Screen of the pane `target` resolves to (visible rows only without `scrollback`), or an
    error string. `alt`: the pane shows the alternate screen (omp's full-screen pages)."""
    if not target:
        return "no target"
    fmt = ("#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{alternate_on}\t"
           "#{session_name}:#{window_index}.#{pane_index}")
    # One tmux invocation, so the pane is resolved once for both commands.
    r = tmux("display-message", "-p", "-t", target, fmt, ";",
             "capture-pane", "-p", "-J", "-t", target, *(("-S", f"-{HISTORY_LINES}") if scrollback else ()))
    if r.returncode != 0:
        return tmux_error(r)
    head, _, body = r.stdout.decode(errors="replace").partition("\n")
    f = head.split("\t", 5)
    if len(f) < 6 or not all(x.isdigit() for x in f[:5]):
        return f"unexpected tmux output: {head[:80]}"
    lines = [line.rstrip() for line in body.split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    return {"target": f[5], "cols": int(f[0]), "rows": int(f[1]),
            "cursor": [int(f[2]), int(f[3])], "lines": lines, "alt": f[4] == "1"}


def pane_info(target: str) -> dict | str:
    """Canonical target, tty, pid, agent and working flags of a pane, or an error string."""
    fmt = "#{session_name}:#{window_index}.#{pane_index}\t#{pane_tty}\t#{pane_pid}\t#{pane_title}"
    r = tmux("display-message", "-p", "-t", target, fmt)
    if r.returncode != 0:
        return tmux_error(r)
    f = r.stdout.decode(errors="replace").rstrip("\n").split("\t", 3)
    if len(f) < 4 or not f[2].isdigit():
        return "unexpected tmux output"
    agent, working, _ = title_status("", f[3])
    return {"target": f[0], "tty": f[1], "pid": int(f[2]), "agent": agent, "working": working}


# ---------------------------------------------------------------- omp screen (footer, editor, pages)

def parse_footer(lines: list[str]) -> dict | None:
    """{line, name, thinking, fast, mode} from omp's status footer near the bottom of the screen,
    e.g. " π > ◒ Opus 5.5 ⚡ > 🗺 Plan ⏸ > 🗑 cwd > ...", or None when no footer is visible."""
    for i in range(len(lines) - 1, max(-1, len(lines) - 14), -1):
        segs = [s.strip() for s in lines[i].split(" > ")]
        for j, seg in enumerate(segs):
            m = FOOTER_MODEL_RE.match(seg)
            if not m or j == 0:
                continue
            name, level = m.group(2).strip(), FOOTER_GLYPHS.get(m.group(1))
            if m.group(1) == "⬢" and m.group(4):
                level = m.group(4)[1:].strip() or None
            mode = "none"
            for s in segs[j + 1:]:
                if s.startswith("🗺") and "Plan" in s:
                    mode = "plan_paused" if "⏸" in s else "plan"
            return {"line": i, "name": name, "thinking": level, "fast": bool(m.group(3)), "mode": mode}
    return None


def editor_draft(lines: list[str], footer: dict | None) -> bool:
    """Whether omp's prompt (the "╰─" line under the footer) holds text; a pasted command would
    be appended to it and the whole thing sent to the model."""
    if footer is None:
        return False
    for ln in lines[footer["line"] + 1:footer["line"] + 3]:
        if ln.startswith("╰─"):
            # Text starts one space after the corner; omp's own hint sits far to the right.
            return bool(re.match(r"╰─ \S", ln))
    return False


def box_title(line: str) -> str:
    m = re.match(r"╭─+\s*(.*?)\s*[─┬╮]*$", line)
    return m.group(1).strip(" ─") if m else ""


def screen_page(lines: list[str], alt: bool) -> dict | None:
    """{title?} when omp shows a page/picker/overlay instead of its transcript and prompt: a
    full-screen page (alternate screen), or a box drawn at column 0 with the footer gone (inline
    pickers like /effort). omp's ask dialog is not a page: it has the native answer sheet."""
    if alt:
        tops = [ln for ln in lines[:3] if ln.startswith("╭─")]
        title = box_title(tops[0]) if tops else ""
        return {"title": title} if title else {}
    top = last_box_top(lines)
    if not top or top.startswith(ASK_MARKERS + TEXT_BOX_MARKERS) or parse_footer(lines) is not None:
        return None
    title = box_title(top)
    return {"title": title} if title else {}


def screen_news(before: list[str], after: list[str]) -> list[str]:
    """Stripped non-empty lines of `after` that were not on screen in `before` (status lines omp
    printed in between), footer and prompt excluded."""
    pool = collections.Counter(ln.strip() for ln in before)
    out = []
    for ln in after:
        s = ln.strip()
        if not s or s.startswith(("╰─", "╭─", "│", "├")):
            continue
        if pool[s] > 0:
            pool[s] -= 1
            continue
        if " > " in s and parse_footer([ln]) is not None:
            continue
        out.append(s)
    return out


def deliver_text(ident: str, target: str, text: str, enter: bool) -> str | None:
    """Paste `text` (bracketed) into `target`, then Enter; None on success, else the error."""
    if text:
        buf = "devdeck-" + re.sub(r"[^A-Za-z0-9_-]", "_", ident)[:80]
        r = tmux("load-buffer", "-b", buf, "-", stdin=text.encode())
        if r.returncode != 0:
            return tmux_error(r)
        r = tmux("paste-buffer", "-p", "-d", "-b", buf, "-t", target)
        if r.returncode != 0:
            tmux("delete-buffer", "-b", buf)
            return tmux_error(r)
    if enter:
        r = tmux("send-keys", "-t", target, "Enter")
        if r.returncode != 0:
            return tmux_error(r)
    return None


def set_clipboard(text: str) -> str | None:
    # wl-copy forks a child that keeps serving the selection and inherits our stdio, so
    # stderr goes to a file rather than a pipe we would wait on forever.
    with tempfile.TemporaryFile() as err:
        try:
            r = subprocess.run(["wl-copy"], input=text.encode(), stdout=subprocess.DEVNULL,
                               stderr=err, timeout=10)
        except (OSError, subprocess.TimeoutExpired) as ex:
            return f"wl-copy: {ex}"
        if r.returncode != 0:
            err.seek(0)
            return "wl-copy: " + (err.read().decode(errors="replace").strip() or f"exit {r.returncode}")
    return None


def notify(body: str) -> None:
    try:
        subprocess.Popen(["notify-send", LABEL, body], stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        pass


# ---------------------------------------------------------------- omp transcripts

def cap(text: str, limit: int) -> tuple[str, bool]:
    return (text, False) if len(text) <= limit else (text[:limit], True)


def ts_ms(value) -> int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value)
    if isinstance(value, str):
        try:
            return int(datetime.datetime.fromisoformat(value).timestamp() * 1000)
        except ValueError:
            return None
    return None


def content_text(content) -> str:
    """Plain text of a message `content` (a string or a list of blocks)."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
        elif block.get("type") == "image":
            parts.append("[image]")
    return "\n".join(parts)


def tool_args_text(args) -> str:
    if isinstance(args, dict):
        args = {k: v for k, v in args.items() if k != "i"}
    return json.dumps(args, ensure_ascii=False, separators=(",", ":"))


# Node kinds. Only some are shown; tool results fold into the assistant entry that made the call.
K_USER, K_ASSISTANT, K_RESULT, K_START, K_RESET, K_EXIT, K_COMPACTION, K_NOTICE, K_HIDDEN = range(9)
SHOWN = {K_USER, K_ASSISTANT, K_EXIT, K_COMPACTION, K_NOTICE}


class Node:
    __slots__ = ("id", "parent", "off", "ln", "kind", "calls", "meta")

    def __init__(self, ident: str, parent, off: int, ln: int, kind: int, calls, meta):
        self.id, self.parent, self.off, self.ln, self.kind, self.calls = ident, parent, off, ln, kind, calls
        self.meta = meta


def entry_meta(obj: dict) -> tuple | None:
    """What one session entry changes in the pane's omp state (model, thinking, fast tier, mode,
    context usage, todo list), as a small tuple kept on its node."""
    t = obj.get("type")
    if t == "model_change":
        return ("model", obj["model"]) if isinstance(obj.get("model"), str) else None
    if t == "thinking_level_change":
        lvl = obj.get("thinkingLevel")
        return ("thinking", lvl) if isinstance(lvl, str) else None
    if t == "service_tier_change":
        return ("fast", bool(obj.get("serviceTier")))
    if t == "mode_change":
        return ("mode", obj["mode"]) if isinstance(obj.get("mode"), str) else None
    if t in ("compaction", "reset_boundary"):
        return ("ctx0",)
    if t != "message" or not isinstance(obj.get("message"), dict):
        return None
    m = obj["message"]
    if m.get("role") == "assistant":
        u = m.get("usage") if isinstance(m.get("usage"), dict) else {}
        used = sum(v for k in ("input", "cacheRead", "cacheWrite", "output")
                   if isinstance(v := u.get(k), int) and not isinstance(v, bool))
        p, mid = m.get("provider"), m.get("model")
        model = f"{p}/{mid}" if isinstance(p, str) and isinstance(mid, str) and p and mid else None
        return ("asst", model, used) if model or used else None
    if m.get("role") == "toolResult" and m.get("toolName") == "todo":
        return ("todo",)
    return None


def classify(obj: dict) -> tuple[int, object]:
    """(kind, calls) of one session entry. calls: [(toolCallId, name)] for assistant messages,
    the toolCallId for results and tool_execution_start markers."""
    t = obj.get("type")
    if t == "message":
        m = obj.get("message")
        if not isinstance(m, dict):
            return K_HIDDEN, None
        role = m.get("role")
        if role == "user":
            return K_USER, None
        if role == "assistant":
            calls, visible = [], False
            for b in m.get("content") or []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "toolCall" and isinstance(b.get("id"), str):
                    calls.append((b["id"], b.get("name")))
                elif (b.get("type") == "text" and (b.get("text") or "").strip()) or \
                        (b.get("type") == "thinking" and (b.get("thinking") or "").strip()):
                    visible = True
            if calls or visible or m.get("errorMessage") or m.get("stopReason") in ("aborted", "error"):
                return K_ASSISTANT, calls
            return K_HIDDEN, None
        if role == "toolResult":
            call = m.get("toolCallId")
            return (K_RESULT, call) if isinstance(call, str) else (K_HIDDEN, None)
        if role in ("bashExecution", "pythonExecution", "fileMention"):
            return K_NOTICE, None
        if role in ("custom", "hookMessage") and m.get("display") is True:
            return K_NOTICE, None
        return K_HIDDEN, None
    if t == "custom":
        ct = obj.get("customType")
        if ct == "tool_execution_start":
            call = (obj.get("data") or {}).get("toolCallId")
            return (K_START, call) if isinstance(call, str) else (K_HIDDEN, None)
        if ct == "session_exit":
            return K_EXIT, None
        return K_HIDDEN, None
    if t == "custom_message":
        return (K_NOTICE, None) if obj.get("display") is True else (K_HIDDEN, None)
    if t == "compaction":
        return K_COMPACTION, None
    if t == "branch_summary":
        return (K_NOTICE, None) if str(obj.get("summary") or "").strip() else (K_HIDDEN, None)
    if t == "reset_boundary":
        return K_RESET, None
    return K_HIDDEN, None


class StaleFile(Exception):
    """The session file was replaced under us; the transcript was reset."""


class Transcript:
    """Incrementally parsed omp session file, shared by every connection and the sessions poller.
    Keeps one small Node per entry (file offsets, not content); entries are converted on demand
    by re-reading their line. `gen` changes when clients must reset (file rewritten, branch
    switch, /clear); `rev` counts appends, `changes` lists (rev, seq) of every new or updated
    entry so each connection can send exactly what it has not seen."""

    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        self.gen = 0
        self.checked = 0.0
        self.used = time.monotonic()
        self._clear()

    def _clear(self) -> None:
        self.ino: int | None = None
        self.offset = 0
        self.exists = False
        self.nodes: dict[str, Node] = {}
        self.leaf_candidate: str | None = None
        self.call_owner: dict[str, str] = {}
        self.asks: dict[str, str] = {}
        self.results: dict[str, str] = {}
        self.started: set[str] = set()
        self.leaf: str | None = None
        self.path_ids: list[str] = []
        self.path_index: dict[str, int] = {}
        self.vis_start = 0
        self.last_msg = -1
        self.last_exit = -1
        self.display: list[str] = []
        self.seq_of: dict[str, int] = {}
        self.rev = 0
        self.changes: list[tuple[int, int]] = []
        self.cache: collections.OrderedDict[tuple, dict] = collections.OrderedDict()
        self.ask_cache: dict[str, dict | None] = {}
        self.cwd: str | None = None
        self.todo_cache: tuple[str, dict | None] | None = None
        self._reset_state()

    def _reset_state(self) -> None:
        self.st_model: str | None = None
        self.st_asst_model: str | None = None
        self.st_thinking: str | None = None
        self.st_fast = False
        self.st_mode = "none"
        self.st_used: int | None = None
        self.st_todo: str | None = None

    def _track(self, node: Node) -> None:
        m = node.meta
        if m is None:
            return
        k = m[0]
        if k == "model":
            self.st_model = m[1]
        elif k == "thinking":
            self.st_thinking = m[1]
        elif k == "fast":
            self.st_fast = m[1]
        elif k == "mode":
            self.st_mode = m[1]
        elif k == "ctx0":
            self.st_used = None
        elif k == "asst":
            if m[1]:
                self.st_asst_model = m[1]
            if m[2]:
                self.st_used = m[2]
        elif k == "todo":
            self.st_todo = node.id

    def _reset(self) -> None:
        self._clear()
        self.gen += 1

    # ------------------------------------------------------------ parsing

    def refresh(self, force: bool = False) -> None:
        with self.lock:
            now = time.monotonic()
            self.used = now
            if not force and now - self.checked < 0.2:
                return
            self.checked = now
            try:
                st = os.stat(self.path)
            except OSError:
                if self.exists or self.ino is not None:
                    self._reset()
                return
            if self.ino is not None and (st.st_ino != self.ino or st.st_size < self.offset):
                self._reset()
            if self.ino is None:
                self.ino = st.st_ino
            self.exists = True
            if st.st_size > self.offset:
                self._ingest()

    def invalidate(self) -> None:
        """Forget everything; the next refresh() reparses the file and clients reset."""
        with self.lock:
            self._reset()

    def _ingest(self) -> None:
        owners: list[str] = []
        try:
            f = open(self.path, "rb")
        except OSError:
            return
        with f:
            if os.fstat(f.fileno()).st_ino != self.ino:
                self._reset()
                self.ino = os.fstat(f.fileno()).st_ino
                self.exists = True
            f.seek(self.offset)
            pos, rest = self.offset, b""
            while True:
                chunk = f.read(4 << 20)
                if not chunk:
                    break
                buf = rest + chunk
                end = buf.rfind(b"\n")
                if end < 0:
                    rest = buf
                    continue
                rest = buf[end + 1:]
                for line in buf[:end + 1].split(b"\n")[:-1]:
                    self._parse(line, pos, owners)
                    pos += len(line) + 1
            self.offset = pos
        self._update_branch(owners)

    def _parse(self, line: bytes, off: int, owners: list[str]) -> None:
        if not line.strip():
            return
        try:
            obj = json.loads(line)
        except ValueError:
            return
        if not isinstance(obj, dict):
            return
        ident = obj.get("id")
        if not isinstance(ident, str):
            return
        kind, calls = classify(obj)
        parent = obj.get("parentId")
        node = Node(ident, parent if isinstance(parent, str) else None, off, len(line), kind, calls, entry_meta(obj))
        self.nodes[ident] = node
        if obj.get("type") == "session":
            if isinstance(obj.get("cwd"), str):
                self.cwd = obj["cwd"]
        elif obj.get("type") != "model_usage":  # may be appended to another branch than the active one
            self.leaf_candidate = ident
        if kind == K_ASSISTANT:
            for call, name in calls:
                self.call_owner[call] = ident
                if name == "ask":
                    self.asks[call] = ident
        elif kind == K_RESULT:
            self.results[calls] = ident
            owner = self.call_owner.get(calls)
            if owner:
                owners.append(owner)
        elif kind == K_START:
            self.started.add(calls)

    def _update_branch(self, owners: list[str]) -> None:
        leaf = self.leaf_candidate
        before = len(self.changes)
        rebuild = False
        if leaf != self.leaf:
            chain, seen, cur = [], set(), leaf
            while cur is not None and cur not in self.path_index and cur not in seen:
                node = self.nodes.get(cur)
                if node is None:
                    cur = None
                    break
                seen.add(cur)
                chain.append(node)
                cur = node.parent
            if (cur is None and not self.path_ids) or (cur is not None and cur == self.leaf):
                for node in reversed(chain):
                    if node.kind == K_RESET:
                        rebuild = True
                        break
                    self._append(node)
            else:
                rebuild = True
            self.leaf = leaf
        if rebuild:
            self._rebuild()
            self.gen += 1
            return
        for owner in owners:
            seq = self.seq_of.get(owner)
            if seq is not None:
                self.changes.append((self.rev + 1, seq))
        if len(self.changes) > before:
            self.rev += 1

    def _append(self, node: Node) -> None:
        idx = len(self.path_ids)
        self.path_ids.append(node.id)
        self.path_index[node.id] = idx
        self._track(node)
        if node.kind in (K_USER, K_ASSISTANT):
            self.last_msg = idx
        elif node.kind == K_EXIT:
            self.last_exit = idx
        if node.kind in SHOWN:
            seq = len(self.display)
            self.display.append(node.id)
            self.seq_of[node.id] = seq
            self.changes.append((self.rev + 1, seq))

    def _rebuild(self) -> None:
        chain, seen, cur = [], set(), self.leaf
        while cur is not None and cur not in seen:
            node = self.nodes.get(cur)
            if node is None:
                break
            seen.add(cur)
            chain.append(node)
            cur = node.parent
        chain.reverse()
        start = 0
        for i, node in enumerate(chain):
            if node.kind == K_RESET:
                start = i + 1
        self.path_ids, self.path_index, self.display, self.seq_of = [], {}, [], {}
        self.last_msg = self.last_exit = -1
        self._reset_state()
        self.changes, self.cache = [], collections.OrderedDict()
        for i, node in enumerate(chain):
            if i < start:
                self.path_index[node.id] = len(self.path_ids)
                self.path_ids.append(node.id)
                self._track(node)
            else:
                self._append(node)
        self.vis_start = start
        self.changes = []

    # ------------------------------------------------------------ reading entries

    def _open(self):
        f = open(self.path, "rb")
        if os.fstat(f.fileno()).st_ino != self.ino:
            f.close()
            self._reset()
            raise StaleFile()
        return f

    def _load(self, f, ident: str) -> dict:
        node = self.nodes[ident]
        f.seek(node.off)
        return json.loads(f.read(node.ln))

    def _result(self, f, call: str) -> dict | None:
        rid = self.results.get(call)
        if rid is None:
            return None
        m = self._load(f, rid).get("message") or {}
        text, truncated = cap(content_text(m.get("content")), RESULT_CAP)
        return {"text": text, "truncated": truncated, "isError": m.get("isError") is True}

    def _convert(self, f, ident: str) -> dict:
        node = self.nodes[ident]
        calls = node.calls if node.kind == K_ASSISTANT else ()
        key = (ident, sum(1 for c, _ in calls if c in self.results))
        hit = self.cache.get(key)
        if hit is not None:
            self.cache.move_to_end(key)
            return hit
        obj = self._load(f, ident)
        e = {"seq": self.seq_of[ident], "id": ident, "ts": ts_ms(obj.get("timestamp"))}
        t = obj.get("type")
        m = obj.get("message") if isinstance(obj.get("message"), dict) else {}
        text = None
        if node.kind == K_USER:
            e["kind"] = "user"
            text = content_text(m.get("content"))
        elif node.kind == K_ASSISTANT:
            e.update(self._assistant(f, m))
            if e["kind"] == "notice":
                text = e.pop("text")
        elif node.kind == K_COMPACTION:
            e["kind"] = "compaction"
            s, truncated = cap(str(obj.get("summary") or ""), TEXT_CAP)
            e["summary"] = s
            if truncated:
                e["textTruncated"] = True
        elif node.kind == K_EXIT:
            e["kind"] = "notice"
            reason = (obj.get("data") or {}).get("reason")
            text = "omp exited" + (f" ({reason})" if isinstance(reason, str) and reason != "dispose" else "")
        else:
            e["kind"] = "notice"
            text = notice_text(t, m, obj)
        if text is not None:
            e["text"], truncated = cap(text, TEXT_CAP)
            if truncated:
                e["textTruncated"] = True
        self.cache[key] = e
        while len(self.cache) > 512:
            self.cache.popitem(last=False)
        return e

    def _assistant(self, f, m: dict) -> dict:
        texts, thinking, tools = [], [], []
        for b in m.get("content") or []:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text" and isinstance(b.get("text"), str) and b["text"].strip():
                texts.append(b["text"])
            elif bt == "thinking" and isinstance(b.get("thinking"), str) and b["thinking"].strip():
                thinking.append(b["thinking"].strip())
            elif bt == "toolCall" and isinstance(b.get("id"), str):
                args = b.get("arguments")
                intent = b.get("intent") or (args.get("i") if isinstance(args, dict) else None)
                a, truncated = cap(tool_args_text(args), ARGS_CAP)
                tool = {"id": b["id"], "name": str(b.get("name") or "?"), "args": a}
                if truncated:
                    tool["argsTruncated"] = True
                if isinstance(intent, str) and intent:
                    tool["intent"] = intent
                result = self._result(f, b["id"])
                if result is not None:
                    tool["result"] = result
                tools.append(tool)
        stop, error = m.get("stopReason"), m.get("errorMessage")
        if not texts and not thinking and not tools:
            label = "Turn aborted" if stop == "aborted" else "Error"
            return {"kind": "notice", "text": f"{label}: {error}" if error else label}
        e: dict = {"kind": "assistant", "tools": tools}
        if texts:
            e["text"], truncated = cap("\n\n".join(texts), TEXT_CAP)
            if truncated:
                e["textTruncated"] = True
        if thinking:
            e["thinking"], truncated = cap("\n\n".join(thinking), THINKING_CAP)
            if truncated:
                e["thinkingTruncated"] = True
        for field in ("model", "stopReason", "errorMessage"):
            if isinstance(m.get(field), str) and m[field]:
                e[field] = m[field]
        return e

    # ------------------------------------------------------------ queries (call refresh() first)

    def snapshot(self) -> tuple[int, int]:
        with self.lock:
            return self.gen, self.rev

    def tail(self) -> tuple[int, int, list[dict], bool]:
        """(gen, rev, last PAGE entries, hasMore)."""
        with self.lock:
            start = max(0, len(self.display) - PAGE)
            return self.gen, self.rev, self._entries(range(start, len(self.display))), start > 0

    def page(self, before: int) -> tuple[list[dict], bool]:
        with self.lock:
            before = max(0, min(before, len(self.display)))
            start = max(0, before - PAGE)
            return self._entries(range(start, before)), start > 0

    def since(self, gen: int, rev: int) -> tuple[int, list[dict]] | None:
        """(rev, entries changed after `rev`), or None when the client must reset."""
        with self.lock:
            if gen != self.gen:
                return None
            i = bisect.bisect_right(self.changes, (rev, 1 << 62))
            seqs = sorted({seq for _, seq in self.changes[i:]})
            if len(seqs) > PAGE:
                return None
            return self.rev, self._entries(seqs)

    def _entries(self, seqs) -> list[dict]:
        seqs = list(seqs)
        if not seqs:
            return []
        with self._open() as f:
            return [self._convert(f, self.display[s]) for s in seqs]

    def full(self, entry_id: str) -> str:
        with self.lock:
            with self._open() as f:
                if entry_id.endswith(":args"):
                    call = entry_id[:-5]
                    owner = self.call_owner.get(call)
                    if owner is None:
                        raise RequestError("no such tool call")
                    for b in (self._load(f, owner).get("message") or {}).get("content") or []:
                        if isinstance(b, dict) and b.get("id") == call:
                            args = b.get("arguments")
                            if isinstance(args, dict):
                                args = {k: v for k, v in args.items() if k != "i"}
                            return json.dumps(args, ensure_ascii=False, indent=2)
                    raise RequestError("no such tool call")
                if entry_id.endswith(":thinking"):
                    ident = entry_id[:-9]
                    if ident not in self.nodes:
                        raise RequestError("no such entry")
                    m = self._load(f, ident).get("message") or {}
                    return "\n\n".join(b["thinking"].strip() for b in m.get("content") or []
                                       if isinstance(b, dict) and b.get("type") == "thinking"
                                       and isinstance(b.get("thinking"), str) and b["thinking"].strip())
                if entry_id in self.results:
                    m = self._load(f, self.results[entry_id]).get("message") or {}
                    return content_text(m.get("content"))
                node = self.nodes.get(entry_id)
                if node is None:
                    raise RequestError("no such entry")
                obj = self._load(f, entry_id)
                m = obj.get("message") if isinstance(obj.get("message"), dict) else {}
                if node.kind == K_COMPACTION:
                    return str(obj.get("summary") or "")
                if node.kind == K_ASSISTANT:
                    return "\n\n".join(b["text"] for b in m.get("content") or []
                                       if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str))
                if node.kind == K_USER:
                    return content_text(m.get("content"))
                return notice_text(obj.get("type"), m, obj, RESULT_CAP * 1000)

    def has_result(self, call: str) -> bool:
        with self.lock:
            return call in self.results

    def pending_ask(self) -> dict | None:
        """{toolCallId, questions} of the ask dialog open in this session, if any."""
        with self.lock:
            found = None
            for call, owner in self.asks.items():
                if call not in self.started or call in self.results:
                    continue
                idx = self.path_index.get(owner)
                if idx is None or idx < self.vis_start or idx < self.last_msg or idx < self.last_exit:
                    continue
                found = (call, owner)
            if found is None:
                return None
            call, owner = found
            if call not in self.ask_cache:
                try:
                    with self._open() as f:
                        blocks = (self._load(f, owner).get("message") or {}).get("content") or []
                except (OSError, StaleFile):
                    return None
                args = next((b.get("arguments") for b in blocks if isinstance(b, dict) and b.get("id") == call), None)
                questions = normalize_questions(args.get("questions") if isinstance(args, dict) else None)
                self.ask_cache[call] = {"toolCallId": call, "questions": questions} if questions else None
            return self.ask_cache[call]

    def omp_state(self) -> dict:
        """omp settings along the current branch: {model, thinking, fast, mode, used, todo, cwd}
        (model/thinking None when the file has not recorded them yet)."""
        with self.lock:
            if self.st_todo is not None and (self.todo_cache is None or self.todo_cache[0] != self.st_todo):
                ident = self.st_todo
                try:
                    with self._open() as f:
                        text = content_text((self._load(f, ident).get("message") or {}).get("content"))
                except (OSError, ValueError, StaleFile):
                    text = None
                if text is not None:
                    m = re.search(r"Overall:\s*(\d+)/(\d+) done", text)
                    capped, _ = cap(text, TODO_CAP)
                    self.todo_cache = (ident, {"done": int(m.group(1)) if m else 0,
                                               "total": int(m.group(2)) if m else 0, "text": capped})
            hit = self.todo_cache
            todo = hit[1] if hit is not None and self.st_todo == hit[0] else None
            return {"model": self.st_model or self.st_asst_model, "thinking": self.st_thinking,
                    "fast": self.st_fast, "mode": self.st_mode, "used": self.st_used, "todo": todo,
                    "cwd": self.cwd}


def notice_text(t, m: dict, obj: dict, limit: int = RESULT_CAP) -> str:
    if t == "message":
        role = m.get("role")
        if role == "bashExecution":
            out, _ = cap(str(m.get("output") or ""), limit)
            code = m.get("exitCode")
            tail = f"\n(exit {code})" if isinstance(code, int) and code != 0 else ""
            return f"$ {m.get('command') or ''}\n{out}".rstrip() + tail
        if role == "pythonExecution":
            out, _ = cap(str(m.get("output") or ""), limit)
            return f">>> {m.get('code') or m.get('command') or ''}\n{out}".rstrip()
        if role == "fileMention":
            files = m.get("files") if isinstance(m.get("files"), list) else []
            names = [str(x.get("path")) for x in files if isinstance(x, dict) and x.get("path")]
            return "Attached " + (", ".join(names) if names else "files")
        return content_text(m.get("content"))
    if t == "branch_summary":
        return "Branch summary: " + str(obj.get("summary") or "")
    return content_text(obj.get("content"))


def normalize_questions(raw) -> list[dict]:
    out = []
    if not isinstance(raw, list):
        return out
    for i, q in enumerate(raw):
        if not isinstance(q, dict) or not isinstance(q.get("question"), str):
            continue
        opts = []
        for o in q.get("options") or []:
            if isinstance(o, dict) and isinstance(o.get("label"), str):
                opt = {"label": o["label"]}
                for k in ("description", "preview"):
                    if isinstance(o.get(k), str) and o[k]:
                        opt[k] = o[k]
                opts.append(opt)
        nq = {"id": str(q.get("id") or f"q{i}"), "question": q["question"], "options": opts,
              "multi": q.get("multi") is True}
        if isinstance(q.get("header"), str) and q["header"]:
            nq["header"] = q["header"]
        rec = q.get("recommended")
        if isinstance(rec, int) and not isinstance(rec, bool) and 0 <= rec < len(opts):
            nq["recommended"] = rec
        out.append(nq)
    return out


# ---------------------------------------------------------------- answering an ask

def clean_text(text: str) -> str:
    """One line of literal text for omp's text boxes: Enter (or a newline) would submit early,
    Escape would cancel, Tab would autocomplete."""
    text = re.sub(r"[\r\n\t]+", " ", text)
    return re.sub(r"[\x00-\x1f\x7f]", "", text).strip()


def ask_keystrokes(questions: list[dict], answers: list) -> list[tuple[str, object]]:
    """tmux batches ("keys", [names]) / ("text", literal) that answer omp's ask dialog.
    Raises RequestError when the answers do not fit the questions."""
    if not isinstance(answers, list):
        raise RequestError("answers must be a list")
    by_id = {}
    for a in answers:
        if not isinstance(a, dict) or not isinstance(a.get("qid"), str):
            raise RequestError("each answer needs a qid")
        by_id[a["qid"]] = a
    unknown = set(by_id) - {q["id"] for q in questions}
    if unknown:
        raise RequestError(f"unknown question {sorted(unknown)[0]!r}")
    batches: list[tuple[str, object]] = []
    keys: list[str] = []

    def flush() -> None:
        while keys:
            batches.append(("keys", keys[:KEY_BATCH]))
            del keys[:KEY_BATCH]

    def boxed(opener: str, value: str) -> None:
        # omp opens and closes its text boxes asynchronously and drops keys meanwhile, so the
        # opener, the text and the closing Enter each go in their own batch.
        keys.append(opener)
        flush()
        batches.append(("text", value))
        batches.append(("keys", ["Enter"]))

    def goto(rows: int, k: int) -> None:
        keys.extend(["Up"] * rows + ["Down"] * k)

    def note_keys(note: str) -> None:
        boxed("n", note)

    single_multi_custom = False
    for q in questions:
        a = by_id.get(q["id"], {})
        labels = [o["label"] for o in q["options"]]
        rows = len(labels) + 1
        selected = a.get("selected") or []
        if not isinstance(selected, list) or not all(isinstance(s, str) for s in selected):
            raise RequestError(f"{q['id']}: selected must be a list of labels")
        for s in selected:
            if s not in labels:
                raise RequestError(f"{q['id']}: no option {s!r}")
        custom = clean_text(a["custom"]) if isinstance(a.get("custom"), str) else ""
        note = clean_text(a["note"]) if isinstance(a.get("note"), str) else ""
        if not q["multi"]:
            if custom:
                goto(rows, len(labels))
                if note:
                    note_keys(note)
                boxed("Enter", custom)     # Custom answer box; its Enter submits and advances
            elif selected:
                goto(rows, labels.index(selected[0]))
                if note:
                    note_keys(note)
                keys.append("Enter")
            else:
                raise RequestError(f"{q['id']}: pick an option or type an answer")
            continue
        noted = False
        for label in dict.fromkeys(selected):
            goto(rows, labels.index(label))
            keys.append("Space")
            if note and not noted:
                note_keys(note)
                noted = True
        if custom:
            goto(rows, len(labels))
            if note and not noted:
                note_keys(note)
            boxed("Space", custom)         # Custom answer box: advances (or, alone, jumps to Submit)
            single_multi_custom = len(questions) == 1
        else:
            keys.append("Enter")           # advances (or, alone, submits)
    if len(questions) > 1 or single_multi_custom:
        keys.append("Enter")               # on the Submit tab
    flush()
    return batches


# ---------------------------------------------------------------- omp models and session history

def omp_binary() -> str:
    # The systemd user service may not have ~/.local/bin on its PATH.
    for cand in (shutil.which("omp"), str(Path.home() / ".local" / "bin" / "omp"), str(Path.home() / ".bun" / "bin" / "omp")):
        if cand and os.access(cand, os.X_OK):
            return cand
    return "omp"


class ModelCatalog:
    """`omp models --json` (no model calls: omp's own catalog cache), kept in memory and in
    MODELS_FILE; served stale while a background refresh runs."""

    def __init__(self, path: Path):
        self.path = path
        self.cond = threading.Condition()
        self.data: dict | None = None
        self.index: dict[str, dict] = {}
        self.refreshing = False
        self.error: str | None = None
        self.failed_at = 0.0
        try:
            data = json.loads(path.read_text())
            if isinstance(data.get("models"), list) and isinstance(data.get("fetchedAt"), int):
                self._set(data)
        except (OSError, ValueError, AttributeError) as ex:
            if path.exists():
                log(f"ignoring unreadable {path}: {ex}")

    def _set(self, data: dict) -> None:
        self.data = data
        self.index = {m["selector"]: m for m in data["models"] if isinstance(m, dict) and "selector" in m}

    def get(self, wait: bool) -> dict | None:
        """The catalog; refreshes in the background when missing or older than MODELS_TTL_S.
        With `wait` and nothing cached, waits for the refresh (RequestError if it fails)."""
        with self.cond:
            data = self.data
            stale = data is None or time.time() * 1000 - data["fetchedAt"] > MODELS_TTL_S * 1000
            backoff = not wait and time.monotonic() - self.failed_at < 60
            if stale and not self.refreshing and not backoff:
                self.refreshing = True
                threading.Thread(target=self._refresh, daemon=True).start()
            if data is None and wait:
                self.cond.wait_for(lambda: not self.refreshing, timeout=MODELS_TIMEOUT_S + 10)
                data = self.data
                if data is None:
                    raise RequestError(self.error or "omp models did not answer")
            return data

    def _refresh(self) -> None:
        data, err = None, None
        try:
            r = subprocess.run([omp_binary(), "models", "--json"], capture_output=True, stdin=subprocess.DEVNULL,
                               timeout=MODELS_TIMEOUT_S, cwd=Path.home())
            out = r.stdout.decode(errors="replace")
            line = next((ln for ln in out.splitlines() if ln.startswith("{")), None)
            if line is None:
                tail = (r.stderr.decode(errors="replace").strip().splitlines() or [f"exit {r.returncode}"])[-1]
                raise ValueError(tail)
            models = []
            for m in json.loads(line)["models"]:
                if not isinstance(m, dict) or not isinstance(m.get("provider"), str) or not isinstance(m.get("id"), str):
                    continue
                if isinstance(m.get("kind"), str) and m["kind"] not in ("chat", "llm"):
                    continue
                thinking = m.get("thinking")
                models.append({"selector": f"{m['provider']}/{m['id']}", "provider": m["provider"], "id": m["id"],
                               "name": m.get("name") if isinstance(m.get("name"), str) else m["id"],
                               "contextWindow": m.get("contextWindow") if isinstance(m.get("contextWindow"), int) else None,
                               "reasoning": m.get("reasoning") is True,
                               "thinking": [x for x in thinking if isinstance(x, str)] if isinstance(thinking, list) else None})
            data = {"models": models, "fetchedAt": int(time.time() * 1000)}
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
                os.replace(tmp, self.path)
            except OSError as ex:
                log(f"cannot persist {self.path}: {ex}")
        except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError) as ex:
            err = f"omp models failed: {ex}"
            log(err)
        with self.cond:
            if data is not None:
                self._set(data)
            else:
                self.failed_at = time.monotonic()
            self.error, self.refreshing = err, False
            self.cond.notify_all()

    def lookup(self, selector: str | None) -> dict | None:
        return self.index.get(selector) if selector else None

    def by_footer_name(self, name: str, prefer: list[str]) -> dict | None:
        """The model omp's footer shows as `name` (catalog name minus a leading "Claude ").
        Several providers serve the same name: `prefer` lists selectors/providers to try first."""
        hits = [m for m in self.index.values() if footer_name(m["name"]) == name]
        if not hits:
            return None

        def rank(m: dict) -> tuple:
            for i, p in enumerate(prefer):
                if m["selector"] == p or m["provider"] == p:
                    return i, len(m["id"])
            return len(prefer), len(m["id"])
        return min(hits, key=rank)


def footer_name(name: str) -> str:
    return name[7:] if name.startswith("Claude ") else name


def model_roles() -> dict[str, str]:
    """`modelRoles:` of omp's config.yml (a flat block of `role: provider/id[:level]` lines)."""
    try:
        text = (OMP_DIR / "config.yml").read_text()
    except OSError:
        return {}
    roles, inside = {}, False
    for ln in text.splitlines():
        if not inside:
            inside = bool(re.match(r"^modelRoles:\s*(#.*)?$", ln))
            continue
        if not ln.strip() or ln.lstrip().startswith("#"):
            continue
        if not ln[0].isspace():
            break
        m = re.match(r"^\s+([\w.-]+)\s*:\s*(.*?)\s*$", ln)
        if m:
            value = re.sub(r"\s+#.*$", "", m.group(2)).strip().strip("'\"")
            if value:
                roles[m.group(1)] = value
    return roles


_heads_lock = threading.Lock()
_heads: dict[str, tuple[tuple, dict | None]] = {}
_users: dict[str, tuple[tuple, str | None]] = {}


def session_head(path: str, st: os.stat_result) -> dict | None:
    """{id, cwd, title} from a session file's title slot and header (first two lines)."""
    key = (st.st_ino, st.st_size, st.st_mtime_ns)
    with _heads_lock:
        hit = _heads.get(path)
    if hit and hit[0] == key:
        return hit[1]
    head = None
    try:
        with open(path, "rb") as f:
            data = f.read(65536)
        title = None
        for raw in data.split(b"\n")[:3]:
            try:
                obj = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(obj, dict):
                continue
            if obj.get("type") == "title" and isinstance(obj.get("title"), str):
                title = obj["title"]
            elif obj.get("type") == "session" and isinstance(obj.get("id"), str):
                t = obj.get("title")
                head = {"id": obj["id"], "cwd": obj.get("cwd") if isinstance(obj.get("cwd"), str) else "",
                        "title": title or (t if isinstance(t, str) else None)}
                break
    except OSError:
        return None
    with _heads_lock:
        _heads[path] = (key, head)
    return head


def session_first_user(path: str, st: os.stat_result) -> str | None:
    """First line of the session's first user message ("" if it has no text), None if it has none."""
    with _heads_lock:
        hit = _users.get(path)
    # Files only grow: a found message stays found; a miss is rechecked when the size changes.
    if hit and hit[0][0] == st.st_ino and (hit[1] is not None or hit[0][1] == st.st_size):
        return hit[1]
    found = None
    try:
        with open(path, "rb") as f:
            if st.st_size:
                with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                    idx = mm.find(b'"message":{"role":"user"')
                    if idx >= 0:
                        start = mm.rfind(b"\n", 0, idx) + 1
                        end = mm.find(b"\n", idx)
                        found = ""
                        try:
                            obj = json.loads(mm[start:end if end >= 0 else len(mm)])
                            text = content_text((obj.get("message") or {}).get("content")).strip()
                            found = text.splitlines()[0][:TITLE_MAX] if text else ""
                        except (ValueError, AttributeError):
                            pass
    except (OSError, ValueError):
        return None
    with _heads_lock:
        _users[path] = ((st.st_ino, st.st_size), found)
    return found


def history_db_info(ids: list[str]) -> tuple[dict[str, str], dict[str, str]]:
    """(titles, latest recaps) by session id from omp's history.db."""
    titles, recaps = {}, {}
    if not ids:
        return titles, recaps
    try:
        db = sqlite3.connect(f"file:{OMP_DIR / 'history.db'}?mode=ro", uri=True, timeout=2)
    except sqlite3.Error as ex:
        log(f"history.db: {ex}")
        return titles, recaps
    try:
        marks = ",".join("?" * len(ids))
        for sid, title in db.execute(f"SELECT session_id, title FROM session_titles WHERE session_id IN ({marks})", ids):
            titles[sid] = title
        for sid, recap in db.execute(f"SELECT session_id, recap FROM session_recaps WHERE session_id IN ({marks}) "
                                     "ORDER BY created_at, id", ids):
            recaps[sid] = recap
    except sqlite3.Error as ex:
        log(f"history.db: {ex}")
    finally:
        db.close()
    return titles, recaps


def live_session_paths() -> set[str]:
    """Session files some open terminal's omp has recorded in its breadcrumb."""
    live = set()
    for crumb in (OMP_DIR / "terminal-sessions").glob("pts-*"):
        if not os.path.exists("/dev/pts/" + crumb.name[4:]):
            continue
        try:
            lines = crumb.read_text(errors="replace").splitlines()
        except OSError:
            continue
        if len(lines) >= 2:
            live.add(lines[1])
    return live


def session_history(cwd: str, current: str | None) -> list[dict]:
    """omp sessions of `cwd`: pinned first, then newest; empty ones (no user message) skipped."""
    cwd = os.path.normpath(cwd)
    try:
        pins = json.loads((OMP_DIR / "session-pins.json").read_text())
        pins = {p for p in pins if isinstance(p, str)} if isinstance(pins, list) else set()
    except (OSError, ValueError):
        pins = set()
    cands = []
    for path in (OMP_DIR / "sessions").glob("*/*.jsonl"):
        path = str(path)
        try:
            st = os.stat(path)
        except OSError:
            continue
        head = session_head(path, st)
        if head and head["cwd"] and os.path.normpath(head["cwd"]) == cwd:
            cands.append((head["id"] in pins, st.st_mtime, path, st, head))
    cands.sort(key=lambda c: (c[0], c[1]), reverse=True)
    picked = []
    for pinned, mtime, path, st, head in cands:
        first = session_first_user(path, st)
        if first is None and not pinned:
            continue
        picked.append((pinned, mtime, path, head, first))
        if len(picked) >= HISTORY_MAX:
            break
    titles, recaps = history_db_info([h["id"] for _, _, _, h, _ in picked])
    live = live_session_paths()
    out = []
    for pinned, mtime, path, head, first in picked:
        sid = head["id"]
        item = {"id": sid, "title": head["title"] or titles.get(sid) or first or "", "mtime": int(mtime * 1000),
                "live": path in live, "current": sid == current, "pinned": pinned}
        if recaps.get(sid):
            item["recap"] = recaps[sid]
        out.append(item)
    return out


# ---------------------------------------------------------------- files and git

def user_path(raw) -> str:
    """Resolved absolute path inside the user's home directory."""
    if not isinstance(raw, str) or not raw.strip():
        raw = "~"
    raw = raw.strip()
    if raw == "~" or raw.startswith("~/"):
        raw = HOME + raw[1:]
    elif not raw.startswith("/"):
        raw = os.path.join(HOME, raw)
    real = os.path.realpath(raw)
    if real != HOME and not real.startswith(HOME + os.sep):
        raise RequestError("outside your home directory")
    return real


def list_dir(raw) -> dict:
    path = user_path(raw)
    try:
        it = os.scandir(path)
    except NotADirectoryError:
        raise RequestError("not a directory")
    except FileNotFoundError:
        raise RequestError("no such directory")
    except PermissionError:
        raise RequestError("permission denied")
    entries, truncated = [], False
    with it:
        for d in it:
            if len(entries) >= LS_CAP:
                truncated = True
                break
            try:
                st = d.stat(follow_symlinks=False)
            except OSError:
                continue
            e = {"name": d.name, "size": st.st_size, "mtime": int(st.st_mtime * 1000)}
            if stat.S_ISLNK(st.st_mode):
                e["type"] = "link"
                try:
                    e["linkTo"] = "dir" if d.is_dir() else "file"
                except OSError:
                    e["linkTo"] = None
            else:
                e["type"] = "dir" if stat.S_ISDIR(st.st_mode) else "file"
            entries.append(e)
    entries.sort(key=lambda e: (not (e["type"] == "dir" or e.get("linkTo") == "dir"), e["name"].casefold(), e["name"]))
    parent = os.path.dirname(path) if path != HOME else None
    out = {"path": path, "parent": parent, "entries": entries}
    if truncated:
        out["truncated"] = True
    return out


def read_file(raw) -> dict:
    path = user_path(raw)
    try:
        st = os.stat(path)
    except FileNotFoundError:
        raise RequestError("no such file")
    except PermissionError:
        raise RequestError("permission denied")
    if stat.S_ISDIR(st.st_mode):
        raise RequestError("is a directory")
    if not stat.S_ISREG(st.st_mode):
        raise RequestError("not a regular file")
    ext = os.path.splitext(path)[1].lower()
    mime = mimetypes.guess_type(path)[0] or ("image/webp" if ext == ".webp" else "application/octet-stream")
    out = {"path": path, "size": st.st_size, "mime": mime}
    try:
        with open(path, "rb") as f:
            if ext in IMAGE_EXT and st.st_size <= READ_IMAGE_CAP:
                out.update(kind="image", data=base64.b64encode(f.read(READ_IMAGE_CAP)).decode(), truncated=False)
                return out
            data = f.read(READ_TEXT_CAP)
    except PermissionError:
        raise RequestError("permission denied")
    if b"\0" in data[:8192]:
        out.update(kind="binary", truncated=st.st_size > 0)
    else:
        out.update(kind="text", text=data.decode("utf-8", errors="replace"), truncated=st.st_size > len(data))
    return out


GIT_ENV = {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C", "GIT_PAGER": "cat"}


def run_capped(cmd: list[str], limit: int, timeout: float = 20.0) -> tuple[bytes, bool, int, str]:
    """(stdout up to `limit`, truncated, returncode, stderr)."""
    with tempfile.TemporaryFile() as err:
        try:
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, stdin=subprocess.DEVNULL, env=GIT_ENV)
        except OSError as ex:
            raise RequestError(str(ex))
        timer = threading.Timer(timeout, p.kill)
        timer.start()
        try:
            data = p.stdout.read(limit + 1)
            truncated = len(data) > limit
            if truncated:
                p.kill()
            p.stdout.close()
            code = p.wait()
        finally:
            timer.cancel()
        err.seek(0)
        return data[:limit], truncated, code, err.read().decode(errors="replace").strip()


def git(repo: str, *args: str, limit: int = 8 << 20) -> tuple[bytes, bool, int, str]:
    return run_capped(["git", "-C", repo, "--no-optional-locks", *args], limit)


def git_request(msg: dict) -> dict:
    path = user_path(msg.get("path"))
    if not os.path.isdir(path):
        path = os.path.dirname(path)
    out, _, code, err = git(path, "rev-parse", "--show-toplevel")
    if code != 0:
        raise RequestError("not a git repository" if "not a git repository" in err else (err or "git failed"))
    repo = out.decode().strip()
    real = os.path.realpath(repo)
    if real != HOME and not real.startswith(HOME + os.sep):
        raise RequestError("repository root is outside your home directory")
    op = msg.get("op")
    if op == "status":
        return git_status(repo)
    if op == "diff":
        return git_diff(repo, msg.get("file"), msg.get("staged") is True)
    if op == "log":
        return git_log(repo)
    raise RequestError(f"unknown git op {op!r}")


def git_status(repo: str) -> dict:
    out, _, code, err = git(repo, "status", "--porcelain=v2", "--branch", "-z")
    if code != 0:
        raise RequestError(err or "git status failed")
    res: dict = {"op": "status", "repo": repo, "branch": None, "ahead": 0, "behind": 0, "files": []}
    recs = out.decode(errors="replace").split("\0")
    i = 0
    while i < len(recs):
        rec = recs[i]
        i += 1
        if not rec:
            continue
        if rec.startswith("# "):
            key, _, val = rec[2:].partition(" ")
            if key == "branch.head":
                res["branch"] = val
            elif key == "branch.upstream":
                res["upstream"] = val
            elif key == "branch.ab":
                m = re.match(r"\+(\d+) -(\d+)", val)
                if m:
                    res["ahead"], res["behind"] = int(m.group(1)), int(m.group(2))
            continue
        f = None
        if rec[0] == "1":
            p = rec.split(" ", 8)
            if len(p) == 9:
                f = {"path": p[8], "index": p[1][0], "worktree": p[1][1]}
        elif rec[0] == "2":
            p = rec.split(" ", 9)
            if len(p) == 10:
                f = {"path": p[9], "index": p[1][0], "worktree": p[1][1], "orig": recs[i] if i < len(recs) else ""}
                i += 1
        elif rec[0] == "u":
            p = rec.split(" ", 10)
            if len(p) == 11:
                f = {"path": p[10], "index": p[1][0], "worktree": p[1][1]}
        elif rec[0] == "?":
            f = {"path": rec[2:], "index": "?", "worktree": "?"}
        if f is not None:
            if len(res["files"]) >= GIT_FILES_CAP:
                res["truncated"] = True
                break
            res["files"].append(f)
    return res


def git_diff(repo: str, file, staged: bool) -> dict:
    args = ["diff", "--no-color", "--no-ext-diff"] + (["--cached"] if staged else [])
    res: dict = {"op": "diff", "repo": repo, "staged": staged}
    if file is not None:
        if not isinstance(file, str) or not file:
            raise RequestError("file must be a path relative to the repository")
        full = os.path.realpath(os.path.join(repo, file))
        if not full.startswith(os.path.realpath(repo) + os.sep):
            raise RequestError("file is outside the repository")
        res["file"] = file
        tracked = git(repo, "ls-files", "--error-unmatch", "--", file)[2] == 0
        if not staged and not tracked and os.path.isfile(full):
            out, truncated, code, err = git(repo, "diff", "--no-color", "--no-ext-diff", "--no-index", "--",
                                            "/dev/null", file, limit=DIFF_CAP)
            if code not in (0, 1):
                raise RequestError(err or "git diff failed")
            res.update(diff=out.decode(errors="replace"), truncated=truncated)
            return res
        args += ["--", file]
    out, truncated, code, err = git(repo, *args, limit=DIFF_CAP)
    if code != 0 and not truncated:
        raise RequestError(err or "git diff failed")
    res.update(diff=out.decode(errors="replace"), truncated=truncated)
    return res


def git_log(repo: str) -> dict:
    out, _, code, err = git(repo, "log", "-n", "50", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e")
    commits = []
    if code != 0:
        if "does not have any commits" not in err:
            raise RequestError(err or "git log failed")
    else:
        for rec in out.decode(errors="replace").split("\x1e"):
            f = rec.strip("\n").split("\x1f")
            if len(f) == 5:
                commits.append({"hash": f[0], "short": f[1], "subject": f[2], "author": f[3], "date": f[4]})
    return {"op": "log", "repo": repo, "commits": commits}


# ---------------------------------------------------------------- server

def encode(msg: dict) -> bytes:
    return json.dumps(msg, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"


def screen_message(rev: int, cur: dict, last: dict | None) -> dict:
    head = {"t": "screen", "target": cur["target"], "rev": rev}
    tail = {"cols": cur["cols"], "rows": cur["rows"], "cursor": cur["cursor"]}
    new = cur["lines"]
    if last is not None and last["target"] == cur["target"]:
        old = last["lines"]
        changed = [[i, line] for i, line in enumerate(new) if i >= len(old) or old[i] != line]
        if sum(len(s) for _, s in changed) + 8 * len(changed) < sum(len(s) + 3 for s in new):
            return {**head, "full": False, "base": last["rev"], **tail, "len": len(new), "set": changed}
    return {**head, "full": True, **tail, "lines": new}


def set_keepalive(sock: socket.socket) -> None:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    idle, intvl, cnt = KEEPALIVE
    for opt, val in (("TCP_KEEPIDLE", idle), ("TCP_KEEPINTVL", intvl), ("TCP_KEEPCNT", cnt)):
        if hasattr(socket, opt):
            sock.setsockopt(socket.IPPROTO_TCP, getattr(socket, opt), val)


class Server:
    def __init__(self, port: int, dest: Path):
        self.port = port
        self.dest = dest
        self.seen = Seen(SEEN_FILE)
        self.deliver_lock = threading.Lock()
        self.answer_lock = threading.Lock()
        self.rev_lock = threading.Lock()
        self.rev = 0
        # client id -> last screen written to it {target, rev, lines, ...}, for `have` resume
        self.client_screens: dict[str, dict] = {}
        self.uploads_lock = threading.Lock()
        self.uploads: dict[str, tuple[threading.Lock, socket.socket | None]] = {}
        self.place_lock = threading.Lock()
        self.transcripts_lock = threading.Lock()
        self.transcripts: dict[str, Transcript] = {}
        # Sessions are polled once for everyone, only while someone is connected.
        self.ctl_cond = threading.Condition()
        self.controls: set[Control] = set()
        self.panes: list[dict] | None = None
        self.panes_sig: tuple = ()
        self.panes_rev = 0
        self.poll_now = threading.Event()
        self.catalog = ModelCatalog(MODELS_FILE)
        self.cmd_locks_lock = threading.Lock()
        self.cmd_locks: dict[str, threading.Lock] = {}
        self.last_escape: dict[str, float] = {}
        # target -> selector this daemon last switched it to, to resolve ambiguous footer names
        self.pane_models: dict[str, str] = {}
        # target -> omp fields last read from its footer (kept while a page hides the footer)
        self.footers: dict[str, dict] = {}
        self.sock = socket.create_server(("0.0.0.0", port), reuse_port=False, backlog=16)

    def next_rev(self) -> int:
        with self.rev_lock:
            self.rev += 1
            return self.rev

    def transcript(self, path: str) -> Transcript:
        with self.transcripts_lock:
            tr = self.transcripts.get(path)
            if tr is None:
                tr = self.transcripts[path] = Transcript(path)
            return tr

    def serve(self) -> None:
        threading.Thread(target=self.poll_loop, daemon=True).start()
        while True:
            conn, addr = self.sock.accept()
            threading.Thread(target=self.handle, args=(conn, addr), daemon=True).start()

    def close(self) -> None:
        self.sock.close()

    # ------------------------------------------------------------ sessions poller

    def attach(self, ctl: Control) -> None:
        with self.ctl_cond:
            self.controls.add(ctl)
            self.ctl_cond.notify_all()
        self.poll_now.set()

    def detach(self, ctl: Control) -> None:
        with self.ctl_cond:
            self.controls.discard(ctl)

    def poll_loop(self) -> None:
        while True:
            with self.ctl_cond:
                self.ctl_cond.wait_for(lambda: self.controls)
            self.poll_now.clear()
            try:
                panes = self.list_panes()
            except Exception as ex:  # the poller must survive anything a pane or file throws at it
                log(f"sessions poll failed: {ex!r}")
                panes = self.panes or []
            with self.ctl_cond:
                if panes != self.panes:
                    self.panes = panes
                    self.panes_sig = tuple((p["target"], p["state"], (p.get("ask") or {}).get("toolCallId"))
                                           for p in panes)
                    self.panes_rev += 1
                    controls = list(self.controls)
                else:
                    controls = []
            for ctl in controls:
                ctl.kick()
            self.evict_transcripts()
            self.poll_now.wait(SESSIONS_POLL_S)

    def evict_transcripts(self) -> None:
        cutoff = time.monotonic() - 600
        with self.transcripts_lock:
            for path in [p for p, tr in self.transcripts.items() if tr.used < cutoff]:
                del self.transcripts[path]

    def list_panes(self) -> list[dict]:
        fmt = "\t".join(["#{session_name}", "#{window_index}", "#{pane_index}", "#{window_name}",
                         "#{pane_current_command}", "#{pane_id}", "#{pane_tty}", "#{pane_pid}",
                         "#{pane_current_path}", "#{pane_title}"])
        r = tmux("list-panes", "-a", "-F", fmt)
        if r.returncode != 0:
            return []
        panes = []
        with self.ctl_cond:
            watched = {c.target for c in self.controls if not c.paused and c.view == "chat"}
        for line in r.stdout.decode(errors="replace").splitlines():
            f = line.split("\t", 9)
            if len(f) < 10 or not f[1].isdigit() or not f[2].isdigit() or not f[7].isdigit():
                continue
            cmd, title = f[4], f[9]
            agent, working, context = title_status(cmd, title)
            pane = {"target": f"{f[0]}:{f[1]}.{f[2]}", "session": f[0], "window": int(f[1]),
                    "pane": int(f[2]), "name": f[3], "cmd": cmd, "cwd": f[8],
                    "title": TITLE_SPINNER_RE.sub("\\1⠿", title),
                    "state": "", "context": context, "agent": agent}
            if not agent:
                pane["state"] = "shell" if cmd in SHELLS else "running"
            else:
                fields, _, _ = self.inspect_agent(pane["target"], f[6], int(f[7]), working,
                                                  pane["target"] in watched)
                pane.update(fields)
            panes.append(pane)
        return panes

    def inspect_agent(self, target: str, tty: str, pid: int, working: bool, page: bool):
        """({state, ask?, sessionId?, omp}, transcript or None, visible screen or None) of an omp
        pane. The screen is captured only when needed: no session file yet (asking and the omp
        settings come from the screen), settings missing from the file, or `page` detection."""
        fields: dict = {"state": "working" if working else "idle"}
        crumb = breadcrumb(tty, pid)
        tr = None
        if crumb:
            fields["sessionId"] = session_id_of(crumb[1])
            tr = self.transcript(crumb[1])
            tr.refresh()
        exists = tr is not None and tr.exists
        st = tr.omp_state() if exists else None
        scr = None
        if page or not exists or not st["model"] or not st["thinking"]:
            cur = capture(target, scrollback=False)
            scr = cur if isinstance(cur, dict) else None
        if exists:
            ask = tr.pending_ask()
            if ask:
                fields["state"] = "asking"
                fields["ask"] = ask
        elif scr is not None and last_box_top(scr["lines"]).startswith(ASK_MARKERS):
            fields["state"] = "asking"
        fields["omp"] = self.omp_field(target, crumb, st, scr, page)
        return fields, tr, scr

    def omp_field(self, target: str, crumb, st: dict | None, scr: dict | None, page: bool) -> dict:
        model = thinking = name = None
        fast, mode, used, todo, cwd = False, "none", None, None, None
        if st is not None:
            model, thinking, fast, mode = st["model"], st["thinking"], st["fast"], st["mode"]
            used, todo, cwd = st["used"], st["todo"], st["cwd"]
        catalog = self.catalog
        catalog.get(wait=False)  # starts a refresh when missing or old
        entry = catalog.lookup(model)
        if st is None or not model or not thinking:
            foot = parse_footer(scr["lines"]) if scr is not None else None
            if foot is not None:
                self.footers[target] = foot
            else:
                foot = self.footers.get(target)  # a page or dialog hides the footer for now
            if foot is not None:
                if not model:
                    entry = catalog.by_footer_name(foot["name"], self.preferred_models(target))
                    model, name = (entry["selector"], None) if entry else (None, foot["name"])
                thinking = thinking or foot["thinking"]
                if st is None:  # brand-new session: nothing on disk yet
                    fast, mode = foot["fast"], foot["mode"]
        if entry is not None:
            name = entry["name"]
        window = entry["contextWindow"] if entry else None
        return {"model": model, "modelName": name, "thinking": thinking, "fast": fast, "mode": mode,
                "ctx": {"used": used, "window": window} if used is not None and window else None,
                "todo": todo, "cwd": cwd or (crumb[0] if crumb else None),
                "sessionId": session_id_of(crumb[1]) if crumb else None,
                "page": screen_page(scr["lines"], scr["alt"]) if page and scr is not None else None}

    def preferred_models(self, target: str) -> list[str]:
        prefer = [self.pane_models[target]] if target in self.pane_models else []
        default = model_roles().get("default")
        if default:
            sel = default.split(":", 1)[0]
            prefer += [sel, sel.split("/", 1)[0]]
        return prefer

    def cmd_lock(self, target: str) -> threading.Lock:
        with self.cmd_locks_lock:
            return self.cmd_locks.setdefault(target, threading.Lock())

    # ------------------------------------------------------------ connections

    def handle(self, sock: socket.socket, addr) -> None:
        peer = addr[0]
        # The makefile must be closed too, or the fd stays open after sock.close().
        with sock, sock.makefile("rb") as rf:
            try:
                self._handle(sock, rf, peer)
            except OSError as ex:
                log(f"{peer}: {ex}")
            except Exception as ex:  # one bad connection must never take the daemon down
                log(f"{peer}: internal error: {ex!r}")

    def _handle(self, sock: socket.socket, rf, peer: str) -> None:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        set_keepalive(sock)
        sock.settimeout(HELLO_TIMEOUT_S)
        line = rf.readline(MAX_LINE)
        try:
            first = json.loads(line)
            if not isinstance(first, dict):
                raise ValueError
        except ValueError:
            log(f"{peer}: bad first line, closing")
            return
        token = load_token()
        got = first.get("token")
        if not token or not isinstance(got, str) or not hmac.compare_digest(got.encode(), token.encode()):
            log(f"{peer}: wrong token, closing")
            return
        sock.settimeout(IDLE_DROP_S)
        if first.get("t") == "hello":
            Control(self, sock, rf, peer, first).run()
        elif first.get("t") == "upload":
            self.upload(sock, rf, peer, first)
        else:
            sock.sendall(encode({"t": "error", "error": "expected hello or upload"}))

    # ------------------------------------------------------------ uploads

    def upload(self, sock: socket.socket, rf, peer: str, req: dict) -> None:
        ident, name, size = req.get("id"), req.get("name"), req.get("size")
        if (not isinstance(ident, str) or not UPLOAD_ID_RE.match(ident) or not isinstance(name, str)
                or not isinstance(size, int) or isinstance(size, bool) or size < 0):
            sock.sendall(encode({"t": "error", "error": "bad upload request"}))
            return
        done = self.seen.get(ident)
        if done:
            sock.sendall(encode({"t": "done", "path": done}))
            return
        # A new attempt for the same id takes over: the old connection is probably a
        # half-open leftover of a dropped link that would otherwise hold the file.
        with self.uploads_lock:
            lock, old = self.uploads.get(ident, (threading.Lock(), None))
            self.uploads[ident] = (lock, sock)
        if old is not None:
            try:
                old.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        with lock:
            try:
                self._receive(sock, rf, peer, ident, name, size)
            finally:
                with self.uploads_lock:
                    if self.uploads.get(ident, (None, None))[1] is sock:
                        del self.uploads[ident]

    def _receive(self, sock: socket.socket, rf, peer: str, ident: str, name: str, size: int) -> None:
        done = self.seen.get(ident)
        if done:
            sock.sendall(encode({"t": "done", "path": done}))
            return
        PARTIAL_DIR.mkdir(parents=True, exist_ok=True)
        part = PARTIAL_DIR / ident
        offset = part.stat().st_size if part.exists() else 0
        if offset > size:
            part.unlink()
            offset = 0
        sock.sendall(encode({"t": "resume", "offset": offset}))
        if offset:
            log(f"{peer}: resuming {name!r} at {offset}/{size}")
        with open(part, "ab") as f:
            while offset < size:
                chunk = rf.read1(min(1 << 16, size - offset))
                if not chunk:
                    log(f"{peer}: upload {name!r} interrupted at {offset}/{size}")
                    return
                f.write(chunk)
                offset += len(chunk)
        with self.place_lock:
            self.dest.mkdir(parents=True, exist_ok=True)
            path = unique_path(self.dest, safe_name(name, ident))
            shutil.move(part, path)
        self.seen.add(ident, str(path))
        log(f"{peer}: received {path} ({size} bytes)")
        sock.sendall(encode({"t": "done", "path": str(path)}))
        notify(f"Received {path.name}")


def safe_name(name: str, ident: str) -> str:
    name = name.replace("\0", "").replace("\\", "/").rsplit("/", 1)[-1].strip().lstrip(".").strip()
    while len(name.encode()) > 200:
        name = name[:-1]
    return name or f"upload-{ident[:8]}"


def unique_path(folder: Path, name: str) -> Path:
    path = folder / name
    stem, ext = os.path.splitext(name)
    n = 1
    while path.exists() or path.is_symlink():
        n += 1
        path = folder / f"{stem} ({n}){ext}"
    return path


class CmdFailed(Exception):
    """A refused or failed omp command; the message is shown to the user."""


PLAN_EXIT_PROMPT = "Exit plan mode?"


class PaneCommand:
    """One `cmd` on one omp pane: preconditions, the slash command (or key), then confirmation
    from the session file, the breadcrumb or the footer. Callers serialise per pane."""

    NAMES = ("switch", "effort", "fast", "plan", "compact", "new", "clear", "retry", "resume", "rename",
             "stop", "queue", "page")

    def __init__(self, server: Server, info: dict, name: str, arg):
        self.server, self.target, self.tty, self.pid = server, info["target"], info["tty"], info["pid"]
        self.name, self.arg = name, arg if isinstance(arg, str) else ""

    # ------------------------------------------------------------ helpers

    def screen(self) -> dict:
        cur = capture(self.target, scrollback=False)
        if isinstance(cur, str):
            raise CmdFailed(cur)
        return cur

    def baseline(self) -> dict:
        crumb = breadcrumb(self.tty, self.pid)
        base = {"path": crumb[1] if crumb else None, "size": 0, "ino": None}
        if base["path"]:
            try:
                st = os.stat(base["path"])
                base["size"], base["ino"] = st.st_size, st.st_ino
            except OSError:
                pass
        return base

    def new_entries(self, base: dict) -> list[dict]:
        """Entries appended to the session file since `base` (all of it if the file is new)."""
        path = base["path"]
        if not path:
            return []
        try:
            with open(path, "rb") as f:
                start = base["size"] if os.fstat(f.fileno()).st_ino == base["ino"] else 0
                f.seek(start)
                data = f.read(8 << 20)
        except OSError:
            return []
        out = []
        for line in data[:data.rfind(b"\n") + 1].split(b"\n"):
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict):
                out.append(obj)
        return out

    def paste(self, text: str, enter: bool = True) -> None:
        err = deliver_text("cmd-" + secrets.token_hex(4), self.target, text, enter)
        if err:
            raise CmdFailed(err)

    def confirm(self, before: list[str], check, timeout: float = CMD_WAIT_S, errors: tuple = ()) -> str | None:
        """Poll until `check(screen, new_status_lines, elapsed)` returns something other than
        False (True = ok, a string = ok with that info). An `Error:` status line (or one containing
        one of `errors`) fails at once; a timeout fails with what the screen shows."""
        start = time.monotonic()
        while True:
            time.sleep(0.2)
            cur = self.screen()
            news = screen_news(before, cur["lines"])
            for s in news:
                if s.startswith("Error:") or any(e in s for e in errors):
                    raise CmdFailed(s.removeprefix("Error:").strip())
            res = check(cur, news, time.monotonic() - start)
            if res is not False:
                return None if res is True else res
            if time.monotonic() - start > timeout:
                foot = parse_footer(cur["lines"])
                shown = news[-4:] + ([cur["lines"][foot["line"]].strip()] if foot else [])
                raise CmdFailed(f"omp did not confirm {self.name} within {timeout:.0f} s"
                                + ("; the PC shows:\n" + "\n".join(shown) if shown else ""))

    def entry(self, base: dict, kind: str, pred=lambda e: True) -> dict | None:
        return next((e for e in reversed(self.new_entries(base)) if e.get("type") == kind and pred(e)), None)

    # ------------------------------------------------------------ entry point

    def run(self) -> str | None:
        info = pane_info(self.target)
        if isinstance(info, str):
            raise CmdFailed(info)
        if not info["agent"]:
            raise CmdFailed("that terminal is not running omp")
        fields, _, scr = self.server.inspect_agent(self.target, info["tty"], info["pid"], info["working"], True)
        if scr is None:
            raise CmdFailed("cannot read the terminal")
        state, omp, lines = fields["state"], fields["omp"], scr["lines"]
        if state == "asking":
            raise CmdFailed("Answer omp's question first")
        if omp["page"] is not None:
            what = omp["page"].get("title")
            raise CmdFailed(f"omp shows {repr(what) if what else 'a page or picker'} on the PC; close it first (Esc)")
        if any(DRAFT_TRAP in ln for ln in lines):
            raise CmdFailed("the PC prompt has an unsent draft: clear it on the PC first")
        if self.name != "stop" and editor_draft(lines, parse_footer(lines)):
            raise CmdFailed("omp's prompt on the PC holds unsent text; clear it first")
        if self.name in ("clear", "retry") and state == "working":
            raise CmdFailed("omp is working; stop it first")
        return getattr(self, "c_" + self.name)(state, omp, lines)

    # ------------------------------------------------------------ commands

    def c_switch(self, state, omp, before):
        sel, _, level = self.arg.strip().partition(":")
        try:
            self.server.catalog.get(wait=True)
        except RequestError as ex:
            raise CmdFailed(str(ex)) from None
        model = self.server.catalog.lookup(sel)
        if model is None:
            raise CmdFailed(f"unknown model {sel!r}")
        if level:
            if level not in THINKING_LEVELS:
                raise CmdFailed(f"unknown thinking level {level!r}")
            if level not in ("off", "auto") and level not in (model["thinking"] or []):
                raise CmdFailed(f"{model['name']} supports thinking: "
                                + ", ".join(["off", "auto", *(model["thinking"] or [])]))
        base = self.baseline()
        self.paste(f"/switch {sel}" + (f":{level}" if level else ""))
        want = footer_name(model["name"])

        def check(cur, news, t):
            if self.entry(base, "model_change", lambda e: e.get("model") == sel):
                return True
            f = parse_footer(cur["lines"])
            return bool(f and f["name"] == want and (not level or f["thinking"] == level) and t >= CMD_SETTLE_S)
        res = self.confirm(before, check)
        self.server.pane_models[self.target] = sel
        return res

    def c_effort(self, state, omp, before):
        level = self.arg.strip()
        if level not in THINKING_LEVELS:
            raise CmdFailed(f"unknown thinking level {level!r}")
        model = self.server.catalog.lookup(omp["model"])
        if model and level not in ("off", "auto") and level not in (model["thinking"] or []):
            raise CmdFailed(f"{model['name']} supports thinking: " + ", ".join(["off", "auto", *(model["thinking"] or [])]))
        base = self.baseline()
        self.paste(f"/effort {level}")

        def check(cur, news, t):
            if self.entry(base, "thinking_level_change", lambda e: e.get("thinkingLevel") == level):
                return True
            f = parse_footer(cur["lines"])
            return bool(f and f["thinking"] == level and t >= CMD_SETTLE_S)
        return self.confirm(before, check)

    def c_fast(self, state, omp, before):
        if self.arg not in ("on", "off"):
            raise CmdFailed("fast needs on or off")
        on = self.arg == "on"
        base = self.baseline()
        self.paste(f"/fast {self.arg}")

        def check(cur, news, t):
            if self.entry(base, "service_tier_change", lambda e: bool(e.get("serviceTier")) == on):
                return True
            f = parse_footer(cur["lines"])
            return bool(f and f["fast"] == on and t >= CMD_SETTLE_S)
        return self.confirm(before, check, errors=("unavailable",))

    def c_plan(self, state, omp, before):
        base = self.baseline()
        was = (parse_footer(before) or {}).get("mode")
        self.paste("/plan")

        def check(cur, news, t):
            if any(PLAN_EXIT_PROMPT in ln for ln in cur["lines"]):
                raise CmdFailed("omp asks to confirm leaving plan mode; answer on the terminal view")
            e = self.entry(base, "mode_change")
            if e:
                return str(e.get("mode"))
            f = parse_footer(cur["lines"])
            return f["mode"] if f and was is not None and f["mode"] != was else False
        return self.confirm(before, check)

    def c_compact(self, state, omp, before):
        focus = clean_text(self.arg)
        base = self.baseline()
        self.paste("/compact" + (f" {focus}" if focus else ""))

        def check(cur, news, t):
            if self.entry(base, "compaction") or any("ompact" in s for s in news) or t >= 3.0:
                return "compacting"
            return False
        return self.confirm(before, check)

    def c_new(self, state, omp, before):
        base = self.baseline()
        self.paste("/new")

        def check(cur, news, t):
            crumb = breadcrumb(self.tty, self.pid)
            return session_id_of(crumb[1]) if crumb and crumb[1] != base["path"] else False
        return self.confirm(before, check, errors=("Exit vibe mode first",))

    def c_clear(self, state, omp, before):
        base = self.baseline()
        self.paste("/clear")

        def check(cur, news, t):
            return bool(self.entry(base, "reset_boundary") or any(s.startswith("✔ Context reset") for s in news))
        return self.confirm(before, check)

    def c_retry(self, state, omp, before):
        self.paste("/retry")
        return self.confirm(before, lambda cur, news, t: t >= 2.0, errors=("Nothing to retry",))

    def c_resume(self, state, omp, before):
        sid = self.arg.strip().lower()
        if not UUID_RE.match(sid):
            raise CmdFailed("resume needs a full session id")
        if sid == omp["sessionId"]:
            raise CmdFailed("that is already this terminal's session")
        if not omp["cwd"] or sid not in {h["id"] for h in session_history(omp["cwd"], omp["sessionId"])}:
            raise CmdFailed(f"no session {sid} in {omp['cwd'] or 'this directory'}")
        base = self.baseline()
        self.paste(f"/resume {sid}")

        def check(cur, news, t):
            crumb = breadcrumb(self.tty, self.pid)
            if not crumb or crumb[1] == base["path"]:
                return False
            got = session_id_of(crumb[1])
            return "resumed" if got == sid else f"opened a copy {got}: that session is open in another terminal"
        return self.confirm(before, check, timeout=10.0)

    def c_rename(self, state, omp, before):
        title = clean_text(self.arg)
        if not title or len(title) > TITLE_MAX or "\n" in self.arg:
            raise CmdFailed(f"rename needs a single-line title of at most {TITLE_MAX} characters")
        base = self.baseline()
        self.paste(f"/rename {title}")

        def check(cur, news, t):
            e = self.entry(base, "title_change")
            if e:
                return str(e.get("title") or title)
            done = next((s for s in news if s.startswith("Session renamed to")), None)
            return done.removeprefix("Session renamed to").strip().strip(".").strip('"') if done else False
        return self.confirm(before, check)

    def c_stop(self, state, omp, before):
        if state != "working":
            raise CmdFailed("omp is not working")
        wait = self.server.last_escape.get(self.target, 0.0) + ESCAPE_GAP_S - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        base = self.baseline()
        r = tmux("send-keys", "-t", self.target, "Escape")
        self.server.last_escape[self.target] = time.monotonic()
        if r.returncode != 0:
            raise CmdFailed(tmux_error(r))

        def check(cur, news, t):
            info = pane_info(self.target)
            if isinstance(info, dict) and not info["working"]:
                return True
            return bool(self.entry(base, "message", lambda e: (e.get("message") or {}).get("stopReason") == "aborted"))
        return self.confirm(before, check)

    def c_queue(self, state, omp, before):
        if not self.arg.strip():
            raise CmdFailed("nothing to queue")
        if state == "working":
            self.paste(self.arg, enter=False)
            r = tmux("send-keys", "-t", self.target, "C-q")
            if r.returncode != 0:
                raise CmdFailed(tmux_error(r))
            return "queued"
        self.paste(self.arg)
        return "sent"

    def c_page(self, state, omp, before):
        cmd = self.arg.strip()
        if cmd not in PAGE_COMMANDS:
            raise CmdFailed(f"{cmd!r} is not a page command; allowed: " + " ".join(PAGE_COMMANDS))
        self.paste(cmd)

        def check(cur, news, t):
            page = screen_page(cur["lines"], cur["alt"])
            if page is not None:
                return page.get("title") or True
            return t >= PAGE_WAIT_S - 0.2 and cur["lines"] != before
        return self.confirm(before, check, timeout=PAGE_WAIT_S)


class Control:
    """One phone's control connection: a reader (this thread) handles requests, a writer
    thread owns the zlib stream and streams the watched pane (screen diffs in the term view,
    transcript entries in the chat view). The writer diffs against what it last wrote, so on
    a slow link sends block and stale intermediate states are skipped."""

    def __init__(self, server: Server, sock: socket.socket, rf, peer: str, hello: dict):
        self.server, self.sock, self.rf, self.peer = server, sock, rf, peer
        self.client = hello.get("client") if isinstance(hello.get("client"), str) else ""
        self.cond = threading.Condition()
        self.out: collections.deque[dict] = collections.deque()
        self.closed = False
        self.target = hello.get("target") if isinstance(hello.get("target"), str) else ""
        self.view = hello.get("view") if hello.get("view") in ("chat", "term") else "chat"
        self.force = False
        self.dirty = True  # first pass sends the current sessions even when paused
        # The phone pauses us while DevDeck isn't on screen: no screens or transcripts, and
        # sessions only when a pane's state or question changes.
        self.paused = hello.get("paused") is True
        self.last: dict | None = None
        have = hello.get("have")
        prev = server.client_screens.get(self.client) if self.client else None
        if (self.view == "term" and isinstance(have, dict) and prev and have.get("target") == prev["target"]
                and have.get("rev") == prev["rev"]):
            self.last = prev
        self.comp = zlib.compressobj(6)
        self.requests = threading.BoundedSemaphore(MAX_REQUESTS)
        self.info_cache: tuple[str, float, dict | str] | None = None
        self.poke = False  # check the watched pane for an omp page right away (after keys, cmd page)

    def poke_page(self) -> None:
        with self.cond:
            self.poke = True
            self.cond.notify()

    def push(self, msg: dict) -> None:
        with self.cond:
            self.out.append(msg)
            self.cond.notify()

    def kick(self) -> None:
        with self.cond:
            self.dirty = True
            self.cond.notify()

    def run(self) -> None:
        self.sock.sendall(encode({"t": "welcome", "server": "devdeck", "version": PROTOCOL_VERSION}))
        if self.paused:
            self.sock.settimeout(PAUSED_DROP_S)
        log(f"{self.peer}: connected (client {self.client or '?'}, {self.view} {self.target or '-'})")
        writer = threading.Thread(target=self.write_loop, daemon=True)
        writer.start()
        self.server.attach(self)
        try:
            self.read_loop()
        finally:
            self.server.detach(self)
            with self.cond:
                self.closed = True
                self.cond.notify()
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            writer.join(timeout=TMUX_TIMEOUT_S + 1)
            log(f"{self.peer}: disconnected")

    def read_loop(self) -> None:
        while True:
            try:
                line = self.rf.readline(MAX_LINE)
            except TimeoutError:
                log(f"{self.peer}: silent for {self.sock.gettimeout():.0f} s, dropping")
                return
            except OSError:
                return
            if not line:
                return
            if not line.endswith(b"\n") and len(line) >= MAX_LINE:
                self.push({"t": "error", "error": "line too long"})
                return
            try:
                msg = json.loads(line)
                if not isinstance(msg, dict):
                    raise ValueError("not an object")
            except ValueError as ex:
                self.push({"t": "error", "error": f"bad json: {ex}"})
                continue
            self.dispatch(msg)

    def dispatch(self, msg: dict) -> None:
        kind = msg.get("t")
        if kind == "ping":
            self.push({"t": "pong", "ts": msg.get("ts")})
        elif kind == "watch":
            target, view = msg.get("target"), msg.get("view", self.view)
            if not isinstance(target, str) or not target or view not in ("chat", "term"):
                self.push({"t": "error", "error": "watch needs a target and view chat|term"})
                return
            with self.cond:
                self.target, self.view, self.force = target, view, True
                self.cond.notify()
        elif kind == "resync":
            with self.cond:
                self.force = True
                self.cond.notify()
        elif kind in ("pause", "resume"):
            paused = kind == "pause"
            self.sock.settimeout(PAUSED_DROP_S if paused else IDLE_DROP_S)
            with self.cond:
                self.paused, self.dirty = paused, True
                self.cond.notify()
        elif kind == "send":
            self.queued(msg, self.do_send)
        elif kind == "clip":
            self.queued(msg, self.do_clip)
        elif kind == "answer":
            threading.Thread(target=self.queued, args=(msg, self.do_answer, self.server.answer_lock),
                             daemon=True).start()
        elif kind == "keys":
            self.do_keys(msg)
        elif kind == "tap":
            self.do_tap(msg)
        elif kind == "type":
            self.do_type(msg)
        elif kind == "new":
            self.new_terminal()
        elif kind in ("more", "full", "ls", "read", "git", "models", "history", "cmd"):
            self.request(msg)
        else:
            self.push({"t": "error", "error": f"unknown message type {kind!r}"})

    # ------------------------------------------------------------ queued items

    def queued(self, msg: dict, action, lock: threading.Lock | None = None) -> None:
        ident = msg.get("id")
        if not isinstance(ident, str) or not ident:
            self.push({"t": "error", "error": f"{msg.get('t')} needs an id"})
            return
        with lock or self.server.deliver_lock:
            if self.server.seen.has(ident):
                self.push({"t": "ack", "id": ident, "ok": True})
                return
            try:
                err = action(msg)
            except RequestError as ex:
                err = str(ex)
            if err is None:
                self.server.seen.add(ident)
        if err is None:
            self.push({"t": "ack", "id": ident, "ok": True})
        else:
            log(f"{self.peer}: {msg.get('t')} {ident} failed: {err.splitlines()[0] if err else err}")
            self.push({"t": "ack", "id": ident, "ok": False, "error": err})

    def do_send(self, msg: dict) -> str | None:
        target, text = msg.get("target"), msg.get("text", "")
        if not isinstance(target, str) or not target:
            return "no target"
        if not isinstance(text, str):
            return "text must be a string"
        enter = bool(msg.get("enter"))
        info = pane_info(target)
        if isinstance(info, str):
            return info
        if info["agent"]:
            if enter and not text.strip() and info["working"]:
                return "An empty Enter would stop the agent; use Stop"
            # omp sends commands with arguments they do not take to the model as a prompt.
            line = text.strip()
            if "\n" not in line:
                for rx, repl in SEND_REWRITES:
                    m = rx.match(line)
                    if m:
                        text = repl + m.group(1)
                        break
        return deliver_text(msg["id"], target, text, enter)

    def do_clip(self, msg: dict) -> str | None:
        text = msg.get("text")
        if not isinstance(text, str):
            return "text must be a string"
        return set_clipboard(text)

    def do_answer(self, msg: dict) -> str | None:
        target, call = msg.get("target"), msg.get("toolCallId")
        if not isinstance(target, str) or not target or not isinstance(call, str) or not call:
            return "answer needs a target and a toolCallId"
        tr = self.transcript_of(target)
        if tr is None:
            return "no omp session in that terminal"
        tr.refresh(force=True)
        ask = tr.pending_ask()
        if ask is None or ask["toolCallId"] != call:
            if tr.has_result(call):
                return "that question was already answered"
            return "that question is no longer open"
        batches = ask_keystrokes(ask["questions"], msg.get("answers"))
        lines = visible_lines(target)
        if lines is None:
            return "cannot read the terminal"
        if any(DRAFT_TRAP in ln for ln in lines):
            return "the PC prompt has an unsent draft, so keys would go there: clear it on the PC first"
        if last_box_top(lines).startswith(TEXT_BOX_MARKERS):
            return "a text box is open in the question dialog on the PC: close it first"
        for i, (kind, value) in enumerate(batches):
            if i:
                box = kind == "text" or batches[i - 1][0] == "text"
                time.sleep(BOX_PAUSE_S if box else KEY_PAUSE_S)
            if kind == "keys":
                r = tmux("send-keys", "-t", target, *value)
            else:
                r = tmux("send-keys", "-t", target, "-l", "--", value)
            if r.returncode != 0:
                return f"keys: {tmux_error(r)}"
        deadline = time.monotonic() + ANSWER_WAIT_S
        while time.monotonic() < deadline:
            time.sleep(0.2)
            tr.refresh(force=True)
            if tr.has_result(call):
                self.kick()
                self.server.poll_now.set()
                return None
        lines = visible_lines(target) or []
        while lines and not lines[-1].strip():
            lines.pop()
        return "omp did not accept the answer; the PC screen shows:\n" + "\n".join(lines[-15:])

    def new_terminal(self) -> None:
        """A fresh tmux session phone-N (lowest free N) running the default shell, watched now."""
        with self.server.deliver_lock:  # two phones pressing "+ New" at once must not collide
            r = tmux("list-sessions", "-F", "#{session_name}")
            taken = set(r.stdout.decode(errors="replace").split()) if r.returncode == 0 else set()
            n = 1
            while f"phone-{n}" in taken:
                n += 1
            name = f"phone-{n}"
            r = tmux("new-session", "-d", "-s", name, "-c", str(Path.home()))
        if r.returncode != 0:
            self.push({"t": "error", "error": f"new terminal: {tmux_error(r)}"})
            return
        info = pane_info(name)
        target = info["target"] if isinstance(info, dict) else name
        log(f"{self.peer}: created terminal {target}")
        self.push({"t": "created", "target": target})
        with self.cond:
            self.target, self.view, self.force = target, "term", True
            self.cond.notify()
        self.server.poll_now.set()

    def do_keys(self, msg: dict) -> None:
        target, keys = msg.get("target"), msg.get("keys")
        if not isinstance(target, str) or not target or not isinstance(keys, list) or not keys:
            self.push({"t": "error", "error": "keys needs a target and a key list"})
            return
        if len(keys) > MAX_KEYS or not all(isinstance(k, str) and KEY_RE.match(k) for k in keys):
            self.push({"t": "error", "error": f"invalid keys {keys!r}"[:200]})
            return
        r = tmux("send-keys", "-t", target, *keys)
        if r.returncode != 0:
            self.push({"t": "error", "error": f"keys: {tmux_error(r)}"})
            return
        if "Escape" in keys:
            info = self.pane(target)
            if isinstance(info, dict):
                self.server.last_escape[info["target"]] = time.monotonic()
        self.poke_page()

    def do_tap(self, msg: dict) -> None:
        """Move the selection of the omp page shown in `target` to screen row `row` (Up/Down only;
        the UI sends Enter itself)."""
        target, row = msg.get("target"), msg.get("row")
        if not isinstance(target, str) or not target or not isinstance(row, int) or isinstance(row, bool) or row < 0:
            self.push({"t": "error", "error": "tap needs a target and a row"})
            return
        cur = capture(target, scrollback=False)
        if isinstance(cur, str):
            self.push({"t": "error", "error": f"tap: {cur}"})
            return
        lines = cur["lines"]
        marks = [(i, ln.index("❯")) for i, ln in enumerate(lines) if "❯" in ln]
        if not marks:
            self.push({"t": "error", "error": "can't locate the selection on this page; use the arrow keys"})
            return
        at, col = min(marks, key=lambda m: abs(m[0] - row))
        step = 1 if row > at else -1
        n = 0
        for r in range(at + step, row + step, step):
            # Rules and blank rows in the selector's column are skipped by omp's own navigation.
            if (lines[r] if r < len(lines) else "")[col:col + 4].strip(" ─│┆"):
                n += 1
        n = min(n, TAP_MAX)
        key = "Down" if step > 0 else "Up"
        for i in range(0, n, 32):
            if i:
                time.sleep(KEY_PAUSE_S)
            r = tmux("send-keys", "-t", target, *([key] * min(32, n - i)))
            if r.returncode != 0:
                self.push({"t": "error", "error": f"tap: {tmux_error(r)}"})
                return
        self.poke_page()

    def do_type(self, msg: dict) -> None:
        target, text = msg.get("target"), msg.get("text")
        if not isinstance(target, str) or not target or not isinstance(text, str):
            self.push({"t": "error", "error": "type needs a target and text"})
            return
        text = re.sub(r"[\x00-\x1f\x7f]", "", text)  # no Enter/Escape/Tab smuggled in as text
        if len(text) > TYPE_MAX or not text:
            self.push({"t": "error", "error": f"type takes one line of 1 to {TYPE_MAX} characters"})
            return
        r = tmux("send-keys", "-t", target, "-l", "--", text)
        if r.returncode != 0:
            self.push({"t": "error", "error": f"type: {tmux_error(r)}"})
            return
        self.poke_page()

    # ------------------------------------------------------------ requests

    def request(self, msg: dict) -> None:
        req = msg.get("req")
        if not isinstance(req, str) or not req:
            self.push({"t": "error", "error": f"{msg.get('t')} needs a req"})
            return
        if not self.requests.acquire(blocking=False):
            self.push({"t": "error", "req": req, "error": "too many requests at once"})
            return
        threading.Thread(target=self._request, args=(msg, req), daemon=True).start()

    def _request(self, msg: dict, req: str) -> None:
        kind = msg["t"]
        try:
            if kind == "more":
                reply = self.do_more(msg)
            elif kind == "full":
                reply = self.do_full(msg)
            elif kind == "ls":
                reply = {"t": "ls", **list_dir(msg.get("path"))}
            elif kind == "read":
                reply = {"t": "read", **read_file(msg.get("path"))}
            elif kind == "git":
                reply = {"t": "git", **git_request(msg)}
            elif kind == "models":
                data = self.server.catalog.get(wait=True)
                reply = {"t": "models", "models": data["models"], "roles": model_roles(),
                         "fetchedAt": data["fetchedAt"]}
            elif kind == "history":
                reply = self.do_history(msg)
            else:
                reply = self.do_cmd(msg)
            reply["req"] = req
        except RequestError as ex:
            reply = {"t": "error", "req": req, "error": str(ex)}
        except StaleFile:
            reply = {"t": "error", "req": req, "error": "the session file changed; try again"}
        except Exception as ex:
            log(f"{self.peer}: {kind} failed: {ex!r}")
            reply = {"t": "error", "req": req, "error": f"internal error: {ex}"}
        finally:
            self.requests.release()
        self.push(reply)

    def transcript_of(self, target: str) -> Transcript | None:
        info = self.pane(target)
        if isinstance(info, str):
            raise RequestError(info)
        path = breadcrumb_session(info["tty"], info["pid"])
        return self.server.transcript(path) if path else None

    def agent_pane(self, target) -> tuple[dict, dict]:
        """(pane_info, inspect_agent fields) of an omp pane, else RequestError."""
        if not isinstance(target, str) or not target:
            raise RequestError("no target")
        info = pane_info(target)
        if isinstance(info, str):
            raise RequestError(info)
        if not info["agent"]:
            raise RequestError("that terminal is not running omp")
        fields, _, _ = self.server.inspect_agent(info["target"], info["tty"], info["pid"], info["working"], False)
        return info, fields

    def do_history(self, msg: dict) -> dict:
        _, fields = self.agent_pane(msg.get("target"))
        omp = fields["omp"]
        if not omp["cwd"]:
            raise RequestError("omp has not told which directory this terminal works in")
        return {"t": "history", "cwd": omp["cwd"], "sessions": session_history(omp["cwd"], omp["sessionId"])}

    def do_cmd(self, msg: dict) -> dict:
        target, name = msg.get("target"), msg.get("cmd")
        if name not in PaneCommand.NAMES:
            return {"t": "cmd", "ok": False, "error": f"unknown command {name!r}"}
        if not isinstance(target, str) or not target:
            return {"t": "cmd", "ok": False, "error": "no target"}
        info = pane_info(target)
        if isinstance(info, str):
            return {"t": "cmd", "ok": False, "error": info}
        lock = self.server.cmd_lock(info["target"])
        if not lock.acquire(timeout=CMD_QUEUE_S):
            return {"t": "cmd", "ok": False, "error": "another command is still running in that terminal"}
        try:
            result = PaneCommand(self.server, info, name, msg.get("arg")).run()
            reply = {"t": "cmd", "ok": True}
            if result:
                reply["info"] = result
            log(f"{self.peer}: cmd {name} on {info['target']}: ok" + (f" ({result})" if result else ""))
        except CmdFailed as ex:
            reply = {"t": "cmd", "ok": False, "error": str(ex)}
            log(f"{self.peer}: cmd {name} on {info['target']} failed: {str(ex).splitlines()[0]}")
        finally:
            lock.release()
        self.server.poll_now.set()
        if name == "page":
            self.poke_page()
        return reply

    def do_more(self, msg: dict) -> dict:
        target, before = msg.get("target"), msg.get("before")
        if not isinstance(target, str) or not isinstance(before, int) or isinstance(before, bool):
            raise RequestError("more needs a target and before")
        tr = self.transcript_of(target)
        if tr is None:
            raise RequestError("no omp session in that terminal")
        tr.refresh()
        entries, more = tr.page(before)
        return {"t": "transcript", "target": self.pane(target)["target"], "sessionId": session_id_of(tr.path),
                "reset": False, "prepend": True, "entries": entries, "hasMore": more}

    def do_full(self, msg: dict) -> dict:
        target, entry = msg.get("target"), msg.get("entryId")
        if not isinstance(target, str) or not isinstance(entry, str) or not entry:
            raise RequestError("full needs a target and an entryId")
        tr = self.transcript_of(target)
        if tr is None:
            raise RequestError("no omp session in that terminal")
        tr.refresh()
        text, _ = cap(tr.full(entry), FULL_CAP)
        return {"t": "full", "entryId": entry, "text": text}

    def pane(self, target: str) -> dict | str:
        """pane_info, cached briefly (the chat view asks every CHAT_POLL_S)."""
        now = time.monotonic()
        cached = self.info_cache
        if cached and cached[0] == target and now - cached[1] < PANE_INFO_TTL_S:
            return cached[2]
        info = pane_info(target)
        self.info_cache = (target, now, info)
        return info

    # ------------------------------------------------------------ writer

    def write(self, msgs: list[dict]) -> None:
        data = b"".join(self.comp.compress(encode(m)) + self.comp.flush(zlib.Z_SYNC_FLUSH) for m in msgs)
        self.sock.sendall(data)

    def write_loop(self) -> None:
        sent_panes: list | None = None
        sent_sig: tuple | None = None
        seen_rev = -1
        next_screen = next_chat = next_page = 0.0
        view_error: str | None = None
        chat: dict | None = None    # {target, path, gen, rev} of what this client has
        page: dict | None = None    # last omp page frame written in the chat view
        try:
            while True:
                with self.cond:
                    if self.paused:
                        self.cond.wait_for(lambda: self.out or self.closed or self.dirty or not self.paused)
                    else:
                        due = next_screen if self.view == "term" else next_chat
                        self.cond.wait_for(lambda: self.out or self.closed or self.force or self.dirty or self.paused
                                           or self.poke, timeout=max(0.0, due - time.monotonic()))
                    if self.closed:
                        return
                    msgs = list(self.out)
                    self.out.clear()
                    target, view, paused, force, poke = self.target, self.view, self.paused, self.force, self.poke
                    self.dirty = False
                    if not paused:
                        self.force = self.poke = False
                if msgs:
                    self.write(msgs)
                with self.server.ctl_cond:
                    panes, sig, rev = self.server.panes, self.server.panes_sig, self.server.panes_rev
                if panes is not None and panes is not sent_panes and (rev != seen_rev or not paused):
                    seen_rev = rev
                    send = (sent_panes is None or sig != sent_sig) if paused else panes != sent_panes
                    if send:
                        self.write([{"t": "sessions", "list": panes}])
                        sent_sig = sig
                    if send or not paused:
                        sent_panes = panes
                if paused:
                    continue
                now = time.monotonic()
                if view == "term":
                    chat = page = None
                    if now < next_screen and not force:
                        continue
                    next_screen = now + SCREEN_POLL_S
                    cur = capture(target)
                    if isinstance(cur, str):
                        if cur != view_error:
                            self.write([{"t": "error", "error": f"{cur}: {target}"}])
                            view_error = cur
                        continue
                    view_error = None
                    last = None if force else self.last
                    if last is not None and all(last[k] == cur[k] for k in ("target", "lines", "cursor", "cols", "rows")):
                        continue
                    rev = self.server.next_rev()
                    self.write([screen_message(rev, cur, last)])
                    next_screen = time.monotonic() + MIN_FRAME_S
                    self.last = {**cur, "rev": rev}
                    if self.client:
                        self.server.client_screens[self.client] = self.last
                else:
                    if now < next_chat and not force and not poke:
                        continue
                    next_chat = now + CHAT_POLL_S
                    if not target:
                        continue
                    info = self.pane(target) if not force else pane_info(target)
                    if force:
                        self.info_cache = (target, now, info)
                    if isinstance(info, str):
                        if info != view_error:
                            self.write([{"t": "error", "error": f"{info}: {target}"}])
                            view_error = info
                        continue
                    view_error = None
                    chat = self.chat_tick(info, chat, force)
                    if page is not None and page["target"] != info["target"]:
                        page = None
                    if info["agent"] and (force or poke or page is not None or now >= next_page):
                        next_page = now + PAGE_CHECK_S
                        page = self.page_tick(info["target"], page, force)
                        if page is not None:
                            next_chat = min(next_chat, time.monotonic() + MIN_FRAME_S)
                    elif page is not None:
                        self.write([{"t": "screen", "target": page["target"], "page": False}])
                        page = None
        except OSError:
            pass
        finally:
            # Unblock the reader if the write side died first.
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def page_tick(self, target: str, last: dict | None, force: bool) -> dict | None:
        """Stream the omp page (picker, settings, ...) open in the watched pane as `screen` frames
        tagged `page:true`; one `page:false` frame when it closes. Returns the last frame."""
        cur = capture(target, scrollback=False)
        if isinstance(cur, str):
            return last
        if screen_page(cur["lines"], cur["alt"]) is None:
            if last is not None:
                self.write([{"t": "screen", "target": cur["target"], "page": False}])
                self.server.poll_now.set()  # pane omp.page back to null
            return None
        if last is None:
            self.server.poll_now.set()
        base = None if force else last
        if base is not None and all(base[k] == cur[k] for k in ("target", "lines", "cursor", "cols", "rows")):
            return last
        rev = self.server.next_rev()
        msg = screen_message(rev, cur, base)
        msg["page"] = True
        self.write([msg])
        return {**cur, "rev": rev}

    def chat_tick(self, info: dict, chat: dict | None, force: bool) -> dict | None:
        target = info["target"]
        path = breadcrumb_session(info["tty"], info["pid"])
        reset = force or chat is None or chat["target"] != target or chat["path"] != path
        if path is None:
            if reset:
                self.write([{"t": "transcript", "target": target, "sessionId": None, "reset": True,
                             "entries": [], "hasMore": False}])
            return {"target": target, "path": None, "gen": 0, "rev": 0}
        tr = self.server.transcript(path)
        try:
            tr.refresh()
            if not reset:
                delta = tr.since(chat["gen"], chat["rev"])
                if delta is not None:
                    rev, entries = delta
                    if entries:
                        self.write([{"t": "transcript", "target": target, "sessionId": session_id_of(path),
                                     "reset": False, "entries": entries, "hasMore": False}])
                    return {**chat, "rev": rev}
            gen, rev, entries, more = tr.tail()
        except StaleFile:
            return None
        except (OSError, ValueError, KeyError) as ex:
            log(f"{self.peer}: cannot read {path}: {ex!r}")
            tr.invalidate()
            return None
        self.write([{"t": "transcript", "target": target, "sessionId": session_id_of(path), "reset": True,
                     "entries": entries, "hasMore": more}])
        return {"target": target, "path": path, "gen": gen, "rev": rev}


def cmd_serve(args) -> None:
    if not load_token():
        sys.exit(f"no token at {TOKEN_FILE}; run: {sys.argv[0]}{f' --instance {INSTANCE}' if INSTANCE else ''} pair")
    server = Server(args.port, Path(args.dest).expanduser())

    def on_signal(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, on_signal)
    log(f"listening on tcp/{args.port}; uploads go to {server.dest}")
    try:
        server.serve()
    except KeyboardInterrupt:
        pass
    finally:
        server.close()


# ---------------------------------------------------------------- pairing

def find_adb(required: bool = True) -> str | None:
    for cand in (os.environ.get("ADB"), shutil.which("adb"),
                 str(HERE.parent / "phone_synaptic_trackpad" / "platform-tools" / "adb")):
        if cand and os.access(cand, os.X_OK):
            return cand
    if required:
        sys.exit("adb not found: install android-tools, or set ADB=/path/to/adb")
    return None


def pick_serial(adb: str, wanted: str | None) -> str:
    out = subprocess.run([adb, "devices"], capture_output=True, text=True).stdout
    devices = [f[0] for f in (line.split() for line in out.splitlines()[1:]) if len(f) >= 2 and f[1] == "device"]
    serial = wanted or (devices[0] if len(devices) == 1 else DEFAULT_SERIAL)
    if serial not in devices and ":" in serial:
        print(f"adb connect {serial} ...")
        subprocess.run([adb, "connect", serial], capture_output=True, text=True, timeout=60)
    return serial


def pc_hosts() -> list[tuple[str, str]]:
    """(interface, IPv4) of UP interfaces the phone may reach: LAN first, tailnet last."""
    out = subprocess.run(["ip", "-4", "-o", "addr", "show", "up"], capture_output=True, text=True).stdout
    lan, tail = [], []
    for m in re.finditer(r"^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/", out, re.M):
        iface, ip = m.group(1), m.group(2)
        if iface.startswith(SKIP_IFACES) or ip.startswith(("127.", "169.254.")):
            continue
        (tail if iface == "tailscale0" else lan).append((iface, ip))
    return lan + tail


def cmd_pair(args) -> None:
    adb_bin = find_adb()
    serial = pick_serial(adb_bin, args.serial)
    adb = [adb_bin, "-s", serial]
    state = subprocess.run(adb + ["get-state"], capture_output=True, text=True)
    if state.stdout.strip() != "device":
        sys.exit(f"phone {serial} not ready over adb: {(state.stderr or state.stdout).strip()} "
                 "(enable USB/wireless debugging and accept the prompt, or pass -s SERIAL)")
    if not APK.exists() or args.rebuild:
        env = {**os.environ, "DEVDECK_VARIANT": INSTANCE} if INSTANCE else None
        subprocess.run([str(HERE / "android" / "build.sh")], check=True, env=env)

    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if not load_token():
        TOKEN_FILE.touch(mode=0o600)
        TOKEN_FILE.chmod(0o600)
        TOKEN_FILE.write_text(secrets.token_hex(32) + "\n")
    token = load_token()

    hosts = pc_hosts()
    if not hosts:
        sys.exit("no usable IPv4 address on this PC")
    print(f"installing app on {serial}...")
    # Copy first, then install on the phone: over a slow relay a streamed `adb install` takes
    # long enough for the screen to lock, and Play Protect rejects installs while locked.
    remote = f"/data/local/tmp/{APK.name}"
    subprocess.run(adb + ["push", str(APK), remote], check=True, stdout=subprocess.DEVNULL)
    r = subprocess.run(adb + ["shell", f"pm install -r {remote}; rc=$?; rm -f {remote}; exit $rc"],
                       capture_output=True, text=True)
    if r.returncode != 0 or "Success" not in r.stdout:
        sys.exit(f"install failed: {(r.stdout + r.stderr).strip()} "
                 "(unlock the phone; if Play Protect asks, choose 'Install anyway', then retry)")
    # Notifications (question asked / turn finished), and keep Doze from cutting the app's
    # network while the screen is off.
    subprocess.run(adb + ["shell", "pm", "grant", APP_PACKAGE, "android.permission.POST_NOTIFICATIONS"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(adb + ["shell", "dumpsys", "deviceidle", "whitelist", f"+{APP_PACKAGE}"],
                   check=True, stdout=subprocess.DEVNULL)
    subprocess.run(adb + ["shell", "am", "start", "-n", APP_ACTIVITY, "--es", "token", token,
                          "--es", "hosts", ",".join(ip for _, ip in hosts), "--ei", "port", str(args.port)],
                   check=True, stdout=subprocess.DEVNULL)
    print(f"paired: the phone tries {', '.join(f'{ip} ({iface})' for iface, ip in hosts)} on tcp/{args.port}.")
    lan_ifaces = sorted({iface for iface, _ in hosts if iface != "tailscale0"})
    if shutil.which("ufw") and lan_ifaces:
        print("ufw is installed; if it is active, allow the port on the LAN interfaces once:")
        for iface in lan_ifaces:
            print(f"  sudo ufw allow in on {iface} to any port {args.port} proto tcp")


# ---------------------------------------------------------------- service

def cmd_install_service(args) -> None:
    unit_dir = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "systemd" / "user"
    unit_dir.mkdir(parents=True, exist_ok=True)
    dest = Path(args.dest).expanduser().resolve()
    (unit_dir / UNIT_NAME).write_text(f"""[Unit]
Description={LABEL} daemon (drive omp agents and tmux sessions from the phone)
PartOf=graphical-session.target
After=graphical-session.target

[Service]
ExecStart={sys.executable} {Path(__file__).resolve()}{f" --instance {INSTANCE}" if INSTANCE else ""} --port {args.port} serve --dest "{dest}"
Restart=on-failure
RestartSec=2

[Install]
WantedBy=graphical-session.target
""")
    was_active = subprocess.run(["systemctl", "--user", "is-active", "--quiet", UNIT_NAME]).returncode == 0
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", UNIT_NAME], check=True)
    if was_active:
        subprocess.run(["systemctl", "--user", "restart", UNIT_NAME], check=True)
    print(f"installed and started {UNIT_NAME}; logs: journalctl --user -u {UNIT_NAME} -f")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, help=f"TCP port (default {DEFAULT_PORT}, or 47491 with --instance)")
    ap.add_argument("--instance", default=os.environ.get("DEVDECK_INSTANCE") or None, metavar="NAME",
                    help="run a separate side-by-side install NAME (own app package, token, state, unit "
                         "and port; env DEVDECK_INSTANCE)")
    sub = ap.add_subparsers(dest="cmd")
    p_serve = sub.add_parser("serve", help="run the daemon (default)")
    p_pair = sub.add_parser("pair", help="install the app on the phone via adb and pair it")
    p_pair.add_argument("-s", "--serial", help="adb serial (default: the only device, else "
                                               f"{DEFAULT_SERIAL})")
    p_pair.add_argument("--rebuild", action="store_true", help="rebuild the APK first")
    p_svc = sub.add_parser("install-service", help="start the daemon with every graphical session")
    for p in (p_serve, p_svc):
        p.add_argument("--dest", default=str(DEFAULT_DEST),
                       help="where received files go (default %(default)s)")
    argv = sys.argv[1:]
    args = ap.parse_args(argv)
    if args.cmd is None:
        args = ap.parse_args([*argv, "serve"])
    if args.instance:
        apply_instance(args.instance)
    if args.port is None:
        args.port = DEFAULT_PORT
    {"serve": cmd_serve, "pair": cmd_pair, "install-service": cmd_install_service}[args.cmd](args)


if __name__ == "__main__":
    main()
