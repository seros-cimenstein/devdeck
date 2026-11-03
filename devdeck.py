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
import hashlib
import hmac
import http.client
import itertools
import json
import mimetypes
import mmap
import os
import pwd
import re
import secrets
import select
import shlex
import shutil
import signal
import socket
import sqlite3
import ssl
import stat
import statistics
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
import wave
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
CTL_SOCK = STATE_DIR / "ctl.sock"  # local control socket for ddctl (serve --ctl overrides)
TRASH_DIR = STATE_DIR / "trash"   # sessions deleted from the phone (restorable)
TERMINALS_FILE = STATE_DIR / "terminals.json"  # omp sessions seen open in panes (README "Restore")
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

# omp controls (models, roles, history, cmd) and live pages
MODELS_FILE = STATE_DIR / "models.json"
MODELS_VERSION = 2        # shape of MODELS_FILE; other versions are refetched
MODELS_TTL_S = 6 * 3600.0
MODELS_TIMEOUT_S = 90.0
OMP_MODELS_DB = OMP_DIR / "models.db"        # omp's provider-model cache (intelligence scores, web grounding)
OMP_STATS_DB = OMP_DIR.parent / "stats.db"   # omp's usage statistics (one row per assistant reply)
USAGE_DAYS = 30
USAGE_SAMPLES = 50        # speed and time to first token: medians of this many latest replies
USAGE_TTL_S = 60.0
OMP_CONFIG_TIMEOUT_S = 30.0
# Provider usage limits (omp's /usage): `omp usage --json` plus `omp usage reset --json`
LIMITS_FILE = STATE_DIR / "usage.json"
LIMITS_VERSION = 1        # shape of LIMITS_FILE; other versions are refetched
LIMITS_FRESH_S = 60.0     # older copies are served at once and refreshed in the background
LIMITS_TIMEOUT_S = 120.0  # omp fetches every account's report; a cold cache takes a minute or more
LIMITS_RETRY_S = 30.0     # after a failed refresh, only an explicit one (force) retries sooner
RESET_ACCOUNT_RE = re.compile(r"^(anthropic|openai-codex)/(\d{1,6})$")  # `omp usage reset` target
RESET_SPEND_S = 90.0
HISTORY_DAYS_MAX = 30
PRESET_RE = re.compile(r"^[\w.-]{1,64}$")
ROLE_NAME_RE = re.compile(r"^[\w.-]{1,64}$")
DATED_ID_RE = re.compile(r"-\d{8}$")
CMD_WAIT_S = 6.0
CMD_QUEUE_S = 20.0        # how long a command waits for the previous one on the same pane
CMD_SETTLE_S = 0.8        # footer-confirmed commands wait this long for an error line first
ESCAPE_GAP_S = 0.6        # two Escapes closer than 500 ms open omp's rewind picker
PAGE_WAIT_S = 4.0
PAGE_CHECK_S = 0.6        # chat view: how often the watched pane is checked for an open page
TODO_CAP = 4000
HISTORY_MAX = 50
HISTORY_ALL_MAX = 100    # sessions in the all-projects list
TAIL_READ = 65536        # first read from a session file's end when checking for a cut-off turn
RESTORE_OFFER_S = 24 * 3600  # interrupted/terminated sessions this recent are offered after the daemon starts
RESTORE_OFFER_MAX = 20
TERMINATED_GUESS_S = 48 * 3600  # files older than the terminals record: unfinished ones this recent count as terminated
TERMINALS_POLL_S = 5.0   # how often the open omp sessions are recorded (TERMINALS_FILE)
TERMINALS_KEEP_S = 7 * 24 * 3600  # recorded sessions closed this long ago are forgotten
EXIT_ABORT_TEXT = "Previous OMP process exited before completing the turn."  # omp's exit-recovery abort
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

# Sketch canvas (the omp `sketch` extension, relayed to the phone; README "Sketch")
SKETCH_DIR = OMP_DIR / "sketch"  # the extension's <omp pid>.json registrations
SKETCH_PATHS = {"/send": "POST", "/decline": "POST", "/diagrams": "GET", "/info": "GET"}
SKETCH_HTTP_S = 15.0
SKETCH_EVENTS_S = 45.0    # the server sends a heartbeat every 15 s
SKETCH_RETRY_S = 2.0
SKETCH_MISSING = "omp in that terminal has not loaded the sketch extension (install it, then restart omp)"

# The devdeck omp extension (omp-ext/devdeck/, README "The devdeck omp extension"): /btw, plan
# review and tree moves of the omp in a pane, over its token-gated server on 127.0.0.1
EXT_DIR = OMP_DIR / "devdeck"   # <omp pid>.json registrations, btw/<session id>.ids, settings-schema.json
EXT_SRC = HERE / "omp-ext" / "devdeck"
EXT_LINK = OMP_DIR / "extensions" / "devdeck"
EXT_HTTP_S = 15.0
EXT_EVENTS_S = 45.0          # the server sends a heartbeat every 15 s
EXT_MISSING = "omp in this terminal hasn't loaded the devdeck extension; restart omp"
BTW_QUESTION_MAX = 20_000
BTW_RUN_S = 15 * 60.0        # a side question's events are relayed at most this long
TREE_PREVIEW = 160
TREE_SKIP = {"session", "title", "custom", "model_usage", "credential_pin", "label", "title_change"}
ENTRY_ID_RE = re.compile(r"^[\w-]{1,64}$")
GOTO_WAIT_S = 10.0
GOTO_SUMMARY_S = 180.0       # "go here with summary" waits for omp's branch summary (a model call)
SETTINGS_TYPES = ("boolean", "enum", "number", "string", "array", "record")
TRASH_KEEP_S = 30 * 86400.0  # deleted sessions stay restorable this long

# voice mode: Kokoro TTS (omp's local runtime), streamed per sentence as Ogg/Opus
VOICES = ("af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore", "af_sarah", "am_michael", "am_fenrir",
          "am_puck", "bf_emma", "bm_george", "bm_fable")
SPEED_RANGE = (0.5, 2.0)
AUDIO_MIME = "audio/ogg; codecs=opus"
OPUS_BITRATE = "24k"
SPOKEN_CAP = 2500         # characters of spoken text per reply; then "The rest is on screen."
SENTENCE_MIN = 25         # shorter sentences are merged with the next one
SENTENCE_MAX = 280        # Kokoro reads at most ~510 phonemes per call; longer ones are split
FIRST_MAX = 50            # the first one is split (comma, else a space) beyond this, so speech starts sooner
AUDIO_CACHE_S = 30 * 60.0
AUDIO_CACHE_BYTES = 50 << 20
TTS_IDLE_S = 600.0        # the worker (model in RAM, ~0.9 GB with fp32 weights) exits after this long unused
TTS_LOAD_S = 180.0        # worker start: model load (and the weights' first download)
TTS_SENTENCE_S = 60.0     # one sentence in the worker
TTS_SAY_S = 240.0         # one `omp say --out` (fallback; may install the runtime first)
TTS_RETRY_S = 60.0        # after a worker failure, use `omp say` this long before retrying it
TTS_WORKER = HERE / "tts_worker.ts"
OMP_CACHE = Path.home() / ".omp" / "agent" / "cache"  # omp's own runtime and weights, not DEVDECK_OMP_DIR
TTS_WEIGHTS = OMP_CACHE / "tiny-models"                # where omp's TTS worker keeps the Kokoro weights
# Private CUDA 12 + cuDNN 9 runtime libraries (lib/) for the worker's GPU path; see README "Engine".
TTS_CUDA_LIBS = Path.home() / ".local" / "share" / "devdeck" / "cuda12" / "lib"
TTS_DEVICES = ("auto", "cpu", "cuda")  # DEVDECK_TTS_DEVICE; auto = CUDA when it works, else the CPU
MAX_UTTERANCES = 4        # concurrent `say` streams per connection
VOICE_RESUME_S = 15 * 60.0  # a reconnecting phone hears the reply it missed within this long

SKIP_IFACES = ("lo", "docker", "virbr", "br-", "veth", "CloudflareWARP")

INSTANCE_RE = re.compile(r"^[a-z][a-z0-9]{0,15}$")
INSTANCE = ""
LABEL = "DevDeck"


def apply_instance(name: str) -> None:
    """Point every per-install path and name at a side-by-side instance `name` (e.g. "plus":
    app dev.devdeckplus, ~/.config/devdeck-plus, devdeck-plus.service, port 47491)."""
    global INSTANCE, LABEL, APK, APP_PACKAGE, APP_ACTIVITY, CONFIG_DIR, TOKEN_FILE, STATE_DIR, SEEN_FILE
    global PARTIAL_DIR, MODELS_FILE, LIMITS_FILE, UNIT_NAME, DEFAULT_PORT, CTL_SOCK, TRASH_DIR, TERMINALS_FILE
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
    LIMITS_FILE = STATE_DIR / "usage.json"
    CTL_SOCK = STATE_DIR / "ctl.sock"
    TRASH_DIR = STATE_DIR / "trash"
    TERMINALS_FILE = STATE_DIR / "terminals.json"
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
    """A readable failure of one client request; `code` (optional) is a machine-readable reason the
    app acts on (`no_extension`, `btw_busy`, `busy`, `live`)."""

    def __init__(self, msg: str, code: str | None = None):
        super().__init__(msg)
        self.code = code


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


_scope_seq = itertools.count(1)


def tmux_new_session(name: str, *args: str) -> subprocess.CompletedProcess:
    """`tmux new-session -d -s name ...`. When no tmux server runs yet this call starts it, so it
    runs in a transient systemd scope of its own (`devdeck-tmux-<instance>-<pid>-<n>`): inside the
    daemon's service cgroup, stopping or restarting the service would kill every terminal. Plain
    tmux when systemd-run is missing or cannot create the scope."""
    cmd = ("new-session", "-d", "-s", name, *args)
    if tmux("list-sessions").returncode == 0 or not shutil.which("systemd-run"):
        return tmux(*cmd)
    unit = f"devdeck-tmux-{INSTANCE or 'main'}-{os.getpid()}-{next(_scope_seq)}"
    try:
        r = subprocess.run(["systemd-run", "--user", "--scope", "--quiet", "--collect", f"--unit={unit}", "tmux", *cmd],
                           capture_output=True, timeout=TMUX_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired) as ex:
        r = subprocess.CompletedProcess(["systemd-run"], 1, b"", str(ex).encode())
    if r.returncode == 0 or tmux("has-session", "-t", f"={name}").returncode == 0:
        log(f"started the tmux server in {unit}.scope")
        return subprocess.CompletedProcess(r.args, 0, r.stdout, r.stderr)
    log(f"systemd-run could not start tmux in a scope ({r.stderr.decode(errors='replace').strip()}); plain tmux")
    return tmux(*cmd)


def systemctl_show(unit: str, *props: str) -> dict[str, str]:
    r = subprocess.run(["systemctl", "--user", "show", unit, *(f"--property={p}" for p in props)],
                       capture_output=True, timeout=TMUX_TIMEOUT_S)
    return dict(ln.split("=", 1) for ln in r.stdout.decode(errors="replace").splitlines() if "=" in ln)


def move_to_scope(scope: str, pids: list[str]) -> str | None:
    """Moves `pids` out of their unit into a new transient scope `scope`; None, else the error."""
    try:
        r = subprocess.run(["busctl", "--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
                            "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))", scope, "fail",
                            "2", "PIDs", "au", str(len(pids)), *pids, "CollectMode", "s", "inactive-or-failed", "0"],
                           capture_output=True, timeout=TMUX_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired) as ex:
        return str(ex)
    return None if r.returncode == 0 else r.stderr.decode(errors="replace").strip() or f"busctl exited {r.returncode}"


def adopt_tmux(unit: str) -> None:
    """Frees the terminals from service `unit` (README "Terminals outlive the daemon"): an older
    daemon started the tmux server inside its service, and tmux puts every pane it spawns in a
    `tmux-spawn-*.scope` that is PartOf the server's unit, so stopping or restarting the service
    killed them all. The server and those panes' processes move into scopes of their own."""
    try:
        cg = systemctl_show(unit, "ControlGroup").get("ControlGroup", "")
        if not cg:
            return
        r = tmux("display-message", "-p", "#{pid}")
        pid = r.stdout.decode(errors="replace").strip()
        if r.returncode == 0 and pid.isdigit() and Path(f"/proc/{pid}/cgroup").read_text().strip() == f"0::{cg}":
            err = move_to_scope(f"devdeck-tmux-{INSTANCE or 'main'}-{pid}.scope", [pid])
            log(f"tmux server (pid {pid}) moved out of {unit}" if err is None else f"could not move the tmux server out of {unit}: {err}")
        r = subprocess.run(["systemctl", "--user", "list-units", "--type=scope", "--all", "--plain", "--no-legend",
                            "tmux-spawn-*"], capture_output=True, timeout=TMUX_TIMEOUT_S)
        for scope in (ln.split()[0] for ln in r.stdout.decode(errors="replace").splitlines() if ln.strip()):
            props = systemctl_show(scope, "PartOf", "ControlGroup")
            if unit not in props.get("PartOf", "").split() or not props.get("ControlGroup"):
                continue
            moved: set[str] = set()
            for attempt in range(2):  # a process forked during the move stays behind: once more
                time.sleep(0.2 * attempt)  # systemd moves them after answering
                try:
                    pids = [p for p in Path(f"/sys/fs/cgroup{props['ControlGroup']}/cgroup.procs").read_text().split()
                            if p not in moved]
                except OSError:
                    break
                if not pids:
                    break
                err = move_to_scope(f"devdeck-pane-{scope.removeprefix('tmux-spawn-').removesuffix('.scope')}-{attempt}.scope", pids)
                log(f"pane {scope} ({len(pids)} processes) moved out of {unit}" if err is None
                    else f"could not move pane {scope} out of {unit}: {err}")
                moved.update(pids)
    except (OSError, subprocess.TimeoutExpired) as ex:
        log(f"adopting tmux out of {unit}: {ex}")


def own_service() -> str | None:
    """The systemd unit this process runs in, when it is a service."""
    try:
        unit = Path("/proc/self/cgroup").read_text().strip().rsplit("/", 1)[-1]
    except OSError:
        return None
    return unit if unit.endswith(".service") else None


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


def boot_time() -> float:
    global _btime
    if _btime is None:
        with open("/proc/stat") as f:
            _btime = next(float(ln.split()[1]) for ln in f if ln.startswith("btime "))
    return _btime


def process_start(pid: int) -> float:
    """Epoch start time of a process (0 if unknown)."""
    if pid in _pid_start:
        return _pid_start[pid]
    try:
        with open(f"/proc/{pid}/stat") as f:
            fields = f.read().rsplit(")", 1)[1].split()
        start = boot_time() + int(fields[19]) / os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError, IndexError, StopIteration):
        return 0.0
    if len(_pid_start) > 512:
        _pid_start.clear()
    _pid_start[pid] = start
    return start


def argv_sessions(argv: list[str]) -> set[str]:
    """Sessions an omp command line names (`--resume`/`--restore`/`--session` id, id prefix or path)."""
    out = set()
    for i, a in enumerate(argv):
        key, eq, val = a.partition("=")
        if key in ("--resume", "--restore", "--session"):
            v = val if eq else (argv[i + 1] if i + 1 < len(argv) else "")
            if v and not v.startswith("-"):
                out.add(v)
    return out


def crumb_named(path: str, named: set[str]) -> bool:
    """Whether breadcrumb session `path` is one an omp command line named (argv_sessions): omp does
    not rewrite a breadcrumb that already says the same, so `omp --resume <id>` in a recycled
    terminal whose old breadcrumb named that very session leaves the old, older-looking one."""
    sid = session_id_of(path)
    return any(v == path or (len(v) >= 8 and sid.startswith(v.lower())) for v in named)


def omp_terminals() -> dict[int, tuple[float, bool, set[str]]]:
    """pts number -> (earliest start (epoch) of an omp process whose controlling terminal it is,
    whether one of them was started with --yolo, the sessions their command lines name)."""
    try:
        btime, tck = boot_time(), os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError, StopIteration):
        return {}
    out: dict[int, tuple[float, bool, set[str]]] = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/stat") as f:
                raw = f.read()
        except OSError:
            continue
        name, _, rest = raw.partition(" (")[2].rpartition(")")
        if name != "omp":
            continue
        fields = rest.split()
        try:
            tty, start = int(fields[4]), btime + int(fields[19]) / tck
        except (ValueError, IndexError):
            continue
        major, minor = (tty >> 8) & 0xFFF, (tty & 0xFF) | ((tty >> 12) & 0xFFF00)
        if not 136 <= major <= 143:  # Unix98 pty slaves: /dev/pts/N
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                argv = f.read().decode(errors="replace").split("\0")
        except OSError:
            argv = []
        yolo, named = "--yolo" in argv, argv_sessions(argv)
        n = (major - 136) * 256 + minor
        prev = out.get(n)
        out[n] = (min(prev[0], start), prev[1] or yolo, prev[2] | named) if prev else (start, yolo, named)
    return out


def pane_omp_sessions(pane_pid: int) -> set[str]:
    """argv_sessions of the omp processes among a pane shell's children and grandchildren."""
    out, pids = set(), [pane_pid]
    for _ in range(2):
        kids = []
        for pid in pids:
            try:
                with open(f"/proc/{pid}/task/{pid}/children") as f:
                    kids += [int(k) for k in f.read().split()]
            except (OSError, ValueError):
                pass
        for k in kids:
            try:
                with open(f"/proc/{k}/cmdline", "rb") as f:
                    argv = f.read().decode(errors="replace").split("\0")
            except OSError:
                continue
            if argv and os.path.basename(argv[0]) == "omp":
                out |= argv_sessions(argv)
        pids = kids
    return out


def breadcrumb(tty: str, pane_pid: int) -> tuple[str, str] | None:
    """(cwd, session JSONL path) omp recorded for this pane's terminal, if written during the pane's
    life (pts numbers are recycled, so an older breadcrumb belongs to some earlier terminal), or
    naming the session the pane's omp was started with (crumb_named)."""
    if not tty.startswith("/dev/pts/"):
        return None
    crumb = OMP_DIR / "terminal-sessions" / f"pts-{tty[len('/dev/pts/'):]}"
    try:
        with open(crumb) as f:
            mtime = os.fstat(f.fileno()).st_mtime
            lines = f.read(8192).splitlines()
    except OSError:
        return None
    if len(lines) < 2 or not lines[1].startswith("/"):
        return None
    if mtime < process_start(pane_pid) - 2 and not crumb_named(lines[1], pane_omp_sessions(pane_pid)):
        return None
    return lines[0], lines[1]


def breadcrumb_session(tty: str, pane_pid: int) -> str | None:
    crumb = breadcrumb(tty, pane_pid)
    return crumb[1] if crumb else None


def session_id_of(path: str) -> str:
    stem = os.path.basename(path).removesuffix(".jsonl")
    return stem.split("_", 1)[1] if "_" in stem else stem


def parent_pid(pid: int) -> int:
    try:
        with open(f"/proc/{pid}/stat") as f:
            return int(f.read().rsplit(")", 1)[1].split()[1])
    except (OSError, ValueError, IndexError):
        return 0


def descent(pid: int, ancestor: int) -> int | None:
    """How many generations process `pid` runs below `ancestor` (0: it is `ancestor`), None when
    it does not (a dead pid never does)."""
    for depth in range(16):
        if pid == ancestor:
            return depth
        if pid <= 1:
            return None
        pid = parent_pid(pid)
    return None


def pane_registration(directory: Path, pane_pid: int) -> tuple[int, dict] | None:
    """(omp pid, registration) an omp extension published as `<directory>/<omp pid>.json` for the
    omp running in the pane whose process is `pane_pid` (registrations without a token skipped).
    When omp processes run inside it (an agent's `omp -p`), the outermost one is the pane's."""
    try:
        names = os.listdir(directory)
    except OSError:
        return None
    found: list[tuple[int, int, dict]] = []
    for name in names:
        m = re.fullmatch(r"(\d+)\.json", name)
        depth = descent(int(m.group(1)), pane_pid) if m else None
        if depth is None:
            continue
        try:
            reg = json.loads((directory / name).read_text())
        except (OSError, ValueError):
            continue
        if isinstance(reg, dict) and isinstance(reg.get("token"), str):
            found.append((depth, int(m.group(1)), reg))
    if not found:
        return None
    _, pid, reg = min(found, key=lambda f: f[0])
    return pid, reg


def sketch_registration(pane_pid: int) -> dict | None:
    """{pid, port, token, request} the sketch extension published for the omp running in the pane
    whose process is `pane_pid`. `port` is None until /sketch starts the server; `request` is the
    pending request_sketch call as {id, prompt}, or None."""
    found = pane_registration(SKETCH_DIR, pane_pid)
    if found is None:
        return None
    pid, reg = found
    port = reg.get("port")
    req = reg.get("request")
    ok_req = isinstance(req, dict) and isinstance(req.get("id"), str) and isinstance(req.get("prompt"), str)
    return {"pid": pid, "port": port if isinstance(port, int) and port > 0 else None,
            "token": reg["token"], "request": {"id": req["id"], "prompt": req["prompt"]} if ok_req else None}


def sketch_conn(reg: dict, timeout: float) -> http.client.HTTPConnection:
    return http.client.HTTPConnection("127.0.0.1", reg["port"], timeout=timeout)


def sketch_http(reg: dict, method: str, path: str, body: bytes | None = None) -> tuple[int, str, str]:
    """(status, content type, body text) of one request to the pane's sketch server."""
    conn = sketch_conn(reg, SKETCH_HTTP_S)
    try:
        headers = {"Content-Type": "application/json"} if body is not None else {}
        conn.request(method, f"{path}?t={urllib.parse.quote(reg['token'])}", body=body, headers=headers)
        r = conn.getresponse()
        return r.status, r.getheader("Content-Type") or "", r.read().decode(errors="replace")
    except (OSError, http.client.HTTPException) as ex:
        raise RequestError(f"omp's sketch canvas is not reachable: {ex}") from None
    finally:
        conn.close()


class SketchFeed:
    """Relays the live events (`/events`, server-sent events) of one pane's sketch server to one
    phone connection as `sketch_event`, reconnecting while omp restarts the server (session
    switch); `closed` once that omp is gone."""

    def __init__(self, push, target: str, pane_pid: int):
        self.push, self.target, self.pane_pid = push, target, pane_pid
        self.stopped = threading.Event()
        self.sock: socket.socket | None = None
        threading.Thread(target=self.run, daemon=True).start()

    def stop(self) -> None:
        self.stopped.set()
        sock = self.sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def emit(self, event: str, data: str | None = None) -> None:
        if not self.stopped.is_set():
            self.push({"t": "sketch_event", "target": self.target, "event": event,
                       **({"data": data} if data is not None else {})})

    def run(self) -> None:
        self.down = False  # `down` already told to the phone
        while not self.stopped.is_set():
            reg = sketch_registration(self.pane_pid)
            if reg is None:
                self.emit("closed")
                return
            if reg["port"] is not None:
                try:
                    self.listen(reg)
                except (OSError, http.client.HTTPException):
                    pass
            if self.stopped.is_set():
                return
            if not self.down:
                self.emit("down")
                self.down = True
            self.stopped.wait(SKETCH_RETRY_S)

    def listen(self, reg: dict) -> None:
        conn = sketch_conn(reg, SKETCH_EVENTS_S)
        try:
            conn.request("GET", f"/events?t={urllib.parse.quote(reg['token'])}")
            r = conn.getresponse()
            if r.status != 200:
                raise http.client.HTTPException(f"HTTP {r.status}")
            self.sock = conn.sock
            if self.stopped.is_set():
                return
            self.emit("open")
            self.down = False
            event, data = "message", []
            while not self.stopped.is_set():
                line = r.readline()
                if not line:
                    return
                line = line.decode(errors="replace").rstrip("\r\n")
                if not line:
                    if data:
                        self.emit(event, "\n".join(data))
                    event, data = "message", []
                elif line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data.append(line[5:].removeprefix(" "))
        finally:
            self.sock = None
            conn.close()


def ext_registration(pane_pid: int) -> dict | None:
    """{pid, port, token, sessionId, planReview} the devdeck extension published for the omp running
    in the pane whose process is `pane_pid`; None when that omp has not loaded it."""
    found = pane_registration(EXT_DIR, pane_pid)
    if found is None:
        return None
    pid, reg = found
    port, sid, plan = reg.get("port"), reg.get("sessionId"), reg.get("planReview")
    if not isinstance(port, int) or isinstance(port, bool) or port <= 0:
        return None
    return {"pid": pid, "port": port, "token": reg["token"], "sessionId": sid if isinstance(sid, str) else None,
            "planReview": plan if isinstance(plan, dict) else None}


def ext_conn(reg: dict, timeout: float) -> http.client.HTTPConnection:
    return http.client.HTTPConnection("127.0.0.1", reg["port"], timeout=timeout)


def ext_http(reg: dict, method: str, path: str, body: dict | None = None, query: dict | None = None,
             timeout: float = EXT_HTTP_S) -> tuple[int, dict]:
    """(HTTP status, JSON object reply) of one request to a pane's devdeck extension."""
    conn = ext_conn(reg, timeout)
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    try:
        conn.request(method, f"{path}?{urllib.parse.urlencode({'t': reg['token'], **(query or {})})}", body=data,
                     headers={"Content-Type": "application/json"} if data is not None else {})
        r = conn.getresponse()
        status, text = r.status, r.read().decode(errors="replace")
    except (OSError, http.client.HTTPException) as ex:
        raise RequestError(f"omp's devdeck extension is not reachable: {ex}") from None
    finally:
        conn.close()
    try:
        reply = json.loads(text) if text else {}
    except ValueError:
        reply = {"error": text.strip()[:300] or f"HTTP {status}"}
    return status, reply if isinstance(reply, dict) else {}


def plan_review_field(raw: dict) -> dict | None:
    """A pane's `planReview` from what the extension published (omp's `plan_review_requested`):
    the choices omp offers now (disabled ones dropped), the execution-model tiers of its slider and
    the tier the slider starts on."""
    rid = raw.get("id")
    if not isinstance(rid, str) or not rid:
        return None
    choices = []
    for o in raw.get("options") or []:
        if isinstance(o, dict) and isinstance(o.get("id"), str) and not o.get("disabled"):
            choice = {"id": o["id"], "label": str(o.get("label") or o["id"])}
            if o["id"] == "refine":
                choice["needsFeedback"] = True
            choices.append(choice)
    tiers = []
    for t in raw.get("tiers") or []:
        if isinstance(t, dict) and isinstance(t.get("role"), str):
            model = f"{t.get('provider')}/{t.get('model')}" if t.get("provider") and t.get("model") else None
            if model and t.get("thinkingLevel"):
                model += f":{t['thinkingLevel']}"
            tiers.append({"role": t["role"], "label": t["role"], **({"model": model} if model else {})})
    out = {"id": rid, "title": str(raw.get("title") or "Plan"), "choices": choices, "tiers": tiers or None}
    if tiers:
        out["defaultRole"] = "default" if any(t["role"] == "default" for t in tiers) else tiers[0]["role"]
    return out


BTW_STATUS = {"running": "running", "complete": "complete", "cancelled": "cancelled", "error": "error",
              "interrupted": "cancelled"}


def btw_topic(rec, source: str) -> dict | None:
    """A BtwTopic (wire protocol) from one record of omp's /btw history (a topic: its first turn
    plus `followUps`). omp's `interrupted` (the asking omp went away) shows as cancelled."""
    if not isinstance(rec, dict) or not isinstance(rec.get("id"), str) or not isinstance(rec.get("question"), str):
        return None
    turns, updated = [], 0
    for t in [rec, *(rec.get("followUps") if isinstance(rec.get("followUps"), list) else [])]:
        if not isinstance(t, dict) or not isinstance(t.get("question"), str):
            continue
        turn = {"question": t["question"], "answer": t["answer"] if isinstance(t.get("answer"), str) else "",
                "status": BTW_STATUS.get(t.get("status"), "error"), "ts": ts_ms(t.get("createdAt")) or 0}
        error = t.get("error") if isinstance(t.get("error"), str) else None
        if error or t.get("status") == "interrupted":
            turn["error"] = error or "interrupted: the omp that was answering stopped"
        turns.append(turn)
        updated = max(updated, ts_ms(t.get("updatedAt")) or turn["ts"])
    title = rec["title"] if isinstance(rec.get("title"), str) and rec["title"].strip() else rec["question"]
    return {"id": rec["id"], "title": " ".join(title.split())[:TITLE_MAX], "status": turns[-1]["status"],
            "updated": updated, "turns": turns, "source": source}


def devdeck_btw_ids(session_id: str | None) -> set[str]:
    """Ids of the /btw topics of a session that were asked from the phone (the extension notes them)."""
    if not session_id or not UUID_RE.match(session_id):
        return set()
    try:
        return set((EXT_DIR / "btw" / f"{session_id}.ids").read_text().split())
    except OSError:
        return set()


def btw_disk_records(session_path: str) -> list[dict]:
    """The topics of omp's /btw history of a session (`<artifact dir>/btw-history/entry-<id>.json`,
    the files omp's TUI and RPC /btw write), with their `.title` sidecars."""
    folder = os.path.join(session_path.removesuffix(".jsonl"), "btw-history")
    try:
        names = os.listdir(folder)
    except OSError:
        return []
    out = []
    for name in names:
        m = re.fullmatch(r"entry-([A-Za-z0-9][\w-]{0,127})\.json", name)
        if not m:
            continue
        try:
            rec = json.loads(Path(folder, name).read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(rec, dict) or rec.get("id") != m.group(1):
            continue
        try:
            rec["title"] = Path(folder, f"entry-{m.group(1)}.title").read_text()
        except OSError:
            pass
        out.append(rec)
    return out


class BtwFeed:
    """Relays the side question DevDeck started in one pane's omp: the devdeck extension's
    `/events` (server-sent events) become `btw_delta` / `btw_record` pushes (Server.btw_push) until
    that question's turn ends. `ready` is set once the stream is open (or failed), so the ask is
    posted only after it and no delta is missed."""

    def __init__(self, server: Server, target: str, reg: dict, session_id: str | None, asker, new_topic: bool):
        self.server, self.target, self.reg, self.session_id, self.asker = server, target, reg, session_id, asker
        self.new_topic = new_topic  # a new question (else a follow-up in an existing topic)
        self.topic_id: str | None = None  # the asked topic, once the ask returned
        self.ready = threading.Event()
        self.stopped = threading.Event()
        self.sock: socket.socket | None = None
        threading.Thread(target=self.run, daemon=True).start()

    def stop(self) -> None:
        self.stopped.set()
        sock = self.sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def run(self) -> None:
        deadline = time.monotonic() + BTW_RUN_S
        conn = ext_conn(self.reg, EXT_EVENTS_S)
        try:
            conn.request("GET", f"/events?t={urllib.parse.quote(self.reg['token'])}")
            r = conn.getresponse()
            if r.status != 200:
                raise http.client.HTTPException(f"HTTP {r.status}")
            self.sock = conn.sock
            event, data = "message", []
            while not self.stopped.is_set() and time.monotonic() < deadline:
                line = r.readline()
                if not line:
                    return
                line = line.decode(errors="replace").rstrip("\r\n")
                if line:
                    if line.startswith("event:"):
                        event = line[6:].strip()
                    elif line.startswith("data:"):
                        data.append(line[5:].removeprefix(" "))
                    continue
                if data:
                    self.on_event(event, "\n".join(data))
                event, data = "message", []
        except (OSError, http.client.HTTPException, ValueError) as ex:
            if not self.stopped.is_set():
                log(f"btw events of {self.target}: {ex!r}")
        finally:
            self.ready.set()
            self.sock = None
            conn.close()
            self.server.btw_feed_done(self)

    def on_event(self, event: str, data: str) -> None:
        if event == "hello":
            self.ready.set()
            return
        msg = json.loads(data)
        if not isinstance(msg, dict):
            return
        if event == "btw_delta" and isinstance(msg.get("recordId"), str) and isinstance(msg.get("delta"), str):
            self.server.btw_push(self.target, {"t": "btw_delta", "target": self.target, "topicId": msg["recordId"],
                                               "delta": msg["delta"]}, self.asker)
        elif event == "btw_record":
            rec = msg.get("record")
            rid = rec.get("id") if isinstance(rec, dict) else None
            # The extension notes a new topic's id only once the ask returned, after its first record.
            mine = self.new_topic and (self.topic_id is None or rid == self.topic_id)
            source = "devdeck" if mine or rid in devdeck_btw_ids(self.session_id) else "omp"
            topic = btw_topic(rec, source)
            if topic is None:
                return
            self.server.btw_push(self.target, {"t": "btw_record", "target": self.target, "topic": topic}, self.asker)
            if topic["status"] != "running" and (self.topic_id is None or rid == self.topic_id):
                self.stopped.set()


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


def send_rewrite(text: str) -> str:
    """Text for an omp prompt: omp sends commands with arguments they do not take to the model
    as a prompt, so `/model x`, `/models x` and `/thinking x` become `/switch x` and `/effort x`."""
    line = text.strip()
    if "\n" not in line:
        for rx, repl in SEND_REWRITES:
            m = rx.match(line)
            if m:
                return repl + m.group(1)
    return text


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
        self.reply_cache: tuple[str, str, str] | None = None
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
            if t == "custom_message" and isinstance(obj.get("customType"), str):
                e["source"] = obj["customType"]
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

    def final_reply(self) -> tuple[str, str, str] | None:
        """(entry id, stopReason, text) of the branch's last message when it is the assistant's."""
        with self.lock:
            idx = self.last_msg
            if idx < 0 or idx < self.vis_start:
                return None
            ident = self.path_ids[idx]
            if self.nodes[ident].kind != K_ASSISTANT:
                return None
            hit = self.reply_cache
            if hit is None or hit[0] != ident:
                try:
                    with self._open() as f:
                        m = self._load(f, ident).get("message") or {}
                except (OSError, ValueError, StaleFile):
                    return None
                text = "\n\n".join(b["text"] for b in m.get("content") or []
                                   if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str))
                hit = self.reply_cache = (ident, str(m.get("stopReason") or ""), text)
            return hit

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

    def branch_end(self) -> str | None:
        """Id of the current branch's last entry (where a live delegation starts reading)."""
        with self.lock:
            return self.path_ids[-1] if self.path_ids else None

    def assistant_since(self, after: str | None) -> tuple[str | None, list[dict]]:
        """(branch end, assistant messages on the current branch after entry `after`) as
        [{id, stopReason, text, tools (count), error}]. From the start when `after` is None (a new
        session file), nothing when `after` left the branch (rewind, branch switch)."""
        with self.lock:
            if after is None:
                start = self.vis_start
            else:
                start = self.path_index.get(after, len(self.path_ids) - 1) + 1
            ids = [i for i in self.path_ids[start:] if self.nodes[i].kind == K_ASSISTANT]
            out = []
            if ids:
                with self._open() as f:
                    for ident in ids:
                        m = self._load(f, ident).get("message") or {}
                        blocks = [b for b in m.get("content") or [] if isinstance(b, dict)]
                        out.append({"id": ident, "stopReason": str(m.get("stopReason") or ""),
                                    "text": "\n\n".join(b["text"] for b in blocks if b.get("type") == "text"
                                                        and isinstance(b.get("text"), str)).strip(),
                                    "tools": sum(1 for b in blocks if b.get("type") == "toolCall"),
                                    "error": str(m.get("errorMessage") or "")})
            return (self.path_ids[-1] if self.path_ids else after), out

    def status_info(self) -> dict:
        """{lastUser, lastAssistant, tools} of the current (or last) turn: the newest user message,
        the newest assistant text and the tool calls since that user message (intent, else name
        and short arguments; newest last, at most 8)."""
        last_user = last_text = None
        tools: list[str] = []
        with self.lock:
            with self._open() as f:
                seen = 0
                for idx in range(len(self.path_ids) - 1, self.vis_start - 1, -1):
                    node = self.nodes[self.path_ids[idx]]
                    if node.kind == K_USER:
                        last_user = content_text((self._load(f, node.id).get("message") or {}).get("content"))
                        break
                    if node.kind != K_ASSISTANT or seen >= 200:
                        continue
                    seen += 1
                    for b in reversed((self._load(f, node.id).get("message") or {}).get("content") or []):
                        if not isinstance(b, dict):
                            continue
                        if b.get("type") == "text" and isinstance(b.get("text"), str) and b["text"].strip():
                            last_text = last_text or b["text"].strip()
                        elif b.get("type") == "toolCall" and len(tools) < 8:
                            args = b.get("arguments")
                            intent = b.get("intent") or (args.get("i") if isinstance(args, dict) else None)
                            tools.append(intent if isinstance(intent, str) and intent
                                         else f"{b.get('name') or '?'} {cap(tool_args_text(args), 120)[0]}")
        tools.reverse()
        return {"lastUser": last_user, "lastAssistant": last_text, "tools": tools}

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


OMP_UPDATE_S = 600.0
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")


def omp_update(check: bool) -> dict:
    """`omp update` (or `--check`): versions before/after and the command's output. Running omp
    sessions keep the old version until they are restarted."""
    omp = omp_binary()

    def version() -> str:
        try:
            r = subprocess.run([omp, "--version"], capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            return "?"
        lines = (r.stdout or r.stderr).strip().splitlines()
        return lines[0] if lines else "?"

    before = version()
    cmd = [omp, "update"] + (["--check"] if check else [])
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=OMP_UPDATE_S, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise RequestError(f"omp update did not finish within {OMP_UPDATE_S / 60:.0f} minutes") from None
    except OSError as ex:
        raise RequestError(f"could not run omp: {ex}") from None
    out, _ = cap(ANSI_RE.sub("", (r.stdout + r.stderr).strip()), 20_000)
    after = before if check else version()
    log(f"omp update{' --check' if check else ''}: exit {r.returncode}, {before} -> {after}")
    return {"t": "omp_update", "ok": r.returncode == 0, "check": check, "before": before,
            "after": after, "output": out}


class ModelCatalog:
    """`omp models --json --kind all` (no model calls: omp's own catalog cache) plus intelligence
    scores and web grounding from omp's models.db, kept in memory and in MODELS_FILE; served
    stale while a background refresh runs."""

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
            if (data.get("v") == MODELS_VERSION and isinstance(data.get("models"), list)
                    and isinstance(data.get("fetchedAt"), int)):
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
            # Via omp_cli (--no-extensions): with extensions loaded `omp models` never exits.
            obj, text = omp_cli(["models", "--json", "--kind", "all"], MODELS_TIMEOUT_S)
            if obj is None or not isinstance(obj.get("models"), list):
                raise ValueError(last_line(text) or "no answer")
            scores, by_id, grounded = model_scores()
            models = []
            for m in obj["models"]:
                if not isinstance(m, dict) or not isinstance(m.get("provider"), str) or not isinstance(m.get("id"), str):
                    continue
                sel = f"{m['provider']}/{m['id']}"
                kind = m.get("kind") if isinstance(m.get("kind"), str) else "chat"
                thinking, cost = m.get("thinking"), m.get("cost")
                price = None
                if m.get("pricingStatus") == "fixed" and isinstance(cost, dict):
                    price = {k: float(cost[k]) if isinstance(cost.get(k), (int, float)) else 0.0
                             for k in ("input", "output", "cacheRead", "cacheWrite")}
                models.append({"selector": sel, "provider": m["provider"], "id": m["id"],
                               "name": m.get("name") if isinstance(m.get("name"), str) else m["id"],
                               "kind": "chat" if kind == "llm" else kind,
                               "contextWindow": m.get("contextWindow") if isinstance(m.get("contextWindow"), int) else None,
                               "maxTokens": m.get("maxTokens") if isinstance(m.get("maxTokens"), int) else None,
                               "reasoning": m.get("reasoning") is True,
                               "thinking": [x for x in thinking if isinstance(x, str)] if isinstance(thinking, list) else None,
                               "vision": isinstance(m.get("input"), list) and "image" in m["input"],
                               "price": price, "int": scores.get(sel, by_id.get(m["id"])),
                               "webSearch": sel in grounded, "dup": False})
            # Dated aliases ("claude-haiku-4-5-20251001") of a same-named row of the same provider.
            undated = {(m["provider"], m["name"]) for m in models if not DATED_ID_RE.search(m["id"])}
            for m in models:
                m["dup"] = bool(DATED_ID_RE.search(m["id"])) and (m["provider"], m["name"]) in undated
            data = {"v": MODELS_VERSION, "models": models, "fetchedAt": int(time.time() * 1000)}
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
                os.replace(tmp, self.path)
            except OSError as ex:
                log(f"cannot persist {self.path}: {ex}")
        except (OSError, RequestError, ValueError, KeyError, TypeError) as ex:
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

    def rows(self) -> list[dict]:
        """The catalog for the phone: each model with this machine's usage and a `hidden` flag
        for noise (dated aliases; chat rows with no score, no price and no use)."""
        data = self.get(wait=True)
        usage = model_usage()
        out = []
        for m in data["models"]:
            u = usage.get(m["selector"])
            hidden = m["dup"] or (m["kind"] == "chat" and m["int"] is None and m["price"] is None and u is None)
            row = {k: v for k, v in m.items() if k != "dup"}
            row["usage"], row["hidden"] = u, hidden
            out.append(row)
        return out

    def by_footer_name(self, name: str, prefer: list[str]) -> dict | None:
        """The chat model omp's footer shows as `name` (catalog name minus a leading "Claude ").
        Several providers serve the same name: `prefer` lists selectors/providers to try first."""
        hits = [m for m in self.index.values() if m["kind"] == "chat" and footer_name(m["name"]) == name]
        if not hits:
            return None

        def rank(m: dict) -> tuple:
            for i, p in enumerate(prefer):
                if m["selector"] == p or m["provider"] == p:
                    return i, len(m["id"])
            return len(prefer), len(m["id"])
        return min(hits, key=rank)


def first_json(buf: bytes) -> dict | None:
    """The first complete JSON object in `buf` (output that may still be arriving), else None."""
    i = buf.find(b"{")
    if i < 0:
        return None
    try:
        obj, _ = json.JSONDecoder().raw_decode(buf[i:].decode(errors="replace"))
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def last_line(text: str) -> str:
    return next((ln.strip() for ln in reversed(text.splitlines()) if ln.strip()), "")[:300]


def omp_cli(args: list[str], timeout: float, want_json: bool = True) -> tuple[dict | None, str]:
    """Runs `omp <args> --no-extensions` in the home directory: (the first JSON object it prints,
    else None; its other output without ANSI codes). Without extensions because the devdeck and
    sketch extensions start servers on load that keep a CLI run alive after its output (`omp usage
    --json` then never exits). Reading stops at the first complete JSON object (`want_json`) or
    when omp closes its output; a process still running 5 s later is killed. RequestError when omp
    cannot be started or does not answer within `timeout`."""
    try:
        p = subprocess.Popen([omp_binary(), *args, "--no-extensions"], stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=Path.home())
    except OSError as ex:
        raise RequestError(f"could not run omp: {ex}") from None
    bufs = {p.stdout: bytearray(), p.stderr: bytearray()}
    live = list(bufs)
    obj, deadline = None, time.monotonic() + timeout
    try:
        while live and obj is None:
            left = deadline - time.monotonic()
            if left <= 0:
                raise RequestError(f"omp {' '.join(a for a in args[:2] if not a.startswith('-'))} "
                                   f"did not answer within {timeout:.0f} s")
            ready, _, _ = select.select(live, [], [], min(left, 1.0))
            for f in ready:
                chunk = os.read(f.fileno(), 65536)
                if not chunk:
                    live.remove(f)
                elif want_json and f is p.stdout:
                    bufs[f] += chunk
                    obj = first_json(bufs[f])
                else:
                    bufs[f] += chunk
    finally:
        try:
            p.wait(timeout=5 if obj is not None or not live else 0)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
        p.stdout.close()
        p.stderr.close()
    rest = bufs[p.stderr] + (b"" if obj is not None else b"\n" + bufs[p.stdout])
    return obj, ANSI_RE.sub("", rest.decode(errors="replace")).strip()


def reset_accounts() -> list[dict]:
    """`omp usage reset --json`: every Codex and Claude account with its saved rate-limit resets
    (`{provider, credentialId, email, accountId, orgId, orgName, availableCount, redeemableCount,
    soonestExpiry?, credits:[{id, title, status, grantedAt, expiresAt}], unavailableReason?,
    error?}`). RequestError with omp's text when it fails."""
    obj, text = omp_cli(["usage", "reset", "--json"], 60.0)
    if obj is None or not isinstance(obj.get("accounts"), list):
        raise RequestError(f"omp usage reset failed: {last_line(text) or 'no answer'}")
    return [a for a in obj["accounts"] if isinstance(a, dict) and isinstance(a.get("provider"), str)
            and isinstance(a.get("credentialId"), int)]


class UsageLimits:
    """omp's provider usage limits (its /usage page): `omp usage --json` (every account's quota
    windows) plus `omp usage reset --json` (saved rate-limit resets with their credential ids),
    kept in memory and in LIMITS_FILE. omp answers from its own report cache in about a second
    but takes a minute or more when that is cold, so a copy older than LIMITS_FRESH_S is served
    at once while a background refresh runs; whoever got the old copy is called back when the
    refresh ends."""

    def __init__(self, path: Path):
        self.path = path
        self.cond = threading.Condition()
        self.data: dict | None = None
        self.refreshing = False
        self.error: str | None = None
        self.failed_at = -LIMITS_RETRY_S
        self.waiters: list = []
        try:
            data = json.loads(path.read_text())
            if (data.get("v") == LIMITS_VERSION and isinstance(data.get("reports"), list)
                    and isinstance(data.get("fetchedAt"), int)):
                self.data = data
        except (OSError, ValueError, AttributeError) as ex:
            if path.exists():
                log(f"ignoring unreadable {path}: {ex}")

    def get(self, force: bool, waiter) -> tuple[dict, bool]:
        """(limits, refreshing). Refreshes when nothing is cached, on `force`, or when the copy is
        older than LIMITS_FRESH_S (after a failure only on `force` for LIMITS_RETRY_S). With nothing
        cached this waits for the refresh (RequestError with omp's text when it fails); otherwise,
        while a refresh runs, `waiter(limits, error)` is called once when it ends."""
        with self.cond:
            data = self.data
            old = data is None or force or time.time() * 1000 - data["fetchedAt"] > LIMITS_FRESH_S * 1000
            backoff = not force and data is not None and time.monotonic() - self.failed_at < LIMITS_RETRY_S
            if old and not self.refreshing and not backoff:
                self.refreshing = True
                threading.Thread(target=self._refresh, daemon=True).start()
            if data is None:
                self.cond.wait_for(lambda: not self.refreshing, timeout=LIMITS_TIMEOUT_S + 70)
                if self.data is None:
                    raise RequestError(self.error or "omp usage did not answer")
                return self.data, False
            if self.refreshing:
                self.waiters.append(waiter)
            return data, self.refreshing

    def _refresh(self) -> None:
        data, err = None, None
        resets: dict = {}

        def fetch_resets():
            try:
                resets["accounts"] = reset_accounts()
            except RequestError as ex:
                resets["error"] = str(ex)
        side = threading.Thread(target=fetch_resets, daemon=True)
        side.start()
        try:
            usage, text = omp_cli(["usage", "--json"], LIMITS_TIMEOUT_S)
            if usage is None or not isinstance(usage.get("reports"), list):
                raise RequestError(f"omp usage failed: {last_line(text) or 'no report'}")
            side.join(70)
            now = int(time.time() * 1000)
            data = {"v": LIMITS_VERSION, "fetchedAt": now,
                    "generatedAt": usage["generatedAt"] if isinstance(usage.get("generatedAt"), int) else now,
                    "reports": [r for r in usage["reports"] if isinstance(r, dict) and isinstance(r.get("provider"), str)],
                    "unavailable": [a for a in usage.get("accountsWithoutUsage") or [] if isinstance(a, dict)],
                    "disabled": [a for a in usage.get("disabledCredentials") or [] if isinstance(a, dict)],
                    "resets": resets.get("accounts"),
                    "resetsError": resets.get("error", None if "accounts" in resets else "omp usage reset did not answer")}
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
                os.replace(tmp, self.path)
            except OSError as ex:
                log(f"cannot persist {self.path}: {ex}")
        except RequestError as ex:
            err = str(ex)
            log(err)
        with self.cond:
            if data is not None:
                self.data = data
            else:
                self.failed_at = time.monotonic()
            self.error, self.refreshing = err, False
            waiters, self.waiters = self.waiters, []
            current = self.data
            self.cond.notify_all()
        for fn in waiters:
            try:
                fn(current, err)
            except Exception as ex:  # one closed connection must not keep the others waiting
                log(f"usage callback failed: {ex!r}")


def usage_history(days: int) -> dict:
    """`omp usage --history --days N --json` (hourly snapshots, ~100 KB a day) folded into one
    series per account and limit: `{provider, email?, accountId?, limitId, label, windowLabel,
    points:[[recordedAt, usedFraction]]}`, oldest point first."""
    obj, text = omp_cli(["usage", "--history", "--days", str(days), "--json"], 60.0)
    if obj is None or not isinstance(obj.get("entries"), list):
        raise RequestError(f"omp usage --history failed: {last_line(text) or 'no answer'}")
    series: dict[tuple, dict] = {}
    for e in obj["entries"]:
        if not isinstance(e, dict) or not isinstance(e.get("provider"), str) or not isinstance(e.get("limitId"), str):
            continue
        t, f = e.get("recordedAt"), e.get("usedFraction")
        if not isinstance(t, int) or not isinstance(f, (int, float)) or isinstance(f, bool):
            continue
        key = (e["provider"], e.get("accountKey") or e.get("accountId") or e.get("email"), e["limitId"])
        s = series.get(key)
        if s is None:
            s = series[key] = {"provider": e["provider"], "limitId": e["limitId"],
                               "label": e.get("label") if isinstance(e.get("label"), str) else e["limitId"],
                               "windowLabel": e.get("windowLabel") if isinstance(e.get("windowLabel"), str) else "",
                               "points": []}
            for k in ("email", "accountId"):
                if isinstance(e.get(k), str) and e[k]:
                    s[k] = e[k]
        s["points"].append([t, round(min(1.0, max(0.0, float(f))), 3)])
    for s in series.values():
        s["points"].sort()
    return {"t": "usage_history", "days": days,
            "sinceMs": obj["sinceMs"] if isinstance(obj.get("sinceMs"), int) else None, "series": list(series.values())}


def footer_name(name: str) -> str:
    return name[7:] if name.startswith("Claude ") else name


def model_scores() -> tuple[dict[str, float], dict[str, float], set[str]]:
    """From omp's provider-model cache (models.db, read-only): intelligence scores by selector and
    by bare id (omp shows a provider's score for the same id elsewhere), and the selectors of chat
    models with web-search grounding. Empty when the cache is missing or unreadable."""
    scores: dict[str, float] = {}
    by_id: dict[str, float] = {}
    grounded: set[str] = set()
    try:
        con = sqlite3.connect(f"file:{OMP_MODELS_DB}?mode=ro", uri=True, timeout=2)
        try:
            rows = con.execute("SELECT provider_id, models FROM model_cache").fetchall()
        finally:
            con.close()
    except sqlite3.Error as ex:
        log(f"cannot read {OMP_MODELS_DB}: {ex}")
        return scores, by_id, grounded
    for provider_id, text in rows:
        try:
            models = json.loads(text)
        except (TypeError, ValueError):
            continue
        for m in models if isinstance(models, list) else []:
            if not isinstance(m, dict) or not isinstance(m.get("id"), str):
                continue
            provider = m.get("provider") if isinstance(m.get("provider"), str) else str(provider_id).split(":", 1)[0]
            sel = f"{provider}/{m['id']}"
            score = m.get("int")
            if isinstance(score, (int, float)) and not isinstance(score, bool):
                scores[sel] = float(score)
                by_id.setdefault(m["id"], float(score))
            if m.get("webSearch"):
                grounded.add(sel)
    return scores, by_id, grounded


_usage_lock = threading.Lock()
_usage: tuple[float, dict[str, dict]] = (-USAGE_TTL_S, {})


def model_usage() -> dict[str, dict]:
    """{selector: {count, last, tps, ttft}} of omp's replies in the last USAGE_DAYS days, from
    omp's stats.db (read-only): reply count, last reply (epoch ms), and the medians of output
    tokens per second (over the whole reply, as omp's model hub shows it) and time to first
    token (ms) of the latest USAGE_SAMPLES replies with 50+ output tokens. Cached USAGE_TTL_S."""
    global _usage
    with _usage_lock:
        if time.monotonic() - _usage[0] < USAGE_TTL_S:
            return _usage[1]
        out: dict[str, dict] = {}
        since = int((time.time() - USAGE_DAYS * 86400) * 1000)
        speeds: dict[str, tuple[list[float], list[float]]] = collections.defaultdict(lambda: ([], []))
        try:
            con = sqlite3.connect(f"file:{OMP_STATS_DB}?mode=ro", uri=True, timeout=2)
            try:
                for p, m, n, last in con.execute(
                        "SELECT provider, model, COUNT(*), MAX(timestamp) FROM messages WHERE timestamp > ?"
                        " GROUP BY provider, model", (since,)):
                    out[f"{p}/{m}"] = {"count": n, "last": last, "tps": None, "ttft": None}
                for p, m, toks, dur, ttft in con.execute(
                        "SELECT provider, model, output_tokens, duration, ttft FROM (SELECT provider, model,"
                        " output_tokens, duration, ttft, ROW_NUMBER() OVER (PARTITION BY provider, model"
                        " ORDER BY timestamp DESC) AS rn FROM messages WHERE timestamp > ? AND output_tokens >= 50"
                        " AND duration > 0) WHERE rn <= ?", (since, USAGE_SAMPLES)):
                    tps, ttfts = speeds[f"{p}/{m}"]
                    tps.append(toks * 1000 / dur)
                    if ttft:
                        ttfts.append(ttft)
            finally:
                con.close()
        except sqlite3.Error as ex:
            log(f"cannot read {OMP_STATS_DB}: {ex}")
        for sel, (tps, ttfts) in speeds.items():
            if sel in out:
                out[sel]["tps"] = round(statistics.median(tps), 1) if tps else None
                out[sel]["ttft"] = round(statistics.median(ttfts)) if ttfts else None
        _usage = (time.monotonic(), out)
        return out


# ---------------------------------------------------------------- omp settings and model roles

_config_lock = threading.Lock()
_config_cache: dict[str, tuple[tuple, dict]] = {}


def _config_stamp(cwd: str) -> tuple:
    def mtime(p: Path) -> int | None:
        try:
            return p.stat().st_mtime_ns
        except OSError:
            return None
    return tuple(mtime(p) for p in (OMP_DIR / "config.yml", OMP_DIR / "config.yaml",
                                    Path(cwd) / ".omp" / "config.yml", Path(cwd) / ".omp" / "settings.json"))


def omp_config(cwd: str | None = None, fresh: bool = False) -> dict:
    """omp's effective settings {key: value} in `cwd` (its project layer applies), from
    `omp config list --json`; cached until omp's global or that project's config file changes.
    Keys without a value are left out. RequestError when omp cannot be run."""
    cwd = cwd if cwd and os.path.isdir(cwd) else str(Path.home())
    stamp = _config_stamp(cwd)
    with _config_lock:
        hit = _config_cache.get(cwd)
    if hit and hit[0] == stamp and not fresh:
        return hit[1]
    try:
        r = subprocess.run([omp_binary(), "config", "list", "--json"], capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=OMP_CONFIG_TIMEOUT_S, cwd=cwd)
        raw = json.loads(r.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError) as ex:
        raise RequestError(f"omp config list failed: {ex}") from None
    if not isinstance(raw, dict):
        raise RequestError("omp config list gave no settings")
    cfg = {k: v["value"] for k, v in raw.items() if isinstance(v, dict) and "value" in v}
    with _config_lock:
        _config_cache[cwd] = (stamp, cfg)
    return cfg


def omp_config_write(action: str, key: str, *value: str) -> None:
    """`omp config set <key> <json>` or `omp config reset <key>`: omp writes its global config file
    (validated, merged under its lock)."""
    try:
        r = subprocess.run([omp_binary(), "config", action, key, *value], capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=OMP_CONFIG_TIMEOUT_S, cwd=Path.home())
    except (OSError, subprocess.TimeoutExpired) as ex:
        raise RequestError(f"omp config {action} failed: {ex}") from None
    if r.returncode != 0:
        lines = ANSI_RE.sub("", r.stderr + r.stdout).strip().splitlines()
        raise RequestError(f"omp config {action} {key}: " + (lines[0] if lines else f"exit {r.returncode}"))


def omp_config_set(key: str, value) -> None:
    """`omp config set <key> <json>`."""
    omp_config_write("set", key, json.dumps(value, ensure_ascii=False))


_schema_lock = threading.Lock()
_schema: tuple[int | None, dict] = (None, {})


def settings_schema() -> dict:
    """omp's settings schema as the devdeck extension saved it (EXT_DIR/settings-schema.json):
    {tabs:[{id, label, groups}], settings:{key: {type, default, values?, options?, tab?, group?,
    label?, description?, credential}}}; empty until some omp loaded the extension."""
    global _schema
    path = EXT_DIR / "settings-schema.json"
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        return {"tabs": [], "settings": {}}
    with _schema_lock:
        if _schema[0] == mtime:
            return _schema[1]
    try:
        raw = json.loads(path.read_text())
        schema = {"tabs": [t for t in raw.get("tabs") or [] if isinstance(t, dict) and isinstance(t.get("id"), str)],
                  "settings": {s["key"]: s for s in raw.get("settings") or []
                               if isinstance(s, dict) and isinstance(s.get("key"), str)}}
    except (OSError, ValueError, AttributeError) as ex:
        log(f"{path}: {ex}")
        schema = {"tabs": [], "settings": {}}
    with _schema_lock:
        _schema = (mtime, schema)
    return schema


def settings_state(cwd: str | None) -> dict:
    """The `settings` reply: every omp setting in `cwd` (its project layer applies) from three
    `omp config list --json` runs at once (effective values, then the keys the global and the project
    layer set), described with the schema. Ordered like omp's /settings page (tab, then group);
    settings the page does not show follow, grouped by their first key segment."""
    cwd = cwd if cwd and os.path.isdir(cwd) else str(Path.home())
    procs = []
    try:
        for extra in ((), ("--scope", "global"), ("--scope", "project")):
            procs.append(subprocess.Popen([omp_binary(), "config", "list", "--json", *extra], stdout=subprocess.PIPE,
                                          stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, cwd=cwd, text=True))
        outs = [p.communicate(timeout=OMP_CONFIG_TIMEOUT_S)[0] for p in procs]
        full, glob_, proj = (json.loads(o) for o in outs)
    except (OSError, subprocess.TimeoutExpired, ValueError) as ex:
        raise RequestError(f"omp config list failed: {ex}") from None
    finally:
        for p in procs:
            if p.poll() is None:
                p.kill()
    if not all(isinstance(d, dict) for d in (full, glob_, proj)):
        raise RequestError("omp config list gave no settings")
    schema = settings_schema()
    tabs = {t["id"]: (i, t) for i, t in enumerate(schema["tabs"])}
    items = []
    for order, (key, cur) in enumerate(full.items()):
        if not isinstance(cur, dict):
            continue
        d = schema["settings"].get(key, {})
        typ = cur.get("type") if cur.get("type") in SETTINGS_TYPES else d.get("type")
        if typ not in SETTINGS_TYPES:
            continue
        tab = tabs.get(d.get("tab"))
        if tab:
            group = tab[1].get("label", tab[0]) + (f" · {d['group']}" if d.get("group") else "")
            groups = tab[1].get("groups") or []
            rank = (0, tab[0], groups.index(d["group"]) if d.get("group") in groups else len(groups), order)
        else:
            group, rank = key.split(".", 1)[0], (1, 0, 0, order)
        item = {"key": key, "group": group, "type": typ,
                "description": d.get("description") or cur.get("description") or "",
                "scope": "project" if key in proj else "global" if key in glob_ else "default"}
        secret = d.get("credential") is True
        if secret:
            item["secret"] = True
        else:
            if "value" in cur:
                item["value"] = cur["value"]
            if d.get("default") is not None:
                item["default"] = d["default"]
        if typ == "enum" and isinstance(d.get("values"), list):
            item["options"] = [str(v) for v in d["values"]]
        elif typ == "string" and isinstance(d.get("options"), list) and d["options"]:
            item["options"] = [str(o.get("value")) for o in d["options"] if isinstance(o, dict)]
        if isinstance(d.get("label"), str):
            item["label"] = d["label"]
        items.append((rank, item))
    items.sort(key=lambda r: r[0])
    # omp watches its config directory and applies on-disk changes to running sessions.
    return {"t": "settings", "items": [i for _, i in items], "restartHint": False}


CHAT_ROLES = ("default", "smol", "slow", "vision", "plan", "commit", "tiny", "memory", "task", "advisor", "widget")
KIND_ROLES = ("image", "web", "speech", "dictation", "judge")
ROLE_KINDS = {"tiny": ("chat", "tiny"), "memory": ("chat", "tiny"), "image": ("image",), "web": ("search", "chat"),
              "speech": ("tts",), "dictation": ("stt",), "judge": ("judge", "tiny", "chat")}
ROLE_LEVELS = THINKING_LEVELS + ("inherit",)
ROLE_DESC = {
    "default": "The main conversation model",
    "smol": "Fast, cheap model for light work and prewalk hand-offs",
    "slow": "Strong model for thorough reasoning",
    "vision": "Chat model that answers questions about images",
    "plan": "Model used while plan mode is on",
    "commit": "Writes commit messages",
    "tiny": "Background work such as session titles",
    "memory": "Memory extraction and consolidation",
    "task": "Model for task subagents",
    "advisor": "Second model that reviews each turn",
    "widget": "Writes the live widgets of background jobs",
    "image": "Image generation (generate_image)",
    "web": "Web search: a search engine or a grounded chat model",
    "speech": "Text to speech",
    "dictation": "Speech to text",
    "judge": "Judgments: auto thinking, stop detection, find",
}


def split_level(spec: str) -> tuple[str, str | None]:
    """("provider/id" or "@role", level) of a role selector with an optional ":level" suffix."""
    head, sep, tail = spec.rpartition(":")
    return (head, tail) if sep and head and tail in ROLE_LEVELS else (spec, None)


def role_names(cfg: dict) -> list[str]:
    """Built-in chat roles, custom roles (from modelRoles, cycleOrder and modelTags), kind roles."""
    custom: list[str] = []
    for src in (cfg.get("modelRoles"), cfg.get("cycleOrder"), cfg.get("modelTags")):
        for name in src or ():
            if isinstance(name, str) and name not in CHAT_ROLES and name not in KIND_ROLES and name not in custom:
                custom.append(name)
    return [*CHAT_ROLES, *custom, *KIND_ROLES]


def role_kinds(name: str) -> tuple[str, ...]:
    return ROLE_KINDS.get(name, ("chat",))


def role_thinking(name: str) -> bool:
    """Whether a ":level" suffix applies: roles that take chat models (omp's hub shows levels on
    web and judge when they hold a chat model; image, speech and dictation take none)."""
    return "chat" in role_kinds(name)


def roles_state(cfg: dict) -> dict:
    """The `roles` reply: omp's role assignments, fallback chains, cycle order, compaction limits
    and presets as configured, each role with what it resolves to."""
    roles = cfg.get("modelRoles") if isinstance(cfg.get("modelRoles"), dict) else {}

    def resolve(value: str, depth: int = 0) -> tuple[str | None, str | None]:
        spec, level = split_level(value.split(",", 1)[0].strip())
        if spec.startswith("@"):
            target = roles.get(spec[1:])
            if not isinstance(target, str) or depth > 5:
                return None, level
            sel, inner = resolve(target, depth + 1)
            return sel, level or inner
        return (spec or None), level

    out = []
    for name in role_names(cfg):
        value = roles.get(name) if isinstance(roles.get(name), str) and roles.get(name) else None
        sel, level = resolve(value) if value else (None, None)
        auto = None
        if value is None:
            auto = {"tiny": "@smol", "memory": "@tiny", "widget": "@smol"}.get(name, "built-in")
            if name in ("smol", "slow") and roles.get("default"):
                auto = "@default"
            elif name == "advisor" and roles.get("slow"):
                auto = "@slow"
        builtin = name in CHAT_ROLES or name in KIND_ROLES
        out.append({"name": name,
                    "label": name if builtin or not re.search(r"[_-]", name) else re.sub(r"[_-]+", " ", name).title(),
                    "group": "kind" if name in KIND_ROLES else "chat" if builtin else "custom",
                    "accepts": list(role_kinds(name)), "thinking": role_thinking(name),
                    "value": value, "selector": sel, "level": level, "auto": auto,
                    "desc": ROLE_DESC.get(name, f"Custom chat role (@{name})")})
    presets = []
    for pname, p in (cfg.get("modelPresets") or {}).items():
        if isinstance(p, dict):
            presets.append({"name": pname,
                            "roles": p.get("modelRoles") if isinstance(p.get("modelRoles"), dict) else {},
                            "thinking": p.get("defaultThinkingLevel") if isinstance(p.get("defaultThinkingLevel"), str) else None})
    storage = cfg.get("modelRoleStorage")
    return {"t": "roles", "storage": storage if storage in ("global", "project") else "global",
            "defaultThinking": cfg.get("defaultThinkingLevel") if isinstance(cfg.get("defaultThinkingLevel"), str) else None,
            "roles": out, "cycle": [c for c in cfg.get("cycleOrder") or [] if isinstance(c, str)],
            "chains": cfg.get("retry.fallbackChains") if isinstance(cfg.get("retry.fallbackChains"), dict) else {},
            "thresholds": cfg.get("compaction.modelThresholds") if isinstance(cfg.get("compaction.modelThresholds"), dict) else {},
            "presets": presets}


ROLE_SETTINGS = {"modelRoles": dict, "retry.fallbackChains": dict, "cycleOrder": list,
                 "compaction.modelThresholds": dict, "modelPresets": dict}
THRESHOLD_RE = re.compile(r"^(f?[1-9]\d*|[1-9]\d?%|100%)$")


def check_selector(catalog: ModelCatalog, spec: str, kinds: tuple[str, ...], thinking: bool, where: str,
                   grounded: bool = False) -> None:
    """RequestError unless `spec` ("provider/id[:level]" or "@role[:level]") names a catalog model of
    one of `kinds` (or another role) with a level that model supports; `grounded` (the web role)
    also requires a chat model to have web-search grounding."""
    sel, level = split_level(spec.strip())
    if level and not thinking:
        raise RequestError(f"{where}: {sel} takes no thinking level")
    if sel.startswith("@"):
        if not ROLE_NAME_RE.match(sel[1:]):
            raise RequestError(f"{where}: bad role alias {sel!r}")
        return
    m = catalog.lookup(sel)
    if m is None:
        raise RequestError(f"{where}: unknown model {sel!r}")
    if m["kind"] not in kinds:
        raise RequestError(f"{where}: {m['name']} is a {m['kind']} model; this takes " + " or ".join(kinds))
    if grounded and m["kind"] == "chat" and not m["webSearch"]:
        raise RequestError(f"{where}: {m['name']} has no web-search grounding")
    if level and m["kind"] != "chat":
        raise RequestError(f"{where}: {m['name']} is a {m['kind']} model and takes no thinking level")
    if level and level not in ("off", "auto", "inherit") and level not in (m["thinking"] or []):
        raise RequestError(f"{where}: {m['name']} supports thinking: "
                           + ", ".join(["off", "auto", "inherit", *(m["thinking"] or [])]))


def check_role_setting(catalog: ModelCatalog, key: str, value, old) -> None:
    """RequestError unless `value` is a valid whole value of the role setting `key`; entries
    unchanged from `old` (possibly hand-written on the PC) are not re-checked."""
    if not isinstance(value, ROLE_SETTINGS[key]):
        raise RequestError(f"{key} must be a{'n object' if ROLE_SETTINGS[key] is dict else ' list'}")
    old = old if isinstance(old, ROLE_SETTINGS[key]) else ROLE_SETTINGS[key]()
    if key == "cycleOrder":
        if any(not isinstance(r, str) or not ROLE_NAME_RE.match(r) for r in value) or len(set(value)) != len(value):
            raise RequestError("cycleOrder must list distinct role names")
        return
    for k, v in value.items():
        if not isinstance(k, str) or not k or (key in ("modelRoles", "modelPresets") and not ROLE_NAME_RE.match(k)):
            raise RequestError(f"{key}: bad key {k!r}")
        if old.get(k) == v:
            continue
        if key == "modelRoles":
            if not isinstance(v, str) or not v.strip():
                raise RequestError(f"modelRoles.{k} must be a model selector")
            for part in v.split(","):
                check_selector(catalog, part, role_kinds(k), role_thinking(k), f"role {k}", grounded=k == "web")
        elif key == "retry.fallbackChains":
            if not isinstance(v, list) or not all(isinstance(s, str) and s.strip() for s in v):
                raise RequestError(f"fallback chain {k} must be a list of selectors")
            for s in v:
                if not split_level(s.strip())[0].endswith("/*"):
                    check_selector(catalog, s, ("chat", "tiny", "judge", "image", "search", "tts", "stt"), True,
                                   f"fallback chain {k}")
        elif key == "compaction.modelThresholds":
            if not (isinstance(v, int) and not isinstance(v, bool) and v > 0) and not (isinstance(v, str) and THRESHOLD_RE.match(v)):
                raise RequestError(f"compaction limit {k}: use tokens (90000), a fixed trigger (f90000) or a percentage (80%)")
        else:  # modelPresets
            if not PRESET_RE.match(k) or not isinstance(v, dict) or not isinstance(v.get("modelRoles"), dict):
                raise RequestError(f"preset {k!r} needs a name of letters, digits, _ . - and its modelRoles")
            lvl = v.get("defaultThinkingLevel")
            if lvl is not None and lvl not in THINKING_LEVELS:
                raise RequestError(f"preset {k}: unknown thinking level {lvl!r}")
            if any(not isinstance(r, str) or not isinstance(s, str) for r, s in v["modelRoles"].items()):
                raise RequestError(f"preset {k}: modelRoles must map role names to selectors")


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


def open_omp_sessions() -> dict[str, dict]:
    """Session files a running omp has open, by path: {tty, cwd, yolo}. Each terminal an omp
    process runs in counts with its breadcrumb when written since that omp started (pts numbers
    are recycled, and a killed omp leaves its breadcrumb behind) or naming the session that omp
    was started with (crumb_named)."""
    out = {}
    for tty, (start, yolo, named) in omp_terminals().items():
        try:
            with open(OMP_DIR / "terminal-sessions" / f"pts-{tty}", errors="replace") as f:
                mtime = os.fstat(f.fileno()).st_mtime
                lines = f.read(8192).splitlines()
        except OSError:
            continue
        if len(lines) >= 2 and (mtime >= start - 2 or crumb_named(lines[1], named)):
            out[lines[1]] = {"tty": f"/dev/pts/{tty}", "cwd": lines[0], "yolo": yolo}
    return out


def live_session_paths() -> set[str]:
    """Session files a running omp has open (open_omp_sessions)."""
    return set(open_omp_sessions())


def exit_record(obj: dict) -> dict | None:
    """The data of an omp `session_exit` entry (how its process ended), else None."""
    data = obj.get("data")
    if obj.get("type") != "custom" or obj.get("customType") != "session_exit" or not isinstance(data, dict):
        return None
    if not isinstance(data.get("reason"), str) or not isinstance(data.get("recordedAt"), str) \
            or data.get("kind") not in ("normal", "signal", "fatal", "process_exit"):
        return None
    return data


def entry_message(obj: dict) -> dict | None:
    if obj.get("type") != "message":
        return None
    return obj["message"] if isinstance(obj.get("message"), dict) else {}


def turn_cut_off(entries: list[dict]) -> bool:
    """omp's restore rule (`session/exit-diagnostics.ts` as of 18.14; `--restore` runs it on the
    session's branch and on each subagent transcript): the last turn was left unfinished and no
    normal exit was recorded after it. Never when the last message is an assistant reply without
    tool calls (the turn finished, failed or was interrupted by the user), or tool results that
    answer an assistant message that failed or was aborted."""
    last = None
    for i in range(len(entries) - 1, -1, -1):
        ex = exit_record(entries[i])
        if ex and ex["kind"] == "normal":
            return False
        m = entry_message(entries[i])
        if m is None:
            continue
        if m.get("role") == "assistant" and m.get("stopReason") == "aborted" and m.get("errorMessage") == EXIT_ABORT_TEXT:
            return True  # closed by omp's exit recovery but not yet retried
        last = i
        break
    if last is None:
        return False
    m = entry_message(entries[last])
    if m.get("role") == "assistant":
        content = m.get("content")
        return isinstance(content, list) and any(
            isinstance(b, dict) and b.get("type") == "toolCall" and (isinstance(b.get("name"), str) or isinstance(b.get("id"), str))
            for b in content)
    if m.get("role") == "toolResult":
        prev = next((p for p in map(entry_message, reversed(entries[:last])) if p is not None and p.get("role") == "assistant"), None)
        return prev is None or prev.get("stopReason") not in ("error", "aborted")
    return True  # a user (or other) message with no reply yet


def tail_entries(path: str, branch: bool) -> list[dict]:
    """The last entries of a session file, read from its end: with `branch` the end of the current
    branch (from the leaf, session_tree's rule, back along `parentId`), else in file order. More of
    the file is read only while the last message (for a tool result also the assistant message
    before it) is missing."""
    size = os.path.getsize(path)
    n = min(size, TAIL_READ)
    while True:
        with open(path, "rb") as f:
            f.seek(size - n)
            data = f.read(n)
        lines = data.split(b"\n")
        if n < size:
            lines = lines[1:]  # the read starts inside this one
        objs = []
        for line in lines:
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict) and obj.get("type") not in ("session", "title"):
                objs.append(obj)
        whole = n >= size
        if branch:
            by_id = {o["id"]: o for o in objs if isinstance(o.get("id"), str)}
            last = next((o for o in reversed(objs) if isinstance(o.get("id"), str)), None)
            cur = (last.get("activeLeafId") if "activeLeafId" in last else last["id"]) if last else None
            if last and cur is None:
                return []  # the leaf is before the first entry
            objs, seen = [], set()
            while isinstance(cur, str) and cur in by_id and cur not in seen:
                seen.add(cur)
                objs.append(by_id[cur])
                cur = by_id[cur].get("parentId")
            objs.reverse()
            whole = whole or (bool(objs) and not isinstance(cur, str))  # reached the root
        msgs = [m for m in map(entry_message, objs) if m is not None]
        if whole or (msgs and (msgs[-1].get("role") != "toolResult" or any(m.get("role") == "assistant" for m in msgs))):
            return objs
        n = min(size, n * 4)


def exited_normally(entries: list[dict]) -> bool:
    """Whether the last process of this session recorded a normal exit after its last message."""
    for obj in reversed(entries):
        ex = exit_record(obj)
        if ex:
            return ex["kind"] == "normal"
        if entry_message(obj) is not None:
            return False
    return False


def subagent_revivable(path: str) -> bool:
    """Whether a subagent transcript has the non-isolated `session_init` contract omp's cold revive
    needs (the last one counts)."""
    try:
        with open(path, "rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            idx = mm.rfind(b'"type":"session_init"')
            if idx < 0:
                return False
            end = mm.find(b"\n", idx)
            obj = json.loads(mm[mm.rfind(b"\n", 0, idx) + 1:end if end >= 0 else len(mm)])
    except (OSError, ValueError):
        return False
    return isinstance(obj, dict) and not obj.get("isolated")


def subagent_cut_off(path: str) -> bool:
    """Whether a subagent transcript under the session (`<session>/<AgentId>.jsonl`, nested ones
    too) was left mid-turn and `omp --restore` would revive it: not killed (no `.tombstone`), not
    an advisor, revivable."""
    folders = [path.removesuffix(".jsonl")]
    while folders:
        folder = folders.pop()
        try:
            names = set(os.listdir(folder))
        except OSError:
            continue
        for name in names:
            if not name.endswith(".jsonl") or ".bak" in name or name == "__advisor.jsonl" or name.startswith("__advisor."):
                continue
            if name[:-6] in names:
                folders.append(os.path.join(folder, name[:-6]))
            sub = os.path.join(folder, name)
            try:
                if name + ".tombstone" not in names and turn_cut_off(tail_entries(sub, False)) and subagent_revivable(sub):
                    return True
            except OSError:
                continue
    return False


_facts: dict[str, tuple[tuple, tuple[bool, bool]]] = {}


def session_facts(path: str) -> tuple[bool, bool]:
    """(interrupted, exited normally) of a session file. Interrupted: `omp --restore` would continue
    something of it (README "Restore"): its own turn was cut off (turn_cut_off on its branch), or
    its process ended without a normal exit while a subagent was mid-turn (omp would revive those
    even after a normal exit; DevDeck does not offer such leftovers). Exited normally: its last
    process recorded a normal exit after its last message. Only file tails are read, cached by
    inode/size/mtime. Whether an omp has the session open now is live_session_paths' business."""
    try:
        st = os.stat(path)
    except OSError:
        return False, False
    key = (st.st_ino, st.st_size, st.st_mtime_ns)
    with _heads_lock:
        hit = _facts.get(path)
    if hit and hit[0] == key:
        return hit[1]
    try:
        branch = tail_entries(path, True)
        normal = exited_normally(branch)
        facts = (turn_cut_off(branch) or (not normal and subagent_cut_off(path)), normal)
    except OSError:
        return False, False
    with _heads_lock:
        _facts[path] = (key, facts)
    return facts


def interrupted(path: str) -> bool:
    return session_facts(path)[0]


def terminated(path: str, mtime: float, record: dict | None) -> bool:
    """Whether a session (open in no running omp) lost its terminal: its omp ended without a
    normal exit (killed, or SIGHUP when the terminal or tmux went away). Counted for sessions the
    terminals record (Server.record_terminals) saw open in a pane, and, for files older than the
    record (`since`; all of them without one), for any modified in the last TERMINATED_GUESS_S."""
    if session_facts(path)[1]:
        return False
    if record is not None and path in record["sessions"]:
        return True
    return (record is None or mtime < record["since"]) and mtime >= time.time() - TERMINATED_GUESS_S


def load_terminals() -> dict:
    """The terminals record {since, sessions: {path: {id, cwd, pane, yolo}}} (Server.record_terminals);
    a new one starts now and is written at once, so `since` survives restarts."""
    try:
        data = json.loads(TERMINALS_FILE.read_text())
        if isinstance(data.get("since"), (int, float)) and isinstance(data.get("sessions"), dict):
            return {"since": float(data["since"]), "sessions": {
                p: e for p, e in data["sessions"].items() if isinstance(e, dict) and isinstance(e.get("id"), str)}}
    except (OSError, ValueError, AttributeError):
        pass
    data = {"since": time.time(), "sessions": {}}
    save_terminals(data)
    return data


def save_terminals(data: dict) -> None:
    try:
        TERMINALS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = TERMINALS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1))
        os.replace(tmp, TERMINALS_FILE)
    except OSError as ex:
        log(f"cannot persist {TERMINALS_FILE}: {ex}")


def session_history(cwd: str | None, current: str | None, restorable_only: bool = False,
                    record: dict | None = None) -> list[dict]:
    """omp sessions of `cwd` (every project's when None, each with its `cwd`): pinned first, then
    newest; empty ones (no user message) skipped. Each one open in no running omp says whether it
    is `interrupted` (cut off mid-turn) and `terminated` (its terminal went away; `record` is the
    terminals record, see terminated()); `restorable_only` lists just those that are either."""
    cwd = os.path.normpath(cwd) if cwd is not None else None
    limit = HISTORY_MAX if cwd is not None else HISTORY_ALL_MAX
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
        if head and head["cwd"] and (cwd is None or os.path.normpath(head["cwd"]) == cwd):
            cands.append((head["id"] in pins, st.st_mtime, path, st, head))
    cands.sort(key=lambda c: (c[0], c[1]), reverse=True)
    live = live_session_paths()
    picked = []
    for pinned, mtime, path, st, head in cands:
        cut = gone = False
        if path not in live:
            cut, gone = interrupted(path), terminated(path, mtime, record)
        if restorable_only and not (cut or gone):
            continue
        first = session_first_user(path, st)
        if first is None and not pinned:
            continue
        picked.append((pinned, mtime, path, head, first, cut, gone))
        if len(picked) >= limit:
            break
    titles, recaps = history_db_info([c[3]["id"] for c in picked])
    out = []
    for pinned, mtime, path, head, first, cut, gone in picked:
        sid = head["id"]
        item = {"id": sid, "title": head["title"] or titles.get(sid) or first or "", "mtime": int(mtime * 1000),
                "live": path in live, "current": sid == current, "pinned": pinned, "interrupted": cut,
                "terminated": gone}
        if recaps.get(sid):
            item["recap"] = recaps[sid]
        if cwd is None:
            item["cwd"] = head["cwd"]
        out.append(item)
    return out


def session_file(sid: str) -> str | None:
    """The session file `<ts>_<sid>.jsonl` directly under ~/.omp/agent/sessions/*/, if any."""
    if not UUID_RE.match(sid):
        return None
    return next((str(p) for p in (OMP_DIR / "sessions").glob(f"*/*_{sid}.jsonl")), None)


def session_entries(path: str):
    """Every JSON object line of a session file, in order."""
    with open(path, "rb") as f:
        for line in f:
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict):
                yield obj


def session_entry(path: str, entry_id: str) -> dict | None:
    """The entry `entry_id` of a session file (only lines naming the id are parsed)."""
    needle = f'"id":"{entry_id}"'.encode()
    with open(path, "rb") as f:
        for line in f:
            if needle not in line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict) and obj.get("id") == entry_id:
                return obj
    return None


def one_line(text: str, limit: int = TREE_PREVIEW) -> str:
    s = " ".join(text.split())
    return s if len(s) <= limit else s[:limit - 1] + "…"


def tree_kind(obj: dict) -> str:
    t = obj.get("type")
    if t == "message":
        role = (obj.get("message") or {}).get("role") if isinstance(obj.get("message"), dict) else None
        if role in ("user", "assistant"):
            return role
        if role == "toolResult":
            return "tool"
        return "notice" if role in ("bashExecution", "pythonExecution", "fileMention", "custom", "hookMessage") \
            else "other"
    if t in ("compaction", "branch_summary"):
        return t
    return "notice" if t == "custom_message" else "other"


def tree_preview(obj: dict) -> str:
    """One line (at most TREE_PREVIEW chars) describing a session entry in the tree."""
    t = obj.get("type")
    if t == "message":
        m = obj["message"] if isinstance(obj.get("message"), dict) else {}
        role, text = m.get("role"), content_text(m.get("content"))
        if role == "assistant" and not text.strip():
            names = [b.get("name") for b in m.get("content") or []
                     if isinstance(b, dict) and b.get("type") == "toolCall" and isinstance(b.get("name"), str)]
            text = "→ " + ", ".join(names) if names else str(m.get("errorMessage") or m.get("stopReason") or "")
        elif role == "toolResult":
            text = f"{m.get('toolName') or 'tool'}: {text}"
        elif not text and role == "bashExecution":
            text = f"$ {m.get('command') or ''}"
        return one_line(text or str(role or "message"))
    if t in ("compaction", "branch_summary"):
        return one_line(str(obj.get("summary") or t.replace("_", " ")))
    if t == "custom_message":
        return one_line(content_text(obj.get("content")) or str(obj.get("customType") or "notice"))
    if t == "model_change":
        return one_line(f"model: {obj.get('model')}")
    if t == "thinking_level_change":
        return one_line(f"thinking: {obj.get('thinkingLevel')}")
    if t == "mode_change":
        return one_line(f"mode: {obj.get('mode')}")
    if t == "reset_boundary":
        return "context cleared (/clear)"
    return one_line(str(t or "entry").replace("_", " "))


def session_tree(path: str) -> dict:
    """{leafId, entries} of a whole session file for the tree view (wire protocol `tree`). Bookkeeping
    entries (TREE_SKIP) are left out; an entry whose parent is left out hangs on the nearest shown
    ancestor. The leaf follows omp's rule: the last entry, or its `activeLeafId` when it has one."""
    parents: dict[str, str | None] = {}
    rows: list[tuple] = []
    labels: dict[str, str] = {}
    leaf: str | None = None
    for obj in session_entries(path):
        ident, t = obj.get("id"), obj.get("type")
        if not isinstance(ident, str) or t in ("session", "title"):
            continue
        parent = obj.get("parentId") if isinstance(obj.get("parentId"), str) else None
        parents[ident] = parent
        if "activeLeafId" in obj:
            leaf = obj["activeLeafId"] if isinstance(obj["activeLeafId"], str) else None
        else:
            leaf = ident
        if t == "label" and isinstance(obj.get("targetId"), str):
            if isinstance(obj.get("label"), str) and obj["label"].strip():
                labels[obj["targetId"]] = obj["label"].strip()
            else:
                labels.pop(obj["targetId"], None)
        if t not in TREE_SKIP:
            rows.append((ident, parent, tree_kind(obj), tree_preview(obj), ts_ms(obj.get("timestamp")) or 0))
    kept = {r[0] for r in rows}
    shown: dict[str | None, str | None] = {None: None}

    def shown_of(ident: str | None) -> str | None:
        chain = []
        while ident not in shown and ident not in kept and len(chain) < len(parents) + 1:
            chain.append(ident)
            ident = parents.get(ident)
        res = shown.get(ident, ident if ident in kept else None)
        for c in chain:
            shown[c] = res
        return res
    on_path, cur = set(), leaf
    while cur is not None and cur not in on_path:
        on_path.add(cur)
        cur = parents.get(cur)
    entries = []
    for ident, parent, kind, preview, ts in rows:
        e = {"id": ident, "parentId": shown_of(parent), "kind": kind, "preview": preview, "ts": ts,
             "onPath": ident in on_path}
        if ident in labels:
            e["label"] = labels[ident]
        entries.append(e)
    return {"leafId": shown_of(leaf), "entries": entries}


def dir_bytes(path: str) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def session_tally(path: str) -> dict:
    """One read of a session file: `entries` counts the whole file; user/assistant messages, models,
    tokens and cost count the current branch (root to leaf), as omp's /session page does: assistant
    replies, `model_usage` entries (titles, cache warming, summaries) and the usage subagents
    report in `task` results. `cost` is None when no entry was priced."""
    created, parent, leaf = None, None, None
    # id -> (parentId, role, provider/model, usage)
    nodes: dict[str, tuple[str | None, str | None, str | None, dict | None]] = {}
    for obj in session_entries(path):
        t = obj.get("type")
        if t == "session":
            created = ts_ms(obj.get("timestamp"))
            parent = obj.get("parentSession") if isinstance(obj.get("parentSession"), str) else None
            continue
        ident = obj.get("id")
        if not isinstance(ident, str) or t == "title":
            continue
        leaf = (obj["activeLeafId"] if isinstance(obj["activeLeafId"], str) else None) if "activeLeafId" in obj else ident
        role = model = None
        usage = obj.get("usage") if t == "model_usage" else None
        if t == "message" and isinstance(obj.get("message"), dict):
            m = obj["message"]
            role = m.get("role")
            if role == "assistant":
                if isinstance(m.get("provider"), str) and isinstance(m.get("model"), str):
                    model = f"{m['provider']}/{m['model']}"
                usage = m.get("usage")
            elif role == "toolResult" and m.get("toolName") == "task" and isinstance(m.get("details"), dict):
                usage = m["details"].get("usage")
        nodes[ident] = (obj.get("parentId") if isinstance(obj.get("parentId"), str) else None, role, model,
                        usage if isinstance(usage, dict) else None)
    users = assistants = 0
    models: collections.Counter[str] = collections.Counter()
    tokens = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
    cost, priced, seen, cur = 0.0, False, set(), leaf
    while cur in nodes and cur not in seen:
        seen.add(cur)
        up, role, model, usage = nodes[cur]
        cur = up
        users += role == "user"
        assistants += role == "assistant"
        if model:
            models[model] += 1
        if usage is None:
            continue
        for k in tokens:
            v = usage.get(k)
            if isinstance(v, int) and not isinstance(v, bool):
                tokens[k] += v
        total = usage.get("cost", {}).get("total") if isinstance(usage.get("cost"), dict) else None
        if isinstance(total, (int, float)) and not isinstance(total, bool):
            cost += total
            priced = True
    return {"created": created, "parent": parent, "entries": len(nodes), "userMessages": users,
            "assistantMessages": assistants, "models": [{"model": k, "count": n} for k, n in models.most_common()],
            "tokens": tokens, "cost": round(cost, 6) if priced else None}


def session_info(path: str) -> dict:
    """Facts about a session file for the session sheet (wire protocol `session_info`), counted
    as session_tally does."""
    st = os.stat(path)
    head = session_head(path, st) or {}
    sid = head.get("id") or session_id_of(path)
    tally = session_tally(path)
    titles, _ = history_db_info([sid])
    artifacts = path.removesuffix(".jsonl")
    btw = os.path.join(artifacts, "btw-history")
    out = {"id": sid, "file": path, "cwd": head.get("cwd") or "",
           "title": head.get("title") or titles.get(sid) or session_first_user(path, st) or "",
           "created": tally["created"] or int(st.st_ctime * 1000), "modified": int(st.st_mtime * 1000),
           "entries": tally["entries"], "userMessages": tally["userMessages"],
           "assistantMessages": tally["assistantMessages"], "models": tally["models"], "tokens": tally["tokens"],
           "cost": tally["cost"],
           "artifactsBytes": dir_bytes(artifacts) if os.path.isdir(artifacts) else 0,
           "btwTopics": len([n for n in (os.listdir(btw) if os.path.isdir(btw) else [])
                             if re.fullmatch(r"entry-.+\.json", n)])}
    if tally["parent"]:
        out["parentSession"] = tally["parent"]
    return out


def prune_trash() -> None:
    """Drops sessions deleted from the phone more than TRASH_KEEP_S ago."""
    cutoff = time.time() - TRASH_KEEP_S
    try:
        folders = list(TRASH_DIR.iterdir())
    except OSError:
        return
    for folder in folders:
        try:
            if json.loads((folder / "meta.json").read_text())["deletedAt"] / 1000 < cutoff:
                shutil.rmtree(folder)
        except (OSError, ValueError, KeyError, TypeError):
            continue


def trash_session(path: str) -> str:
    """Moves a session file and its artifact directory (subagent sessions, /btw history, ...) into
    TRASH_DIR/<trashId>/ with a meta.json; returns the trashId."""
    prune_trash()
    trash_id = f"{int(time.time())}-{secrets.token_hex(4)}"
    folder = TRASH_DIR / trash_id
    folder.mkdir(mode=0o700, parents=True)
    artifacts = path.removesuffix(".jsonl")
    has_art = os.path.isdir(artifacts)
    meta = {"id": session_id_of(path), "path": path, "artifacts": artifacts if has_art else None,
            "deletedAt": int(time.time() * 1000)}
    (folder / "meta.json").write_text(json.dumps(meta))
    shutil.move(path, folder / os.path.basename(path))
    if has_art:
        shutil.move(artifacts, folder / os.path.basename(artifacts))
    return trash_id


def restore_session(trash_id) -> str:
    """Moves a trashed session back where it was; its path."""
    if not isinstance(trash_id, str) or not re.fullmatch(r"\d{1,12}-[0-9a-f]{8}", trash_id):
        raise RequestError("session_restore needs a trashId")
    folder = TRASH_DIR / trash_id
    try:
        meta = json.loads((folder / "meta.json").read_text())
        path, artifacts = meta["path"], meta.get("artifacts")
    except (OSError, ValueError, KeyError, TypeError):
        raise RequestError("no such deleted session (restorable for 30 days)") from None
    sessions = str(OMP_DIR / "sessions") + os.sep
    if not isinstance(path, str) or not path.startswith(sessions) or \
            (artifacts is not None and (not isinstance(artifacts, str) or not artifacts.startswith(sessions))):
        raise RequestError("the deleted session's record is damaged")
    if os.path.exists(path) or (artifacts and os.path.exists(artifacts)):
        raise RequestError(f"{path} exists again; not overwriting it")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    shutil.move(folder / os.path.basename(path), path)
    if artifacts and (folder / os.path.basename(artifacts)).exists():
        shutil.move(folder / os.path.basename(artifacts), artifacts)
    shutil.rmtree(folder, ignore_errors=True)
    return path


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


# ---------------------------------------------------------------- voice: spoken text

FENCE_RE = re.compile(r"^(`{3,}|~{3,})\s*([\w+#.-]*)")
HEADING_RE = re.compile(r"^#{1,6}\s+(.*?)\s*#*$")
LIST_RE = re.compile(r"^(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$")
HR_RE = re.compile(r"^(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$")
QUOTE_RE = re.compile(r"^(?:>\s?)+")
URL_RE = re.compile(r"\b(?:https?|ftp|file)://[^\s<>()\[\]`]+|\bwww\.[^\s<>()\[\]`]+")
# Absolute or ~/ ./ paths, or relative ones ending in a file extension; an optional :line[:col].
PATH_RE = re.compile(r"(?<![\w/.~@-])(?:(?:~|\.{1,2})?(?:/[\w.@+-]+){2,}/?|(?:~|\.{1,2})/[\w.@+-]+/?"
                     r"|[\w.@+-]+(?:/[\w.@+-]+)+\.[A-Za-z]\w{0,5})(?::\d+(?:[:-]\d+)?)?")
FILE_DOT_RE = re.compile(r"(?<![\w.@/-])([A-Za-z_][\w-]+)\.([A-Za-z][A-Za-z0-9]{0,5})(?!\w|\.\w)")
UUID_ANY_RE = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
HASH_RE = re.compile(r"(?<![\w#])#?(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])([0-9a-f]{7,64})(?!\w)")
LONG_NUMBER_RE = re.compile(r"(?<![\w.,])\d{8,}(?![\w.,]\d)")
EMOJI_RE = re.compile("[\U0001F000-\U0001FAFF\u2300-\u23FF\u2500-\u27BF\u2B00-\u2BFF\uFE0F\u200D]")
SPOKEN_SYMBOLS = (("->", " to "), ("→", " to "), ("⟶", " to "), ("=>", " to "), ("⇒", " to "), ("<-", " from "),
                  ("←", " from "), (">=", " at least "), ("≥", " at least "), ("<=", " at most "), ("≤", " at most "),
                  ("!=", " not "), ("≠", " not "), ("≈", " about "), (" & ", " and "), ("·", ", "), ("•", ", "),
                  (" | ", ", "), (" — ", ", "), ("—", ", "), (" – ", ", "))
DIAGRAM_LANGS = {"mermaid", "svg", "dot", "graphviz", "plantuml"}
MATH_LANGS = {"math", "latex", "tex", "katex"}
LANG_NAMES = {"py": "Python", "python": "Python", "js": "JavaScript", "javascript": "JavaScript", "jsx": "JavaScript",
              "ts": "TypeScript", "typescript": "TypeScript", "tsx": "TypeScript", "sh": "shell", "bash": "shell",
              "zsh": "shell", "fish": "shell", "shell": "shell", "console": "shell", "json": "JSON", "jsonl": "JSON",
              "yaml": "YAML", "yml": "YAML", "toml": "TOML", "html": "HTML", "css": "CSS", "sql": "SQL", "rs": "Rust",
              "rust": "Rust", "go": "Go", "java": "Java", "kotlin": "Kotlin", "c": "C", "cpp": "C plus plus",
              "c++": "C plus plus", "diff": "diff", "md": "Markdown", "markdown": "Markdown", "xml": "XML",
              "text": "", "txt": "", "plain": "", "plaintext": ""}
NUMBER_WORDS = ("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
                "twelve")


def number_word(n: int) -> str:
    return NUMBER_WORDS[n] if 0 <= n < len(NUMBER_WORDS) else str(n)


def code_marker(lang: str) -> str:
    if lang in DIAGRAM_LANGS:
        return "A diagram."
    if lang in MATH_LANGS:
        return "A formula."
    name = LANG_NAMES.get(lang, lang if re.fullmatch(r"[a-z][a-z0-9]{0,11}", lang) else "")
    return f"{name[:1].upper()}{name[1:]} code block omitted." if name else "Code block omitted."


def file_name(path: str) -> str:
    """The last component of a path (line suffix dropped), keeping a sentence's final period."""
    path = re.sub(r":\d+(?:[:-]\d+)?$", "", path)
    return path.rstrip("/").rsplit("/", 1)[-1] or path


def code_words(code: str) -> str:
    """Inline code read as words: paths shortened, camelCase and snake_case split, symbols dropped."""
    c = code.strip()
    if URL_RE.fullmatch(c):
        return "a link"
    c = UUID_ANY_RE.sub(" an ID ", URL_RE.sub(" a link ", c))
    c = PATH_RE.sub(lambda m: file_name(m.group(0)), c)
    c = re.sub(r"(?<=[a-z0-9])(?=[A-Z][a-z])", " ", c)
    c = re.sub(r"(?<=[A-Za-z])\.(?=[A-Za-z])", " dot ", c)
    c = re.sub(r"[^\w\s.,'%]+|_+", " ", c)
    return " ".join(c.split())


def math_words(tex: str) -> str:
    return " ".join(re.sub(r"[\\{}^_$]+", " ", tex).split())


def inline_spoken(text: str) -> str:
    """One line of markdown as plain spoken text."""
    t = re.sub(r"!\[([^\]]*)\]\((?:[^()\s]|\([^)]*\))*\)", lambda m: m.group(1) or "an image", text)
    t = re.sub(r"\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*\)", r"\1", t)
    t = re.sub(r"\[([^\]]+)\]\[[^\]]*\]", r"\1", t)
    t = re.sub(r"(`+)(.+?)\1", lambda m: " " + code_words(m.group(2)) + " ", t)
    t = re.sub(r"(?<![\\$\w])\$(?![\s\d])([^$\n]+?)(?<!\s)\$(?![\w$])", lambda m: math_words(m.group(1)), t)
    t = re.sub(r"<(?:https?|ftp|file)://[^>\s]+>", "a link", t)
    t = URL_RE.sub("a link", t)
    t = re.sub(r"<br\s*/?>", " ", t, flags=re.I)
    t = re.sub(r"</?[A-Za-z][^<>]*>", "", t)
    t = UUID_ANY_RE.sub("an ID", t)
    t = PATH_RE.sub(lambda m: file_name(m.group(0)), t)
    t = FILE_DOT_RE.sub(r"\1 dot \2", t)
    t = re.sub(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1", r"\2", t)
    t = re.sub(r"(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])", r"\1", t)
    t = re.sub(r"(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])", r"\1", t)
    t = re.sub(r"~~(.+?)~~", r"\1", t)
    t = HASH_RE.sub(lambda m: " ".join(m.group(1)[:4]), t)
    t = LONG_NUMBER_RE.sub("a long number", t)
    for sym, word in SPOKEN_SYMBOLS:
        t = t.replace(sym, word)
    t = EMOJI_RE.sub("", t)
    t = re.sub(r"#(?=\w)", "", t)
    t = re.sub(r"[*`~^]+|(?<=\w)_+(?=\w)", " ", t)
    t = re.sub(r"\s+([,.;:!?])", r"\1", " ".join(t.split()))
    t = re.sub(r"\s*\(\s*\)|\s*\[\s*\]", "", re.sub(r"([(\[])\s+", r"\1", re.sub(r"\s+([)\]])", r"\1", t)))
    t = re.sub(r"([.!?])\s+(\([^()]*\))\.?", r" \2\1", t)  # "done. (web/)" -> "done (web)."
    return t.strip(" ,")


def as_sentence(text: str) -> str:
    t = text.strip()
    if not t:
        return ""
    core = t.rstrip("\"')]")
    if core.endswith((":", ";", ",")):
        return core[:-1].rstrip() + "."
    return t if core.endswith((".", "!", "?", "…")) else t + "."


def table_cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def spoken_text(md: str, limit: int = SPOKEN_CAP) -> str:
    """Spoken form of an assistant's markdown: headings, emphasis and list markers dropped, links
    read as their text, URLs as "a link", inline code as words, code blocks, tables and diagrams
    replaced by one short sentence each, paths shortened to the file name, hashes and long
    numbers shortened. Longer than `limit` characters: cut at a sentence, "The rest is on screen."."""
    units: list[str] = []
    para, para_quote = "", False

    def flush() -> None:
        nonlocal para
        if para:
            units.append(as_sentence(para))
            para = ""

    lines = md.replace("\r\n", "\n").split("\n")
    i = 0
    while i < len(lines):
        quote = lines[i].lstrip().startswith(">")
        s = QUOTE_RE.sub("", lines[i].strip()).strip()
        m = FENCE_RE.match(s)
        if m:
            flush()
            j = i + 1
            while j < len(lines) and not lines[j].strip().startswith(m.group(1)):
                j += 1
            units.append(code_marker(m.group(2).lower()))
            i = j + 1
            continue
        if s.startswith("$$"):
            flush()
            j = i
            if s == "$$" or not s[2:].rstrip().endswith("$$"):
                j = i + 1
                while j < len(lines) and "$$" not in lines[j]:
                    j += 1
            units.append("A formula.")
            i = j + 1
            continue
        if s.lower().startswith("<svg"):
            flush()
            j = i
            while j < len(lines) and "</svg>" not in lines[j].lower():
                j += 1
            units.append("A diagram.")
            i = j + 1
            continue
        nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
        if s.startswith("|") and "-" in nxt and "|" in nxt and not nxt.strip("|:- "):
            flush()
            header = [h for h in (inline_spoken(c) for c in table_cells(s)) if h]
            j = i + 2
            while j < len(lines) and lines[j].strip().startswith("|"):
                j += 1
            rows = j - i - 2
            units.append(f"A table with {number_word(rows)} row{'' if rows == 1 else 's'}."
                         + (f" Columns: {', '.join(header)}." if header else ""))
            i = j
            continue
        i += 1
        if not s or HR_RE.match(s):
            flush()
            continue
        m = HEADING_RE.match(s) or LIST_RE.match(s)
        if m:
            flush()
            units.append(as_sentence(inline_spoken(m.group(1))))
            continue
        t = inline_spoken(s)
        if not t:
            continue
        # Hard-wrapped prose continues in lower case; anything else is a line of its own.
        if (para and quote == para_quote and not para.rstrip("\"')]").endswith((".", "!", "?", ":", "…"))
                and t[0].islower()):
            para += " " + t
        else:
            flush()
            para, para_quote = t, quote
    flush()
    text = " ".join(u for u in units if u)
    if len(text) > limit:
        cut = max(text.rfind(p, 0, limit) for p in (". ", "! ", "? "))
        if cut < limit // 2:
            cut = text.rfind(" ", 0, limit)
        text = text[:cut + 1].rstrip() + " The rest is on screen."
    return text


def split_sentences(text: str) -> list[str]:
    """Streaming units: sentences, long ones split at a comma (or a space), short ones merged."""
    pieces: list[str] = []
    for s in re.split(r"(?<=[.!?…])\s+|(?<=[.!?…][\"')\]])\s+", text):
        s = s.strip()
        while len(s) > SENTENCE_MAX:
            cut = max(s.rfind(sep, SENTENCE_MIN, SENTENCE_MAX) for sep in (", ", "; ", ": ", " (", " - "))
            if cut <= 0:
                cut = s.rfind(" ", SENTENCE_MIN, SENTENCE_MAX)
            if cut <= 0:
                cut = SENTENCE_MAX
            pieces.append(s[:cut + 1].strip())
            s = s[cut + 1:].strip()
        if s:
            pieces.append(s)
    out: list[str] = []
    for s in pieces:
        if out and len(out[-1]) < SENTENCE_MIN and len(out[-1]) + 1 + len(s) <= SENTENCE_MAX:
            out[-1] += " " + s
        else:
            out.append(s)
    if len(out) > 1 and len(out[-1]) < SENTENCE_MIN and len(out[-2]) + 1 + len(out[-1]) <= SENTENCE_MAX:
        out[-2] += " " + out.pop()
    if out and len(out[0]) > FIRST_MAX:
        cut = max(out[0].rfind(sep, SENTENCE_MIN, FIRST_MAX) for sep in (". ", "! ", "? ", ", ", "; ", ": ", " - "))
        if cut <= 0:
            cut = out[0].rfind(" ", SENTENCE_MIN, FIRST_MAX)
        if cut > 0 and len(out[0]) - cut > SENTENCE_MIN:
            out[0:1] = [out[0][:cut + 1].strip(), out[0][cut + 1:].strip()]
    return out


def ask_speech(questions: list[dict]) -> str:
    """omp's pending question(s) read aloud with numbered options."""
    n = len(questions)
    parts = [f"omp asks {number_word(n)} questions." if n > 1 else "omp asks:"]
    for qi, q in enumerate(questions):
        if n > 1:
            parts.append(f"Question {number_word(qi + 1)} of {number_word(n)}:")
        parts.append(as_sentence(inline_spoken(q.get("question") or "")))
        opts = [as_sentence(inline_spoken(o.get("label") or "")) for o in q.get("options") or []]
        if opts:
            parts.append("Options: " + " ".join(f"{number_word(k + 1)}, {o}" for k, o in enumerate(opts)))
            if q.get("multi"):
                parts.append("You can pick more than one.")
    parts.append("You can also say other, then your answer.")
    return " ".join(p for p in parts if p)


# ---------------------------------------------------------------- voice: synthesis

class SpeechError(Exception):
    """Synthesis failed; the message is shown to the user."""


class WorkerFailed(SpeechError):
    """The persistent worker died, hung or never started; `omp say` takes over for a while."""


class Cancelled(Exception):
    """The utterance was stopped (say_stop, voice off, disconnect)."""


def tool_binary(name: str, *extra: Path) -> str | None:
    # The systemd user service may not have ~/.bun/bin or ~/.local/bin on its PATH.
    for cand in (shutil.which(name), *(str(p) for p in extra)):
        if cand and os.access(cand, os.X_OK):
            return cand
    return None


def kokoro_runtime() -> Path | None:
    """omp's installed Kokoro runtime dir (newest kokoro-* holding kokoro-js), if any."""
    found = [p.parents[2] for p in (OMP_CACHE / "tts-runtime").glob("kokoro-*/node_modules/kokoro-js/package.json")]
    return max(found, key=lambda p: [int(x) for x in re.findall(r"\d+", p.name)]) if found else None


def cuda_missing(runtime: Path) -> str | None:
    """Why the worker cannot use CUDA on this PC, or None when the pieces are all there: an NVIDIA
    driver, onnxruntime-node's CUDA provider in omp's runtime and the private CUDA/cuDNN libs."""
    if not Path("/dev/nvidiactl").exists():
        return "no NVIDIA driver (/dev/nvidiactl)"
    if not any(runtime.glob("node_modules/onnxruntime-node/bin/napi-v*/linux/x64/libonnxruntime_providers_cuda.so")):
        return "onnxruntime-node has no CUDA provider (libonnxruntime_providers_cuda.so)"
    if not (TTS_CUDA_LIBS / "libcudnn.so.9").exists():
        return f"no CUDA 12/cuDNN 9 libraries in {TTS_CUDA_LIBS}"
    return None


def omp_say_pcm(text: str, voice: str, speed: float) -> tuple[bytes, int]:
    """(mono PCM16, rate) from `omp say --out`: a new process that loads the model every call."""
    with tempfile.TemporaryDirectory(prefix="devdeck-tts-") as tmp:
        src, wav = Path(tmp) / "text.txt", Path(tmp) / "out.wav"
        src.write_text(text)
        try:
            r = subprocess.run([omp_binary(), "say", "-f", str(src), "--voice", voice, "--speed", f"{speed:g}",
                                "--out", str(wav)], stdin=subprocess.DEVNULL, capture_output=True, timeout=TTS_SAY_S)
        except (OSError, subprocess.TimeoutExpired) as ex:
            raise SpeechError(f"omp say: {ex}") from None
        if r.returncode != 0 or not wav.exists():
            msg = (r.stderr or r.stdout).decode(errors="replace").strip().splitlines()
            raise SpeechError(f"omp say failed: {msg[-1] if msg else f'exit {r.returncode}'}")
        with wave.open(str(wav)) as w:
            if w.getsampwidth() != 2 or w.getnchannels() != 1:
                raise SpeechError("omp say wrote an unexpected WAV format")
            return w.readframes(w.getnframes()), w.getframerate()


def encode_opus(pcm: bytes, rate: int) -> bytes:
    """Mono PCM16 to Ogg/Opus (speech-tuned, OPUS_BITRATE) with ffmpeg."""
    ffmpeg = tool_binary("ffmpeg")
    if ffmpeg is None:
        raise SpeechError("ffmpeg is not installed")
    try:
        r = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", str(rate), "-ac", "1",
                            "-i", "pipe:0", "-c:a", "libopus", "-b:a", OPUS_BITRATE, "-application", "voip",
                            "-f", "ogg", "pipe:1"], input=pcm, capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as ex:
        raise SpeechError(f"ffmpeg: {ex}") from None
    if r.returncode != 0 or not r.stdout:
        raise SpeechError(f"ffmpeg failed: {r.stderr.decode(errors='replace').strip()[:300]}")
    return r.stdout


class Speech:
    """Kokoro-82M synthesis for every connection: one sentence at a time (Kokoro already uses all
    cores), Ogg/Opus encoded, cached per (text, voice, speed). The engine is a persistent bun
    worker (tts_worker.ts) that loads omp's model once; it starts on first use (or when voice
    mode turns on), and exits after TTS_IDLE_S unused to give its memory back. It runs on the
    device DEVDECK_TTS_DEVICE names (auto: CUDA when it works, else the CPU, for the rest of
    the daemon's life once CUDA failed). When it cannot start or fails, `omp say --out` (a new
    process per sentence) is used instead."""

    def __init__(self):
        self.lock = threading.Lock()    # the engine; held for one sentence at a time
        self.proc: subprocess.Popen | None = None
        self.buf = bytearray()
        self.used = 0.0
        self.failed = -TTS_RETRY_S      # monotonic time of the last worker failure
        self.wanted = os.environ.get("DEVDECK_TTS_DEVICE", "").strip().lower() or "auto"
        if self.wanted not in TTS_DEVICES:
            log(f"DEVDECK_TTS_DEVICE={self.wanted!r} is not one of {', '.join(TTS_DEVICES)}; using auto")
            self.wanted = "auto"
        self.device = "cpu"             # what the running worker uses
        self.cuda_off: str | None = None  # why auto no longer tries CUDA (it failed once)
        self.warming = False
        self.errlog: collections.deque[str] = collections.deque(maxlen=20)
        self.cache_lock = threading.Lock()
        self.cache: collections.OrderedDict[tuple, tuple[float, bytes, int]] = collections.OrderedDict()
        self.cache_bytes = 0
        threading.Thread(target=self._reaper, daemon=True).start()

    # ------------------------------------------------------------ public

    def synth(self, text: str, voice: str, speed: float, cancel: threading.Event) -> tuple[bytes, int, str]:
        """(ogg, duration ms, engine) of one sentence; engine is "cache", "worker cpu",
        "worker cuda" or "omp say"."""
        key = (text, voice, speed)
        hit = self._cached(key)
        if hit is not None:
            return hit[0], hit[1], "cache"
        while not self.lock.acquire(timeout=0.2):
            if cancel.is_set():
                raise Cancelled()
        try:
            if cancel.is_set():
                raise Cancelled()
            pcm, rate, engine = self._pcm(text, voice, speed)
            self.used = time.monotonic()
        finally:
            self.lock.release()
        ogg = encode_opus(pcm, rate)
        dur = round(len(pcm) / 2 * 1000 / rate)
        self._store(key, ogg, dur)
        return ogg, dur, engine

    def warm(self) -> None:
        """Voice mode is on, or a voice-mode agent is working: have the model loaded by the time a
        reply needs it (and count this as use, so the idle timer does not unload it meanwhile)."""
        self.used = time.monotonic()
        if self.warming or (self.proc is not None and self.proc.poll() is None):
            return
        self.warming = True
        threading.Thread(target=self._warm, daemon=True).start()

    # ------------------------------------------------------------ engine

    def _warm(self) -> None:
        try:
            with self.lock:
                if time.monotonic() - self.failed < TTS_RETRY_S:
                    return
                try:
                    self._worker()
                except WorkerFailed as ex:
                    log(f"tts worker: {ex}")
                    self._stop_worker()
                    self.failed = time.monotonic()
        finally:
            self.warming = False

    def _pcm(self, text: str, voice: str, speed: float) -> tuple[bytes, int, str]:
        if time.monotonic() - self.failed >= TTS_RETRY_S:
            try:
                for _ in range(2):      # a second time only on the CPU after CUDA failed
                    if self._worker() is None:
                        break
                    try:
                        pcm, rate = self._ask_worker(text, voice, speed)
                        return pcm, rate, f"worker {self.device}"
                    except SpeechError as ex:
                        if not self._drop_cuda(ex):
                            raise
            except WorkerFailed as ex:
                log(f"tts worker: {ex}; using omp say for {TTS_RETRY_S:.0f} s")
                self._stop_worker()
                self.failed = time.monotonic()
        pcm, rate = omp_say_pcm(text, voice, speed)
        return pcm, rate, "omp say"

    def _drop_cuda(self, ex: SpeechError) -> bool:
        """auto: a worker running on CUDA died, hung or reported a CUDA error (out of GPU memory
        even after splitting the sentence, say); stop it and use the CPU from now on. False when
        that does not apply."""
        if self.wanted != "auto" or self.device != "cuda" or not (isinstance(ex, WorkerFailed) or re.search(
                r"(?i)cuda|cudnn|cublas|cufft|curand|gpu|failed to allocate", str(ex))):
            return False
        self.cuda_off = f"failed while running: {str(ex)[:300]}"
        log(f"tts worker on CUDA {self.cuda_off}; using the CPU from now on")
        self._stop_worker()
        return True

    def _worker(self) -> subprocess.Popen | None:
        """The running worker, started if needed; None when bun or omp's runtime is missing
        (the first `omp say` installs the runtime)."""
        if self.proc is not None:
            if self.proc.poll() is None:
                return self.proc
            log(f"tts worker exited ({self.proc.returncode}): {self._errtail()}")
            self._stop_worker()
        bun, runtime = tool_binary("bun", Path.home() / ".bun" / "bin" / "bun"), kokoro_runtime()
        if bun is None or runtime is None or not TTS_WORKER.exists():
            return None
        device, why = self.wanted, None
        if device == "auto":
            why = self.cuda_off or cuda_missing(runtime)
            device = "cpu" if why else "cuda"
        start = time.monotonic()
        try:
            head = self._start(bun, runtime, device)
        except WorkerFailed as ex:
            if self.wanted != "auto" or device != "cuda":
                raise
            # The worker reports a CUDA failure and exits (it cannot switch in-process), or crashed.
            self._stop_worker()
            self.cuda_off = why = str(ex)[:300]
            log(f"tts worker on CUDA failed ({why}); starting it on the CPU")
            device = "cpu"
            head = self._start(bun, runtime, device)
        self.device = device
        note = f"; CUDA not used: {why}" if why else ""
        log(f"tts worker ready on {device} in {(time.monotonic() - start) * 1000:.0f} ms "
            f"({head.get('dtype')} model loaded in {head.get('ms')} ms{note})")
        return self.proc

    def _start(self, bun: str, runtime: Path, device: str) -> dict:
        """Start the worker on `device` (cpu|cuda) and return its ready line. Only a CUDA worker
        gets the private CUDA/cuDNN libraries on its LD_LIBRARY_PATH."""
        env = None
        if device == "cuda":
            env = {**os.environ, "LD_LIBRARY_PATH": os.pathsep.join(
                filter(None, [str(TTS_CUDA_LIBS), os.environ.get("LD_LIBRARY_PATH")]))}
        try:
            self.proc = subprocess.Popen([bun, str(TTS_WORKER), str(runtime), str(TTS_WEIGHTS), device], cwd=str(runtime),
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         bufsize=0, start_new_session=True, env=env)
        except OSError as ex:
            raise WorkerFailed(f"cannot start: {ex}") from None
        self.buf = bytearray()
        threading.Thread(target=self._drain, args=(self.proc,), daemon=True).start()
        head = self._read_head(time.monotonic() + TTS_LOAD_S)
        if head.get("ready") is not True:
            raise WorkerFailed(f"{device}: {head.get('error') or f'unexpected first line {head!r}'}")
        return head

    def _ask_worker(self, text: str, voice: str, speed: float) -> tuple[bytes, int]:
        proc = self.proc
        try:
            proc.stdin.write(json.dumps({"text": text, "voice": voice, "speed": speed}).encode() + b"\n")
        except OSError as ex:
            raise WorkerFailed(f"write: {ex}; {self._errtail()}") from None
        deadline = time.monotonic() + TTS_SENTENCE_S
        head = self._read_head(deadline)
        if head.get("ok") is not True:
            raise SpeechError(f"Kokoro: {head.get('error') or head!r}")
        size, rate = head.get("bytes"), head.get("rate")
        if not isinstance(size, int) or not isinstance(rate, int) or size < 0 or rate <= 0:
            raise WorkerFailed(f"bad header {head!r}")
        while len(self.buf) < size:
            self._fill(deadline)
        pcm = bytes(self.buf[:size])
        del self.buf[:size]
        return pcm, rate

    def _fill(self, deadline: float) -> None:
        fd = self.proc.stdout.fileno()
        left = deadline - time.monotonic()
        if left <= 0 or not select.select([fd], [], [], left)[0]:
            raise WorkerFailed(f"no answer in time; {self._errtail()}")
        chunk = os.read(fd, 1 << 16)
        if not chunk:
            raise WorkerFailed(f"exited: {self._errtail()}")
        self.buf += chunk

    def _read_head(self, deadline: float) -> dict:
        while (end := self.buf.find(b"\n")) < 0:
            self._fill(deadline)
        line = bytes(self.buf[:end])
        del self.buf[:end + 1]
        try:
            head = json.loads(line)
        except ValueError:
            head = None
        if not isinstance(head, dict):
            raise WorkerFailed(f"bad output {line[:200]!r}")
        return head

    def _drain(self, proc: subprocess.Popen) -> None:
        for line in proc.stderr:
            text = line.decode(errors="replace").rstrip()
            if text:
                self.errlog.append(text)

    def _errtail(self) -> str:
        return " | ".join(list(self.errlog)[-3:]) or "no error output"

    def _stop_worker(self) -> None:
        proc, self.proc = self.proc, None
        if proc is None:
            return
        try:
            proc.stdin.close()
            proc.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            proc.kill()
            proc.wait()

    def _reaper(self) -> None:
        while True:
            time.sleep(30)
            self._expire()
            if self.proc is not None and time.monotonic() - self.used > TTS_IDLE_S and self.lock.acquire(blocking=False):
                try:
                    if self.proc is not None and time.monotonic() - self.used > TTS_IDLE_S:
                        log(f"tts worker idle for {TTS_IDLE_S:.0f} s, stopping it")
                        self._stop_worker()
                finally:
                    self.lock.release()

    # ------------------------------------------------------------ audio cache

    def _cached(self, key: tuple) -> tuple[bytes, int] | None:
        with self.cache_lock:
            hit = self.cache.get(key)
            if hit is None or hit[0] < time.monotonic():
                return None
            self.cache[key] = (time.monotonic() + AUDIO_CACHE_S, hit[1], hit[2])
            self.cache.move_to_end(key)
            return hit[1], hit[2]

    def _store(self, key: tuple, ogg: bytes, dur: int) -> None:
        with self.cache_lock:
            old = self.cache.pop(key, None)
            if old is not None:
                self.cache_bytes -= len(old[1])
            self.cache[key] = (time.monotonic() + AUDIO_CACHE_S, ogg, dur)
            self.cache_bytes += len(ogg)
            while self.cache_bytes > AUDIO_CACHE_BYTES:
                _, (_, data, _) = self.cache.popitem(last=False)
                self.cache_bytes -= len(data)

    def _expire(self) -> None:
        now = time.monotonic()
        with self.cache_lock:
            while self.cache:
                key, (expires, data, _) = next(iter(self.cache.items()))
                if expires >= now:
                    break
                del self.cache[key]
                self.cache_bytes -= len(data)


# ---------------------------------------------------------------- live: GPT Live voice calls

# Replicates omp 18.12.6's /live (packages/coding-agent/src/live/): the phone holds the WebRTC
# call, the daemon signals it with omp's ChatGPT login and drives the sideband WebSocket.
LIVE_MODEL = "gpt-live-1-codex"
LIVE_VOICES = ("arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale")
LIVE_VOICE = "sol"
LIVE_MODES = ("concierge", "direct")
LIVE_SIGNAL_HOST = "chatgpt.com"
LIVE_SIGNAL_PATH = "/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas"
LIVE_SIDEBAND_HOST = "api.openai.com"
CODEX_VERSION = "0.159.0"     # the Codex Desktop version omp presents
CODEX_ORIGINATOR = "Codex Desktop"
CODEX_DB = Path.home() / ".omp" / "agent" / "agent.db"  # omp's credential store; only ever read
LIVE_CALL_RE = re.compile(r"^rtc_[\w-]+$")
LIVE_SIGNAL_S = 30.0
LIVE_CONNECT_TRIES = 5
LIVE_CONNECT_S = 15.0
LIVE_PING_S = 15.0           # sideband ping after this long without a frame ...
LIVE_SILENT_S = 45.0         # ... and the call is taken as dead after this long
LIVE_CHUNK_BYTES = 500       # per context append
LIVE_FINAL_CAP = 6000        # characters of a final reply handed to the voice model
LIVE_GONE_S = 60.0           # the call ends this long after the phone's link is gone
LIVE_TICK_S = 0.5            # delegation progress is read this often
LIVE_NOTICE_GAP_S = 20.0     # at most one proactive notice per this long (merged)
LIVE_REJECT_S = 5.0          # an error this soon after the first session.context.append rejects it
LIVE_START_S = 3.0           # no session.started this long after the sideband connected: it came before
LIVE_NOTICE_CHANNEL = "speakable"  # notices are spoken at the next pause (verified: with or without a channel)
WS_MAX = 16 << 20
# Sideband events the daemon has no use for (audio both ways, user-turn deltas that
# input_transcript.added repeats, acknowledgements, usage); others are logged once per call.
LIVE_QUIET_EVENTS = {"session.updated", "output_audio.delta", "session.input_audio.append",
                     "session.output_audio.delta", "turn.created", "turn.delta", "session.context.appended",
                     "delegation.context.appended", "session.usage.updated"}
CONCIERGE_SESSION = os.environ.get("DEVDECK_CONCIERGE_SESSION") or "devdeck-voice"
CONCIERGE_DIR = Path.home() / ".local" / "share" / "devdeck" / "concierge"
CONCIERGE_AGENTS = HERE / "concierge" / "AGENTS.md"
CONCIERGE_MODEL = "anthropic/claude-haiku-4-5:low"  # DEVDECK_CONCIERGE_MODEL: provider/id[:level]
CONCIERGE_READY_S = 30.0

LIVE_INSTRUCTIONS = """You: DevDeck Live, realtime voice surface of one assistant for {firstName} (OS account: {username}) that runs the coding agents and terminals on their laptop.

<conventions>
RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` = `MUST NOT`.
</conventions>

<critical>
- You + client backend: one assistant, not separate agents.
- MUST delegate everything about the user's terminals, coding agents, repositories, files, commands, status, progress and verification to client backend; NEVER guess what a terminal is doing.
- MUST keep conversation natural while client backend works.
</critical>

User speaks to you from their phone, often on the move with earbuds. MUST respond directly, briefly, conversationally, with speech-friendly phrasing. NEVER use markdown, code blocks, long lists, file paths, or read implementation detail aloud unless requested.

Client backend: same assistant's execution surface on the laptop. Usually a fast concierge that sees every terminal: lists them, reads their status and last replies, gives them tasks, stops them, switches their models, answers their questions, opens new ones, and switches who you talk to. In direct mode it is the coding agent in one terminal. Status questions, coding tasks, terminal control, answers to an agent's question → MUST promptly create client delegation with complete plain-language request and all relevant conversational context (which terminal or project, what exactly); NEVER attempt tool work. New request during active work MUST create new delegation.

Treat delegation context as own internal progress/results. NEVER describe backend as another assistant. MAY briefly acknowledge active work; NEVER claim changes, findings, or verification before backend reports. Commentary context: silent progress for conversational continuity; NEVER recite. Context beginning with `"Agent Final Message":`: backend's final visible answer; MUST present useful result naturally and briefly as own, NEVER mention label, protocol, delegation, or backend. Context beginning with `Notice:`: news from the user's other terminals (an agent finished or is asking something); tell the user briefly at the next natural pause, without interrupting them. Context beginning with `Routing:`: who your delegations now reach; NEVER recite.

Greetings, clarification, thinking out loud, design discussion, ordinary conversation needing no terminals: MUST answer directly without delegation. MUST ask concise clarifying question only when execution request genuinely underspecified.

<critical>
MUST preserve one-assistant continuity: converse here, delegate execution, communicate returned result as own.
</critical>
"""


class LiveError(Exception):
    """A live call failed or could not start; the message is shown (and may be spoken)."""


def codex_credentials() -> list[dict]:
    """omp's enabled ChatGPT (openai-codex) OAuth logins valid for at least another minute, most
    recently updated first: [{access, accountId}]. Read-only: refreshing rotates the refresh
    token, which only omp may do."""
    try:
        db = sqlite3.connect(f"file:{CODEX_DB}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error as ex:
        log(f"live: {CODEX_DB}: {ex}")
        return []
    try:
        rows = db.execute("SELECT data FROM auth_credentials WHERE provider = 'openai-codex' AND "
                          "credential_type = 'oauth' AND disabled_cause IS NULL "
                          "ORDER BY updated_at DESC, id DESC").fetchall()
    except sqlite3.Error as ex:
        log(f"live: {CODEX_DB}: {ex}")
        rows = []
    finally:
        db.close()
    fresh = time.time() * 1000 + 60_000
    out = []
    for (data,) in rows:
        try:
            d = json.loads(data)
        except (TypeError, ValueError):
            continue
        if (isinstance(d, dict) and isinstance(d.get("access"), str) and d["access"]
                and isinstance(d.get("expires"), (int, float)) and d["expires"] > fresh):
            out.append({"access": d["access"], "accountId": d["accountId"] if isinstance(d.get("accountId"), str) else None})
    return out


def codex_logins() -> list[dict]:
    """codex_credentials(); when all have expired, `omp token openai-codex` (which refreshes an
    expired login the way omp itself does; the token it prints is discarded) runs once first."""
    creds = codex_credentials()
    if creds:
        return creds
    try:
        subprocess.run([omp_binary(), "token", "openai-codex"], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as ex:
        log(f"live: omp token: {ex}")
    creds = codex_credentials()
    if not creds:
        raise LiveError("omp's ChatGPT login has expired; open omp once so it refreshes")
    return creds


def live_headers(cred: dict, session_id: str, call_session: str) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {cred['access']}", "OpenAI-Alpha": "quicksilver=v2",
               "User-Agent": f"{CODEX_ORIGINATOR}/{CODEX_VERSION}", "x-session-id": call_session,
               "originator": CODEX_ORIGINATOR, "version": CODEX_VERSION, "session-id": session_id,
               "thread-id": session_id}
    if cred["accountId"]:
        headers["chatgpt-account-id"] = cred["accountId"]
    return headers


def live_instructions() -> str:
    try:
        username = pwd.getpwuid(os.getuid()).pw_name.strip() or "user"
    except KeyError:
        username = "user"
    first = next((p for p in re.split(r"[._\-\s]+", username) if p), "there")
    return LIVE_INSTRUCTIONS.replace("{firstName}", first).replace("{username}", username)


def live_signal(sdp: str, voice: str, headers: dict[str, str]) -> tuple[int, str, str]:
    """POST the phone's SDP offer: (HTTP status, body = the SDP answer, Location header)."""
    body = json.dumps({"sdp": sdp, "session": {"model": LIVE_MODEL, "instructions": live_instructions(),
                                               "audio": {"output": {"voice": voice}},
                                               "delegation": {"type": "client"}}}).encode()
    conn = http.client.HTTPSConnection(LIVE_SIGNAL_HOST, timeout=LIVE_SIGNAL_S, context=ssl.create_default_context())
    try:
        conn.request("POST", LIVE_SIGNAL_PATH, body=body,
                     headers={**headers, "Accept": "*/*", "Content-Type": "application/json"})
        r = conn.getresponse()
        return r.status, r.read(1 << 20).decode(errors="replace"), r.getheader("Location") or ""
    finally:
        conn.close()


def live_call_id(location: str) -> str | None:
    return next((s for s in location.split("?", 1)[0].split("/") if LIVE_CALL_RE.match(s)), None)


def live_chunks(text: str) -> list[str]:
    """`text` split at character boundaries into pieces of at most LIVE_CHUNK_BYTES UTF-8 bytes."""
    out, cur, size = [], [], 0
    for ch in text:
        n = len(ch.encode("utf-8", "surrogatepass"))
        if size + n > LIVE_CHUNK_BYTES:
            out.append("".join(cur))
            cur, size = [], 0
        cur.append(ch)
        size += n
    out.append("".join(cur))
    return out


def first_sentence(md: str, limit: int = 200) -> str:
    spoken = spoken_text(md, 1000)
    m = re.match(r"(.+?[.!?])(?:\s|$)", spoken, re.S)
    s = (m.group(1) if m else spoken).strip()
    return s if len(s) <= limit else s[:limit].rsplit(" ", 1)[0] + "..."


def ask_summary(ask: dict) -> str:
    qs = ask["questions"]
    q = qs[0]
    s = q["question"].strip()
    if q["options"]:
        s += " Options: " + ", ".join(o["label"] for o in q["options"]) + "."
    if len(qs) > 1:
        s += f" (and {len(qs) - 1} more question{'s' if len(qs) > 2 else ''})"
    return s


def match_option(text: str, labels: list[str]) -> str | None:
    """The option label a spoken answer names: exact, else the only one contained in it (or
    containing it); None means a custom answer."""
    def norm(s: str) -> str:
        return " ".join(re.sub(r"[^\w]+", " ", s.lower()).split())
    t = norm(text)
    exact = [lb for lb in labels if norm(lb) == t]
    if exact:
        return exact[0]
    hits = [lb for lb in labels if norm(lb) and (f" {norm(lb)} " in f" {t} " or f" {t} " in f" {norm(lb)} ")]
    return hits[0] if len(hits) == 1 else None


def concierge_model() -> tuple[str, str]:
    raw = (os.environ.get("DEVDECK_CONCIERGE_MODEL") or CONCIERGE_MODEL).strip()
    sel, sep, level = raw.rpartition(":")
    return (sel, level) if sep and level in THINKING_LEVELS else (raw, "low")


def start_concierge(ctl_path: Path) -> str | None:
    """Create the concierge's tmux session (omp with a fast model in CONCIERGE_DIR, which gets the
    repo's concierge/AGENTS.md); None on success, else the error."""
    CONCIERGE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        want = CONCIERGE_AGENTS.read_bytes()
        dest = CONCIERGE_DIR / "AGENTS.md"
        if not dest.exists() or dest.read_bytes() != want:
            dest.write_bytes(want)
    except OSError as ex:
        log(f"concierge: AGENTS.md: {ex}")
    model, level = concierge_model()
    # Separate argv, no shell; tmux takes PATH from its client rather than from -e, so `env`
    # puts the repo (ddctl) on omp's PATH.
    r = tmux_new_session(CONCIERGE_SESSION, "-c", str(CONCIERGE_DIR), "-e", f"DEVDECK_CTL={ctl_path}",
                         "env", f"PATH={HERE}{os.pathsep}{os.environ.get('PATH', '')}", f"DEVDECK_CTL={ctl_path}",
                         omp_binary(), "--model", model, "--thinking", level, "--tools", "bash,read", "--no-skills",
                         "--no-title")
    if r.returncode != 0:
        return tmux_error(r)
    log(f"concierge: started {CONCIERGE_SESSION} ({model}, thinking {level})")
    return None


class WebSocketRefused(ConnectionError):
    def __init__(self, status: int, detail: str):
        super().__init__(f"HTTP {status}" + (f": {detail}" if detail else ""))
        self.status = status


class WebSocket:
    """Minimal RFC 6455 client over TLS (stdlib only) for one thread: masked frames out, text,
    binary, fragmented and control frames in, no extensions. read() waits at most 1 s."""

    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    def __init__(self, host: str, path: str, headers: dict[str, str], timeout: float):
        raw = socket.create_connection((host, 443), timeout=timeout)
        try:
            self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        except BaseException:
            raw.close()
            raise
        self.buf = bytearray()
        self.frag_op: int | None = None
        self.frag: list[bytes] = []
        self.close_sent = False
        try:
            self._handshake(host, path, headers)
        except BaseException:
            self.sock.close()
            raise
        self.sock.settimeout(1.0)

    def _handshake(self, host: str, path: str, headers: dict[str, str]) -> None:
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        head = [f"GET {path} HTTP/1.1", f"Host: {host}", "Upgrade: websocket", "Connection: Upgrade",
                f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13", *(f"{k}: {v}" for k, v in headers.items())]
        self.sock.sendall(("\r\n".join(head) + "\r\n\r\n").encode())
        while (end := self.buf.find(b"\r\n\r\n")) < 0:
            if len(self.buf) > 65536:
                raise ConnectionError("oversized handshake response")
            self._recv()
        lines = bytes(self.buf[:end]).decode("latin-1").split("\r\n")
        del self.buf[:end + 4]
        fields = {}
        for ln in lines[1:]:
            k, _, v = ln.partition(":")
            fields[k.strip().lower()] = v.strip()
        status = lines[0].split(" ", 2)
        code = int(status[1]) if len(status) > 1 and status[1].isdigit() else 0
        if code != 101:
            length = fields.get("content-length", "")
            want = min(int(length), 2048) if length.isdigit() else 0
            try:
                while len(self.buf) < want:
                    self._recv()
            except OSError:
                pass
            raise WebSocketRefused(code, " ".join(bytes(self.buf[:2048]).decode(errors="replace").split()))
        accept = base64.b64encode(hashlib.sha1((key + self.GUID).encode()).digest()).decode()
        if fields.get("sec-websocket-accept") != accept:
            raise ConnectionError("bad Sec-WebSocket-Accept")

    def _recv(self) -> None:
        data = self.sock.recv(1 << 16)
        if not data:
            raise ConnectionError("connection closed by the server")
        self.buf += data

    def fileno(self) -> int:
        return self.sock.fileno()

    def pending(self) -> int:
        """Decrypted bytes the TLS layer holds (select() does not see them)."""
        return self.sock.pending()

    def read(self) -> None:
        try:
            self._recv()
        except TimeoutError:  # a partial TLS record; the rest comes with the next read
            pass

    def send(self, op: int, payload: bytes = b"") -> None:
        n = len(payload)
        head = bytearray([0x80 | op])
        if n < 126:
            head.append(0x80 | n)
        elif n < 1 << 16:
            head.append(0x80 | 126)
            head += n.to_bytes(2, "big")
        else:
            head.append(0x80 | 127)
            head += n.to_bytes(8, "big")
        mask = secrets.token_bytes(4)
        self.sock.sendall(bytes(head) + mask + ws_mask(payload, mask))
        if op == 8:
            self.close_sent = True

    def messages(self) -> list[tuple[int, bytes]]:
        """Complete messages (op, payload) in the buffer: text/binary (fragments joined) and
        control frames (ping 9, pong 10, close 8)."""
        out = []
        b = self.buf
        while len(b) >= 2:
            op, fin, masked, n, i = b[0] & 0x0F, b[0] & 0x80, b[1] & 0x80, b[1] & 0x7F, 2
            if n == 126:
                if len(b) < 4:
                    break
                n, i = int.from_bytes(b[2:4], "big"), 4
            elif n == 127:
                if len(b) < 10:
                    break
                n, i = int.from_bytes(b[2:10], "big"), 10
            if n > WS_MAX:
                raise ConnectionError(f"oversized frame ({n} bytes)")
            key = b""
            if masked:
                key, i = bytes(b[i:i + 4]), i + 4
            if len(b) < i + n:
                break
            payload = bytes(b[i:i + n])
            del b[:i + n]
            if masked:
                payload = ws_mask(payload, key)
            if op >= 8:
                out.append((op, payload))
                continue
            if op:
                self.frag_op, self.frag = op, [payload]
            elif self.frag_op is None:
                raise ConnectionError("continuation frame without a message")
            else:
                self.frag.append(payload)
            if fin:
                out.append((self.frag_op, b"".join(self.frag)))
                self.frag_op, self.frag = None, []
        return out

    def close(self) -> None:
        if not self.close_sent:
            try:
                self.send(8, (1000).to_bytes(2, "big"))
            except OSError:
                pass
        try:
            self.sock.close()
        except OSError:
            pass


def ws_mask(data: bytes, mask: bytes) -> bytes:
    n = len(data)
    if not n:
        return b""
    return (int.from_bytes(data, "big") ^ int.from_bytes((mask * (n // 4 + 1))[:n], "big")).to_bytes(n, "big")


class LiveSession:
    """The daemon's one GPT Live call (README "Live"). The phone holds the WebRTC call (audio
    goes straight to OpenAI); this side signals it with omp's ChatGPT login and attaches the
    sideband WebSocket (one I/O thread). The call's events reach the daemon through the phone,
    which relays its data channel (`live_event`, and `live_send` back); the sideband carries them
    only for an app without the relay. Delegations are routed into a terminal; their progress,
    final replies and the other terminals' news go back into the call. A tick thread reads the
    routed pane's session file and ends the call when the phone stays away."""

    def __init__(self, server: Server, ctl: Control, req: str, sdp: str, voice: str, mode: str, target: str | None):
        self.server, self.ctl, self.client = server, ctl, ctl.client
        self.req, self.offer, self.voice = req, sdp, voice
        self.mode, self.target = mode, target
        self.lock = threading.RLock()
        self.route_lock = threading.Lock()
        self.session_id, self.call_session = str(uuid.uuid4()), str(uuid.uuid4())
        self.call_id: str | None = None
        self.phase = "connecting"
        self.answered = False      # the phone got the SDP answer
        self.started = False       # session.started came
        self.speaking = False
        self.ended = False
        self.ws: WebSocket | None = None
        self.out: collections.deque[dict] = collections.deque()  # sideband messages to send
        self.wake_r, self.wake_w = socket.socketpair()
        self.deleg: dict | None = None  # {id, text, target, mode, path, after, ask}
        self.turns = {"user": [0, "", False], "assistant": [0, "", False]}  # turn, text, final
        self.gone_at: float | None = None
        self.ctx_ok: bool | None = None       # whether session.context.append is accepted
        self.ctx_probe: float | None = None   # when the first one was sent
        self.ctx_pending: list[str] = []      # notices in that first one, re-routed if it is rejected
        self.notices: list[str] = []
        self.notice_at = 0.0
        self.held: list[str] = []             # notices for the next final reply
        self.seen: dict[str, tuple] = {}      # pane target -> (state, final reply id, ask id)
        self.unknown: set[str] = set()
        self.sideband_at: float | None = None  # when the sideband connected (session.started fallback)
        self.counts = {"user": 0, "assistant": 0, "delegation": 0}  # finished turns, delegations
        self.audio_ms = 0                      # session.usage.updated audio_duration_ms
        self.relay = False                     # events come from the phone's data channel (relayed)
        self.seen_ids: set[str] = set()        # item/turn ids handled (both sources overlap at the switch)

    # ------------------------------------------------------------ phone side

    def push(self, msg: dict) -> None:
        """To every connection of the phone that started the call."""
        with self.server.ctl_cond:
            ctls = {c for c in self.server.controls if self.client and c.client == self.client}
        ctls.add(self.ctl)
        for c in ctls:
            c.push(msg)

    def state(self, error: str | None = None) -> dict:
        with self.lock:
            msg = {"t": "live", "phase": self.phase, "mode": self.mode}
            if self.mode == "direct" and self.target:
                msg["target"] = self.target
            if self.call_id:
                msg["callId"] = self.call_id
        if error:
            msg["error"] = error
        return msg

    def set_phase(self) -> None:
        with self.lock:
            if self.ended or not self.started:
                return
            phase = "working" if self.deleg else "speaking" if self.speaking else "listening"
            if phase == self.phase:
                return
            self.phase = phase
        self.push(self.state())

    def end(self, error: str | None = None, notify: bool = True) -> None:
        """End the call: session.close goes out on the sideband (the I/O thread then closes it),
        and the phone is told (`ended`, or `error`)."""
        with self.lock:
            if self.ended:
                return
            self.ended = True
            self.phase = "error" if error else "ended"
            self.out.append({"type": "session.close"})
        self.wake()
        with self.server.live_lock:
            if self.server.live is self:
                self.server.live = None
        log(f"live: call {self.call_id or '-'} ended" + (f": {error}" if error else "") +
            f" ({self.counts['user']} user turns, {self.counts['assistant']} replies, "
            f"{self.counts['delegation']} delegations, usage audio {self.audio_ms / 1000:.0f} s, "
            f"events via {'phone relay' if self.relay else 'sideband'})")
        if notify:
            self.push(self.state(error))

    # ------------------------------------------------------------ connection

    def run(self) -> None:
        try:
            self.connect()
        except LiveError as ex:
            log(f"live: {ex}")
            if not self.answered:
                self.push({"t": "error", "req": self.req, "error": str(ex)})
            self.end(str(ex))
            self.close_wake()
            return
        threading.Thread(target=self.tick_loop, daemon=True).start()
        self.io_loop()

    def connect(self) -> None:
        if self.mode == "concierge":
            self.server.concierge(start=True)
        # the login that worked last goes first; a refused one (expired: 401/403, an account
        # without GPT Live such as a free plan: 404) hands over to the next
        creds = sorted(codex_logins(), key=lambda c: c["accountId"] != self.server.live_account)
        status, body, location, cred, refused = 0, "", "", creds[0], []
        for cred in creds:
            try:
                status, body, location = live_signal(self.offer, self.voice,
                                                     live_headers(cred, self.session_id, self.call_session))
            except (OSError, http.client.HTTPException) as ex:
                raise LiveError(f"cannot reach ChatGPT: {ex}") from None
            if status not in (401, 403, 404):
                break
            refused.append(status)
            log(f"live: ChatGPT account {(cred['accountId'] or '?')[:8]} refused the call (HTTP {status})")
        detail = " ".join(body.split())[:300]
        if status in (401, 403):
            raise LiveError(f"ChatGPT refused omp's login (HTTP {status}); open omp once so it refreshes")
        if status == 404 and len(refused) == len(creds):
            raise LiveError("none of omp's ChatGPT logins can use GPT Live (HTTP 404); it needs a paid plan")
        if not 200 <= status < 300:
            raise LiveError(f"GPT Live refused the call (HTTP {status}): {detail}")
        self.server.live_account = cred["accountId"]
        call = live_call_id(location)
        if not call or not body.strip():
            raise LiveError(f"GPT Live answered without {'a call id' if not call else 'an SDP answer'} (HTTP {status})")
        with self.lock:
            if self.ended:
                raise LiveError("stopped")
            self.call_id = call
        log(f"live: signalled call {call} (HTTP {status}, Location {location})")
        self.push({"t": "live_answer", "req": self.req, "sdp": body, "callId": call})
        self.answered = True
        self.push(self.state())
        headers = live_headers(cred, self.session_id, self.call_session)
        path = "/v1/live/" + urllib.parse.quote(call, safe="")
        last: Exception | None = None
        for attempt in range(LIVE_CONNECT_TRIES):
            if self.ended:
                raise LiveError("stopped")
            try:
                ws = WebSocket(LIVE_SIDEBAND_HOST, path, headers, LIVE_CONNECT_S)
                break
            except (OSError, ConnectionError) as ex:
                last = ex
                log(f"live: sideband attempt {attempt + 1} failed: {ex}")
            if attempt + 1 < LIVE_CONNECT_TRIES:
                time.sleep(0.5 * 2 ** attempt)
        else:
            raise LiveError(f"GPT Live control channel failed: {last}")
        with self.lock:
            if self.ended:
                ws.close()
                raise LiveError("stopped")
            self.ws, self.sideband_at = ws, time.monotonic()
        log(f"live: sideband connected ({call})")

    def send(self, msg: dict) -> None:
        """To the call: through the phone's data channel while the relay runs and the phone is
        here, else on the sideband."""
        with self.lock:
            if self.ended:
                return
            ctl = self.ctl if self.relay and self.gone_at is None else None
            if ctl is None:
                self.out.append(msg)
        if ctl is not None:
            ctl.push({"t": "live_send", "callId": self.call_id, "msg": msg})
        else:
            self.wake()

    def relayed(self, data: bytes) -> None:
        """An event from the phone's data channel (Server.live_event). The first one makes the
        relay the call's event source and outlet; the sideband then stays attached (the server
        only delegates with one) but unread: its base64 audio mirror (64 KB/s each way) outruns a
        slow laptop link, and everything else in it came late."""
        with self.lock:
            first, self.relay = not self.relay, True
        if first:
            log("live: events now come over the phone's data channel")
            self.wake()
        self.on_event(data)

    def wake(self) -> None:
        try:
            self.wake_w.send(b"x")
        except OSError:
            pass

    def close_wake(self) -> None:
        for s in (self.wake_r, self.wake_w):
            s.close()

    def io_loop(self) -> None:
        ws, error = self.ws, None
        rx, pinged = time.monotonic(), False
        try:
            while True:
                while True:
                    with self.lock:
                        msg = self.out.popleft() if self.out else None
                    if msg is None:
                        break
                    ws.send(1, json.dumps(msg, ensure_ascii=False, separators=(",", ":")).encode())
                    if msg["type"] == "session.close":
                        return
                relay = self.relay
                if not relay:
                    for op, data in ws.messages():
                        rx, pinged = time.monotonic(), False
                        if op == 1 and not self.relay:
                            self.on_event(data)
                        elif op == 9:
                            ws.send(10, data)
                        elif op == 8:
                            code = int.from_bytes(data[:2], "big") if len(data) >= 2 else 1005
                            reason = data[2:].decode(errors="replace")
                            raise ConnectionError(f"GPT Live closed the call ({code}{': ' + reason if reason else ''})")
                if self.out:
                    continue
                if not relay and ws.pending():
                    ws.read()
                    continue
                r, _, _ = select.select([self.wake_r] if relay else [ws, self.wake_r], [], [], LIVE_PING_S / 3)
                if self.wake_r in r:
                    self.wake_r.recv(4096)
                if relay:
                    continue
                if ws in r:
                    ws.read()
                    continue
                idle = time.monotonic() - rx
                if idle > LIVE_SILENT_S:
                    raise ConnectionError("GPT Live stopped answering")
                if idle > LIVE_PING_S and not pinged:
                    ws.send(9, b"devdeck")
                    pinged = True
        except (OSError, ConnectionError) as ex:
            error = str(ex) or type(ex).__name__
        finally:
            ws.close()
            if error:
                self.end(error)
            self.close_wake()

    # ------------------------------------------------------------ voice model events

    def on_started(self, how: str) -> None:
        """The call is up: phase and the hello context. Once, on session.started, or from the tick
        when that event fired before the sideband connected (it is not repeated then)."""
        with self.lock:
            if self.started or self.ended:
                return
            self.started = True
        log(f"live: call {self.call_id} started ({how})")
        self.set_phase()
        self.hello()

    def on_event(self, data: bytes) -> None:
        try:
            ev = json.loads(data)
        except ValueError:
            return
        if not isinstance(ev, dict):
            return
        t = ev.get("type")
        if t in ("input_transcript.added", "output_transcript.added", "delegation.created", "turn.done"):
            part = ev.get("turn" if t == "turn.done" else "item")
            key = part.get("id") if isinstance(part, dict) else None
            if isinstance(key, str):
                with self.lock:
                    if key in self.seen_ids:
                        return
                    self.seen_ids.add(key)
        if t == "session.started":
            self.on_started(f"session.started {((ev.get('session') or {}).get('id'))}")
        elif t in ("input_transcript.added", "output_transcript.added"):
            item = ev.get("item") if isinstance(ev.get("item"), dict) else {}
            role = "user" if t[0] == "i" else "assistant"
            if role == "assistant":
                with self.lock:
                    self.speaking = True
            self.transcript(role, item.get("text"), False)
            self.set_phase()
        elif t == "turn.done":
            turn = ev.get("turn") if isinstance(ev.get("turn"), dict) else {}
            role = turn.get("role")
            if role in ("user", "assistant"):
                said = turn.get("transcript")
                with self.lock:
                    self.counts[role] += 1
                log(f"live: {role}: {' '.join(said.split())[:200]!r}" if isinstance(said, str) else f"live: {role}: -")
                self.transcript(role, said, True)
                if role == "assistant":
                    with self.lock:
                        self.speaking = False
                    self.set_phase()
        elif t == "session.usage.updated":
            usage = ev.get("usage") if isinstance(ev.get("usage"), dict) else {}
            if isinstance(usage.get("audio_duration_ms"), (int, float)):
                with self.lock:
                    self.audio_ms = int(usage["audio_duration_ms"])
        elif t == "delegation.created":
            self.on_delegation(ev.get("item"))
        elif t == "error":
            err = ev.get("error")
            msg = ev.get("message") if isinstance(ev.get("message"), str) else \
                err.get("message") if isinstance(err, dict) and isinstance(err.get("message"), str) else \
                json.dumps(err) if err is not None else "unknown error"
            self.on_error(msg)
        elif t not in LIVE_QUIET_EVENTS and t not in self.unknown:
            self.unknown.add(t)
            log(f"live: event {t}: {data[:300].decode(errors='replace')}")

    def transcript(self, role: str, text, final: bool) -> None:
        """omp's transcript coalescing: incremental pieces (cumulative or deltas) grow a role's
        current turn; one after its final (turn.done) starts the next turn."""
        if not isinstance(text, str) or not text:
            return
        with self.lock:
            turn, cur, was = self.turns[role]
            if not final:
                if not cur:
                    turn, nxt = turn + 1, text
                elif was:
                    if text == cur or cur.endswith(text):
                        return
                    turn, nxt = turn + 1, text
                elif text.startswith(cur):
                    nxt = text
                elif cur.endswith(text):
                    nxt = cur
                else:
                    nxt = cur + text
            else:
                if not cur:
                    turn += 1
                elif was:
                    if text == cur:
                        return
                    turn += 1
                nxt = cur if not was and cur.startswith(text) and len(cur) > len(text) else text
            if [turn, nxt, final] == self.turns[role]:
                return
            self.turns[role] = [turn, nxt, final]
        if nxt.strip():
            self.push({"t": "live_transcript", "role": role, "turn": turn, "text": nxt.strip(), "final": final})

    def on_error(self, message: str) -> None:
        with self.lock:
            probe = self.ctx_probe is not None and time.monotonic() - self.ctx_probe < LIVE_REJECT_S
            if probe:
                self.ctx_ok, self.ctx_probe = False, None
                pending, self.ctx_pending = self.ctx_pending, []
        if probe:
            log(f"live: session.context.append rejected: {message}")
            for text in pending:
                self.notice_fallback(text)
            return
        log(f"live: error event: {message}")
        self.end(message)

    # ------------------------------------------------------------ context into the call

    def append(self, did: str, text: str, channel: str | None = None) -> None:
        for chunk in live_chunks(text):
            self.send({"type": "delegation.context.append", "delegation_item_id": did,
                       **({"channel": channel} if channel else {}), "content": [{"type": "input_text", "text": chunk}]})

    def final(self, did: str, text: str) -> None:
        with self.lock:
            held, self.held = self.held, []
        text = text.strip()
        if len(text) > LIVE_FINAL_CAP:
            text = text[:LIVE_FINAL_CAP].rstrip() + "\n\n(The rest is on screen.)"
        if held:
            text += "\n\n" + "\n".join(held)
        self.append(did, '"Agent Final Message":\n\n' + text)

    def context(self, text: str, channel: str | None = None, notice: bool = False) -> bool:
        """session.context.append unless known to be rejected (False then). The first one is a
        probe: an error within LIVE_REJECT_S marks the message type unsupported, and its notices
        are re-routed."""
        with self.lock:
            if self.ctx_ok is False:
                return False
            if self.ctx_ok is None:
                if self.ctx_probe is None:
                    self.ctx_probe = time.monotonic()
                if notice:
                    self.ctx_pending.append(text)
        for chunk in live_chunks(text):
            self.send({"type": "session.context.append", **({"channel": channel} if channel else {}),
                       "content": [{"type": "input_text", "text": chunk}]})
        return True

    def routing_text(self) -> str:
        with self.lock:
            mode, target = self.mode, self.target
        if mode == "direct":
            return (f"Routing: your delegations now go straight to the coding agent in terminal {target}; "
                    "it only knows its own project.")
        return "Routing: your delegations go to the concierge, which sees and controls all terminals."

    def hello(self) -> None:
        """First context of the call (and the session.context.append probe): routing and the
        terminals that run agents."""
        with self.server.ctl_cond:
            panes = list(self.server.panes or [])
        agents = [f"{p['target']} ({p['state']}{', ' + p['cwd'].replace(HOME, '~') if p.get('cwd') else ''})"
                  for p in panes if p["agent"] and p["session"] != CONCIERGE_SESSION]
        self.context(self.routing_text() + (" Agent terminals: " + "; ".join(agents) + "." if agents else ""))

    def notice(self, target: str, kind: str, text: str) -> None:
        self.push({"t": "live_notice", "text": text, "target": target, "kind": kind})
        log(f"live: notice {text[:120]}")
        with self.lock:
            self.notices.append(text)

    def flush_notices(self) -> None:
        now = time.monotonic()
        with self.lock:
            if not self.notices or not self.started or now - self.notice_at < LIVE_NOTICE_GAP_S:
                return
            text = "Notice: " + " ".join(n if n.endswith((".", "?", "!", ")")) else n + "." for n in self.notices)
            self.notices, self.notice_at = [], now
        if not self.context(text, LIVE_NOTICE_CHANNEL, notice=True):
            self.notice_fallback(text)

    def notice_fallback(self, text: str) -> None:
        """Commentary on the running delegation, else held for the next final reply."""
        with self.lock:
            d = self.deleg
            if d is None:
                self.held.append(text)
                return
        self.append(d["id"], text, "commentary")

    def set_mode(self, mode: str, target: str | None) -> None:
        with self.lock:
            if (mode, target) == (self.mode, self.target):
                return
            self.mode, self.target = mode, target
            started = self.started
        self.push(self.state())
        if started and not self.context(self.routing_text()):
            with self.lock:
                self.held.append(self.routing_text())

    # ------------------------------------------------------------ delegations

    def on_delegation(self, item) -> None:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            return
        text = "\n".join(c["text"] for c in item.get("content") or [] if isinstance(c, dict)
                         and c.get("type") == "input_text" and isinstance(c.get("text"), str)).strip()
        if not text:
            return
        with self.lock:
            mode, target = self.mode, self.target
            self.counts["delegation"] += 1
        log(f"live: delegation {item['id']} ({mode}): {text[:200]!r}")
        threading.Thread(target=self.route, args=(item["id"], text, mode, target), daemon=True).start()

    def route(self, did: str, text: str, mode: str, target: str | None) -> None:
        """Paste the delegation into the concierge (verbatim) or the direct terminal ("[voice] "
        prefix; a spoken answer when it asks), then follow that pane for this delegation."""
        with self.route_lock:
            try:
                if mode == "concierge":
                    target = self.server.concierge(start=True, wait=True)
                info = pane_info(target or "")
                if isinstance(info, str):
                    raise LiveError(f"terminal {target}: {info}")
                target = info["target"]
                if not info["agent"]:
                    raise LiveError(f"terminal {target} is not running omp")
                tr = self.server.pane_transcript(info)
                if tr is not None:
                    tr.refresh(force=True)
                ask = tr.pending_ask() if tr is not None else None
                path, after = (tr.path, tr.branch_end()) if tr is not None else (None, None)
                if ask is not None:
                    if mode == "concierge":
                        raise LiveError("the concierge waits on a question on the PC; answer it there")
                    self.answer(target, ask, text)
                else:
                    err = deliver_text("live-" + did, target, text if mode == "concierge" else f"[voice] {text}", True)
                    if err:
                        raise LiveError(f"could not type into terminal {target}: {err}")
            except (LiveError, RequestError) as ex:
                log(f"live: delegation {did} failed: {ex}")
                self.final(did, f"That did not reach the terminal: {ex}")
                self.push({"t": "live_delegation", "id": did, "text": text, "routedTo": target, "mode": mode,
                           "state": "failed", "error": str(ex)})
                return
            d = {"id": did, "text": text, "target": target, "mode": mode, "path": path, "after": after,
                 "ask": ask["toolCallId"] if ask else None}
            with self.lock:
                old, self.deleg = self.deleg, d
            if old is not None:
                self.push({"t": "live_delegation", "id": old["id"], "text": old["text"], "routedTo": old["target"],
                           "mode": old["mode"], "state": "done"})
            self.push({"t": "live_delegation", "id": did, "text": text, "routedTo": target, "mode": mode, "state": "sent"})
            self.server.poll_now.set()
            self.set_phase()

    def answer(self, target: str, ask: dict, text: str) -> None:
        """A spoken answer to the direct terminal's open question: the option it names, else a
        custom answer."""
        qs = ask["questions"]
        if len(qs) != 1:
            raise LiveError("it asks several questions at once; answer them on the phone screen or the PC")
        q = qs[0]
        pick = match_option(text, [o["label"] for o in q["options"]])
        err = self.server.answer_ask(target, ask["toolCallId"],
                                     [{"qid": q["id"], **({"selected": [pick]} if pick else {"custom": text})}])
        if err:
            raise LiveError(err)
        log(f"live: answered {target}'s question with {pick or 'a custom answer'}")

    def track(self) -> None:
        """Progress of the running delegation from its pane's session file: commentary for each
        new assistant message that calls tools and says something, the final reply when the
        turn stops (or fails), and the agent's question (direct mode) as a final reply."""
        with self.lock:
            d = self.deleg
        if d is None:
            return
        info = pane_info(d["target"])
        if isinstance(info, str):
            self.finish(d, f"Terminal {d['target']} is gone ({info}).", "failed")
            return
        path = breadcrumb_session(info["tty"], info["pid"])
        if path is None:
            return
        if path != d["path"]:  # omp started, /new, /resume: read the new file from its start
            d["path"], d["after"] = path, None
        tr = self.server.transcript(path)
        try:
            tr.refresh()
            d["after"], msgs = tr.assistant_since(d["after"])
            ask = tr.pending_ask()
        except (StaleFile, OSError, ValueError) as ex:
            log(f"live: cannot read {path}: {ex!r}")
            return
        for m in msgs:
            if m["stopReason"] == "toolUse":
                if m["text"]:
                    self.append(d["id"], m["text"], "commentary")
                continue
            if m["stopReason"] == "aborted":
                self.finish(d, "The agent was stopped before it finished.", "done")
            elif m["stopReason"] == "error":
                self.finish(d, f"The agent failed: {m['error'] or 'unknown error'}.", "failed")
            elif m["text"]:
                self.finish(d, m["text"], "done")
            else:
                continue
            return
        if ask is not None and ask["toolCallId"] != d["ask"] and d["mode"] == "direct":
            self.finish(d, f"The agent in {d['target']} asks: {ask_summary(ask)}", "done")

    def finish(self, d: dict, text: str, state: str) -> None:
        with self.lock:
            if self.deleg is d:
                self.deleg = None
        log(f"live: delegation {d['id']} {state}: {text[:120]!r}")
        self.final(d["id"], text)
        self.push({"t": "live_delegation", "id": d["id"], "text": d["text"], "routedTo": d["target"],
                   "mode": d["mode"], "state": state})
        self.set_phase()

    # ------------------------------------------------------------ other terminals, lifecycle

    def on_panes(self, panes: list[dict], trs: dict[str, Transcript]) -> None:
        """Proactive notices (from the sessions poller): another agent finished a turn (working ->
        idle with a new final reply) or started asking. Not for the routed or concierge panes."""
        with self.lock:
            skip = {self.deleg["target"] if self.deleg else None, self.target if self.mode == "direct" else None}
        per_session = collections.Counter(p["session"] for p in panes)
        for p in panes:
            if not p["agent"] or p["session"] == CONCIERGE_SESSION:
                continue
            t, tr, ask = p["target"], trs.get(p["target"]), p.get("ask")
            reply = tr.final_reply() if tr is not None else None
            cur = (p["state"], reply[0] if reply else None, ask["toolCallId"] if ask else None)
            prev, self.seen[t] = self.seen.get(t), cur
            if prev is None or t in skip:
                continue
            name = p["session"] if per_session[p["session"]] == 1 else t
            if cur[2] and cur[2] != prev[2]:
                self.notice(t, "asking", f"{name} is asking: {ask_summary(ask)}")
            elif (cur[0] == "idle" and prev[0] == "working" and cur[1] and cur[1] != prev[1]
                  and reply[1] == "stop" and reply[2].strip()):
                self.notice(t, "finished", f"{name} finished: {first_sentence(reply[2])}")

    def tick_loop(self) -> None:
        while not self.ended:
            time.sleep(LIVE_TICK_S)
            try:
                now = time.monotonic()
                with self.lock:
                    gone, late = self.gone_at, not self.started and self.sideband_at is not None \
                        and now - self.sideband_at >= LIVE_START_S
                    if self.ctx_probe is not None and now - self.ctx_probe >= LIVE_REJECT_S:
                        self.ctx_ok, self.ctx_probe, self.ctx_pending = True, None, []
                        log("live: session.context.append accepted")
                if gone is not None and now - gone > LIVE_GONE_S:
                    self.end(f"the phone was away for {LIVE_GONE_S:.0f} s")
                    return
                if late:
                    self.on_started(f"no session.started within {LIVE_START_S:.0f} s of the sideband")
                self.track()
                self.flush_notices()
            except Exception as ex:  # the call must survive anything a pane or file throws at it
                log(f"live tick failed: {ex!r}")


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
        self.answer_lock = threading.RLock()  # queued phone answers hold it around answer_ask, which takes it too
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
        self.limits = UsageLimits(LIMITS_FILE)
        self.reset_lock = threading.Lock()  # one saved-reset spend at a time
        self.roles_lock = threading.Lock()  # serialises read-check-write of omp's role settings
        self.cmd_locks_lock = threading.Lock()
        self.cmd_locks: dict[str, threading.Lock] = {}
        self.last_escape: dict[str, float] = {}
        # target -> selector this daemon last switched it to, to resolve ambiguous footer names
        self.pane_models: dict[str, str] = {}
        # target -> omp fields last read from its footer (kept while a page hides the footer)
        self.footers: dict[str, dict] = {}
        self.speech = Speech()
        self.pane_trs: dict[str, Transcript] = {}  # agent pane target -> its transcript, from the last poll
        # (client id, target) -> (session path, last reply id) of a voice subscription whose
        # connection ended, so a reconnecting phone still hears a reply it missed
        self.voice_left: dict[tuple[str, str], tuple[str | None, str | None, float]] = {}
        # the one GPT Live call, and the routing a new call (or ddctl without a call) uses
        self.live_lock = threading.Lock()
        self.live: LiveSession | None = None
        self.live_pref: dict = {"mode": "concierge", "target": None}
        self.live_account: str | None = None  # ChatGPT account of the last accepted call
        self.concierge_lock = threading.Lock()
        self.ctl_path = CTL_SOCK
        self.ctl_sock: socket.socket | None = None
        self.btw_lock = threading.Lock()
        self.btw_feeds: dict[str, BtwFeed] = {}  # pane target -> the side question DevDeck runs there
        # Sessions cut off mid-turn or whose terminal went away, found once after start (README
        # "Restore"): None until then, what is left to offer after that ([] once dismissed).
        self.restore_lock = threading.Lock()
        self.restore_offer: list[dict] | None = None
        # omp sessions seen open in tmux panes (TERMINALS_FILE, see record_terminals)
        self.terminals_lock = threading.Lock()
        self.terminals = load_terminals()
        self.record_now = threading.Event()
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
        if unit := own_service():
            adopt_tmux(unit)
        threading.Thread(target=self.poll_loop, daemon=True).start()
        threading.Thread(target=self.record_loop, daemon=True).start()
        threading.Thread(target=self.find_restorable, daemon=True).start()
        while True:
            conn, addr = self.sock.accept()
            threading.Thread(target=self.handle, args=(conn, addr), daemon=True).start()

    def close(self) -> None:
        self.sock.close()
        live = self.live
        if live is not None:
            live.end("the PC daemon stopped")
        if self.ctl_sock is not None:
            self.ctl_sock.close()
            try:
                self.ctl_path.unlink()
            except OSError:
                pass

    # ------------------------------------------------------------ restore offer (README "Restore")

    def find_restorable(self) -> None:
        """Once per run: sessions of every project cut off mid-turn or left by a terminal that went
        away (crash, reboot, power loss, killed tmux) in the last RESTORE_OFFER_S, offered to each
        client that connects until dismissed or restored."""
        since = (time.time() - RESTORE_OFFER_S) * 1000
        try:
            found = [s for s in session_history(None, None, True, self.terminal_record())
                     if s["mtime"] >= since][:RESTORE_OFFER_MAX]
        except Exception as ex:  # the offer is a nicety; never take the daemon down for it
            log(f"restore offer: {ex!r}")
            found = []
        with self.restore_lock:
            if self.restore_offer is not None:  # dismissed before it was found
                return
            self.restore_offer = found
        log(f"restore offer: {len(found)} session(s)" + "".join(
            f"\n  {s['id']} {'interrupted' if s['interrupted'] else 'terminated'} {s['title'][:60]!r} in {s['cwd']}"
            for s in found))
        if found:
            with self.ctl_cond:
                ctls = list(self.controls)
            for ctl in ctls:
                self.offer_restore(ctl)

    def offer_restore(self, ctl: Control) -> None:
        """`restore_offer` to a client, without sessions restored, reopened or finished since."""
        with self.restore_lock:
            offer = self.restore_offer
        if not offer:
            return
        live, record = live_session_paths(), self.terminal_record()
        left = []
        for s in offer:
            p = session_file(s["id"])
            try:
                if p and p not in live and (interrupted(p) or terminated(p, os.path.getmtime(p), record)):
                    left.append(s)
            except OSError:
                pass
        with self.restore_lock:
            if self.restore_offer is offer:
                self.restore_offer = left
            else:
                ids = {s["id"] for s in self.restore_offer or []}
                left = [s for s in left if s["id"] in ids]
        if left:
            ctl.push({"t": "restore_offer", "sessions": left})

    def restore_drop(self, ids: set[str] | None) -> None:
        """Drops sessions `ids` (restored) or, with None, the whole offer (dismissed) for this run;
        every client hears what is left (`restore_offer` with an empty list withdraws it)."""
        with self.restore_lock:
            before = self.restore_offer or []
            left = [s for s in before if ids is not None and s["id"] not in ids]
            self.restore_offer = left
        if len(left) == len(before):
            return
        with self.ctl_cond:
            ctls = list(self.controls)
        for ctl in ctls:
            ctl.push({"t": "restore_offer", "sessions": left})

    # ------------------------------------------------------------ terminals record (README "Restore")

    def terminal_record(self) -> dict:
        with self.terminals_lock:
            return {"since": self.terminals["since"], "sessions": dict(self.terminals["sessions"])}

    def record_loop(self) -> None:
        while True:
            try:
                self.record_terminals()
            except Exception as ex:  # the recorder must survive anything a pane or file throws at it
                log(f"terminals record failed: {ex!r}")
            self.record_now.wait(TERMINALS_POLL_S)
            self.record_now.clear()

    def record_terminals(self) -> None:
        """Notes which omp session is open in which tmux pane (and with --yolo), so a session whose
        terminal goes away without omp exiting normally counts as terminated and can be brought
        back. Forgets sessions that ended normally, whose file is gone, or idle TERMINALS_KEEP_S."""
        r = tmux("list-panes", "-a", "-F", "#{pane_tty}\t#{session_name}:#{window_index}.#{pane_index}")
        panes = dict(ln.split("\t", 1) for ln in r.stdout.decode(errors="replace").splitlines()
                     if "\t" in ln) if r.returncode == 0 else {}
        opened, now = open_omp_sessions(), time.time()
        with self.terminals_lock:
            rec, changed = self.terminals["sessions"], False
            for path, o in opened.items():
                if o["tty"] not in panes:
                    continue  # an omp outside tmux
                entry = {"id": session_id_of(path), "cwd": o["cwd"], "pane": panes[o["tty"]], "yolo": o["yolo"]}
                if rec.get(path) != entry:
                    rec[path], changed = entry, True
            for path in [p for p in rec if p not in opened]:
                try:
                    gone = os.path.getmtime(path) < now - TERMINALS_KEEP_S or session_facts(path)[1]
                except OSError:
                    gone = True
                if gone:
                    del rec[path]
                    changed = True
            if changed:
                save_terminals(self.terminals)

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
                self.ctl_cond.wait_for(lambda: self.controls or self.live is not None)
            self.poll_now.clear()
            try:
                panes = self.list_panes()
            except Exception as ex:  # the poller must survive anything a pane or file throws at it
                log(f"sessions poll failed: {ex!r}")
                panes = self.panes or []
            with self.ctl_cond:
                if panes != self.panes:
                    self.panes = panes
                    self.panes_sig = tuple((p["target"], p["state"], (p.get("ask") or {}).get("toolCallId"),
                                            (p.get("sketch") or {}).get("toolCallId"),
                                            (p.get("planReview") or {}).get("id")) for p in panes)
                    self.panes_rev += 1
                    self.record_now.set()
                    controls = list(self.controls)
                else:
                    controls = []
            for ctl in controls:
                ctl.kick()
            try:
                self.voice_tick(panes)
            except Exception as ex:
                log(f"voice tick failed: {ex!r}")
            live = self.live
            if live is not None:
                try:
                    live.on_panes(panes, self.pane_trs)
                except Exception as ex:
                    log(f"live notices failed: {ex!r}")
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
        panes, trs = [], {}
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
                fields, tr, _ = self.inspect_agent(pane["target"], f[6], int(f[7]), working,
                                                   pane["target"] in watched)
                pane.update(fields)
                if tr is not None:
                    trs[pane["target"]] = tr
            panes.append(pane)
        self.pane_trs = trs
        return panes

    def inspect_agent(self, target: str, tty: str, pid: int, working: bool, page: bool):
        """({state, ask?, sketch?, sessionId?, omp}, transcript or None, visible screen or None) of an omp
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
        reg = sketch_registration(pid)
        if reg is not None and reg["request"] is not None:
            fields["sketch"] = {"toolCallId": reg["request"]["id"], "prompt": reg["request"]["prompt"]}
        ext = ext_registration(pid)
        plan = plan_review_field(ext["planReview"]) if ext is not None and ext["planReview"] else None
        if plan is not None:
            fields["planReview"] = plan
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
        try:
            roles = omp_config().get("modelRoles")
        except RequestError:
            roles = None
        default = roles.get("default") if isinstance(roles, dict) else None
        if isinstance(default, str):
            sel = split_level(default.split(",", 1)[0].strip())[0]
            if not sel.startswith("@"):
                prefer += [sel, sel.split("/", 1)[0]]
        return prefer

    # ------------------------------------------------------------ voice mode

    def voice_tick(self, panes: list[dict]) -> None:
        """Read aloud, for each phone in voice mode, the finished replies (working -> idle with a
        new final assistant text, stopReason stop) and new questions of the panes it listens to.
        Only starts utterance threads: synthesis never runs on the poller."""
        with self.ctl_cond:
            controls = [c for c in self.controls if c.voice]
        if not controls:
            return
        by_target = {p["target"]: p for p in panes}
        for ctl in controls:
            for target, sub in ctl.voice_subs():
                pane = by_target.get(target)
                if pane is None or not pane["agent"]:
                    continue
                tr = self.pane_trs.get(target)
                path = tr.path if tr is not None else None
                reply = tr.final_reply() if tr is not None else None
                rid = reply[0] if reply else None
                if sub["path"] != path:  # first look, /new, /resume: nothing that was there is read
                    sub["path"], sub["heard"], sub["prev"], sub["done_at"] = path, rid, rid, 0.0
                if ctl.paused:  # read when the app is back on screen
                    continue
                state, opts = pane["state"], sub["opts"]
                if state == "working":
                    self.speech.warm()
                elif state == "asking":
                    ask = pane.get("ask")
                    if ask and opts["readAsks"] and ask["toolCallId"] not in sub["asked"]:
                        sub["asked"].add(ask["toolCallId"])
                        ctl.speak_ask(target, ask, opts)
                elif rid is not None and rid != sub["heard"]:
                    read = reply[1] == "stop" and reply[2].strip() and opts["autoRead"]
                    sub["prev"] = sub["heard"] if read else rid
                    sub["heard"], sub["done_at"] = rid, None if read else 0.0
                    if read:
                        ctl.speak_reply(target, rid, reply[2], opts, sub)

    def voice_sub(self, ctl: Control, target: str, opts: dict) -> dict:
        """A new voice subscription of `ctl` to `target`. A reconnecting phone (same client id)
        continues where its previous connection left off, so a reply that finished while the
        link was down is still read, and one that went to a dead connection is read again."""
        sub = {"opts": opts, "path": None, "heard": None, "prev": None, "done_at": 0.0, "asked": set()}
        if not ctl.client:
            return sub
        with self.ctl_cond:
            twins = [c for c in self.controls if c is not ctl and c.client == ctl.client]
        for twin in twins:  # the old connection has not noticed the drop yet: take over from it
            old = twin.drop_voice(target)
            if old is not None:
                sub["path"], sub["heard"] = old["path"], twin.delivered(old)
                sub["prev"] = sub["heard"]
                return sub
        left = self.voice_left.pop((ctl.client, target), None)
        if left is not None and time.monotonic() - left[2] < VOICE_RESUME_S:
            sub["path"], sub["heard"] = left[0], left[1]
            sub["prev"] = sub["heard"]
        return sub

    def cmd_lock(self, target: str) -> threading.Lock:
        with self.cmd_locks_lock:
            return self.cmd_locks.setdefault(target, threading.Lock())

    def run_cmd(self, info: dict, name: str, arg) -> str | None:
        """PaneCommand `name` on an omp pane, one at a time per pane; CmdFailed when refused."""
        lock = self.cmd_lock(info["target"])
        if not lock.acquire(timeout=CMD_QUEUE_S):
            raise CmdFailed("another command is still running in that terminal")
        try:
            return PaneCommand(self, info, name, arg).run()
        finally:
            lock.release()
            self.poll_now.set()

    def btw_push(self, target: str, msg: dict, asker) -> None:
        """A side question's `btw_delta` / `btw_record` to every client watching `target` in the chat
        view and to the one that asked; paused clients get nothing (they re-fetch with btw_list)."""
        with self.ctl_cond:
            controls = list(self.controls)
        for ctl in controls:
            if not ctl.paused and (ctl is asker or (ctl.view == "chat" and ctl.target == target)):
                ctl.push(msg)

    def btw_feed_done(self, feed: BtwFeed) -> None:
        with self.btw_lock:
            if self.btw_feeds.get(feed.target) is feed:
                del self.btw_feeds[feed.target]

    def pane_transcript(self, info: dict) -> Transcript | None:
        path = breadcrumb_session(info["tty"], info["pid"])
        return self.transcript(path) if path else None

    def create_terminal(self, cwd: str | None = None, omp: bool = False, yolo: bool = False,
                        resume: str | None = None, restore: bool = False) -> str:
        """A fresh tmux session phone-N (lowest free N) running the default shell in `cwd` (home),
        optionally starting omp in it (with --yolo if asked, `--resume <id>` with `resume`, or
        `--restore <id>` with `restore` too); its pane target. RequestError on failure."""
        with self.deliver_lock:  # two phones pressing "+ New" at once must not collide
            r = tmux("list-sessions", "-F", "#{session_name}")
            taken = set(r.stdout.decode(errors="replace").split()) if r.returncode == 0 else set()
            n = 1
            while f"phone-{n}" in taken:
                n += 1
            name = f"phone-{n}"
            r = tmux_new_session(name, "-c", cwd or str(Path.home()))
        if r.returncode != 0:
            raise RequestError(f"new terminal: {tmux_error(r)}")
        info = pane_info(name)
        target = info["target"] if isinstance(info, dict) else name
        verb = "restore" if restore else "resume"
        if omp:
            launch = shlex.quote(omp_binary()) + (" --yolo" if yolo else "") + (f" --{verb} {resume}" if resume else "")
            err = deliver_text("new-" + name, target, launch, True)
            if err:
                raise RequestError(f"started {target} but could not start omp in it: {err}")
        log(f"created terminal {target}" + (f" with omp{' --yolo' if yolo else ''}" if omp else "")
            + (f" {verb[:-1]}ing {resume}" if resume else "") + (f" in {cwd}" if cwd else ""))
        self.poll_now.set()
        self.record_now.set()
        return target

    def reopen_session(self, sid: str, raw_cwd, restore: bool, yolo: bool) -> str:
        """A new terminal running `omp --resume <sid>` (`--restore` with `restore`, refused while a
        running omp has the session open) in `raw_cwd`: inside home, or the session's recorded
        folder even outside it (also the default). --yolo when asked or when the pane the session
        was last seen in ran omp with it. Its pane target; RequestError on failure."""
        sid = sid.lower()
        path = session_file(sid)
        if path is None:
            raise RequestError(f"no session {sid}")
        if restore and path in live_session_paths():
            raise RequestError("that session is open in a running omp; nothing to restore")
        head = session_head(path, os.stat(path))
        recorded = os.path.normpath(head["cwd"]) if head and head["cwd"] else None
        cwd = None
        if raw_cwd is not None:
            same = recorded and isinstance(raw_cwd, str) and os.path.normpath(raw_cwd) == recorded
            cwd = recorded if same else user_path(raw_cwd)
            if not os.path.isdir(cwd):
                raise RequestError(f"not a folder: {cwd}")
        elif recorded and os.path.isdir(recorded):
            cwd = recorded
        with self.terminals_lock:
            seen = self.terminals["sessions"].get(path) or {}
        return self.create_terminal(cwd, True, yolo or seen.get("yolo") is True, sid, restore)

    def answer_ask(self, target: str, call: str, answers) -> str | None:
        """Answer omp's open question `call` in `target` with keys (see ask_keystrokes); None once
        the session file records the answer, else the error."""
        info = pane_info(target)
        if isinstance(info, str):
            raise RequestError(info)
        tr = self.pane_transcript(info)
        if tr is None:
            return "no omp session in that terminal"
        target = info["target"]
        tr.refresh(force=True)
        ask = tr.pending_ask()
        if ask is None or ask["toolCallId"] != call:
            if tr.has_result(call):
                return "that question was already answered"
            return "that question is no longer open"
        batches = ask_keystrokes(ask["questions"], answers)
        with self.answer_lock:
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
                self.poll_now.set()
                return None
        lines = visible_lines(target) or []
        while lines and not lines[-1].strip():
            lines.pop()
        return "omp did not accept the answer; the PC screen shows:\n" + "\n".join(lines[-15:])

    # ------------------------------------------------------------ live calls

    def live_offer(self, ctl: Control, msg: dict) -> None:
        """`live_offer {req, sdp, voice, mode, target?}`: a new call for this phone (replacing its
        own running one); answered with `live_answer` or `error {req}` (see LiveSession)."""
        req, sdp, voice = msg.get("req"), msg.get("sdp"), msg.get("voice") or LIVE_VOICE
        mode = msg.get("mode") or self.live_pref["mode"]
        target = msg.get("target") if mode == "direct" else None

        def fail(error: str) -> None:
            log(f"{ctl.peer}: live_offer refused: {error}")
            ctl.push({"t": "error", "req": req, "error": error})
            ctl.push({"t": "live", "phase": "error", "mode": mode, "error": error})

        if not isinstance(req, str) or not req or not isinstance(sdp, str) or not sdp.strip():
            fail("live_offer needs a req and an sdp")
            return
        if voice not in LIVE_VOICES:
            fail(f"unknown voice {voice!r}; one of {', '.join(LIVE_VOICES)}")
            return
        if mode not in LIVE_MODES:
            fail("mode must be concierge or direct")
            return
        if mode == "direct":
            info = pane_info(target) if isinstance(target, str) and target else "direct mode needs a target"
            if isinstance(info, str):
                fail(f"terminal {target}: {info}" if target else info)
                return
            if not info["agent"]:
                fail(f"terminal {info['target']} is not running omp")
                return
            target = info["target"]
        with self.live_lock:
            old = self.live
            if old is not None and old.ctl is not ctl and not (ctl.client and old.client == ctl.client):
                live = None
            else:
                live = self.live = LiveSession(self, ctl, req, sdp, voice, mode, target)
                self.live_pref = {"mode": mode, "target": target}
        if live is None:
            fail("a live call is already running on another device; end it there first")
            return
        if old is not None:
            old.end(notify=False)  # the phone replaced it itself
        with self.ctl_cond:
            self.ctl_cond.notify_all()  # the poller runs while a call does (notices)
        log(f"{ctl.peer}: live_offer ({mode}{' ' + target if target else ''}, voice {voice})")
        live.push(live.state())
        threading.Thread(target=live.run, daemon=True).start()

    def live_event(self, ctl: Control, msg: dict) -> None:
        """`live_event {callId, ev}`: one event of the call the phone got on its data channel (the
        raw JSON text); see LiveSession.relayed."""
        live = self.live
        ev = msg.get("ev")
        if (live is not None and isinstance(ev, str) and msg.get("callId") == live.call_id
                and (live.ctl is ctl or (ctl.client and live.client == ctl.client))):
            live.relayed(ev.encode())

    def live_mode(self, mode, target) -> dict:
        """Route the call's delegations to the concierge or straight to an omp terminal (also the
        default for the next call); {mode, target, active}."""
        if mode not in LIVE_MODES:
            raise RequestError("mode must be concierge or direct")
        if mode == "direct":
            if not isinstance(target, str) or not target:
                raise RequestError("direct mode needs a terminal")
            info = pane_info(target)
            if isinstance(info, str):
                raise RequestError(f"terminal {target}: {info}")
            if not info["agent"]:
                raise RequestError(f"terminal {info['target']} is not running omp")
            target = info["target"]
        else:
            target = None
        with self.live_lock:
            live = self.live
            self.live_pref = {"mode": mode, "target": target}
        if live is not None:
            if mode == "concierge":
                try:
                    self.concierge(start=True)
                except LiveError as ex:
                    raise RequestError(str(ex)) from None
            live.set_mode(mode, target)
            log(f"live: routing to {target or 'the concierge'}")
        return {"mode": mode, "target": target, "active": live is not None}

    def live_stop(self, ctl: Control) -> None:
        live = self.live
        if live is not None and (live.ctl is ctl or (ctl.client and live.client == ctl.client)):
            live.end()

    def live_attached(self, ctl: Control) -> None:
        """A (re)connected phone takes its call back: the call's state goes to it again."""
        live = self.live
        if live is not None and ctl.client and live.client == ctl.client:
            with live.lock:
                live.ctl, live.gone_at = ctl, None
            ctl.push(live.state())

    def live_detached(self, ctl: Control) -> None:
        """The phone's last connection went: the call ends LIVE_GONE_S later unless it is back."""
        live = self.live
        if live is None or not (live.ctl is ctl or (ctl.client and live.client == ctl.client)):
            return
        with self.ctl_cond:
            back = bool(live.client) and any(c.client == live.client for c in self.controls)
        if not back:
            with live.lock:
                live.gone_at = time.monotonic()
            log(f"live: phone gone; the call ends in {LIVE_GONE_S:.0f} s unless it reconnects")

    def concierge(self, start: bool, wait: bool = False) -> str:
        """Pane target of the concierge omp (tmux session CONCIERGE_SESSION; started first when
        missing and `start`); with `wait`, only once omp runs in it."""
        name = f"={CONCIERGE_SESSION}:"
        with self.concierge_lock:
            if tmux("has-session", "-t", f"={CONCIERGE_SESSION}").returncode != 0:
                if not start:
                    raise LiveError("the concierge is not running")
                err = start_concierge(self.ctl_path)
                if err:
                    raise LiveError(f"cannot start the concierge: {err}")
                self.poll_now.set()
        deadline = time.monotonic() + (CONCIERGE_READY_S if wait else 0.0)
        while True:
            info = pane_info(name)
            if isinstance(info, dict) and (info["agent"] or not wait):
                return info["target"]
            if time.monotonic() > deadline:
                raise LiveError(f"the concierge: {info}" if isinstance(info, str) else "the concierge's omp did not start")
            time.sleep(0.3)

    # ------------------------------------------------------------ local control socket (ddctl)

    def ctl_serve(self, path: Path) -> None:
        """Listen on the Unix socket `path` (0600, peers checked to be this user) for ddctl:
        one JSON request line, one JSON reply line {ok, error?, ...}, then close."""
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old = os.umask(0o177)
        try:
            sock.bind(str(path))
        finally:
            os.umask(old)
        sock.listen(8)
        self.ctl_path, self.ctl_sock = path, sock
        threading.Thread(target=self.ctl_accept, args=(sock,), daemon=True).start()

    def ctl_accept(self, sock: socket.socket) -> None:
        while True:
            try:
                conn, _ = sock.accept()
            except OSError:
                return
            threading.Thread(target=self.ctl_handle, args=(conn,), daemon=True).start()

    def ctl_handle(self, conn: socket.socket) -> None:
        with conn:
            try:
                _, uid, _ = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED,
                                                                 struct.calcsize("3i")))
                if uid != os.getuid():
                    log(f"ctl: refused uid {uid}")
                    return
                conn.settimeout(10)
                with conn.makefile("rb") as rf:
                    line = rf.readline(MAX_LINE)
                try:
                    req = json.loads(line)
                    if not isinstance(req, dict):
                        raise ValueError("not an object")
                except ValueError as ex:
                    reply = {"ok": False, "error": f"bad json: {ex}"}
                else:
                    reply = self.ctl_reply(req)
                conn.sendall(encode(reply))
            except OSError as ex:
                log(f"ctl: {ex}")

    def ctl_reply(self, req: dict) -> dict:
        try:
            return {"ok": True, **self.ctl_request(req)}
        except (RequestError, CmdFailed) as ex:
            return {"ok": False, "error": str(ex)}
        except StaleFile:
            return {"ok": False, "error": "the session file changed; try again"}
        except Exception as ex:
            log(f"ctl: {req.get('cmd')} failed: {ex!r}")
            return {"ok": False, "error": f"internal error: {ex}"}

    def ctl_target(self, raw) -> dict:
        """pane_info of a terminal named by ddctl ("sess:win.pane", or "sess"/"sess:win" for its
        active pane)."""
        if not isinstance(raw, str) or not raw.strip():
            raise RequestError("no terminal given")
        info = pane_info(raw.strip())
        if isinstance(info, str):
            names = ", ".join(p["target"] for p in self.list_panes()) or "none"
            raise RequestError(f"no terminal {raw!r}; terminals: {names}")
        return info

    def ctl_request(self, req: dict) -> dict:
        cmd = req.get("cmd")
        if cmd == "terminals":
            return {"terminals": self.list_panes()}
        if cmd == "live":
            return self.live_mode(req.get("mode"), req.get("target"))
        if cmd == "new":
            cwd = req.get("cwd")
            if cwd is not None and not (isinstance(cwd, str) and os.path.isabs(cwd) and os.path.isdir(cwd)):
                raise RequestError(f"not a directory: {cwd}")
            return {"target": self.create_terminal(cwd, omp=req.get("omp") is True)}
        if cmd not in ("status", "last", "send", "queue", "stop", "model", "effort", "ask", "answer"):
            raise RequestError(f"unknown command {cmd!r}")
        info = self.ctl_target(req.get("target"))
        target = info["target"]
        tr = self.pane_transcript(info) if info["agent"] else None
        if tr is not None:
            tr.refresh(force=True)
        if cmd == "status":
            pane = next((p for p in self.list_panes() if p["target"] == target), None)
            st = tr.status_info() if tr is not None and tr.exists else {"lastUser": None, "lastAssistant": None, "tools": []}
            return {"pane": pane, **st, "ask": tr.pending_ask() if tr is not None else None}
        if cmd == "last":
            reply = tr.final_reply() if tr is not None else None
            return {"text": reply[2] if reply else None, "id": reply[0] if reply else None}
        if cmd == "ask":
            return {"ask": tr.pending_ask() if tr is not None else None}
        if cmd == "answer":
            ask = tr.pending_ask() if tr is not None else None
            if ask is None:
                raise RequestError(f"{target} has no open question")
            err = self.answer_ask(target, ask["toolCallId"], req.get("answers"))
            if err:
                raise RequestError(err)
            return {}
        if cmd == "send":
            text = req.get("text")
            if not isinstance(text, str) or not text.strip():
                raise RequestError("nothing to send")
            if info["agent"]:
                if tr is not None and tr.pending_ask() is not None:
                    raise RequestError(f"{target} is asking a question; answer it first (ask/answer)")
                text = send_rewrite(text)
            err = deliver_text("ctl-" + secrets.token_hex(4), target, text, True)
            if err:
                raise RequestError(err)
            self.poll_now.set()
            return {"result": "steered" if info["working"] else "sent"}
        name, arg = {"queue": ("queue", req.get("text")), "stop": ("stop", None),
                     "model": ("switch", req.get("selector")), "effort": ("effort", req.get("level"))}[cmd]
        result = self.run_cmd(info, name, arg)
        return {"result": result} if result else {}

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
             "stop", "queue", "page", "preset")

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
        if self.name in ("clear", "retry", "goto") and state == "working":
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
        if model["kind"] != "chat":
            raise CmdFailed(f"{model['name']} is a {model['kind']} model, not a chat model")
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

    def c_preset(self, state, omp, before):
        """`/modelpreset switch <name>`: omp writes the preset's roles and switches this session to
        its default model. Confirmed by a model change or by the roles now matching the preset."""
        name = self.arg.strip()
        if not PRESET_RE.match(name):
            raise CmdFailed("preset needs a preset name")
        try:
            presets = omp_config(omp["cwd"]).get("modelPresets")
        except RequestError as ex:
            raise CmdFailed(str(ex)) from None
        preset = presets.get(name) if isinstance(presets, dict) else None
        if not isinstance(preset, dict):
            raise CmdFailed(f"no model preset {name!r}")
        want = preset.get("modelRoles") if isinstance(preset.get("modelRoles"), dict) else {}
        base = self.baseline()
        self.paste(f"/modelpreset switch {name}")

        def check(cur, news, t):
            if self.entry(base, "model_change"):
                return True
            try:
                return t >= CMD_SETTLE_S and omp_config(omp["cwd"]).get("modelRoles") == want
            except RequestError:
                return False
        return self.confirm(before, check)

    def c_sketch(self, state, omp, before):
        """Start the sketch extension's canvas server (`/sketch url`: no browser on the PC)."""
        reg = sketch_registration(self.pid)
        if reg is None:
            raise CmdFailed(SKETCH_MISSING)
        if reg["port"] is not None:
            return None
        self.paste("/sketch url")

        def check(cur, news, t):
            r = sketch_registration(self.pid)
            return r is not None and r["port"] is not None
        return self.confirm(before, check)

    def c_goto(self, state, omp, before):
        """`/devdeck-goto <nonce> <entryId> [summarize]`: the devdeck extension moves the session leaf
        with navigateTree (command context only); its outcome is read back by nonce."""
        entry, _, mode = self.arg.partition(" ")
        reg = ext_registration(self.pid)
        if reg is None:
            raise CmdFailed(EXT_MISSING)
        nonce = secrets.token_hex(6)
        self.paste(f"/devdeck-goto {nonce} {entry}" + (" summarize" if mode == "summarize" else ""))

        def check(cur, news, t):
            try:
                status, res = ext_http(reg, "GET", "/goto", query={"nonce": nonce})
            except RequestError:
                return False
            if status != 200 or not res.get("done"):
                return False
            if not res.get("ok"):
                raise CmdFailed(str(res.get("error") or "omp refused the move"))
            return True
        return self.confirm(before, check, timeout=GOTO_SUMMARY_S if mode == "summarize" else GOTO_WAIT_S)


class Utterance:
    """One text being spoken to one connection: `say` (req), an auto-read reply or a question."""
    __slots__ = ("req", "target", "kind", "cancel", "pushed")

    def __init__(self, req: str | None, target: str | None, kind: str):
        self.req, self.target, self.kind = req, target, kind
        self.cancel = threading.Event()
        self.pushed: list[dict] = []  # audio messages queued for the writer (dropped again on stop)


def voice_opts(raw) -> dict:
    o = raw if isinstance(raw, dict) else {}
    speed = o.get("speed")
    speed = float(speed) if isinstance(speed, (int, float)) and not isinstance(speed, bool) else 1.0
    return {"autoRead": o.get("autoRead") is not False, "readAsks": o.get("readAsks") is not False,
            "voice": o.get("voice") if o.get("voice") in VOICES else VOICES[0],
            "speed": round(min(SPEED_RANGE[1], max(SPEED_RANGE[0], speed)), 2)}


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
        self.voice_lock = threading.Lock()
        # target -> {opts, path, heard, prev, done_at, asked} (see Server.voice_tick and delivered())
        self.voice: dict[str, dict] = {}
        self.utterances: set[Utterance] = set()  # guarded by self.cond
        self.last_rx = time.monotonic()  # when the phone last sent anything
        self.sketch: SketchFeed | None = None  # the canvas this phone has open; guarded by self.cond

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
        self.server.live_attached(self)
        threading.Thread(target=self.server.offer_restore, args=(self,), daemon=True).start()
        try:
            self.read_loop()
        finally:
            self.server.detach(self)
            self.server.live_detached(self)
            with self.cond:
                self.closed = True
                self.cond.notify()
            self.stop_utterances(lambda u: True)
            self.close_sketch()
            now = time.monotonic()
            for target, sub in self.voice_subs():
                if self.client:
                    self.server.voice_left[(self.client, target)] = (sub["path"], self.delivered(sub), now)
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
                self.last_rx = time.monotonic()
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
            self.new_terminal(msg)
        elif kind == "restore_dismiss":
            self.server.restore_drop(None)
        elif kind == "voice":
            self.do_voice(msg)
        elif kind == "say":
            self.do_say(msg)
        elif kind == "live_offer":
            self.server.live_offer(self, msg)
        elif kind == "live_mode":
            try:
                self.server.live_mode(msg.get("mode"), msg.get("target"))
            except RequestError as ex:
                self.push({"t": "error", "error": f"live_mode: {ex}"})
        elif kind == "live_stop":
            self.server.live_stop(self)
        elif kind == "live_event":
            self.server.live_event(self, msg)
        elif kind == "say_stop":
            req = msg.get("req")
            self.stop_utterances(lambda u: u.req == req if isinstance(req, str) else True)
        elif kind == "sketch":
            if msg.get("op") == "close":
                self.close_sketch()
            else:
                self.request(msg)
        elif kind in ("more", "full", "ls", "read", "git", "models", "roles", "roles_set", "history", "cmd", "omp_update",
                      "btw_list", "btw_ask", "btw_cancel", "plan_get", "plan_answer", "plan_open", "tree", "goto",
                      "settings", "settings_set", "session_info", "session_delete", "session_restore",
                      "usage", "usage_reset", "usage_history", "restore_many"):
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
            text = send_rewrite(text)
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
        err = self.server.answer_ask(target, call, msg.get("answers"))
        if err is None:
            self.kick()
        return err

    def new_terminal(self, msg: dict) -> None:
        """A fresh tmux session phone-N running the default shell, watched now. Optional `cwd`
        (inside home) and `omp` (start omp there, `yolo` adds --yolo); `resume` a session id (with
        omp:true) reopens that session instead (Server.reopen_session, `restore` for --restore).
        omp ones open in chat."""
        omp = msg.get("omp") is True
        resume, restore = msg.get("resume"), msg.get("restore") is True
        try:
            if resume is not None or restore:
                if not omp or not isinstance(resume, str):
                    raise RequestError(f"{'restore' if restore else 'resume'} needs omp:true and the id of an existing session")
                target = self.server.reopen_session(resume, msg.get("cwd"), restore, msg.get("yolo") is True)
            else:
                cwd = None
                if msg.get("cwd") is not None:
                    cwd = user_path(msg.get("cwd"))
                    if not os.path.isdir(cwd):
                        raise RequestError(f"not a folder: {cwd}")
                target = self.server.create_terminal(cwd, omp, msg.get("yolo") is True)
        except (RequestError, OSError) as ex:
            self.push({"t": "error", "error": str(ex)})
            return
        if restore:
            self.server.restore_drop({resume.lower()})
        view = "chat" if omp else "term"
        self.push({"t": "created", "target": target, "view": view})
        with self.cond:
            self.target, self.view, self.force = target, view, True
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

    # ------------------------------------------------------------ voice mode

    def voice_subs(self) -> list[tuple[str, dict]]:
        with self.voice_lock:
            return list(self.voice.items())

    def delivered(self, sub: dict) -> str | None:
        """The last reply of `sub` this phone surely got: the newest one when it was queued
        completely and the phone was heard from afterwards (so the link was alive), else the
        one before it."""
        done = sub["done_at"]
        return sub["heard"] if done is not None and self.last_rx > done else sub["prev"]

    def drop_voice(self, target: str) -> dict | None:
        """Hand this (stale) connection's subscription to `target` over to a new connection."""
        with self.voice_lock:
            sub = self.voice.pop(target, None)
        if sub is not None:
            self.stop_utterances(lambda u: u.kind != "say" and u.target == target)
        return sub

    def voice_error(self, error: str, **fields) -> None:
        self.push({"t": "voice_error", "error": error, **{k: v for k, v in fields.items() if v is not None}})

    def do_voice(self, msg: dict) -> None:
        target, on = msg.get("target"), msg.get("on")
        if not isinstance(target, str) or not target or not isinstance(on, bool):
            self.voice_error("voice needs a target and on")
            return
        info = self.pane(target)
        canon = info["target"] if isinstance(info, dict) else target
        if not on:
            with self.voice_lock:
                self.voice.pop(canon, None)
                self.voice.pop(target, None)
            self.server.voice_left.pop((self.client, canon), None)
            self.stop_utterances(lambda u: u.kind != "say" and u.target == canon)
            return
        if isinstance(info, str):
            self.voice_error(f"{info}: {target}")
            return
        opts = voice_opts(msg.get("opts"))
        with self.voice_lock:
            sub = self.voice.get(canon)
            if sub is not None:
                sub["opts"] = opts
        if sub is None:
            sub = self.server.voice_sub(self, canon, opts)
            with self.voice_lock:
                self.voice.setdefault(canon, sub)
        self.server.speech.warm()
        self.server.poll_now.set()  # an open question is read right away

    def do_say(self, msg: dict) -> None:
        req, target, entry, text = msg.get("req"), msg.get("target"), msg.get("entryId"), msg.get("text")
        req = req if isinstance(req, str) and req else None
        target = target if isinstance(target, str) and target else None
        if entry is not None and (not isinstance(entry, str) or not entry or target is None):
            self.voice_error("say with an entryId needs a target", req=req)
            return
        if entry is None and (not isinstance(text, str) or not text.strip()):
            self.voice_error("say needs an entryId or a text", req=req)
            return
        # voice/speed: the message's own (top level or opts), else this target's voice mode, else defaults
        given = {**(msg.get("opts") if isinstance(msg.get("opts"), dict) else {}),
                 **{k: msg[k] for k in ("voice", "speed") if k in msg}}
        if "voice" in given and given["voice"] not in VOICES:
            self.voice_error(f"unknown voice {given['voice']!r}", req=req)
            return
        with self.voice_lock:
            sub = self.voice.get(target) if target else None
            base = dict(sub["opts"]) if sub else voice_opts(None)
        opts = voice_opts({**base, **given})
        utt = Utterance(req, target, "say")
        with self.cond:
            if sum(1 for u in self.utterances if u.kind == "say") >= MAX_UTTERANCES:
                utt = None
            else:
                self.utterances.add(utt)
        if utt is None:
            self.voice_error("too many readings at once; stop one first", req=req)
            return
        threading.Thread(target=self._say, args=(utt, entry, text, opts), daemon=True).start()

    def _say(self, utt: Utterance, entry: str | None, text: str | None, opts: dict) -> None:
        fields = {"req": utt.req, "entryId": entry}

        def make_text() -> str:
            if entry is None:
                return spoken_text(text)
            tr = self.transcript_of(utt.target)
            if tr is None:
                raise RequestError("no omp session in that terminal")
            tr.refresh()
            return spoken_text(tr.full(entry))

        self.stream(utt, make_text, fields, opts)

    def speak_reply(self, target: str, entry: str, text: str, opts: dict, sub: dict) -> None:
        self.speak(Utterance(None, target, "auto"), lambda: spoken_text(text), {"auto": True, "entryId": entry}, opts,
                   sub)

    def speak_ask(self, target: str, ask: dict, opts: dict) -> None:
        self.speak(Utterance(None, target, "ask"), lambda: spoken_text(ask_speech(ask["questions"])),
                   {"ask": True, "toolCallId": ask["toolCallId"]}, opts)

    def speak(self, utt: Utterance, make_text, fields: dict, opts: dict, sub: dict | None = None) -> None:
        with self.cond:
            if self.closed:
                return
            self.utterances.add(utt)
        threading.Thread(target=self.stream, args=(utt, make_text, fields, opts, sub), daemon=True).start()

    def stream(self, utt: Utterance, make_text, fields: dict, opts: dict, sub: dict | None = None) -> None:
        """Synthesise the text sentence by sentence and queue each as an `audio` message as soon
        as it is ready, so the phone starts playing the first while the rest is synthesised."""
        fields = {k: v for k, v in fields.items() if v is not None}
        start, first, engines = time.monotonic(), 0.0, set()
        try:
            spoken = make_text()
            sentences = split_sentences(spoken)
            if not sentences:
                raise SpeechError("nothing to read")
            base = {"t": "audio", "target": utt.target, **fields}
            for seq, sentence in enumerate(sentences):
                ogg, dur, engine = self.server.speech.synth(sentence, opts["voice"], opts["speed"], utt.cancel)
                engines.add(engine)
                msg = {**base, "seq": seq, "last": seq == len(sentences) - 1, "mime": AUDIO_MIME,
                       "data": base64.b64encode(ogg).decode(), "text": sentence, "dur": dur}
                with self.cond:
                    if utt.cancel.is_set():
                        raise Cancelled()
                    utt.pushed.append(msg)
                    self.out.append(msg)
                    self.cond.notify()
                if not seq:
                    first = time.monotonic() - start
            log(f"{self.peer}: spoke {utt.kind} {utt.req or fields.get('entryId') or ''}: {len(sentences)} sentences, "
                f"{len(spoken)} chars, first after {first * 1000:.0f} ms, all after "
                f"{(time.monotonic() - start) * 1000:.0f} ms ({'/'.join(sorted(engines))})")
        except Cancelled:
            pass
        except (SpeechError, RequestError) as ex:
            log(f"{self.peer}: {utt.kind} speech failed: {ex}")
            self.voice_error(str(ex), target=utt.target, **fields)
        except StaleFile:
            self.voice_error("the session file changed; try again", target=utt.target, **fields)
        finally:
            self.finish(utt)
            if sub is not None:
                sub["done_at"] = time.monotonic()

    def finish(self, utt: Utterance) -> None:
        with self.cond:
            self.utterances.discard(utt)
            utt.pushed = []

    def stop_utterances(self, pred) -> None:
        """Cancel matching utterances and drop their audio the writer has not sent yet."""
        with self.cond:
            hit = [u for u in self.utterances if pred(u)]
            drop = set()
            for u in hit:
                u.cancel.set()
                drop.update(id(m) for m in u.pushed)
            if drop:
                self.out = collections.deque(m for m in self.out if id(m) not in drop)

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
                reply = {"t": "models", "models": self.server.catalog.rows(), "fetchedAt": data["fetchedAt"]}
            elif kind == "roles":
                reply = roles_state(omp_config(self.roles_cwd(msg)))
            elif kind == "roles_set":
                reply = self.do_roles_set(msg)
            elif kind == "history":
                reply = self.do_history(msg)
            elif kind == "omp_update":
                reply = omp_update(msg.get("check") is True)
            elif kind == "sketch":
                reply = self.do_sketch(msg)
            elif kind == "cmd":
                reply = self.do_cmd(msg)
            else:
                reply = getattr(self, "do_" + kind)(msg)
            reply["req"] = req
        except RequestError as ex:
            reply = {"t": "error", "req": req, "error": str(ex), **({"code": ex.code} if ex.code else {})}
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
        """This cwd's sessions, or with `all` every project's (each with its `cwd`; `target` is then
        optional). With `restorable` only the sessions cut off mid-turn or whose terminal went away."""
        everywhere, cwd, current = msg.get("all") is True, "", None
        if not everywhere or msg.get("target") is not None:
            _, fields = self.agent_pane(msg.get("target"))
            omp = fields["omp"]
            if not omp["cwd"] and not everywhere:
                raise RequestError("omp has not told which directory this terminal works in")
            cwd, current = omp["cwd"] or "", omp["sessionId"]
        return {"t": "history", "cwd": cwd,
                "sessions": session_history(None if everywhere else cwd, current, msg.get("restorable") is True,
                                            self.server.terminal_record())}

    def do_restore_many(self, msg: dict) -> dict:
        """One new terminal per item {id, cwd?}: `omp --restore <id>` when the session is cut off
        mid-turn, else `omp --resume <id>` (Server.reopen_session). One item failing does not stop
        the others; this client keeps watching what it watched."""
        items = msg.get("items")
        if not isinstance(items, list) or not items or len(items) > HISTORY_ALL_MAX:
            raise RequestError(f"restore_many needs 1-{HISTORY_ALL_MAX} items")
        results, done = [], set()
        for it in items:
            sid = it.get("id") if isinstance(it, dict) else None
            if not isinstance(sid, str) or not UUID_RE.match(sid.lower()):
                results.append({"id": sid if isinstance(sid, str) else "", "error": "not a session id"})
                continue
            sid = sid.lower()
            path = session_file(sid)
            restore = path is not None and interrupted(path)
            try:
                if path is not None and path in live_session_paths():
                    raise RequestError("open in a running omp already")
                target = self.server.reopen_session(sid, it.get("cwd"), restore, False)
            except (RequestError, OSError) as ex:
                results.append({"id": sid, "error": str(ex)})
                continue
            results.append({"id": sid, "target": target, "restored": restore})
            done.add(sid)
        log(f"{self.peer}: restore_many opened {len(done)} of {len(items)}")
        self.server.restore_drop(done)
        return {"t": "restore_many", "results": results}

    # ------------------------------------------------------------ native omp pages (README "Native omp pages")

    def omp_pane(self, target) -> dict:
        """pane_info of an omp pane, else RequestError."""
        if not isinstance(target, str) or not target:
            raise RequestError("no target")
        info = pane_info(target)
        if isinstance(info, str):
            raise RequestError(info)
        if not info["agent"]:
            raise RequestError("that terminal is not running omp")
        return info

    def pane_session(self, info: dict) -> str:
        """The session file of an omp pane, else RequestError."""
        path = breadcrumb_session(info["tty"], info["pid"])
        if not path or not os.path.isfile(path):
            raise RequestError("omp in that terminal has no session file yet (send a first message)")
        return path

    def ext_pane(self, target) -> tuple[dict, dict]:
        """(pane_info, devdeck extension registration) of an omp pane, else RequestError (code
        no_extension when its omp has not loaded the extension)."""
        info = self.omp_pane(target)
        reg = ext_registration(info["pid"])
        if reg is None:
            raise RequestError(EXT_MISSING, code="no_extension")
        return info, reg

    def do_btw_list(self, msg: dict) -> dict:
        """The pane session's /btw topics from omp's history files (no extension needed); the one a
        DevDeck side question is answering right now comes from the extension, partial answer included."""
        info = self.omp_pane(msg.get("target"))
        path = breadcrumb_session(info["tty"], info["pid"])
        sid = session_id_of(path) if path else None
        recs = {r["id"]: r for r in btw_disk_records(path)} if path else {}
        with self.server.btw_lock:
            feed = self.server.btw_feeds.get(info["target"])
        if feed is not None and feed.session_id == sid:
            try:
                status, res = ext_http(feed.reg, "GET", "/btw")
                for r in (res.get("records") or []) if status == 200 else []:
                    if isinstance(r, dict) and r.get("id") == feed.topic_id:
                        recs[r["id"]] = r
            except RequestError:
                pass
        mine = devdeck_btw_ids(sid)
        topics = [t for t in (btw_topic(r, "devdeck" if i in mine else "omp") for i, r in recs.items()) if t]
        topics.sort(key=lambda t: (t["turns"][0]["ts"], t["id"]), reverse=True)
        return {"t": "btw_list", "target": info["target"], "sessionId": sid, "topics": topics}

    def do_btw_ask(self, msg: dict) -> dict:
        """A side question (or, with `topicId`, a follow-up) through the extension, which runs omp's
        own /btw pipeline; the answer streams to the watching clients (BtwFeed)."""
        question, topic = msg.get("question"), msg.get("topicId")
        if not isinstance(question, str) or not question.strip() or len(question) > BTW_QUESTION_MAX:
            raise RequestError(f"btw_ask needs a question of at most {BTW_QUESTION_MAX} characters")
        if topic is not None and (not isinstance(topic, str) or not ENTRY_ID_RE.match(topic)):
            raise RequestError("bad topicId")
        info, reg = self.ext_pane(msg.get("target"))
        target = info["target"]
        with self.server.btw_lock:
            if target in self.server.btw_feeds:
                raise RequestError("A side question is still running here; cancel it first", code="btw_busy")
            feed = self.server.btw_feeds[target] = BtwFeed(self.server, target, reg, reg["sessionId"], self,
                                                           topic is None)
        try:
            feed.ready.wait(EXT_HTTP_S)
            status, res = ext_http(reg, "POST", "/btw", {"question": question, **({"topicId": topic} if topic else {})})
            rec = res.get("record")
            if status != 200 or not isinstance(rec, dict) or not isinstance(rec.get("id"), str):
                raise RequestError(str(res.get("error") or f"HTTP {status}"),
                                   code="btw_busy" if res.get("code") == "btw_busy" else None)
        except RequestError:
            feed.stop()
            self.server.btw_feed_done(feed)
            raise
        feed.topic_id = rec["id"]
        log(f"{self.peer}: btw {'follow-up' if topic else 'question'} on {target}: topic {rec['id']}")
        return {"t": "btw_ask", "target": target, "topicId": rec["id"]}

    def do_btw_cancel(self, msg: dict) -> dict:
        topic = msg.get("topicId")
        if topic is not None and (not isinstance(topic, str) or not ENTRY_ID_RE.match(topic)):
            raise RequestError("bad topicId")
        _, reg = self.ext_pane(msg.get("target"))
        status, res = ext_http(reg, "POST", "/btw/cancel", {"topicId": topic} if topic else {})
        if status != 200:
            raise RequestError(str(res.get("error") or f"HTTP {status}"))
        return {"t": "btw_cancel", "cancelled": res.get("cancelled") is True}

    def do_plan_get(self, msg: dict) -> dict:
        rid = msg.get("id")
        if not isinstance(rid, str) or not rid:
            raise RequestError("plan_get needs an id")
        _, reg = self.ext_pane(msg.get("target"))
        status, res = ext_http(reg, "GET", "/plan", query={"id": rid})
        if status != 200 or not isinstance(res.get("markdown"), str):
            raise RequestError(str(res.get("error") or f"HTTP {status}"))
        return {"t": "plan_get", "id": rid, "path": res.get("path") or "", "markdown": res["markdown"]}

    def do_plan_answer(self, msg: dict) -> dict:
        rid, choice, feedback, role = msg.get("id"), msg.get("choice"), msg.get("feedback"), msg.get("role")
        if not isinstance(rid, str) or not rid or not isinstance(choice, str) or not choice:
            raise RequestError("plan_answer needs an id and a choice")
        if (feedback is not None and not isinstance(feedback, str)) or (role is not None and not isinstance(role, str)):
            raise RequestError("feedback and role must be strings")
        if choice == "refine" and not (feedback or "").strip():
            return {"t": "plan_answer", "ok": False, "error": "Refining needs feedback"}
        info, reg = self.ext_pane(msg.get("target"))
        body = {"id": rid, "choice": choice, **({"feedback": feedback} if feedback else {}), **({"role": role} if role else {})}
        status, res = ext_http(reg, "POST", "/plan/answer", body)
        self.server.poll_now.set()
        if status != 200:
            return {"t": "plan_answer", "ok": False, "error": str(res.get("error") or f"HTTP {status}")}
        ok = res.get("ok") is True
        log(f"{self.peer}: plan review {choice} on {info['target']}: " + ("ok" if ok else str(res.get("error"))))
        return {"t": "plan_answer", "ok": ok, **({} if ok else {"error": str(res.get("error") or "refused")})}

    def do_plan_open(self, msg: dict) -> dict:
        _, reg = self.ext_pane(msg.get("target"))
        status, res = ext_http(reg, "POST", "/plan/open", {}, timeout=60.0)
        self.server.poll_now.set()
        if status != 200:
            return {"t": "plan_open", "ok": False, "error": str(res.get("error") or f"HTTP {status}")}
        ok = res.get("ok") is True
        return {"t": "plan_open", "ok": ok, **({} if ok else {"error": str(res.get("error") or "refused")})}

    def do_tree(self, msg: dict) -> dict:
        info = self.omp_pane(msg.get("target"))
        path = self.pane_session(info)
        return {"t": "tree", "target": info["target"], "sessionId": session_id_of(path), **session_tree(path)}

    def do_goto(self, msg: dict) -> dict:
        """Move the pane's session to an entry: `/devdeck-goto` (PaneCommand goto), which calls omp's
        navigateTree. A user prompt lands before it and comes back as `draft`, as omp's rewind does."""
        entry, summarize, rewind = msg.get("entryId"), msg.get("summarize") is True, msg.get("rewind") is True
        if not isinstance(entry, str) or not ENTRY_ID_RE.match(entry):
            raise RequestError("goto needs an entryId")
        info, _ = self.ext_pane(msg.get("target"))
        if info["working"]:
            raise RequestError("omp is working; stop it first", code="busy")
        obj = session_entry(self.pane_session(info), entry)
        if obj is None:
            raise RequestError(f"no entry {entry} in this session")
        m = obj.get("message") if obj.get("type") == "message" and isinstance(obj.get("message"), dict) else {}
        prompt = m.get("role") == "user"
        if rewind and not prompt:
            raise RequestError("rewind needs one of your prompts")
        try:
            self.server.run_cmd(info, "goto", f"{entry} summarize" if summarize else entry)
        except CmdFailed as ex:
            if "is working" in str(ex):
                raise RequestError(str(ex), code="busy") from None
            log(f"{self.peer}: goto {entry} on {info['target']} failed: {str(ex).splitlines()[0]}")
            return {"t": "goto", "ok": False, "error": str(ex)}
        log(f"{self.peer}: goto {entry} on {info['target']}" + (" (summarized)" if summarize else ""))
        return {"t": "goto", "ok": True, **({"draft": content_text(m.get("content"))} if prompt else {})}

    def do_settings(self, msg: dict) -> dict:
        return settings_state(self.roles_cwd(msg))

    def do_settings_set(self, msg: dict) -> dict:
        """`omp config set` (or `reset` for value null) of one global setting; answers the fresh list."""
        key, value = msg.get("key"), msg.get("value")
        if not isinstance(key, str) or not re.fullmatch(r"[\w.-]{1,128}", key):
            raise RequestError("settings_set needs a key")
        cwd = self.roles_cwd(msg)
        if settings_schema()["settings"].get(key, {}).get("credential") is True:
            raise RequestError(f"{key} holds a secret; change it on the PC")
        with self.server.roles_lock:
            if value is None:
                omp_config_write("reset", key)
            else:
                omp_config_set(key, value)
            state = settings_state(cwd)
        item = next((i for i in state["items"] if i["key"] == key), None)
        log(f"{self.peer}: omp setting {key} " + ("reset" if value is None else "set"))
        if item is not None and item["scope"] == "project" and value is not None and item.get("value") != value:
            raise RequestError(f"saved, but this project's .omp/config.yml still decides {key}; change it on the PC")
        return state

    def do_session_info(self, msg: dict) -> dict:
        info = self.omp_pane(msg.get("target"))
        return {"t": "session_info", **session_info(self.pane_session(info))}

    def do_usage(self, msg: dict) -> dict:
        """Provider usage limits (omp's /usage), plus with `target` that omp session's spend. A copy
        older than LIMITS_FRESH_S (any copy with `force`) comes back at once with `stale:true`; the
        refreshed limits follow as a `usage` push without `req` (with `error` when omp failed)."""
        target = msg.get("target")
        path = None
        if target is not None:
            try:
                info = self.omp_pane(target)
                path = breadcrumb_session(info["tty"], info["pid"])
            except RequestError:
                path = None  # the limits are global; only the session line is missing

        def pushed(data: dict, err: str | None) -> None:
            if self.closed:
                return
            out = self.usage_msg(data, target, path)
            if err:
                out["error"] = err
            self.push(out)
        data, refreshing = self.server.limits.get(msg.get("force") is True, pushed)
        out = self.usage_msg(data, target, path)
        if refreshing:
            out["stale"] = True
        return out

    def usage_msg(self, data: dict, target, path: str | None) -> dict:
        out = {"t": "usage", **{k: data.get(k) for k in ("fetchedAt", "generatedAt", "reports", "unavailable", "disabled", "resets")}}
        if isinstance(target, str):
            out["target"] = target
        if data.get("resetsError"):
            out["resetsError"] = data["resetsError"]
        try:
            cfg = omp_config()
            out["autoRedeem"] = {"openai-codex": cfg.get("codexResets.autoRedeem", "unset"),
                                 "anthropic": cfg.get("claudeResets.autoRedeem", "unset")}
        except RequestError:
            pass
        if path and os.path.isfile(path):
            try:
                tally = session_tally(path)
                out["session"] = {"tokens": tally["tokens"], "cost": tally["cost"]}
            except (OSError, ValueError, StaleFile):
                pass
        return out

    def do_usage_reset(self, msg: dict) -> dict:
        """Spends one saved rate-limit reset: `omp usage reset <provider>/<credential id>`
        (irreversible; the app confirms first). Refused unless a fresh `omp usage reset --json`
        lists the account with a reset usable now. `ok` = omp's count of the account's saved resets
        went down; `output` is what omp printed."""
        account = msg.get("account")
        m = RESET_ACCOUNT_RE.match(account) if isinstance(account, str) else None
        if m is None:
            raise RequestError("usage_reset needs an account as provider/credential id, e.g. openai-codex/3")
        provider, cred = m.group(1), int(m.group(2))

        def listed() -> dict | None:
            return next((a for a in reset_accounts() if a["provider"] == provider and a["credentialId"] == cred), None)
        if not self.server.reset_lock.acquire(blocking=False):
            raise RequestError("a saved reset is being spent already; wait for it to finish")
        try:
            before = listed()
            if before is None:
                raise RequestError(f"omp lists no account {account} for saved resets; refresh and try again")
            if isinstance(before.get("error"), str):
                raise RequestError(f"omp could not load the saved resets of {account}: {before['error']}")
            if not isinstance(before.get("redeemableCount"), int) or before["redeemableCount"] < 1:
                why = before.get("unavailableReason")
                raise RequestError(f"{account} has no saved reset usable now" + (f" ({why})" if isinstance(why, str) else ""))
            log(f"{self.peer}: spending a saved reset on {account} ({before.get('availableCount')} saved)")
            _, text = omp_cli(["usage", "reset", account], RESET_SPEND_S, want_json=False)
            try:
                after = listed()
            except RequestError:
                after = None
        finally:
            self.server.reset_lock.release()
        left = after.get("availableCount") if after else None
        ok = isinstance(left, int) and isinstance(before.get("availableCount"), int) and left < before["availableCount"]
        log(f"{self.peer}: usage reset {account}: {'spent' if ok else 'not spent'}, {last_line(text)}")
        return {"t": "usage_reset", "ok": ok, "account": account, "output": cap(text, 4000)[0],
                "left": left if isinstance(left, int) else None}

    def do_usage_history(self, msg: dict) -> dict:
        days = msg.get("days", 7)
        if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= HISTORY_DAYS_MAX:
            raise RequestError(f"usage_history needs days between 1 and {HISTORY_DAYS_MAX}")
        return usage_history(days)

    def do_session_delete(self, msg: dict) -> dict:
        sid = msg.get("id")
        _, fields = self.agent_pane(msg.get("target"))
        if not isinstance(sid, str) or not UUID_RE.match(sid.lower()):
            raise RequestError("session_delete needs a session id")
        sid = sid.lower()
        path = session_file(sid)
        if path is None:
            raise RequestError("no such session")
        if sid == fields["omp"]["sessionId"] or path in live_session_paths():
            raise RequestError("that session is open in a terminal; close it there first", code="live")
        with self.server.deliver_lock:
            trash_id = trash_session(path)
        log(f"{self.peer}: deleted session {sid} (trash {trash_id})")
        return {"t": "session_delete", "ok": True, "trashId": trash_id}

    def do_session_restore(self, msg: dict) -> dict:
        with self.server.deliver_lock:
            path = restore_session(msg.get("trashId"))
        log(f"{self.peer}: restored session {path}")
        return {"t": "session_restore", "ok": True}

    def roles_cwd(self, msg: dict) -> str | None:
        """The directory whose omp settings apply: the omp cwd of `target` when given (its project
        layer counts), else the home directory."""
        if msg.get("target") is None:
            return None
        _, fields = self.agent_pane(msg.get("target"))
        return fields["omp"]["cwd"]

    def do_roles_set(self, msg: dict) -> dict:
        """Writes one whole role setting with `omp config set`, if it still equals `base` (the value
        the phone edited), then answers with the fresh roles state."""
        key, value = msg.get("key"), msg.get("value")
        if key not in ROLE_SETTINGS:
            raise RequestError("roles_set key must be one of " + ", ".join(ROLE_SETTINGS))
        cwd = self.roles_cwd(msg)
        catalog = self.server.catalog
        catalog.get(wait=True)
        with self.server.roles_lock:
            cfg = omp_config(cwd, fresh=True)
            if key == "modelRoles" and cfg.get("modelRoleStorage") == "project":
                raise RequestError("model roles are saved per project here (modelRoleStorage: project); change them on the PC")
            cur = cfg.get(key) if isinstance(cfg.get(key), ROLE_SETTINGS[key]) else ROLE_SETTINGS[key]()
            if cur != msg.get("base"):
                raise RequestError(f"{key} changed on the PC; reloaded")
            check_role_setting(catalog, key, value, cur)
            omp_config_set(key, value)
            cfg = omp_config(cwd, fresh=True)
            if cfg.get(key, ROLE_SETTINGS[key]()) != value:
                raise RequestError(f"saved, but another config layer (a project .omp/config.yml) still decides {key}; "
                                   "change it on the PC")
        log(f"{self.peer}: set omp {key}")
        return roles_state(cfg)

    def do_cmd(self, msg: dict) -> dict:
        target, name = msg.get("target"), msg.get("cmd")
        if name not in PaneCommand.NAMES:
            return {"t": "cmd", "ok": False, "error": f"unknown command {name!r}"}
        if not isinstance(target, str) or not target:
            return {"t": "cmd", "ok": False, "error": "no target"}
        info = pane_info(target)
        if isinstance(info, str):
            return {"t": "cmd", "ok": False, "error": info}
        try:
            result = self.server.run_cmd(info, name, msg.get("arg"))
            reply = {"t": "cmd", "ok": True}
            if result:
                reply["info"] = result
            log(f"{self.peer}: cmd {name} on {info['target']}: ok" + (f" ({result})" if result else ""))
        except CmdFailed as ex:
            reply = {"t": "cmd", "ok": False, "error": str(ex)}
            log(f"{self.peer}: cmd {name} on {info['target']} failed: {str(ex).splitlines()[0]}")
        if name == "page":
            self.poke_page()
        return reply

    def do_sketch(self, msg: dict) -> dict:
        """`open`: start the pane's sketch canvas if needed, return its page and relay its events
        to this phone; `http`: one call of the page to its server."""
        op, target = msg.get("op"), msg.get("target")
        if not isinstance(target, str) or not target:
            raise RequestError("sketch needs a target")
        info = pane_info(target)
        if isinstance(info, str):
            raise RequestError(info)
        if not info["agent"]:
            raise RequestError("that terminal is not running omp")
        reg = sketch_registration(info["pid"])
        if reg is None:
            raise RequestError(SKETCH_MISSING)
        if op == "open":
            if reg["port"] is None:
                try:
                    self.server.run_cmd(info, "sketch", None)
                except CmdFailed as ex:
                    raise RequestError(str(ex)) from None
                reg = sketch_registration(info["pid"])
                if reg is None or reg["port"] is None:
                    raise RequestError("omp did not start the sketch canvas")
            status, _, html = sketch_http(reg, "GET", "/")
            if status != 200:
                raise RequestError(f"omp's sketch canvas answered HTTP {status}")
            feed = SketchFeed(self.push, info["target"], info["pid"])
            with self.cond:
                closed = self.closed
                old, self.sketch = self.sketch, None if closed else feed
            for f in (old, feed if closed else None):
                if f is not None:
                    f.stop()
            log(f"{self.peer}: sketch canvas of {info['target']} opened")
            return {"t": "sketch", "op": "open", "target": info["target"], "html": html}
        if op == "http":
            method, path, body = msg.get("method"), msg.get("path"), msg.get("body")
            if SKETCH_PATHS.get(path) != method or (body is not None and not isinstance(body, str)):
                raise RequestError(f"sketch http: {method} {path} is not allowed")
            if reg["port"] is None:
                raise RequestError("the sketch canvas was closed on the PC; open it again")
            status, ctype, text = sketch_http(reg, method, path, body.encode() if body is not None else None)
            if path == "/send":
                log(f"{self.peer}: sketch sent to {info['target']}: HTTP {status}")
            return {"t": "sketch", "op": "http", "status": status, "type": ctype, "body": text}
        raise RequestError("sketch op must be open, http or close")

    def close_sketch(self) -> None:
        with self.cond:
            feed, self.sketch = self.sketch, None
        if feed is not None:
            feed.stop()

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
    ctl = Path(args.ctl).expanduser() if args.ctl else CTL_SOCK
    try:
        server.ctl_serve(ctl)
    except OSError as ex:
        log(f"no local control socket ({ctl}): {ex}")

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

def install_ext() -> None:
    """Symlink the devdeck omp extension (omp-ext/devdeck) into omp's extension directory; omp
    processes started afterwards load it."""
    EXT_LINK.parent.mkdir(parents=True, exist_ok=True)
    if EXT_LINK.is_symlink() and EXT_LINK.resolve() == EXT_SRC.resolve():
        print(f"{EXT_LINK} already links to {EXT_SRC}")
        return
    if EXT_LINK.exists() or EXT_LINK.is_symlink():
        sys.exit(f"{EXT_LINK} exists and is not a link to {EXT_SRC}; move it away first")
    EXT_LINK.symlink_to(EXT_SRC, target_is_directory=True)
    print(f"linked {EXT_LINK} -> {EXT_SRC}; omp sessions started from now on load it (restart running ones)")


def cmd_install_ext(args) -> None:
    install_ext()


def cmd_install_service(args) -> None:
    install_ext()
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
# Only the daemon: the tmux server (terminals, omp sessions) runs in a scope of its own, and the
# daemon's own short-lived helpers may finish.
KillMode=process

[Install]
WantedBy=graphical-session.target
""")
    was_active = subprocess.run(["systemctl", "--user", "is-active", "--quiet", UNIT_NAME]).returncode == 0
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", UNIT_NAME], check=True)
    if was_active:
        adopt_tmux(UNIT_NAME)  # an older daemon's terminals would go down with the restart
        subprocess.run(["systemctl", "--user", "restart", UNIT_NAME], check=True)
    print(f"installed and started {UNIT_NAME}; logs: journalctl --user -u {UNIT_NAME} -f")


def cmd_adopt_tmux(args) -> None:
    adopt_tmux(UNIT_NAME)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, help=f"TCP port (default {DEFAULT_PORT}, or 47491 with --instance)")
    ap.add_argument("--instance", default=os.environ.get("DEVDECK_INSTANCE") or None, metavar="NAME",
                    help="run a separate side-by-side install NAME (own app package, token, state, unit "
                         "and port; env DEVDECK_INSTANCE)")
    sub = ap.add_subparsers(dest="cmd")
    p_serve = sub.add_parser("serve", help="run the daemon (default)")
    p_serve.add_argument("--ctl", metavar="PATH", help="local control socket for ddctl (default "
                                                       "<state dir>/ctl.sock)")
    p_pair = sub.add_parser("pair", help="install the app on the phone via adb and pair it")
    p_pair.add_argument("-s", "--serial", help="adb serial (default: the only device, else "
                                               f"{DEFAULT_SERIAL})")
    p_pair.add_argument("--rebuild", action="store_true", help="rebuild the APK first")
    p_svc = sub.add_parser("install-service", help="start the daemon with every graphical session (also "
                                                   "runs install-ext)")
    sub.add_parser("install-ext", help="link the devdeck omp extension (omp-ext/devdeck) into "
                                       "~/.omp/agent/extensions/")
    sub.add_parser("adopt-tmux", help="move the tmux server and its panes out of the daemon's service, so "
                                      "stopping or restarting it keeps the terminals (the daemon does this "
                                      "itself when it starts)")
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
    {"serve": cmd_serve, "pair": cmd_pair, "install-service": cmd_install_service,
     "install-ext": cmd_install_ext, "adopt-tmux": cmd_adopt_tmux}[args.cmd](args)


if __name__ == "__main__":
    main()
