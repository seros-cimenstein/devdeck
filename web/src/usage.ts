// Native provider usage (omp's /usage): every account's quota windows as bars with their reset times, saved
// rate-limit resets (spending one asks first), this session's spend and an optional 7-day history per window.
import { request } from "./bridge";
import { errText, fmtTokens, isOnline } from "./omp";
import { currentPane, paneTitle, state } from "./state";
import type { ResetAccount, UsageHistoryMsg, UsageLimit, UsageMsg, UsageReport, UsageResetMsg, UsageSeries } from "./types";
import { confirmSheet, errorEl, Sheet, spinnerEl, toast } from "./ui";
import { fmtAgo, h, icon, lsGet, lsSet } from "./util";

const CACHE_KEY = "dd.usage";
/** A cold `omp usage` takes up to two minutes on the PC before the first answer. */
const LOAD_TIMEOUT_MS = 200_000;
/** A refresh the PC announced (`stale`) whose push never came (link lost) stops spinning after this. */
const PUSH_WAIT_MS = 200_000;
const HISTORY_DAYS = 7;

const PROVIDERS: Record<string, string> = {
  anthropic: "Claude",
  "openai-codex": "Codex",
  "github-copilot": "GitHub Copilot",
  "google-antigravity": "Antigravity",
  "google-gemini-cli": "Gemini CLI",
  "opencode-go": "OpenCode Go",
  zai: "Z.ai",
  "kimi-code": "Kimi Code",
  minimax: "MiniMax",
};
const providerName = (p: string) => PROVIDERS[p] ?? p.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** The last limits seen (without the session line), so the sheet opens with them at once, offline too. */
let last: UsageMsg | null = lsGet<UsageMsg | null>(CACHE_KEY, null);
let sheet: UsageSheet | null = null;

/** Keeps `m` unless an equal or newer copy is already known; true when `m` is the newest. */
function accept(m: UsageMsg): boolean {
  if (!Array.isArray(m.reports)) return false;
  if (last && last.fetchedAt > m.fetchedAt) return false;
  const { req: _req, session: _s, stale: _st, error: _e, target: _t, ...keep } = m;
  last = keep as UsageMsg;
  lsSet(CACHE_KEY, last);
  return true;
}

/** omp's /usage for the current omp pane (with its session's spend), else the limits alone. */
export function openUsage() {
  if (sheet?.isOpen) return;
  const p = currentPane();
  sheet = new UsageSheet(p?.agent ? p.target : "");
}

/** A `usage` push (no `req`): the refresh the PC announced with `stale:true` has ended. */
export function onUsagePush(m: UsageMsg) {
  accept(m);
  sheet?.onPush(m);
}

// ---------------------------------------------------------------- formatting

function maskEmail(e: string): string {
  const at = e.indexOf("@");
  if (at < 1) return e.length > 4 ? `${e.slice(0, 2)}\u2022\u2022\u2022` : e;
  return `${e[0]}\u2022\u2022\u2022${e.slice(at)}`;
}

/** "45 m", "2 h 14 m", "3 d 4 h". */
function fmtDur(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "<1 m";
  if (m < 60) return `${m} m`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return m % 60 ? `${hr} h ${m % 60} m` : `${hr} h`;
  const d = Math.floor(hr / 24);
  return hr % 24 ? `${d} d ${hr % 24} h` : `${d} d`;
}

/** Local time: "14:32" today, "Tue 09:00" within a week, else "Nov 6, 09:00". */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time;
  if (ms - now.getTime() < 6 * 86_400_000 && ms > now.getTime()) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

const pctOf = (l: UsageLimit): number | null => {
  const a = l.amount;
  if (typeof a.usedFraction === "number") return Math.min(1, Math.max(0, a.usedFraction));
  if (typeof a.used === "number" && typeof a.limit === "number" && a.limit > 0) return Math.min(1, a.used / a.limit);
  return null;
};

/** Bar colour: omp's status, else by how full the window is. */
function level(l: UsageLimit, f: number | null): "" | "warn" | "crit" | "unk" {
  if (l.status === "exhausted") return "crit";
  if (l.status === "warning") return "warn";
  if (l.status === "unknown" || f == null) return "unk";
  if (l.status === "ok") return "";
  return f >= 0.9 ? "crit" : f >= 0.7 ? "warn" : "";
}

function amountText(l: UsageLimit, f: number | null): string {
  const a = l.amount;
  if (f == null) return "not reported";
  const pct = `${Math.round(f * 100)}% used`;
  if (a.unit === "percent" || typeof a.limit !== "number" || !(a.limit > 0) || typeof a.used !== "number") return pct;
  return `${a.used.toLocaleString()} / ${a.limit.toLocaleString()} ${a.unit} \u00b7 ${pct}`;
}

/** "Claude 5 Hour" with window "5 Hour" stays as is; "Gemini" with window "Weekly" becomes "Gemini · Weekly". */
function limitName(l: UsageLimit): string {
  const w = l.window?.label;
  return w && !l.label.toLowerCase().includes(w.toLowerCase()) ? `${l.label} \u00b7 ${w}` : l.label;
}

/** omp repeats a shared window once per model family (`scope.sharedGroup`); shown once. */
function windowsOf(r: UsageReport): UsageLimit[] {
  const seen = new Set<string>();
  return r.limits.filter((l) => {
    const g = l.scope?.sharedGroup;
    if (!g) return true;
    if (seen.has(g)) return false;
    seen.add(g);
    return true;
  });
}

function resetLine(l: UsageLimit, now: number): string {
  const at = l.window?.resetsAt;
  if (typeof at !== "number") return "";
  return at > now ? `Resets in ${fmtDur(at - now)} \u00b7 ${fmtClock(at)}` : `Reset ${fmtDur(now - at)} ago \u00b7 refresh for new numbers`;
}

const REASONS: Record<string, string> = {
  not_at_wall: "usable only once a limit is reached",
};

const AUTO: Record<string, string> = {
  yes: "omp spends saved resets on its own when an account is blocked or a reset is about to expire",
  no: "omp never spends them on its own",
  unset: "an open omp session asks before spending one",
};

function sameAccount(r: UsageReport, a: { provider: string; accountId?: string; email?: string; orgId?: string }): boolean {
  const m = r.metadata ?? {};
  if (r.provider !== a.provider || (!a.accountId && !a.email)) return false;
  if (a.accountId && m.accountId && a.accountId !== m.accountId) return false;
  if (a.email && m.email && a.email !== m.email) return false;
  if (a.orgId && m.orgId && a.orgId !== m.orgId) return false;
  return !!((a.accountId && m.accountId) || (a.email && m.email));
}

const availableCredits = (ra: ResetAccount) =>
  (ra.credits ?? []).filter((c) => c.status === "available").sort((x, y) => Date.parse(x.expiresAt ?? "") - Date.parse(y.expiresAt ?? ""));

// ---------------------------------------------------------------- sheet

class UsageSheet {
  private readonly s: Sheet;
  private data: UsageMsg | null = last;
  private session: UsageMsg["session"] | null = null;
  private loading = false;
  /** The PC is refreshing; a push follows. */
  private refreshing = false;
  private err = "";
  private pushErr = "";
  /** Accounts whose email is shown in full. */
  private readonly reveal = new Set<string>();
  private history: UsageHistoryMsg | null = null;
  private histOn = false;
  private histLoading = false;
  private spending = "";
  private waitTimer = 0;
  private readonly clock: number;

  constructor(private readonly target: string) {
    const p = target ? state.byTarget.get(target) : undefined;
    this.s = new Sheet("Usage", p ? paneTitle(p) : "Provider limits", "tall");
    this.s.onClose = () => {
      clearTimeout(this.waitTimer);
      clearInterval(this.clock);
      if (sheet === this) sheet = null;
    };
    // "Resets in ..." and "updated ... ago" stay current while the sheet is open.
    this.clock = window.setInterval(() => this.render(), 30_000);
    this.load(false);
  }

  get isOpen() {
    return this.s.isOpen;
  }

  private load(force: boolean) {
    if (this.loading) return;
    if (!isOnline()) {
      if (!this.data) this.err = "Offline: usage needs the PC";
      this.render();
      return;
    }
    this.loading = true;
    this.err = "";
    this.render();
    const msg = { t: "usage", ...(this.target ? { target: this.target } : {}), ...(force ? { force: true } : {}) };
    request<UsageMsg>(msg, LOAD_TIMEOUT_MS)
      .then((m) => {
        const newest = accept(m);
        this.data = last;
        if (m.session) this.session = m.session;
        this.pushErr = "";
        // A stale reply older than what we show means its refresh already ended (the push won the race).
        this.setRefreshing(!!m.stale && newest);
      })
      .catch((e) => {
        this.err = errText(e);
      })
      .finally(() => {
        this.loading = false;
        this.render();
      });
  }

  private setRefreshing(on: boolean) {
    this.refreshing = on;
    clearTimeout(this.waitTimer);
    if (on)
      this.waitTimer = window.setTimeout(() => {
        this.refreshing = false;
        this.render();
      }, PUSH_WAIT_MS);
  }

  onPush(m: UsageMsg) {
    this.data = last;
    if (m.target === this.target && m.session) this.session = m.session;
    this.pushErr = m.error ?? "";
    this.setRefreshing(false);
    this.render();
  }

  private toggleHistory() {
    this.histOn = !this.histOn;
    if (this.histOn && !this.history && !this.histLoading) {
      if (!isOnline()) {
        this.histOn = false;
        return toast("Offline: history needs the PC", "err");
      }
      this.histLoading = true;
      request<UsageHistoryMsg>({ t: "usage_history", days: HISTORY_DAYS }, 90_000)
        .then((m) => {
          this.history = m;
        })
        .catch((e) => {
          this.histOn = false;
          toast(`History: ${errText(e)}`, "err");
        })
        .finally(() => {
          this.histLoading = false;
          this.render();
        });
    }
    this.render();
  }

  // ---- rendering

  private render() {
    if (!this.s.isOpen) return;
    this.renderFoot();
    const d = this.data;
    if (!d) {
      this.s.body.replaceChildren(
        this.err
          ? errorEl(`Couldn't load usage: ${this.err}`, () => this.load(true))
          : spinnerEl("Asking omp for usage (a minute or two when its cache is cold)..."),
      );
      return;
    }
    const keep = this.s.body.scrollTop;
    const kids: (HTMLElement | null)[] = [this.statusRow(d)];
    if (!isOnline()) kids.push(h("p.sheet-warn.us-note", { text: `Offline: these numbers are from ${fmtAgo(d.fetchedAt)} ago.` }));
    else if (this.err) kids.push(h("p.sheet-warn.us-note", { text: `Couldn't refresh: ${this.err}` }));
    else if (this.pushErr) kids.push(h("p.sheet-warn.us-note", { text: `omp couldn't refresh: ${this.pushErr}` }));
    kids.push(this.sessionCard());
    kids.push(...this.providers(d));
    if (d.resetsError) kids.push(h("p.sheet-text.muted.us-note", { text: `Saved resets unknown: ${d.resetsError}` }));
    this.s.body.replaceChildren(...kids.filter((k): k is HTMLElement => !!k));
    this.s.body.scrollTop = keep;
  }

  private statusRow(d: UsageMsg): HTMLElement {
    const busy = this.refreshing || this.loading;
    const ago = Date.now() - d.generatedAt < 60_000 ? "just now" : `${fmtAgo(d.generatedAt)} ago`;
    return h(
      "div.us-status",
      null,
      busy ? h("span.spin.xs") : null,
      h("span", { text: busy ? `Refreshing from omp \u00b7 shown: ${ago}` : `Updated ${ago}` }),
    );
  }

  private renderFoot() {
    const f = this.s.foot;
    f.hidden = false;
    f.classList.add("row");
    const busy = this.refreshing || this.loading;
    const hist = h("button.btn.wide", { disabled: !this.data || this.histLoading, onclick: () => this.toggleHistory() }, this.histLoading ? h("span.spin.xs") : null, this.histOn ? "Hide history" : `${HISTORY_DAYS}-day history`);
    const refresh = h(
      "button.btn.wide",
      { disabled: busy || !isOnline(), onclick: () => this.load(true) },
      busy ? h("span.spin.xs") : h("span.icw", { html: icon("refresh") }),
      "Refresh",
    );
    f.replaceChildren(hist, refresh);
  }

  private sessionCard(): HTMLElement | null {
    const s = this.session;
    if (!s) return null;
    const t = s.tokens;
    const cost = s.cost == null ? "cost unknown" : `$${s.cost.toFixed(s.cost < 1 ? 3 : 2)}`;
    const parts = [`${fmtTokens(t.input)} in`, `${fmtTokens(t.output)} out`];
    if (t.cacheRead || t.cacheWrite) parts.push(`${fmtTokens(t.cacheRead)} cache read`, `${fmtTokens(t.cacheWrite)} cache write`);
    return h(
      "div.us-card.us-sess",
      null,
      h("div.us-head", null, h("span.us-who.plain", { text: "This session" }), h("span.us-cost", { text: cost })),
      h("div.us-meta", { text: parts.join(" \u00b7 ") }),
    );
  }

  private providers(d: UsageMsg): HTMLElement[] {
    const resets = d.resets ?? [];
    const matched = new Set<ResetAccount>();
    const groups = new Map<string, HTMLElement[]>();
    const add = (p: string, el: HTMLElement) => {
      let g = groups.get(p);
      if (!g) groups.set(p, (g = []));
      g.push(el);
    };
    for (const r of d.reports) {
      const ra = resets.find((a) => sameAccount(r, a)) ?? null;
      if (ra) matched.add(ra);
      add(r.provider, this.card(r, ra, d));
    }
    for (const ra of resets) if (!matched.has(ra) && ra.availableCount > 0) add(ra.provider, this.card(null, ra, d));
    for (const a of d.unavailable ?? []) add(a.provider, this.noteCard(a.label || a.email || "Account", "Usage unavailable for this login"));
    for (const a of d.disabled ?? []) add(a.provider, this.noteCard(a.label || a.email || "Account", "Disabled \u00b7 log in again on the PC to restore it"));
    if (!groups.size) return [h("div.empty", { text: "omp reported no usage. Accounts of providers with a usage endpoint show up here once you log in to them in omp." })];
    const mine = state.byTarget.get(this.target)?.omp?.model?.split("/")[0] ?? "";
    const order = [...groups.keys()].sort((a, b) => Number(b === mine) - Number(a === mine));
    const out: HTMLElement[] = [];
    for (const p of order) {
      const cards = groups.get(p)!;
      out.push(
        h(
          "div.ms-sec.us-sec",
          null,
          h("span", { text: providerName(p) }),
          cards.length > 1 ? h("span.count", { text: `${cards.length} accounts` }) : null,
          p === mine ? h("span.tag.acc", { text: "This session" }) : null,
        ),
        ...cards,
      );
    }
    return out;
  }

  private noteCard(who: string, text: string): HTMLElement {
    return h("div.us-card.dim", null, h("div.us-head", null, h("span.us-who.plain", { text: who.includes("@") ? maskEmail(who) : who })), h("div.us-meta", { text }));
  }

  private who(key: string, email: string | undefined, fallback: string): HTMLElement {
    if (!email) return h("span.us-who.plain", { text: fallback });
    const shown = this.reveal.has(key);
    return h(
      "button.us-who",
      {
        title: shown ? "Hide the address" : "Show the address",
        "aria-label": shown ? email : "Account email, hidden; tap to show",
        onclick: () => {
          if (shown) this.reveal.delete(key);
          else this.reveal.add(key);
          this.render();
        },
      },
      h("span", { text: shown ? email : maskEmail(email) }),
      h("span.icw", { html: icon("eye") }),
    );
  }

  private card(r: UsageReport | null, ra: ResetAccount | null, d: UsageMsg): HTMLElement {
    const now = Date.now();
    const md = r?.metadata ?? {};
    const email = md.email ?? ra?.email;
    const key = `${r?.provider ?? ra?.provider}|${md.accountId ?? ra?.accountId ?? email ?? ""}|${md.orgId ?? ""}`;
    const plan = md.planType || md.plan || (md.orgName && md.orgName !== email && !md.orgName.includes("@") ? md.orgName : "");
    const head = h(
      "div.us-head",
      null,
      // Without an email: the provider's login (GitHub user), never an opaque UUID.
      this.who(key, email, md.orgName || (md.accountId && !/^[0-9a-f-]{32,}$/i.test(md.accountId) ? md.accountId : "") || "Account"),
      plan ? h("span.tag", { text: plan }) : null,
      md.daybreak ? h("span.tag.ok", { text: "daybreak" }) : null,
      md.limitReached ? h("span.tag.err", { text: "Limit reached" }) : null,
    );
    const kids: (HTMLElement | null)[] = [head];
    if (r) {
      const wins = windowsOf(r);
      if (!wins.length) kids.push(h("div.us-meta", { text: "No limits reported" }));
      for (const l of wins) kids.push(this.windowRow(r, l, now));
      const notes = [...new Set([...(r.notes ?? []), ...wins.flatMap((l) => l.notes ?? [])])];
      if (notes.length) kids.push(h("div.us-meta", { text: notes.join(" \u2022 ") }));
    }
    if (ra) kids.push(this.resetsBlock(r, ra, key, d, now));
    return h("div.us-card", null, ...kids);
  }

  private windowRow(r: UsageReport, l: UsageLimit, now: number): HTMLElement {
    const f = pctOf(l);
    const lv = level(l, f);
    const fill = h("span.us-fill");
    fill.style.transform = `scaleX(${f ?? 0})`;
    const reset = resetLine(l, now);
    const row = h(
      `div.us-win${lv ? "." + lv : ""}`,
      null,
      h("div.us-wl", null, h("span.us-wn", { text: limitName(l) }), h("span.us-pct", { text: amountText(l, f) })),
      h("div.us-bar", null, fill),
      reset ? h("div.us-reset", { text: reset }) : null,
    );
    if (this.histOn && this.history) {
      const s = this.history.series.find((x) => x.provider === r.provider && x.limitId === l.id && sameAccount(r, x));
      row.append(s && s.points.length > 1 ? sparkline(s, this.history) : h("div.us-reset", { text: "No history recorded for this window yet" }));
    }
    return row;
  }

  private resetsBlock(r: UsageReport | null, ra: ResetAccount, key: string, d: UsageMsg, now: number): HTMLElement | null {
    if (ra.error) return h("div.us-meta", { text: `Saved resets unavailable: ${ra.error}` });
    if (!(ra.availableCount > 0)) return null;
    const account = `${ra.provider}/${ra.credentialId}`;
    const credits = availableCredits(ra);
    const rows = credits.map((c) => {
      const exp = c.expiresAt ? Date.parse(c.expiresAt) : NaN;
      const soon = isFinite(exp) && exp - now < 86_400_000;
      return h(
        "div.us-credit",
        null,
        h("span.us-ct", { text: c.title || "Saved reset" }),
        isFinite(exp) ? h(`span.us-exp${soon ? ".soon" : ""}`, { text: exp > now ? `expires in ${fmtDur(exp - now)} \u00b7 ${fmtClock(exp)}` : "expired" }) : null,
      );
    });
    const usable = ra.redeemableCount;
    const auto = d.autoRedeem?.[ra.provider];
    const busy = this.spending === account;
    return h(
      "div.us-resets",
      null,
      h(
        "div.us-rhead",
        null,
        h("span.us-rt", { text: `${ra.availableCount} saved reset${ra.availableCount === 1 ? "" : "s"}` }),
        usable < ra.availableCount ? h("span.us-meta", { text: `${usable} usable now` }) : null,
        h(
          "button.btn.sm.us-spend",
          { disabled: !usable || !!this.spending || !isOnline(), onclick: () => void this.spend(r, ra, key) },
          busy ? h("span.spin.xs") : null,
          busy ? "Spending..." : "Spend one...",
        ),
      ),
      ...rows,
      !usable && ra.unavailableReason
        ? h("div.us-meta", { text: `Not usable now: ${REASONS[ra.unavailableReason] ?? ra.unavailableReason.replace(/_/g, " ")}` })
        : null,
      auto && AUTO[auto] ? h("div.us-meta", { text: `Auto-spend ${auto === "yes" ? "on" : auto === "no" ? "off" : "asks"}: ${AUTO[auto]}.` }) : null,
    );
  }

  private async spend(r: UsageReport | null, ra: ResetAccount, key: string) {
    if (this.spending || !isOnline()) return;
    const account = `${ra.provider}/${ra.credentialId}`;
    const email = r?.metadata?.email ?? ra.email;
    const who = email ? (this.reveal.has(key) ? email : maskEmail(email)) : account;
    const c = availableCredits(ra)[0];
    const now = Date.now();
    const exp = c?.expiresAt ? Date.parse(c.expiresAt) : NaN;
    const wins = r ? windowsOf(r).map((l) => `${limitName(l)} ${Math.round((pctOf(l) ?? 0) * 100)}% used`) : [];
    const left = ra.availableCount - 1;
    const text = [
      `${providerName(ra.provider)} \u00b7 ${who}.`,
      `omp spends one ${c?.title ? `\u201c${c.title}\u201d` : "saved reset"}: this account's rate-limit windows start over${wins.length ? ` (now ${wins.join(", ")})` : ""}.`,
      isFinite(exp) ? `The soonest saved reset expires ${fmtClock(exp)} (in ${fmtDur(Math.max(0, exp - now))}).` : "",
      `${left} saved reset${left === 1 ? "" : "s"} left afterwards. This can't be undone.`,
    ]
      .filter(Boolean)
      .join(" ");
    if (!(await confirmSheet({ title: "Spend a saved reset?", text, ok: "Spend reset", danger: true }))) return;
    if (!this.s.isOpen) return;
    this.spending = account;
    this.render();
    try {
      const m = await request<UsageResetMsg>({ t: "usage_reset", account }, 150_000);
      if (m.ok) toast(`Reset spent on ${who}${m.left != null ? ` \u00b7 ${m.left} left` : ""}`, "ok");
      else toast(`Not spent: ${m.output.split("\n").filter(Boolean).pop() || "omp did not spend it"}`, "err");
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      this.spending = "";
      this.load(true);
    }
  }
}

/** Used fraction over the history window as a small line chart, with the window's peak. */
function sparkline(s: UsageSeries, hist: UsageHistoryMsg): HTMLElement {
  const end = Date.now();
  const start = hist.sinceMs ?? s.points[0][0];
  const span = Math.max(1, end - start);
  const pts = s.points.map(([t, f]) => `${(((t - start) / span) * 100).toFixed(2)},${(23 - f * 22).toFixed(2)}`).join(" ");
  const peak = Math.max(...s.points.map((p) => p[1]));
  const svg = `<svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
  return h(
    "div.us-hist",
    null,
    h("div.us-spark", { html: svg }),
    h("div.us-reset", { text: `Last ${hist.days} days \u00b7 peak ${Math.round(peak * 100)}%` }),
  );
}
