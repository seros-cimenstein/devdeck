// Native session tree (omp's /tree) and transcript rewind (/rewind, /branch) from the daemon's `tree`
// skeleton; moving the session leaf goes through `goto` (the devdeck extension's navigateTree).
import { request } from "./bridge";
import { errText, isOnline } from "./omp";
import { hooks, paneTitle, state } from "./state";
import type { GotoMsg, TreeEntry, TreeKind, TreeMsg } from "./types";
import { confirmSheet, errorEl, Sheet, spinnerEl, toast } from "./ui";
import { fmtAgo, h, icon } from "./util";

const KIND: Record<TreeKind, [glyph: string, label: string]> = {
  user: ["\u203a", "You"],
  assistant: ["\u25c6", "Assistant"],
  tool: ["\u2699", "Tool"],
  compaction: ["\u21ca", "Compaction"],
  branch_summary: ["\u2442", "Branch summary"],
  notice: ["\u2022", "Notice"],
  other: ["\u00b7", "Entry"],
};

const busyWarn = () => h("p.sheet-warn.tr-warn", { text: "The agent is working: stop it or wait for the turn to end before moving in the session." });

/** Moves the session to `entryId`; a rewind puts the prompt back into the compose box. True on success. */
async function goTo(target: string, entryId: string, o: { summarize?: boolean; rewind?: boolean }): Promise<boolean> {
  if (!isOnline()) {
    toast("Offline: this needs the PC", "err");
    return false;
  }
  try {
    const m = await request<GotoMsg>({ t: "goto", target, entryId, ...(o.summarize ? { summarize: true } : {}), ...(o.rewind ? { rewind: true } : {}) }, 90_000);
    if (!m.ok) throw new Error(m.error || "omp could not move there");
    if (m.draft) hooks.setDraft(target, m.draft);
    const where = o.rewind ? "Rewound" : o.summarize ? "Moved, with a summary of the branch you left" : "Moved to that point";
    toast(m.draft ? `${where}: the prompt is in the compose box` : where, "ok");
    return true;
  } catch (e) {
    toast(errText(e), "err");
    return false;
  }
}

/** Loads the tree into `s.body` (spinner, error with Retry) and calls `show` with it. */
function loadTree(s: Sheet, target: string, show: (m: TreeMsg) => void) {
  s.body.replaceChildren(spinnerEl("Loading the session..."));
  request<TreeMsg>({ t: "tree", target }, 60_000)
    .then((m) => {
      if (s.isOpen) show(m);
    })
    .catch((e) => {
      if (s.isOpen) s.body.replaceChildren(errorEl(errText(e), () => loadTree(s, target, show)));
    });
}

// ---------------------------------------------------------------- rewind / branch

/** This path's prompts, newest first; tapping one rewinds to just before it (omp's /rewind, /branch). */
export function openRewind(branch = false) {
  const p = state.byTarget.get(state.target);
  if (!p?.agent) return;
  const target = p.target;
  const s = new Sheet(branch ? "Branch from a prompt" : "Rewind", paneTitle(p), "tall");
  loadTree(s, target, (m) => {
    const prompts = m.entries.filter((e) => e.onPath && e.kind === "user").reverse();
    const kids: HTMLElement[] = [
      h("p.sheet-text.muted.tr-intro", {
        text: "Pick a prompt to go back to just before it. It comes back into the compose box to edit and send again; later messages stay in the session as a branch (see Session tree).",
      }),
    ];
    if (state.byTarget.get(target)?.state === "working") kids.push(busyWarn());
    if (!prompts.length) kids.push(h("div.empty", { text: "No prompts on this path yet" }));
    const list = h("div.hs-list");
    prompts.forEach((e, i) => {
      const row = h(
        "button.hs-row",
        null,
        h("span.hs-top", null, h("span.hs-title.tr-prompt", { text: e.preview || "(empty prompt)" }), h("span.hs-meta", null, h("span", { text: fmtAgo(e.ts) }))),
        h("span.hs-recap", { text: i === 0 ? "Latest prompt" : `${i} later prompt${i > 1 ? "s" : ""}` }),
      );
      row.addEventListener("click", async () => {
        const ok = await confirmSheet({
          title: "Rewind here?",
          text: `omp goes back to just before \u201c${e.preview.slice(0, 80)}${e.preview.length > 80 ? "\u2026" : ""}\u201d and the prompt returns to the compose box. Nothing is deleted: the later conversation stays as a branch.`,
          ok: "Rewind",
        });
        if (!ok) return;
        row.classList.add("busy");
        row.append(h("span.spin.xs.hs-spin"));
        if (await goTo(target, e.id, { rewind: true })) s.close();
        row.classList.remove("busy");
        row.querySelector(".hs-spin")?.remove();
      });
      list.append(row);
    });
    kids.push(list);
    s.body.replaceChildren(...kids);
  });
}

// ---------------------------------------------------------------- tree

interface Node {
  e: TreeEntry;
  kids: Node[];
}

/** Rows in display order: a branch point indents its children; a single child continues at the same depth. */
interface Row {
  e: TreeEntry;
  depth: number;
  /** First entry of a side branch (its parent has several visible children). */
  fork: boolean;
  /** Visible children count. */
  branches: number;
}

/**
 * Builds the visible forest: hidden entries (filter) hand their children to the nearest visible ancestor.
 * Children are ordered oldest first, with the child on the current path last so the path reads straight down.
 */
function layout(entries: TreeEntry[], visible: (e: TreeEntry) => boolean): Row[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const nodes = new Map<string, Node>();
  for (const e of entries) if (visible(e)) nodes.set(e.id, { e, kids: [] });
  const roots: Node[] = [];
  for (const n of nodes.values()) {
    let pid = n.e.parentId;
    while (pid && !nodes.has(pid)) pid = byId.get(pid)?.parentId ?? null;
    (pid ? nodes.get(pid)!.kids : roots).push(n);
  }
  const order = (a: Node, b: Node) => Number(a.e.onPath) - Number(b.e.onPath) || a.e.ts - b.e.ts;
  const rows: Row[] = [];
  // Iterative DFS: deep sessions would overflow a recursive walk.
  const stack: { n: Node; depth: number; fork: boolean }[] = roots.sort(order).reverse().map((n) => ({ n, depth: 0, fork: roots.length > 1 }));
  while (stack.length) {
    const { n, depth, fork } = stack.pop()!;
    n.kids.sort(order);
    rows.push({ e: n.e, depth, fork, branches: n.kids.length });
    const many = n.kids.length > 1;
    for (let i = n.kids.length - 1; i >= 0; i--) {
      const k = n.kids[i];
      // Side branches indent; the on-path (or last) child continues at the parent's depth.
      const side = many && i < n.kids.length - 1;
      stack.push({ n: k, depth: side ? depth + 1 : depth, fork: side });
    }
  }
  return rows;
}

type Filter = "user" | "all";
const MAX_INDENT = 6;

/** The whole session file as a tree (omp's /tree): branch points, current leaf, labels; tap an entry to go there. */
export function openTree() {
  const p = state.byTarget.get(state.target);
  if (!p?.agent) return;
  const target = p.target;
  const s = new Sheet("Session tree", paneTitle(p), "tall");
  let filter: Filter = "user";
  let data: TreeMsg | null = null;
  const seg = h("div.seg.tr-seg");
  for (const [id, label] of [["user", "Prompts"], ["all", "Everything"]] as const)
    seg.append(
      h("button.seg-b", {
        text: label,
        "data-f": id,
        onclick: () => {
          filter = id;
          render(true);
        },
      }),
    );
  s.body.before(seg);

  const render = (scrollToLeaf: boolean) => {
    for (const b of seg.children) b.classList.toggle("on", (b as HTMLElement).dataset.f === filter);
    const m = data;
    if (!m) return;
    const visible = (e: TreeEntry) =>
      filter === "all" || e.kind === "user" || e.kind === "branch_summary" || e.kind === "compaction" || e.id === m.leafId || !!e.label;
    const rows = layout(m.entries, visible);
    const forks = rows.filter((r) => r.branches > 1).length;
    s.setSub(`${paneTitle(state.byTarget.get(target))} \u00b7 ${m.entries.length} entries${forks ? ` \u00b7 ${forks} branch point${forks > 1 ? "s" : ""}` : ""}`);
    const kids: HTMLElement[] = [];
    if (state.byTarget.get(target)?.state === "working") kids.push(busyWarn());
    if (!rows.length) kids.push(h("div.empty", { text: "This session has no entries yet" }));
    const list = h("div.tr-list");
    for (const r of rows) {
      const e = r.e;
      const [glyph, kindLabel] = KIND[e.kind] ?? KIND.other;
      const cur = e.id === m.leafId;
      const row = h(
        `button.tr-row.k-${e.kind}${e.onPath ? ".on" : ""}${cur ? ".cur" : ""}`,
        { style: `--d:${Math.min(r.depth, MAX_INDENT)}`, "aria-label": `${kindLabel}: ${e.preview}` },
        h("span.tr-g", { text: r.fork ? "\u2514" : glyph }),
        h(
          "span.tr-main",
          null,
          h("span.tr-l1", null, e.label ? h("span.tag.acc", { text: e.label }) : null, h("span.tr-pv", { text: e.preview || `(${kindLabel.toLowerCase()})` })),
          h(
            "span.tr-meta",
            null,
            r.fork && r.depth > MAX_INDENT ? h("span", { text: `depth ${r.depth}` }) : null,
            h("span", { text: fmtAgo(e.ts) }),
            r.branches > 1 ? h("span.tr-br", null, h("span.icw", { html: icon("git") }), h("span", { text: `${r.branches} branches` })) : null,
            cur ? h("span.tag.acc", { text: "Current" }) : null,
          ),
        ),
      );
      row.addEventListener("click", () => openEntry(e, kindLabel, cur));
      list.append(row);
    }
    // The leaf may be hidden by the filter: the last on-path row then marks where the session is.
    let here = list.querySelector<HTMLElement>(".tr-row.cur");
    if (!here) {
      const onPath = list.querySelectorAll<HTMLElement>(".tr-row.on");
      here = onPath[onPath.length - 1] ?? null;
      here?.classList.add("here");
    }
    kids.push(list);
    s.body.replaceChildren(...kids);
    if (scrollToLeaf) here?.scrollIntoView({ block: "center" });
  };

  const openEntry = (e: TreeEntry, kindLabel: string, cur: boolean) => {
    const a = new Sheet(kindLabel, fmtAgo(e.ts), "small");
    a.body.append(h("p.sheet-text.tr-full", { text: e.preview || "(no text)" }));
    if (e.label) a.body.append(h("p.sheet-text.muted", null, h("span.tag.acc", { text: e.label })));
    if (cur) a.body.append(h("p.sheet-text.muted", { text: "The session is here now." }));
    else if (e.onPath) a.body.append(h("p.sheet-text.muted", { text: "On the current path: going here drops the later entries from the context (they stay in the file as a branch)." }));
    else a.body.append(h("p.sheet-text.muted", { text: "On another branch: going here switches the conversation to it." }));
    const act = async (btn: HTMLButtonElement, o: { summarize?: boolean; rewind?: boolean }) => {
      for (const b of a.foot.querySelectorAll("button")) (b as HTMLButtonElement).disabled = true;
      btn.replaceChildren(h("span.spin.xs"), h("span", { text: "Moving..." }));
      if (await goTo(target, e.id, o)) {
        a.close();
        s.close();
        return;
      }
      a.close();
    };
    const mk = (label: string, cls: string, o: { summarize?: boolean; rewind?: boolean }) => {
      const b = h(`button.btn.wide${cls}`, { text: label, disabled: cur && !o.rewind }) as HTMLButtonElement;
      b.addEventListener("click", () => void act(b, o));
      return b;
    };
    a.foot.hidden = false;
    a.foot.append(mk("Go here", ".primary", {}), mk("Go here with a summary", "", { summarize: true }));
    if (e.kind === "user") a.foot.append(mk("Rewind before this prompt (edit it)", "", { rewind: true }));
  };

  loadTree(s, target, (m) => {
    data = m;
    render(true);
  });
  render(false);
}
