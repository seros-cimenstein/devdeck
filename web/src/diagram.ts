// Full-screen diagram viewer: pinch, drag, double-tap and wheel zoom; the phone's back key closes it.
import { bridge } from "./bridge";
import { pushLayer, removeLayer } from "./ui";
import { h } from "./util";

const PAD = 12; // px of air around the fitted diagram
const TAP_MS = 300; // max gap between a tap's lift and the next touch for a double tap
const TAP_SLOP = 12; // px a finger may move and still count as a tap
const ZOOM_TAP = 3; // double-tap zoom, relative to fit

/** The rendered <svg> of a .diagram box (mermaid or ```svg); null while loading or on a render error. */
export function diagramSvg(box: Element): SVGSVGElement | null {
  const host = box.querySelector<HTMLElement>(":scope > .svg-host");
  if (host) return host.shadowRoot?.querySelector("svg") ?? null;
  return box.querySelector<SVGSVGElement>(":scope > svg");
}

/** Diagram size in CSS px at scale 1: the viewBox (1 unit = 1 px), else the rendered size. */
function naturalSize(svg: SVGSVGElement): { w: number; h: number } {
  const vb = svg.viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return { w: vb.width, h: vb.height };
  const r = svg.getBoundingClientRect();
  return { w: r.width || 300, h: r.height || 150 };
}

interface Pt {
  x: number;
  y: number;
}

export function openDiagram(box: HTMLElement) {
  const src = diagramSvg(box);
  if (!src) return;
  const { w, h: ht } = naturalSize(src);

  // ```svg diagrams keep their shadow root (their <style> must not leak); mermaid output is cloned as is,
  // so it lays out exactly as mermaid measured it in the light DOM.
  const content = h("div.dg-content");
  let svg: SVGSVGElement;
  const host = box.querySelector<HTMLElement>(":scope > .svg-host");
  if (host?.shadowRoot) {
    const root = content.attachShadow({ mode: "open" });
    // Cloning nodes skips serializing and reparsing the markup.
    for (const n of host.shadowRoot.childNodes) root.append(n.cloneNode(true));
    svg = root.querySelector("svg")!;
  } else {
    svg = src.cloneNode(true) as SVGSVGElement;
    content.append(svg);
  }
  svg.style.maxWidth = "none";
  svg.style.margin = "0";
  svg.style.width = `${w}px`;
  svg.style.height = `${ht}px`;

  // No header: the status bar is hidden too, while the navigation bar stays for the back key and the
  // system's rotate suggestion (the viewer refits on rotation).
  const stage = h("div.dg-view", null, content);
  document.getElementById("app")!.append(stage);
  requestAnimationFrame(() => requestAnimationFrame(() => stage.classList.add("open")));
  // Once faded in, the covered chat/terminal stops being painted on every gesture frame.
  const coverTimer = setTimeout(() => document.body.classList.add("dg-covered"), 200);
  bridge.setFullscreen(true);

  // ---- view state: content point p shows at stage point p * s + t
  let s = 1;
  let tx = 0;
  let ty = 0;
  let fit = 1;
  let maxS = 4;
  let vw = 0;
  let vh = 0;

  // One style write per frame however many pointer events arrive.
  let frame = 0;
  const apply = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      content.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
    });
  };
  // While a gesture runs the diagram is a GPU layer that is only scaled (cheap, slightly soft); after it,
  // Chrome re-rasterizes the SVG once at the final scale, so text ends up sharp.
  let settleTimer = 0;
  const moving = (on: boolean) => {
    clearTimeout(settleTimer);
    if (on) content.classList.add("moving");
    else settleTimer = window.setTimeout(() => content.classList.remove("moving"), 120);
  };
  const clampS = (v: number) => Math.min(maxS, Math.max(fit, v));
  /** Centers an axis that fits, else keeps the diagram's edges from leaving the screen. */
  const clampT = () => {
    const cw = w * s;
    const ch = ht * s;
    tx = cw <= vw ? (vw - cw) / 2 : Math.min(0, Math.max(vw - cw, tx));
    ty = ch <= vh ? (vh - ch) / 2 : Math.min(0, Math.max(vh - ch, ty));
  };
  /** Zooms to `ns` keeping the content under stage point (cx, cy) in place. */
  const zoomAt = (ns: number, cx: number, cy: number) => {
    const px = (cx - tx) / s;
    const py = (cy - ty) / s;
    s = clampS(ns);
    tx = cx - px * s;
    ty = cy - py * s;
    clampT();
    apply();
  };
  const measure = () => {
    vw = stage.clientWidth;
    vh = stage.clientHeight;
    fit = Math.max(0.01, Math.min((vw - 2 * PAD) / w, (vh - 2 * PAD) / ht));
    maxS = Math.max(fit * 4, 4);
  };
  const toFit = () => {
    s = fit;
    clampT();
    apply();
  };
  const animate = (fn: () => void) => {
    content.classList.add("anim");
    fn();
    setTimeout(() => content.classList.remove("anim"), 260);
  };

  // Rotation or resize: refit when the diagram was fitted, else keep the same point centered.
  const ro = new ResizeObserver(() => {
    if (!stage.clientWidth || !stage.clientHeight) return;
    const first = vw === 0;
    const wasFit = s <= fit * 1.01;
    const px = (vw / 2 - tx) / s;
    const py = (vh / 2 - ty) / s;
    measure();
    if (first || wasFit) return toFit();
    s = clampS(s);
    tx = vw / 2 - px * s;
    ty = vh / 2 - py * s;
    clampT();
    apply();
  });
  ro.observe(stage);

  // ---- gestures: one finger pans, two pinch (and pan by their midpoint), double tap toggles zoom
  // The viewer covers the whole viewport, so client coordinates are stage coordinates.
  const pts = new Map<number, Pt>();
  let base: { s: number; tx: number; ty: number; c: Pt; d: number } | null = null;
  let tap: { x: number; y: number; t: number; moved: boolean } | null = null;
  let lastTap: { x: number; y: number; t: number } | null = null;

  const centroid = (): Pt => {
    let x = 0;
    let y = 0;
    for (const p of pts.values()) {
      x += p.x;
      y += p.y;
    }
    return { x: x / pts.size, y: y / pts.size };
  };
  const spread = () => {
    if (pts.size < 2) return 0;
    const [a, b] = pts.values();
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  /** New baseline whenever the finger count changes, so adding or lifting one never jumps. */
  const rebase = () => {
    base = pts.size ? { s, tx, ty, c: centroid(), d: spread() } : null;
  };

  stage.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    stage.setPointerCapture(e.pointerId);
    content.classList.remove("anim");
    moving(true);
    const p = { x: e.clientX, y: e.clientY };
    pts.set(e.pointerId, p);
    tap = pts.size === 1 ? { ...p, t: e.timeStamp, moved: false } : null;
    rebase();
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId) || !base) return;
    const p = { x: e.clientX, y: e.clientY };
    pts.set(e.pointerId, p);
    if (tap && Math.hypot(p.x - tap.x, p.y - tap.y) > TAP_SLOP) tap.moved = true;
    const c = centroid();
    const ns = pts.size >= 2 && base.d > 0 ? clampS((base.s * spread()) / base.d) : base.s;
    const px = (base.c.x - base.tx) / base.s;
    const py = (base.c.y - base.ty) / base.s;
    s = ns;
    tx = c.x - px * s;
    ty = c.y - py * s;
    clampT();
    apply();
  });
  const end = (e: PointerEvent) => {
    if (!pts.delete(e.pointerId)) return;
    rebase();
    if (!pts.size) moving(false);
    if (e.type !== "pointerup" || pts.size || !tap || tap.moved) return;
    const t = tap;
    tap = null;
    // Double tap: the second touch lands within TAP_MS of the first lift, near the same spot.
    if (lastTap && t.t - lastTap.t < TAP_MS && Math.hypot(t.x - lastTap.x, t.y - lastTap.y) < 40) {
      lastTap = null;
      animate(() => (s > fit * 1.05 ? toFit() : zoomAt(fit * ZOOM_TAP, t.x, t.y)));
    } else lastTap = { x: t.x, y: t.y, t: e.timeStamp };
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      moving(true);
      zoomAt(s * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
      moving(false);
    },
    { passive: false },
  );

  const layer = {
    close() {
      removeLayer(layer);
      ro.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(settleTimer);
      clearTimeout(coverTimer);
      document.body.classList.remove("dg-covered");
      bridge.setFullscreen(false);
      stage.classList.remove("open");
      setTimeout(() => stage.remove(), 200);
    },
  };
  pushLayer(layer);
}
