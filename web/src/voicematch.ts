// Matches a spoken answer to an omp ask question (English and Turkish): ordinals/numbers, fuzzy labels,
// "other <text>", multi-select lists joined by and/ve/commas, cancel. Pure: no DOM, unit-checkable.

export interface MatchQuestion {
  options: { label: string }[];
  multi: boolean;
  recommended?: number;
}

export type MatchResult =
  | { kind: "cancel" }
  /** Picked option indexes (sorted); `custom` set when "other <text>" was said too. */
  | { kind: "pick"; selected: number[]; custom?: string }
  /** "other" without text: ask for the free answer next. */
  | { kind: "other" }
  /** Several options fit (or a single-select heard several); the candidates help the re-prompt. */
  | { kind: "ambiguous"; candidates: number[] }
  | { kind: "none" };

/** Lowercase, fold Turkish/Latin diacritics to ASCII, keep letters/digits/spaces. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[`*_~#>[\]()"'’]/g, " ")
    .replace(/[^a-z0-9.,&+\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const EN_CARD = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const EN_ORD = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const TR_CARD = ["bir", "iki", "uc", "dort", "bes", "alti", "yedi", "sekiz", "dokuz", "on"];
const TR_ORD = ["birinci", "ikinci", "ucuncu", "dorduncu", "besinci", "altinci", "yedinci", "sekizinci", "dokuzuncu", "onuncu"];
/** Homophones a recognizer may produce for numbers; only trusted right after "option"/"number". */
const HOMO: Record<string, number> = { won: 1, to: 2, too: 2, tree: 3, for: 4, fore: 4 };
/** Turkish case/possessive endings after a number or ordinal ("ikinciyi", "ucuncusu", "ikiyi"). */
const TR_SUFFIX = /^(|y?[iu]|s[iu]|s[iu]n[iu]|n[iu]|y?[iu]n[iu]|y?l[ae]|d[ae]|[iu]?n[iu]n)$/;
/** Space-separated word list as a prototype-free lookup ("constructor" must not match). */
const words = (s: string): Record<string, true> => Object.assign(Object.create(null), Object.fromEntries(s.split(" ").map((w) => [w, true])));
/** Words that make the next number an option reference. */
const OPT_WORDS = words("option options number choice item secenek secenegi secenegini numara numarali madde sik sikki sikkini");
const LAST_WORDS = words("last sonuncu sonuncuyu sonuncusu sondaki sondakini");
const ALL_WORDS = words("all both everything hepsi hepsini tumu tumunu ikisi ikisini hepsine");
const REC_WORDS = words("recommended suggested onerilen onerileni onerdigin tavsiye");
const CANCEL = /^(cancel|cancel that|never ?mind|forget it|stop|abort|iptal|iptal et|vazgec|vazgectim|bosver|dur)$/;
const CANCEL_LEAD = /^(cancel|iptal|vazgec)\b/;
const OTHER_RE = /^\s*(?:(?:the|an?|option|secenek)\s+)?(something else|other|another|baska bir sey|başka bir şey|diger|diğer|baska|başka)(?=$|[\s,:.;!-])[\s,:.;!-]*(?:(?:answer|cevap|cevabim|cevabım|yanit|yanıt)[\s,:.-]*)?([\s\S]*)$/i;
const SPLIT = /\s*(?:,|&|\+|\band also\b|\band then\b|\band\b|\bplus\b|\bas well as\b|\bve\b|\bile\b|\bayrica\b|\bde\b|\bda\b)\s*/;
/** Filler words ignored by label matching. */
const STOP = words(
  "the a an one ones option options number please i id want would like choose pick take go with use lets let s its it that this is to of for my answer select " +
    "bu su o olsun lutfen secenek secenegi sec seciyorum istiyorum tamam ile icin bir and ve",
);

function trStem(tok: string, stems: string[]): number {
  for (let i = stems.length - 1; i >= 0; i--) {
    const s = stems[i];
    if (tok.startsWith(s) && TR_SUFFIX.test(tok.slice(s.length))) return i + 1;
  }
  return 0;
}

/** Option numbers (1-based) mentioned in one part of the utterance; -1 = last, -2 = all, -3 = recommended. */
function numbersIn(part: string): number[] {
  const toks = part.split(" ").filter(Boolean);
  const out: number[] = [];
  let prevOrd = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].replace(/[.,]+$/, "");
    const afterOpt = i > 0 && !!OPT_WORDS[toks[i - 1]];
    let n = 0;
    let ord = false;
    const dm = /^#?(\d{1,2})(?:st|nd|rd|th|\.)?$/.exec(t);
    if (dm) n = Number(dm[1]);
    else if (EN_ORD.includes(t)) {
      n = EN_ORD.indexOf(t) + 1;
      ord = true;
    } else if (EN_CARD.includes(t)) {
      // "the second one", "that one", "which one": "one" is a pronoun there
      if (t === "one" && i > 0 && (prevOrd || /^(the|that|this|which|last|other|recommended|suggested|any|either|same)$/.test(toks[i - 1]))) continue;
      if (t === "one" && i + 1 < toks.length && !afterOpt && /^(of|more|thing|sec|moment)$/.test(toks[i + 1])) continue;
      n = EN_CARD.indexOf(t) + 1;
    } else if (afterOpt && Object.hasOwn(HOMO, t)) n = HOMO[t];
    else if ((n = trStem(t, TR_ORD))) ord = true;
    else if (TR_CARD.includes(t) || (t.length > 3 && trStem(t, TR_CARD) && !/^(biraz|bira|bire|onay|once|onem|onun|ona|onu|ucu|ucuz|ikin)/.test(t))) {
      // bare Turkish cardinals; "bir" is also the article "a", trust it only next to an option word or alone
      const card = TR_CARD.includes(t) ? TR_CARD.indexOf(t) + 1 : trStem(t, TR_CARD);
      if (card === 1 && t === "bir" && !afterOpt && !(i + 1 < toks.length && OPT_WORDS[toks[i + 1]]) && toks.length > 1) continue;
      n = card;
    } else if (LAST_WORDS[t]) n = -1;
    else if (ALL_WORDS[t]) n = -2;
    else if (REC_WORDS[t]) n = -3;
    prevOrd = ord || n === -1;
    if (n) out.push(n);
  }
  return out;
}

/** Turkish yes/no said to English option labels. */
const SYNONYM: Record<string, string> = { evet: "yes", hayir: "no", olur: "yes" };

function tokens(s: string): string[] {
  return s
    .replace(/[.,&+]/g, " ")
    .split(" ")
    .filter((t) => t && !STOP[t])
    .map((t) => (Object.hasOwn(SYNONYM, t) ? SYNONYM[t] : t));
}

function lev(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function tokSim(a: string, b: string): number {
  if (a === b) return 1;
  const min = Math.min(a.length, b.length);
  if (min >= 4 && (a.startsWith(b) || b.startsWith(a))) return 0.85;
  if (min >= 4 && lev(a, b) <= (min >= 7 ? 2 : 1)) return 0.8;
  return 0;
}

/** Token-overlap score of a spoken part against a label in [0, 1]. */
function labelScore(part: string, label: string): number {
  const nl = norm(label);
  if (!nl) return 0;
  if (part === nl) return 1;
  if (nl.length >= 3 && (` ${part} `.includes(` ${nl} `))) return 0.95;
  const lt = tokens(nl);
  const pt = tokens(part);
  if (!lt.length || !pt.length) return 0;
  let hit = 0;
  for (const l of lt) {
    let best = 0;
    for (const p of pt) best = Math.max(best, tokSim(l, p));
    hit += best;
  }
  // Recall over the label, damped when the utterance carries much more than the label.
  const score = (hit / lt.length) * 0.75 + (hit / pt.length) * 0.25;
  // One word naming the label's head ("yes" for "Yes, apply the patch") is enough.
  return pt.length === 1 && lt[0] === pt[0] ? Math.max(score, 0.6) : score;
}

const LABEL_MIN = 0.5;

/** Option indexes matched by label in one part; several when they tie. */
function labelsIn(part: string, q: MatchQuestion): { best: number[]; score: number } {
  const scores = q.options.map((o) => labelScore(part, o.label));
  const top = Math.max(0, ...scores);
  if (top < LABEL_MIN) return { best: [], score: top };
  const best = scores.flatMap((s, i) => (s >= top - 0.12 ? [i] : []));
  return { best, score: top };
}

function resolveNums(nums: number[], q: MatchQuestion): number[] | null {
  const n = q.options.length;
  const out: number[] = [];
  for (const x of nums) {
    if (x === -1) out.push(n - 1);
    else if (x === -2) out.push(...q.options.map((_, i) => i));
    else if (x === -3) {
      if (q.recommended == null) return null;
      out.push(q.recommended);
    } else if (x >= 1 && x <= n) out.push(x - 1);
    else return null;
  }
  return out;
}

/** Selections in one part: numbers first, labels otherwise; null when nothing fits. */
function matchPart(part: string, q: MatchQuestion): { sel: number[]; ambiguous?: number[] } | null {
  const lab = labelsIn(part, q);
  // A label that is spoken outright (e.g. "Option 2 workers") beats number parsing.
  if (lab.score >= 0.95 && lab.best.length === 1) return { sel: lab.best };
  const nums = numbersIn(part);
  if (nums.length) {
    const r = resolveNums(nums, q);
    if (r) return { sel: r };
  }
  if (!lab.best.length) return null;
  if (lab.best.length > 1) return { sel: [], ambiguous: lab.best };
  return { sel: lab.best };
}

export function matchAnswer(utterance: string, q: MatchQuestion): MatchResult {
  const raw = utterance.trim();
  const n = norm(raw).replace(/[.,!?]+$/, "");
  if (!n) return { kind: "none" };
  const labelExact = q.options.some((o) => norm(o.label) === n);
  if (!labelExact && (CANCEL.test(n) || (CANCEL_LEAD.test(n) && !q.options.some((o) => /\b(cancel|iptal)\b/.test(norm(o.label)))))) return { kind: "cancel" };

  // "other <text>" anywhere after the picks: the rest of the original utterance is the custom answer.
  let head = n;
  let custom: string | undefined;
  let otherSaid = false;
  if (!labelExact) {
    const lead = OTHER_RE.exec(raw);
    if (lead) {
      otherSaid = true;
      head = "";
      custom = lead[2].trim().replace(/^[,:.\s-]+/, "");
    } else if (q.multi) {
      const m = /^(.*?)[\s,]+(?:and|ve|plus|also)?\s*(?=(?:the\s+)?(?:other|another|diger|diğer|baska|başka)\b)/i.exec(raw);
      const tail = m ? OTHER_RE.exec(raw.slice(m[0].length)) : null;
      if (m && tail) {
        otherSaid = true;
        head = norm(m[1]).replace(/[.,!?]+$/, "");
        custom = tail[2].trim();
      }
    }
  }
  // "both X and Y" lists two picks; "both" alone (or "both of them") still means all.
  head = head.replace(/^both\s+(?=.*\b(?:and|ve)\b)/, "");

  const sel = new Set<number>();
  const amb = new Set<number>();
  if (head) {
    const whole = matchPart(head, q);
    const parts = head.split(SPLIT).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1 && !(whole && whole.sel.length && labelsIn(head, q).score >= 0.95)) {
      let miss = false;
      for (const p of parts) {
        const r = matchPart(p, q);
        if (!r) {
          if (tokens(p).length) miss = true;
          continue;
        }
        r.sel.forEach((i) => sel.add(i));
        r.ambiguous?.forEach((i) => amb.add(i));
      }
      if (miss && !sel.size) return amb.size ? { kind: "ambiguous", candidates: [...amb].sort((a, b) => a - b) } : { kind: "none" };
      // A single-select answer with one clear pick tolerates filler ("no, leave it").
      if (miss && !(sel.size === 1 && !amb.size && !q.multi)) return { kind: "ambiguous", candidates: [...sel, ...amb].sort((a, b) => a - b) };
    } else if (whole) {
      whole.sel.forEach((i) => sel.add(i));
      whole.ambiguous?.forEach((i) => amb.add(i));
    } else if (!otherSaid) return { kind: "none" };
  }

  if (amb.size) return { kind: "ambiguous", candidates: [...new Set([...amb, ...sel])].sort((a, b) => a - b) };
  const picks = [...sel].sort((a, b) => a - b);
  if (otherSaid) {
    if (!q.multi && picks.length) return { kind: "ambiguous", candidates: picks };
    if (!custom) return picks.length ? { kind: "pick", selected: picks } : { kind: "other" };
    return { kind: "pick", selected: q.multi ? picks : [], custom };
  }
  if (!picks.length) return { kind: "none" };
  if (!q.multi && picks.length > 1) return { kind: "ambiguous", candidates: picks };
  return { kind: "pick", selected: picks };
}

const SPOKEN_NUM = EN_CARD;

/** Spoken prompt listing the options: "Options: one, X. two, Y. You can also say other, then your answer." */
export function optionsSpeech(q: MatchQuestion & { question?: string }, only?: number[]): string {
  const idx = only?.length ? only : q.options.map((_, i) => i);
  const list = idx.map((i) => `${SPOKEN_NUM[i] ?? String(i + 1)}, ${plain(q.options[i].label)}.`).join(" ");
  return `Options: ${list} You can also say other, then your answer.`;
}

/** Strips inline markdown so labels read naturally. */
export function plain(s: string): string {
  return s.replace(/[`*_~#>]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
}

export function spokenIndex(i: number): string {
  return SPOKEN_NUM[i] ?? String(i + 1);
}
