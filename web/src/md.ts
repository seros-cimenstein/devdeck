// Markdown rendering: markdown-it + KaTeX + highlight.js, with lazy mermaid and sanitized inline SVG.
import MarkdownIt from "markdown-it";
import mdKatex from "@vscode/markdown-it-katex";
import katex from "katex";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import { esc, icon } from "./util";

const HL_MAX = 80_000;

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
// The plugin is CommonJS with `exports.default`; depending on interop the import is the function or the module.
const katexModule: unknown = mdKatex;
const katexPlugin =
  typeof katexModule === "function"
    ? mdKatex
    : (katexModule as { default: typeof mdKatex }).default;
md.use(katexPlugin, { throwOnError: false });
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

export function highlight(code: string, lang?: string): string {
  if (lang && code.length <= HL_MAX && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      /* fall through to plain */
    }
  }
  return esc(code);
}

function codeBlock(code: string, lang: string): string {
  const body = highlight(code.replace(/\n$/, ""), lang);
  return (
    `<div class="code"><div class="code-h"><span>${esc(lang || "text")}</span>` +
    `<button class="code-copy" data-act="copy" aria-label="Copy">${icon("copy")}<span>Copy</span></button></div>` +
    `<pre><code class="hljs">${body}</code></pre></div>`
  );
}

md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx];
  const lang = t.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const src = t.content;
  if (lang === "mermaid") return `<div class="diagram mermaid-box" data-src="${esc(src)}"><div class="dg-wait">Diagram</div></div>`;
  if (lang === "svg") return `<div class="diagram svg-box" data-src="${esc(src)}"></div>`;
  if (lang === "math" || lang === "latex" || lang === "tex" || lang === "katex") {
    try {
      return `<div class="katex-block">${katex.renderToString(src, { displayMode: true, throwOnError: false })}</div>`;
    } catch {
      /* render as code */
    }
  }
  return codeBlock(src, lang);
};
md.renderer.rules.code_block = (tokens, idx) => codeBlock(tokens[idx].content, "");
md.renderer.rules.table_open = () => '<div class="table-wrap"><table>';
md.renderer.rules.table_close = () => "</table></div>";

export function renderMarkdown(src: string): string {
  try {
    return md.render(src);
  } catch {
    return `<p>${esc(src)}</p>`;
  }
}

export function renderInline(src: string): string {
  try {
    return md.renderInline(src);
  } catch {
    return esc(src);
  }
}

/** Creates the markdown container and hydrates diagrams in it. */
export function markdownEl(src: string, cls = "md"): HTMLElement {
  const d = document.createElement("div");
  d.className = cls;
  d.innerHTML = renderMarkdown(src);
  hydrate(d);
  return d;
}

// ---- inline SVG (omp's ```svg fences): sanitized, isolated in a shadow root so <style> cannot leak,
// while CSS custom properties from the theme still inherit into it.
const SVG_SHADOW_CSS =
  ":host{display:block;color:var(--fg)}svg{display:block;max-width:100%;height:auto;margin:0 auto;}";

export function sanitizeSvg(src: string): string {
  return DOMPurify.sanitize(src, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["style"] });
}

function mountSvg(box: HTMLElement) {
  const src = box.dataset.src || "";
  box.removeAttribute("data-src");
  const clean = sanitizeSvg(src);
  if (!/<svg[\s>]/i.test(clean)) {
    box.outerHTML = codeBlock(src, "xml");
    return;
  }
  const root = box.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${SVG_SHADOW_CSS}</style>${clean}`;
}

// ---- mermaid: loaded on first sight of a diagram, rendered when scrolled into view.
interface MermaidApi {
  initialize(cfg: Record<string, unknown>): void;
  render(id: string, src: string): Promise<{ svg: string }>;
}
let mermaidP: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  if (mermaidP) return mermaidP;
  const { promise, resolve, reject } = Promise.withResolvers<MermaidApi>();
  mermaidP = promise;
  const s = document.createElement("script");
  s.src = "mermaid.js";
  s.async = true;
  s.onload = () => {
    // mermaid.min.js is an IIFE that assigns window.mermaid.
    const w: Window & { mermaid?: MermaidApi } = window;
    const m = w.mermaid;
    if (!m) return reject(new Error("mermaid missing"));
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => cs.getPropertyValue(n).trim();
    m.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: "system-ui, sans-serif",
      themeVariables: {
        darkMode: true,
        background: v("--surface"),
        primaryColor: v("--surface2"),
        primaryTextColor: v("--fg"),
        primaryBorderColor: v("--accent"),
        secondaryColor: "#1f2a3a",
        tertiaryColor: "#20262f",
        lineColor: v("--muted"),
        textColor: v("--fg"),
        mainBkg: v("--surface2"),
        nodeBorder: v("--accent"),
        clusterBkg: v("--surface"),
        clusterBorder: v("--border"),
        edgeLabelBackground: v("--surface"),
        noteBkgColor: "#2a2614",
        noteTextColor: v("--fg"),
        actorBkg: v("--surface2"),
        actorBorder: v("--accent"),
        actorTextColor: v("--fg"),
        signalColor: v("--fg"),
        signalTextColor: v("--fg"),
        labelBoxBkgColor: v("--surface2"),
        fontSize: "14px",
      },
    });
    resolve(m);
  };
  s.onerror = () => {
    mermaidP = null;
    reject(new Error("could not load mermaid.js"));
  };
  document.head.append(s);
  return promise;
}

let mmChain: Promise<unknown> = Promise.resolve();
let mmSeq = 0;
function renderMermaid(box: HTMLElement) {
  const src = box.dataset.src || "";
  box.removeAttribute("data-src");
  box.classList.add("dg-loading");
  // mermaid.render is not re-entrant: serialize.
  mmChain = mmChain.then(async () => {
    try {
      const m = await loadMermaid();
      const { svg } = await m.render(`mmd${++mmSeq}`, src);
      box.classList.remove("dg-loading");
      box.innerHTML = svg;
    } catch (e) {
      box.classList.remove("dg-loading");
      box.innerHTML =
        `<div class="dg-err">Diagram error: ${esc(String((e as Error)?.message || e).slice(0, 300))}</div>` +
        codeBlock(src, "mermaid");
      document.querySelectorAll('[id^="dmmd"]').forEach((n) => n.remove());
    }
  });
}

const io =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (items) => {
          for (const it of items) {
            if (!it.isIntersecting) continue;
            io?.unobserve(it.target);
            renderMermaid(it.target as HTMLElement);
          }
        },
        { rootMargin: "600px 0px" },
      )
    : null;

export function hydrate(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(".svg-box[data-src]").forEach(mountSvg);
  root.querySelectorAll<HTMLElement>(".mermaid-box[data-src]").forEach((b) => {
    if (io) io.observe(b);
    else renderMermaid(b);
  });
}
