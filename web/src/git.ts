// Git status / diff / log panels.
import { request } from "./bridge";
import { hooks } from "./state";
import type { GitCommit, GitDiffMsg, GitFile, GitLogMsg, GitStatusMsg } from "./types";
import { errorEl, Panel, spinnerEl } from "./ui";
import { basename, esc, fmtAgo, h, joinPath, tildify } from "./util";

const DIFF_CHUNK = 3000;

export function openGit(path: string) {
  const panel = new Panel("Git", "git");
  const tabs = h("div.seg");
  const body = h("div.git-body");
  panel.body.append(tabs, body);
  let tab: "changes" | "log" = "changes";
  let repo = "";
  const tabBtn = (id: "changes" | "log", label: string) => {
    const b = h("button.seg-b", { text: label, onclick: () => ((tab = id), sel(), load()) });
    b.dataset.id = id;
    tabs.append(b);
  };
  const sel = () => tabs.querySelectorAll<HTMLElement>(".seg-b").forEach((b) => b.classList.toggle("on", b.dataset.id === tab));
  tabBtn("changes", "Changes");
  tabBtn("log", "Log");
  sel();
  panel.action("refresh", "Refresh", () => load());

  const load = () => {
    body.textContent = "";
    body.append(spinnerEl("Loading"));
    if (tab === "changes") {
      request<GitStatusMsg>({ t: "git", path, op: "status" })
        .then((m) => {
          if (tab !== "changes") return;
          repo = m.repo;
          renderStatus(m);
        })
        .catch((e: Error) => fail(e));
    } else {
      request<GitLogMsg>({ t: "git", path, op: "log" })
        .then((m) => {
          if (tab !== "log") return;
          repo = m.repo;
          renderLog(m.commits);
        })
        .catch((e: Error) => fail(e));
    }
  };
  const fail = (e: Error) => {
    body.textContent = "";
    body.append(errorEl(e.message, load));
  };

  const renderStatus = (m: GitStatusMsg) => {
    const track = m.upstream ? ` → ${m.upstream}` : "";
    const ab = [m.ahead ? `${m.ahead} ahead` : "", m.behind ? `${m.behind} behind` : ""].filter(Boolean).join(", ");
    panel.setTitle(m.branch || "(detached)", `${tildify(m.repo)}${track}${ab ? ` · ${ab}` : ""}`);
    body.textContent = "";
    const staged = m.files.filter((f) => f.index !== " " && f.index !== "?" && f.index !== "!");
    const unstaged = m.files.filter((f) => f.worktree !== " " && f.worktree !== "?" && f.index !== "?");
    const untracked = m.files.filter((f) => f.index === "?");
    if (!m.files.length) {
      body.append(h("div.empty", { text: "Working tree clean" }));
      return;
    }
    const actions = h("div.git-actions");
    if (unstaged.length) actions.append(h("button.btn", { text: "All changes", onclick: () => openDiff(repo, undefined, false) }));
    if (staged.length) actions.append(h("button.btn", { text: "All staged", onclick: () => openDiff(repo, undefined, true) }));
    if (actions.childNodes.length) body.append(actions);
    const section = (title: string, files: GitFile[], code: (f: GitFile) => string, open: (f: GitFile) => void) => {
      if (!files.length) return;
      body.append(h("div.g-sec", null, h("span", { text: title }), h("span.count", { text: String(files.length) })));
      for (const f of files) {
        const c = code(f);
        body.append(
          h(
            "button.g-file",
            { onclick: () => open(f) },
            h(`span.g-code.g-${statusClass(c)}`, { text: c }),
            h("span.g-path", null, h("span.g-base", { text: basename(f.path) }), h("span.g-dir", { text: dirOf(f.path) })),
          ),
        );
      }
    };
    section("Staged", staged, (f) => f.index, (f) => openDiff(repo, f.path, true));
    section("Changes", unstaged, (f) => f.worktree, (f) => openDiff(repo, f.path, false));
    section("Untracked", untracked, () => "?", (f) => hooks.openFile(joinPath(repo, f.path)));
  };

  const renderLog = (commits: GitCommit[]) => {
    body.textContent = "";
    if (!commits.length) {
      body.append(h("div.empty", { text: "No commits" }));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const c of commits) {
      frag.append(
        h(
          "div.commit",
          null,
          h("div.c-subj", { text: c.subject }),
          h("div.c-meta", null, h("span.c-hash", { text: c.short }), h("span", { text: `${c.author} · ${fmtAgo(c.date)}` })),
        ),
      );
    }
    body.append(frag);
  };

  load();
}

function statusClass(c: string): string {
  return { M: "mod", A: "add", D: "del", R: "ren", C: "ren", U: "conf", "?": "new", T: "mod" }[c] || "mod";
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function openDiff(repo: string, file: string | undefined, staged: boolean) {
  const panel = new Panel(file ? basename(file) : "All changes", "diffp");
  panel.setTitle(file ? basename(file) : staged ? "Staged changes" : "Unstaged changes", file ? dirOf(file) || tildify(repo) : tildify(repo));
  const seg = h("div.seg");
  const body = h("div.diff-body");
  panel.body.append(seg, body);
  let isStaged = staged;
  for (const [id, label] of [[false, "Unstaged"], [true, "Staged"]] as const) {
    const b = h("button.seg-b", { text: label });
    b.addEventListener("click", () => {
      isStaged = id;
      seg.querySelectorAll(".seg-b").forEach((x, i) => x.classList.toggle("on", (i === 1) === isStaged));
      load();
    });
    if (id === staged) b.classList.add("on");
    seg.append(b);
  }
  const load = () => {
    body.textContent = "";
    body.append(spinnerEl("Loading diff"));
    request<GitDiffMsg>({ t: "git", path: repo, op: "diff", file, staged: isStaged })
      .then((m) => {
        body.textContent = "";
        if (!m.diff.trim()) {
          body.append(h("div.empty", { text: isStaged ? "Nothing staged" : "No unstaged changes" }));
          return;
        }
        if (m.truncated) body.append(h("div.banner", { text: "Diff truncated" }));
        body.append(renderDiff(m.diff));
      })
      .catch((e: Error) => {
        body.textContent = "";
        body.append(errorEl(e.message, load));
      });
  };
  load();
}

/** Unified diff → rows with old/new line numbers; rendered in chunks to stay responsive. */
export function renderDiff(diff: string): HTMLElement {
  const lines = diff.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const box = h("div.diff");
  const inner = h("div.diff-in");
  box.append(inner);
  let oldNo = 0;
  let newNo = 0;
  let pos = 0;
  let adds = 0;
  let dels = 0;
  const row = (cls: string, a: string | number, b: string | number, text: string) =>
    `<div class="dl ${cls}"><span class="g"><i>${a}</i><i>${b}</i></span><span class="dc">${esc(text) || " "}</span></div>`;
  const chunk = () => {
    const out: string[] = [];
    const end = Math.min(lines.length, pos + DIFF_CHUNK);
    for (; pos < end; pos++) {
      const l = lines[pos];
      if (l.startsWith("diff --git ")) {
        const m = / b\/(.+)$/.exec(l);
        out.push(`<div class="dl d-file"><span class="dc">${esc(m ? m[1] : l.slice(11))}</span></div>`);
      } else if (l.startsWith("@@")) {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
        if (m) {
          oldNo = +m[1];
          newNo = +m[2];
        }
        out.push(row("d-hunk", "", "", l));
      } else if (/^(index |--- |\+\+\+ )/.test(l)) {
        continue;
      } else if (/^(new file|deleted file|similarity|rename |old mode|new mode|Binary files|copy )/.test(l)) {
        out.push(row("d-meta", "", "", l));
      } else if (l.startsWith("+")) {
        adds++;
        out.push(row("d-add", "", newNo++, l.slice(1)));
      } else if (l.startsWith("-")) {
        dels++;
        out.push(row("d-del", oldNo++, "", l.slice(1)));
      } else if (l.startsWith("\\")) {
        out.push(row("d-meta", "", "", l));
      } else {
        out.push(row("d-ctx", oldNo++, newNo++, l.slice(1)));
      }
    }
    inner.insertAdjacentHTML("beforeend", out.join(""));
    more.remove();
    if (pos < lines.length) {
      more.textContent = `Show more (${lines.length - pos} lines)`;
      box.append(more);
    }
  };
  const more = h("button.btn.ghost.more", { onclick: () => chunk() });
  chunk();
  const stats = h("div.diff-stats", null, h("span.add", { text: `+${adds}` }), h("span.del", { text: `-${dels}` }));
  if (pos >= lines.length) box.prepend(stats);
  return box;
}
