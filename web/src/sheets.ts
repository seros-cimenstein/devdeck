// Native sheets for omp session controls: session history, session info, tasks, compact, rename, omp update.
import { bridge, request, send } from "./bridge";
import { errText, fmtTokens, isOnline, ompCmd, runCmd } from "./omp";
import { currentPane, hooks, paneTitle, state } from "./state";
import type { HistoryMsg, HistorySession, OkMsg, SessionDeleteMsg, SessionInfoMsg } from "./types";
import { confirmSheet, errorEl, Sheet, spinnerEl, toast } from "./ui";
import { dirname, fmtAgo, fmtSize, h, icon, tildify } from "./util";

// ---------------------------------------------------------------- history (resume)

/** Sessions of this folder (resume here) or of every project (others open in a new terminal); delete with Undo. */
export function openHistorySheet() {
  const p = currentPane();
  if (!p?.agent) return;
  const target = p.target;
  const s = new Sheet("Resume session", tildify(p.omp?.cwd || p.cwd), "tall");
  let all = false;
  const tabs = h("div.seg.mh-tabs");
  for (const [id, label] of [[false, "This folder"], [true, "All projects"]] as const)
    tabs.append(
      h("button.seg-b", {
        text: label,
        "data-all": String(id),
        onclick: () => {
          if (all === id) return;
          all = id;
          load();
        },
      }),
    );
  s.body.before(tabs);
  const load = () => {
    for (const b of tabs.children) b.classList.toggle("on", (b as HTMLElement).dataset.all === String(all));
    const wantAll = all;
    s.body.replaceChildren(spinnerEl("Loading sessions..."));
    s.body.scrollTop = 0;
    request<HistoryMsg>({ t: "history", target, ...(wantAll ? { all: true } : {}) }, 30_000)
      .then((m) => {
        if (!s.isOpen || all !== wantAll) return;
        if (m.cwd) s.setSub(tildify(m.cwd));
        if (!m.sessions?.length) {
          s.body.replaceChildren(h("div.empty", { text: wantAll ? "No sessions found" : "No earlier sessions in this folder" }));
          return;
        }
        const list = h("div.hs-list");
        for (const it of m.sessions) list.append(historyRow(it, target, s, wantAll && !!it.cwd && it.cwd !== m.cwd));
        s.body.replaceChildren(list);
      })
      .catch((e) => {
        if (s.isOpen && all === wantAll) s.body.replaceChildren(errorEl(errText(e), load));
      });
  };
  load();
}

/** One session; `other`: it belongs to another project, so it opens in a new terminal there. */
function historyRow(it: HistorySession, target: string, s: Sheet, other: boolean): HTMLElement {
  const meta = h("span.hs-meta", null, h("span", { text: fmtAgo(it.mtime) }));
  if (it.pinned) meta.prepend(h("span.icw.hs-pin", { html: icon("pin"), title: "Pinned" }));
  if (it.current) meta.append(h("span.tag.acc", { text: "Current" }));
  else if (it.live) meta.append(h("span.tag.ok", { text: "Live" }));
  const del = it.current || it.live ? null : (h("button.ib.mh-ib.hs-del", { "aria-label": "Delete session", title: "Delete", html: icon("trash") }) as HTMLButtonElement);
  const row = h(
    `div.hs-row${it.current ? ".cur" : ""}`,
    { role: "button", tabindex: 0 },
    h("span.hs-top", null, h("span.hs-title", { text: it.title || "Untitled session" }), meta),
    it.recap ? h("span.hs-recap", { text: it.recap }) : null,
    it.cwd ? h("span.hs-cwd", { text: tildify(it.cwd) }) : null,
    del,
  );
  const busy = (on: boolean) => {
    row.classList.toggle("busy", on);
    if (on) row.append(h("span.spin.xs.hs-spin"));
    else row.querySelector(".hs-spin")?.remove();
  };
  del?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!isOnline()) return toast("Offline", "err");
    busy(true);
    try {
      const m = await request<SessionDeleteMsg>({ t: "session_delete", target, id: it.id }, 30_000);
      if (!m.ok) throw new Error("The PC did not delete it");
      row.replaceWith(deletedRow(it, m.trashId, row));
    } catch (err) {
      toast(errText(err), "err");
    } finally {
      busy(false);
    }
  });
  const open = async () => {
    if (it.current) return toast("This is the session that is open now");
    if (other) {
      const ok = await confirmSheet({
        title: "Open in a new terminal?",
        text: `This session belongs to ${tildify(it.cwd!)}. DevDeck opens a new terminal there and resumes it with omp --resume.`,
        ok: "Open",
      });
      if (!ok) return;
      if (!send({ t: "new", cwd: it.cwd!, omp: true, resume: it.id })) return toast("Offline: cannot create a terminal", "err");
      toast("Opening a terminal...");
      s.close();
      return;
    }
    const p = state.byTarget.get(target);
    const working = p?.state === "working";
    if (working || it.live) {
      const ok = await confirmSheet({
        title: "Resume this session?",
        text: [
          working ? "The agent is working; switching sessions stops the current turn." : "",
          it.live ? "It is open in another terminal, so omp resumes a copy of it here." : "",
        ]
          .filter(Boolean)
          .join(" "),
        ok: "Resume",
        danger: working,
      });
      if (!ok) return;
    }
    busy(true);
    try {
      const m = await runCmd(target, "resume", it.id);
      toast(m.info || `Resumed: ${it.title || "session"}`, "ok");
      s.close();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      busy(false);
    }
  };
  row.addEventListener("click", () => void open());
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void open();
  });
  return row;
}

/** Stand-in for a deleted session with Undo (restores the files from the PC's trash). */
function deletedRow(it: HistorySession, trashId: string, row: HTMLElement): HTMLElement {
  const undo = h("button.btn.sm", { text: "Undo" }) as HTMLButtonElement;
  const gone = h("div.hs-row.hs-gone", null, h("span.hs-top", null, h("span.hs-title", { text: `Deleted: ${it.title || "Untitled session"}` }), undo));
  undo.addEventListener("click", async () => {
    undo.disabled = true;
    try {
      const m = await request<OkMsg>({ t: "session_restore", trashId }, 30_000);
      if (!m.ok) throw new Error(m.error || "The PC could not restore it");
      gone.replaceWith(row);
      toast("Session restored", "ok");
    } catch (e) {
      undo.disabled = false;
      toast(errText(e), "err");
    }
  });
  return gone;
}

// ---------------------------------------------------------------- session info

/** omp's /session facts for the current pane, read-only. */
export function openSessionInfo() {
  const p = currentPane();
  if (!p?.agent) return;
  const target = p.target;
  const s = new Sheet("Session info", paneTitle(p));
  const load = () => {
    s.body.replaceChildren(spinnerEl("Loading session facts..."));
    s.foot.hidden = true;
    request<SessionInfoMsg>({ t: "session_info", target }, 30_000)
      .then((m) => {
        if (s.isOpen) showSessionInfo(s, m);
      })
      .catch((e) => {
        if (s.isOpen) s.body.replaceChildren(errorEl(errText(e), load));
      });
  };
  load();
}

function showSessionInfo(s: Sheet, m: SessionInfoMsg) {
  const when = (ms: number) => (ms ? `${new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} (${fmtAgo(ms)})` : "\u2014");
  const t = m.tokens;
  const rows: [string, string, string?][] = [
    ["Title", m.title || "Untitled session"],
    ["ID", m.id, "mono"],
    ["Folder", tildify(m.cwd), "mono"],
    ["File", tildify(m.file), "mono"],
    ["Created", when(m.created)],
    ["Modified", when(m.modified)],
    ["Entries", String(m.entries)],
    ["Messages", `${m.userMessages} yours \u00b7 ${m.assistantMessages} assistant`],
    ["Tokens", `${fmtTokens(t.input)} in \u00b7 ${fmtTokens(t.output)} out`],
    ["Cache", `${fmtTokens(t.cacheRead)} read \u00b7 ${fmtTokens(t.cacheWrite)} write`],
    ["Cost", m.cost == null ? "unknown" : `$${m.cost.toFixed(m.cost < 1 ? 3 : 2)}`],
    ["Artifacts", fmtSize(m.artifactsBytes)],
    ["Side questions", String(m.btwTopics)],
  ];
  if (m.parentSession) rows.push(["Forked from", m.parentSession, "mono"]);
  s.setSub(m.title || s.subEl.textContent || "");
  const facts = h("div.mh-facts.si-facts", null, ...rows.flatMap(([k, v, cls]) => [h("span.mh-fk", { text: k }), h(`span.mh-fv${cls ? `.${cls}` : ""}`, { text: v })]));
  const kids: HTMLElement[] = [facts];
  if (m.models?.length) {
    kids.push(h("div.ms-sec", null, h("span", { text: "Models" }), h("span.count", { text: String(m.models.length) })));
    const box = h("div.si-models");
    for (const x of [...m.models].sort((a, b) => b.count - a.count))
      box.append(h("div.si-model", null, h("span.ms-id", { text: x.model }), h("span.si-n", { text: `${x.count} repl${x.count === 1 ? "y" : "ies"}` })));
    kids.push(box);
  }
  s.body.replaceChildren(...kids);
  s.foot.hidden = false;
  s.foot.classList.add("row");
  s.foot.replaceChildren(
    h("button.btn.wide", {
      text: "Copy ID",
      onclick: () => {
        bridge.copyText(m.id);
        toast("Session ID copied", "ok");
      },
    }),
    h("button.btn.wide", {
      text: "Show in Files",
      onclick: () => {
        s.close();
        hooks.openFiles(dirname(m.file));
      },
    }),
  );
}

// ---------------------------------------------------------------- tasks

interface TodoItem {
  done: boolean;
  active: boolean;
  text: string;
}
interface TodoPhase {
  name: string;
  items: TodoItem[];
}

/** Parses omp's todo tool output (phase headers + `- [X]`/`- [ ]` rows); empty when the format is unknown. */
function parseTodo(text: string): TodoPhase[] {
  const phases: TodoPhase[] = [];
  let cur: TodoPhase | null = null;
  for (const line of text.split("\n")) {
    const item = /^\s*- \[([ xX])\] (.*)$/.exec(line);
    if (item) {
      if (!cur) phases.push((cur = { name: "", items: [] }));
      const active = /\s\(in progress\)$/.test(item[2]);
      cur.items.push({ done: item[1] !== " ", active, text: active ? item[2].replace(/\s\(in progress\)$/, "") : item[2] });
      continue;
    }
    const ph = /^ {2}(\S.*):$/.exec(line);
    if (ph) phases.push((cur = { name: ph[1], items: [] }));
  }
  return phases.filter((p) => p.items.length);
}

export function openTasksSheet() {
  const p = currentPane();
  const todo = p?.omp?.todo;
  if (!p || !todo) return;
  const s = new Sheet("Tasks", `${todo.done}/${todo.total} done · ${paneTitle(p)}`);
  const phases = parseTodo(todo.text);
  if (!phases.length) {
    s.body.append(h("pre.todo-raw", { text: todo.text }));
    return;
  }
  const box = h("div.todo");
  for (const ph of phases) {
    const done = ph.items.filter((i) => i.done).length;
    if (ph.name) box.append(h("div.ms-sec", null, h("span", { text: ph.name }), h("span.count", { text: `${done}/${ph.items.length}` })));
    for (const it of ph.items)
      box.append(
        h(
          `div.todo-it${it.done ? ".done" : ""}${it.active ? ".active" : ""}`,
          null,
          h("span.todo-mk", { html: it.done ? icon("check") : "" }),
          h("span.todo-t", { text: it.text }),
        ),
      );
  }
  s.body.append(box);
}

// ---------------------------------------------------------------- compact / rename

export function openCompactSheet() {
  const p = currentPane();
  if (!p?.agent) return;
  const s = new Sheet("Compact context", paneTitle(p), "small");
  const ctx = p.omp?.ctx;
  const focus = h("textarea.field", { rows: 2, placeholder: "Focus (optional): what the summary should keep", maxlength: 500 }) as HTMLTextAreaElement;
  s.body.append(h("p.sheet-text", { text: "omp summarises the conversation so far and continues from the summary. This runs a model call on the PC and can take a minute." }));
  if (ctx) s.body.append(h("p.sheet-text.muted", { text: `Context now: ${fmtTokens(ctx.used)} of ${fmtTokens(ctx.window)} tokens (${Math.round((ctx.used / ctx.window) * 100)}%)` }));
  s.body.append(focus);
  if (p.state === "working") s.body.append(h("p.sheet-warn", { text: "The agent is working: compacting now stops the current turn." }));
  const go = h(`button.btn.primary.wide${p.state === "working" ? ".danger" : ""}`, { text: "Compact" }) as HTMLButtonElement;
  go.disabled = !isOnline();
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.textContent = "";
    go.append(h("span.spin.xs"), h("span", { text: "Starting..." }));
    const ok = await ompCmd("compact", focus.value.trim().replace(/\s+/g, " ") || undefined, "Compacting...");
    if (ok) s.close();
    else {
      go.disabled = false;
      go.textContent = "Compact";
    }
  });
  s.foot.hidden = false;
  s.foot.append(go);
}

export function openRenameSheet() {
  const p = currentPane();
  if (!p?.agent) return;
  const s = new Sheet("Rename session", paneTitle(p), "small");
  const input = h("input.field", { type: "text", placeholder: "Session title", maxlength: 120, enterkeyhint: "done" }) as HTMLInputElement;
  const go = h("button.btn.primary.wide", { text: "Rename" }) as HTMLButtonElement;
  const sync = () => (go.disabled = !input.value.trim() || !isOnline());
  const submit = async () => {
    const title = input.value.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!title) return;
    go.disabled = true;
    go.textContent = "";
    go.append(h("span.spin.xs"), h("span", { text: "Renaming..." }));
    try {
      const m = await runCmd(p.target, "rename", title);
      toast(`Renamed: ${m.info || title}`, "ok");
      s.close();
    } catch (e) {
      toast((e as Error).message, "err");
      go.textContent = "Rename";
      sync();
    }
  };
  input.addEventListener("input", sync);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
  go.addEventListener("click", () => void submit());
  sync();
  s.body.append(input, h("p.sheet-text.muted.rn-hint", { text: "omp may reformat the title (it runs a short model call)." }));
  s.foot.hidden = false;
  s.foot.append(go);
  setTimeout(() => input.focus(), 320);
}

// ---------------------------------------------------------------- omp update

interface OmpUpdateMsg {
  ok: boolean;
  check: boolean;
  before: string;
  after: string;
  output: string;
}

/** Runs `omp update` (or `--check`) on the PC and shows versions and output. */
export function openOmpUpdate() {
  const s = new Sheet("Update omp", "on the PC", "small");
  const intro = h("p.sheet-text", {
    text: "Installs the newest omp on the PC. Terminals already running omp keep their version until you restart them (/restart, or exit and start omp again).",
  });
  const out = h("div.ou-out");
  const check = h("button.btn.wide", { text: "Check only" }) as HTMLButtonElement;
  const go = h("button.btn.wide.primary", { text: "Update" }) as HTMLButtonElement;
  const run = (dry: boolean) => {
    if (!isOnline()) return toast("Offline", "err");
    check.disabled = go.disabled = true;
    out.textContent = "";
    out.append(spinnerEl(dry ? "Checking for updates..." : "Updating omp (can take a few minutes)..."));
    request<OmpUpdateMsg>({ t: "omp_update", check: dry }, 11 * 60_000)
      .then((m) => {
        out.textContent = "";
        const changed = m.after !== m.before;
        const head = m.check
          ? `Installed: ${m.before}`
          : changed
            ? `Updated: ${m.before} \u2192 ${m.after}`
            : m.ok
              ? `Already up to date: ${m.after}`
              : `Update failed (still ${m.after})`;
        out.append(h(`div.ou-head${m.ok ? "" : ".err"}`, { text: head }));
        if (m.output) out.append(h("pre.ou-log", { text: m.output }));
        if (!m.check && changed) toast(`omp updated to ${m.after}`, "ok");
      })
      .catch((e: Error) => {
        out.textContent = "";
        out.append(errorEl(e.message, () => run(dry)));
      })
      .finally(() => {
        check.disabled = go.disabled = false;
      });
  };
  check.addEventListener("click", () => run(true));
  go.addEventListener("click", () => run(false));
  s.body.append(intro, out);
  s.foot.hidden = false;
  s.foot.classList.add("row");
  s.foot.append(check, go);
}
