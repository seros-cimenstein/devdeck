// File browser and viewer (ls/read requests), with a git entry point when inside a repo.
import { bridge, request } from "./bridge";
import { highlight, hydrate, renderMarkdown, sanitizeSvg } from "./md";
import { hooks } from "./state";
import type { GitStatusMsg, LsEntry, LsMsg, ReadMsg } from "./types";
import { errorEl, Panel, spinnerEl, toast } from "./ui";
import { basename, dirname, fmtAgo, fmtSize, h, homeDir, icon, joinPath, langForPath, learnHome, lsGet, lsSet, tildify } from "./util";

const repoOf = new Map<string, string | null>();

/** Repo root for a directory (cached), or null when not inside a git repo. */
export async function findRepo(path: string): Promise<string | null> {
  for (const [root, r] of repoOf) if (r && (path === root || path.startsWith(root + "/"))) return r;
  if (repoOf.has(path)) return repoOf.get(path) ?? null;
  try {
    const m = await request<GitStatusMsg>({ t: "git", path, op: "status" });
    repoOf.set(m.repo, m.repo);
    repoOf.set(path, m.repo);
    return m.repo;
  } catch {
    repoOf.set(path, null);
    return null;
  }
}

export class FilesPanel {
  private readonly panel: Panel;
  private readonly crumbs: HTMLElement;
  private readonly list: HTMLElement;
  private readonly gitBtn: HTMLButtonElement;
  private path = "";
  private repo: string | null = null;
  private showHidden = lsGet<boolean>("dd.hidden", false);
  private entries: LsEntry[] = [];
  private seq = 0;

  constructor(start: string) {
    this.panel = new Panel("Files", "files");
    this.gitBtn = this.panel.action("git", "Git", () => this.repo && hooks.openGit(this.repo));
    this.gitBtn.hidden = true;
    this.panel.action("eye", "Toggle hidden files", () => {
      this.showHidden = !this.showHidden;
      lsSet("dd.hidden", this.showHidden);
      this.renderList();
    });
    this.panel.action("up", "Up", () => this.path && this.go(dirname(this.path)));
    this.crumbs = h("div.crumbs");
    this.list = h("div.flist");
    this.panel.body.append(this.crumbs, this.list);
    this.go(start || "~");
  }

  private go(path: string) {
    const my = ++this.seq;
    this.list.textContent = "";
    this.list.append(spinnerEl("Loading"));
    request<LsMsg>({ t: "ls", path })
      .then((m) => {
        if (my !== this.seq) return;
        this.path = m.path;
        learnHome(m.path);
        this.entries = m.entries;
        this.renderCrumbs();
        this.renderList();
        this.list.scrollTop = 0;
        this.panel.body.scrollTop = 0;
        this.gitBtn.hidden = true;
        void findRepo(m.path).then((r) => {
          if (my !== this.seq) return;
          this.repo = r;
          this.gitBtn.hidden = !r;
        });
      })
      .catch((e: Error) => {
        if (my !== this.seq) return;
        this.list.textContent = "";
        this.list.append(errorEl(e.message, () => this.go(path)));
      });
  }

  private renderCrumbs() {
    const c = this.crumbs;
    c.textContent = "";
    const home = homeDir();
    let base = "";
    let parts: string[];
    if (home && (this.path === home || this.path.startsWith(home + "/"))) {
      base = home;
      parts = this.path.slice(home.length).split("/").filter(Boolean);
      c.append(h("button.crumb", { html: icon("home"), "aria-label": "Home", onclick: () => this.go(home) }));
    } else {
      parts = this.path.split("/").filter(Boolean);
      c.append(h("button.crumb", { text: "/", onclick: () => this.go("/") }));
    }
    let acc = base;
    for (const p of parts) {
      acc = acc + "/" + p;
      const to = acc;
      c.append(h("span.crumb-sep", { html: icon("chev") }), h("button.crumb", { text: p, onclick: () => this.go(to) }));
    }
    requestAnimationFrame(() => (c.scrollLeft = c.scrollWidth));
  }

  private renderList() {
    const l = this.list;
    l.textContent = "";
    const shown = this.entries.filter((e) => this.showHidden || !e.name.startsWith("."));
    if (!shown.length) {
      l.append(h("div.empty", { text: this.entries.length ? "Only hidden files" : "Empty folder" }));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const e of shown) {
      const full = joinPath(this.path, e.name);
      const isDir = e.type === "dir" || (e.type === "link" && e.linkTo === "dir");
      const ic = isDir ? "folder" : /\.(png|jpe?g|gif|webp|svg)$/i.test(e.name) ? "image" : e.type === "link" ? "link" : "file";
      frag.append(
        h(
          `button.frow${isDir ? ".dir" : ""}${e.name.startsWith(".") ? ".hid" : ""}`,
          { onclick: () => (isDir ? this.go(full) : hooks.openFile(full)) },
          h("span.icw", { html: icon(ic) }),
          h("span.f-name", { text: e.name }),
          h("span.f-meta", { text: isDir ? fmtAgo(e.mtime) : `${fmtSize(e.size)} · ${fmtAgo(e.mtime)}` }),
        ),
      );
    }
    l.append(frag);
  }
}

export function openFileViewer(path: string) {
  const panel = new Panel(basename(path), "viewer");
  panel.setTitle(basename(path), tildify(dirname(path)));
  const body = panel.body;
  body.append(spinnerEl("Loading"));
  let text = "";
  let wrap = lsGet<boolean>("dd.wrap", false);
  let rendered = true;
  const isMd = /\.(md|markdown|mdx)$/i.test(path);

  const copyBtn = panel.action("copy", "Copy text", () => {
    if (!text) return;
    bridge.copyText(text);
    toast("Copied to phone clipboard");
  });
  copyBtn.hidden = true;
  const modeBtn = panel.action("code", "Source / rendered", () => {
    rendered = !rendered;
    show();
  });
  modeBtn.hidden = true;
  const wrapBtn = panel.action("wrap", "Wrap lines", () => {
    wrap = !wrap;
    lsSet("dd.wrap", wrap);
    show();
  });
  wrapBtn.hidden = true;

  let msg: ReadMsg | null = null;
  const show = () => {
    const m = msg!;
    body.textContent = "";
    if (m.truncated) body.append(h("div.banner", { text: `Showing the first part of a ${fmtSize(m.size)} file` }));
    if (m.kind === "image" && m.data) {
      const mime = m.mime || "image/png";
      const box = h("div.imgview");
      if (mime.includes("svg")) {
        // Inline sanitized SVG so theme variables apply; fall back to <img> if sanitizing drops everything.
        const svg = sanitizeSvg(atob(m.data));
        if (/<svg[\s>]/i.test(svg)) {
          const host = h("div.svg-host");
          host.attachShadow({ mode: "open" }).innerHTML =
            `<style>:host{display:block;color:var(--fg)}svg{max-width:100%;height:auto;display:block;margin:auto}</style>${svg}`;
          box.append(host);
        } else box.append(h("img", { src: `data:${mime};base64,${m.data}`, alt: basename(path) }));
      } else {
        const img = h("img", { src: `data:${mime};base64,${m.data}`, alt: basename(path) });
        img.addEventListener("click", () => box.classList.toggle("zoom"));
        box.append(img);
      }
      body.append(box, h("div.img-meta", { text: `${mime} · ${fmtSize(m.size)}` }));
      return;
    }
    if (m.kind !== "text") {
      body.append(h("div.empty", { text: `Binary file (${m.mime || "unknown type"}, ${fmtSize(m.size)})` }));
      return;
    }
    copyBtn.hidden = false;
    modeBtn.hidden = !isMd;
    wrapBtn.hidden = isMd && rendered;
    wrapBtn.classList.toggle("on", wrap);
    if (isMd && rendered) {
      const d = h("div.md.doc", { html: renderMarkdown(text) });
      hydrate(d);
      body.append(d);
      return;
    }
    body.append(codeView(text, langForPath(path), wrap));
  };

  request<ReadMsg>({ t: "read", path })
    .then((m) => {
      msg = m;
      text = m.text ?? "";
      show();
    })
    .catch((e: Error) => {
      body.textContent = "";
      body.append(errorEl(e.message));
    });
}

export function codeView(text: string, lang: string | undefined, wrap: boolean): HTMLElement {
  const src = text.endsWith("\n") ? text.slice(0, -1) : text;
  let n = 1;
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  const nums = Array.from({ length: n }, (_, i) => i + 1).join("\n");
  return h(
    `div.codeview${wrap ? ".wrap" : ""}`,
    null,
    wrap ? null : h("pre.gutter", { text: nums }),
    h("div.cv-scroll", null, h("pre", null, h("code.hljs", { html: highlight(src, lang) }))),
  );
}
