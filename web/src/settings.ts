// Native omp settings (omp's /settings): grouped, searchable list with typed editors; writes go through
// `settings_set` (omp's global config), project-layer keys are read-only.
import { request } from "./bridge";
import { errText, isOnline } from "./omp";
import { currentPane, paneTitle } from "./state";
import type { SettingItem, SettingsMsg } from "./types";
import { errorEl, Sheet, spinnerEl, toast } from "./ui";
import { h, icon } from "./util";

/** Settings of the current omp pane (its project layer applies), else the global ones. */
export function openSettings() {
  new SettingsSheet(currentPane()?.agent ? currentPane()!.target : "");
}

const effective = (it: SettingItem) => (it.value !== undefined ? it.value : it.default);

function fmtValue(v: unknown, type: SettingItem["type"]): string {
  if (v === undefined || v === null) return "\u2014";
  if (type === "boolean") return v ? "On" : "Off";
  if (Array.isArray(v)) return v.length ? `${v.length} item${v.length > 1 ? "s" : ""}` : "none";
  if (typeof v === "object") {
    const n = Object.keys(v as object).length;
    return n ? `${n} key${n > 1 ? "s" : ""}` : "none";
  }
  return String(v);
}

/** Display name: omp's label, else the key without its group prefix ("compaction.enabled" in "compaction" → "enabled"). */
function nameOf(it: SettingItem): string {
  return it.label || (it.key.startsWith(`${it.group}.`) ? it.key.slice(it.group.length + 1) : it.key);
}

/** Editing is refused for project-layer values and credentials. */
const readOnly = (it: SettingItem) => it.scope === "project" || !!it.secret;

class SettingsSheet {
  private readonly s: Sheet;
  private readonly q = h("input.ms-q", { type: "search", placeholder: "Search settings", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  private readonly listBox = h("div.st-list");
  private readonly listView: HTMLElement;
  private data: SettingsMsg | null = null;
  private err = "";
  private open: string | null = null;
  private listScroll = 0;
  private busy = false;
  /** Something was saved in this sheet (shows the restart hint). */
  private saved = false;
  /** Unsaved text of the open key's editor. */
  private draft: string | null = null;

  constructor(private readonly target: string) {
    const p = currentPane();
    this.s = new Sheet("omp settings", target && p ? paneTitle(p) : "Global settings", "tall");
    this.q.addEventListener("input", () => this.renderList());
    this.listView = h("div", null, h("div.ms-top", null, h("div.ms-search", null, h("span.icw", { html: icon("search") }), this.q)), this.listBox);
    this.s.onBack = () => {
      if (this.open == null) return false;
      this.toList();
      return true;
    };
    this.load();
  }

  private load() {
    this.err = "";
    this.render();
    request<SettingsMsg>(this.target ? { t: "settings", target: this.target } : { t: "settings" }, 30_000)
      .then((m) => {
        this.data = m;
        this.render();
      })
      .catch((e) => {
        this.err = errText(e);
        this.render();
      });
  }

  private item(key: string): SettingItem | undefined {
    return this.data?.items.find((x) => x.key === key);
  }

  private show(key: string) {
    this.listScroll = this.s.body.scrollTop;
    this.open = key;
    this.draft = null;
    this.render();
    this.s.body.scrollTop = 0;
  }

  private toList() {
    this.open = null;
    this.draft = null;
    this.render();
    this.s.body.scrollTop = this.listScroll;
  }

  private async write(it: SettingItem, value: unknown, okText: string): Promise<boolean> {
    if (this.busy || !isOnline() || it.scope === "project") return false;
    this.busy = true;
    this.render();
    try {
      const msg = { t: "settings_set", key: it.key, value, ...(this.target ? { target: this.target } : {}) };
      this.data = await request<SettingsMsg>(msg, 30_000);
      this.saved = true;
      this.draft = null;
      toast(okText, "ok");
      return true;
    } catch (e) {
      toast(errText(e), "err");
      return false;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private render() {
    if (!this.s.isOpen) return;
    this.s.foot.hidden = true;
    this.s.foot.replaceChildren();
    if (!this.data) {
      this.s.body.replaceChildren(this.err ? errorEl(`Couldn't load omp's settings: ${this.err}`, () => this.load()) : spinnerEl("Loading settings..."));
      return;
    }
    const it = this.open != null ? this.item(this.open) : undefined;
    if (it) {
      const keep = this.s.body.scrollTop;
      this.s.body.replaceChildren(this.detail(it));
      this.s.body.scrollTop = keep;
      return;
    }
    this.open = null;
    this.renderList();
    if (this.s.body.firstChild !== this.listView) this.s.body.replaceChildren(this.listView);
  }

  private restartNote(): HTMLElement | null {
    return this.saved && this.data?.restartHint
      ? h("p.sheet-warn.mh-note", { text: "Saved to omp's config. omp sessions already running pick most changes up only after a restart (/restart)." })
      : null;
  }

  private renderList() {
    const d = this.data;
    if (!d) return;
    const words = this.q.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = d.items.filter((it) => {
      const hay = `${it.key} ${it.label ?? ""} ${it.group} ${it.description}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const groups = new Map<string, SettingItem[]>();
    for (const it of hits) {
      let g = groups.get(it.group);
      if (!g) groups.set(it.group, (g = []));
      g.push(it);
    }
    const kids: (HTMLElement | null)[] = [this.restartNote()];
    if (!hits.length) kids.push(h("div.empty", { text: words.length ? "No setting matches" : "omp reported no settings" }));
    for (const [g, items] of groups) {
      kids.push(h("div.ms-sec", null, h("span", { text: g || "General" }), h("span.count", { text: String(items.length) })));
      for (const it of items) kids.push(this.row(it));
    }
    this.listBox.replaceChildren(...kids.filter((k): k is HTMLElement => !!k));
  }

  private row(it: SettingItem): HTMLElement {
    const v = effective(it);
    const ro = readOnly(it);
    let right: HTMLElement;
    if (it.secret) right = h("span.st-val", { text: "hidden" });
    else if (it.type === "boolean") {
      right = h(`span.switch${v ? ".on" : ""}`, { role: "switch", "aria-checked": String(!!v), "aria-label": it.key });
      if (!ro)
        right.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.busy || !isOnline()) return;
          void this.write(it, !v, `${nameOf(it)}: ${v ? "off" : "on"}`);
        });
    } else right = h("span.st-val", { text: fmtValue(v, it.type) });
    return h(
      `button.st-row${ro ? ".ro" : ""}`,
      { onclick: () => this.show(it.key) },
      h(
        "span.ms-main",
        null,
        h(
          "span.st-k",
          null,
          h(`span.st-name${it.label ? ".lbl" : ""}`, { text: nameOf(it) }),
          it.scope === "global" ? h("span.st-set", { title: "Set in your config" }) : null,
          it.scope === "project" ? h("span.tag", { text: "Project" }) : null,
        ),
        it.description ? h("span.st-d", { text: it.description }) : null,
      ),
      right,
    );
  }

  // ---- detail

  private detail(it: SettingItem): HTMLElement {
    const ro = readOnly(it);
    const can = !ro && !this.busy && isOnline();
    const scopeTag = it.scope === "global" ? h("span.tag.acc", { text: "Set" }) : it.scope === "project" ? h("span.tag", { text: "Project" }) : h("span.tag", { text: "Default" });
    const el = h(
      "div.mh-detail",
      null,
      h("button.ms-back", { onclick: () => this.toList() }, h("span.ms-back-ic", { text: "\u2039" }), h("span", { text: "Settings" })),
      h(
        "div.mh-dh",
        null,
        h(`div.mh-dname${it.label ? "" : ".st-dk"}`, { text: it.label || it.key }),
        it.label ? h("div.ms-id", { text: it.key }) : null,
        h("div.mh-tags", null, scopeTag, h("span.tag", { text: it.secret ? "secret" : it.type }), this.busy ? h("span.spin.xs") : null),
      ),
    );
    if (it.description) el.append(h("p.sheet-text.st-desc", { text: it.description }));
    if (it.secret) {
      el.append(h("p.sheet-warn.mh-note", { text: "A credential: DevDeck never shows or changes it. Set it on the PC." }));
      return el;
    }
    if (ro) el.append(h("p.sheet-warn.mh-note", { text: "Set in this project's omp config, which overrides your global value: change it on the PC." }));
    el.append(h("div.ms-sec", null, h("span", { text: "Value" })), this.editor(it, can));
    if (it.default !== undefined) el.append(h("p.sheet-text.muted.st-def", { text: `Default: ${it.type === "array" || it.type === "record" ? JSON.stringify(it.default) : fmtValue(it.default, it.type)}` }));
    if (it.scope === "global")
      el.append(
        h(
          "div.mh-acts",
          null,
          h("button.btn.sm", {
            text: "Reset to default",
            disabled: !can,
            onclick: () => void this.write(it, null, `${it.key} reset`),
          }),
        ),
      );
    const note = this.restartNote();
    if (note) el.append(note);
    return el;
  }

  private editor(it: SettingItem, can: boolean): HTMLElement {
    const v = effective(it);
    const box = h("div.mh-block");
    switch (it.type) {
      case "boolean": {
        box.append(
          h(
            "button.ms-fast.mh-tog",
            { role: "switch", "aria-checked": String(!!v), disabled: !can, onclick: () => void this.write(it, !v, `${it.key}: ${v ? "off" : "on"}`) },
            h("span.ms-fast-l", null, h("span", { text: v ? "On" : "Off" })),
            h(`span.switch${v ? ".on" : ""}`),
          ),
        );
        return box;
      }
      case "enum": {
        for (const o of it.options ?? []) {
          const on = o === v;
          box.append(
            h(
              `button.ms-row.st-opt${on ? ".sel" : ""}`,
              { disabled: !can, onclick: () => !on && void this.write(it, o, `${it.key}: ${o}`) },
              h("span.ms-main", null, h("span.ms-name", { text: o })),
              on ? h("span.icw.st-check", { html: icon("check") }) : null,
              o === it.default ? h("span.tag", { text: "default" }) : null,
            ),
          );
        }
        if (!it.options?.length) box.append(h("p.sheet-text.muted", { text: `Value: ${fmtValue(v, it.type)}` }));
        return box;
      }
      case "number":
      case "string": {
        const num = it.type === "number";
        const input = h("input.field.st-in", {
          type: num ? "number" : "text",
          inputmode: num ? "decimal" : undefined,
          autocomplete: "off",
          autocapitalize: "off",
          spellcheck: "false",
          enterkeyhint: "done",
          disabled: !can,
          value: this.draft ?? (v == null ? "" : String(v)),
        }) as HTMLInputElement;
        input.addEventListener("input", () => (this.draft = input.value));
        const save = () => {
          const t = input.value.trim();
          let val: unknown = input.value;
          if (num) {
            const n = Number(t);
            if (!t || !Number.isFinite(n)) return toast("Enter a number", "err");
            val = n;
          }
          void this.write(it, val, `${it.key}: ${num ? val : JSON.stringify(val)}`);
        };
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && can) save();
        });
        box.append(h("div.mh-thr-row", null, input, h("button.btn", { text: "Save", disabled: !can, onclick: save })));
        return box;
      }
      default: {
        const ta = h("textarea.field.st-json", { rows: 8, spellcheck: "false", autocapitalize: "off", disabled: !can }) as HTMLTextAreaElement;
        ta.value = this.draft ?? JSON.stringify(v ?? (it.type === "array" ? [] : {}), null, 2);
        ta.addEventListener("input", () => (this.draft = ta.value));
        const err = h("p.sheet-warn", { hidden: true });
        const save = () => {
          let val: unknown;
          try {
            val = JSON.parse(ta.value);
          } catch (e) {
            err.textContent = `Not valid JSON: ${(e as Error).message}`;
            err.hidden = false;
            return;
          }
          const ok = it.type === "array" ? Array.isArray(val) : !!val && typeof val === "object" && !Array.isArray(val);
          if (!ok) {
            err.textContent = it.type === "array" ? "Expected a JSON list: [ ... ]" : "Expected a JSON object: { ... }";
            err.hidden = false;
            return;
          }
          err.hidden = true;
          void this.write(it, val, `${it.key} saved`);
        };
        box.append(ta, err, h("div.mh-acts", null, h("button.btn.sm.primary", { text: "Save", disabled: !can, onclick: save })));
        return box;
      }
    }
  }
}
