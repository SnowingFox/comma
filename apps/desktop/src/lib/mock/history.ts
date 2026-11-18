import type { DictionaryEntry, RunMode, RunRecord, UsageBreakdown, UsageDay, UsageRange, UsageSummary, UsageTotals } from "@comma/shared/ipc";
import type { MockContext, MockHandlers } from "./types";

// Deterministic sample data, so screenshots are stable. Module state only: a reload starts over.

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SAMPLES: { mode: RunMode; app: string; raw: string; refined: string; language: string }[] = [
  {
    mode: "dictate",
    app: "Slack",
    raw: "hey um can we push the design review to thursday no wait friday morning",
    refined: "Hey, can we push the design review to Friday morning?",
    language: "en",
  },
  {
    mode: "dictate",
    app: "Mail",
    raw: "hi Priya thanks for the notes uh I'll send the revised deck by end of day",
    refined: "Hi Priya, thanks for the notes. I'll send the revised deck by end of day.",
    language: "en",
  },
  {
    mode: "dictate",
    app: "Notion",
    raw: "so the plan is three steps first we ship the beta then we collect feedback and then you know we fix the onboarding",
    refined: "The plan has three steps: ship the beta, collect feedback, then fix the onboarding.",
    language: "en",
  },
  {
    mode: "dictate",
    app: "Cursor",
    raw: "add a test that checks the parser rejects an empty string",
    refined: "Add a test that checks the parser rejects an empty string.",
    language: "en",
  },
  {
    mode: "dictate",
    app: "WeChat",
    raw: "我们 嗯 明天下午三点开会 把那个方案再过一遍",
    refined: "我们明天下午三点开会，把方案再过一遍。",
    language: "zh",
  },
  {
    mode: "ask",
    app: "Notion",
    raw: "make this shorter and friendlier",
    refined: "Thanks for waiting. The fix is live, and your data is safe.",
    language: "en",
  },
  {
    mode: "ask",
    app: "Safari",
    raw: "what's the difference between a semicolon and a colon",
    refined: "A colon introduces what follows (a list, an explanation); a semicolon joins two closely related sentences.",
    language: "en",
  },
  {
    mode: "translate",
    app: "Slack",
    raw: "I'll be ten minutes late, start without me",
    refined: "Llegaré diez minutos tarde, empezad sin mí.",
    language: "en",
  },
  {
    mode: "translate",
    app: "Mail",
    raw: "please find the contract attached and let me know if anything is unclear",
    refined: "Veuillez trouver le contrat en pièce jointe et dites-moi si quelque chose n'est pas clair.",
    language: "en",
  },
];

const MODELS = ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash", "openai/gpt-5.6-mini"];

const words = (text: string) => (/[㐀-鿿]/.test(text) ? Math.ceil(text.replace(/\s/g, "").length / 2) : text.split(/\s+/).filter(Boolean).length);

function makeRuns(): RunRecord[] {
  const r = rng(7);
  const out: RunRecord[] = [];
  const now = Date.now();
  const day = 86_400_000;
  for (let d = 0; d < 34; d++) {
    // Fewer runs on weekends, a busy streak last week.
    const date = new Date(now - d * day);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const count = d === 0 ? 6 : Math.round((weekend ? 2 : 7) * (0.5 + r()) * (d > 6 && d < 12 ? 1.5 : 1));
    for (let i = 0; i < count; i++) {
      const sample = SAMPLES[Math.floor(r() * SAMPLES.length)]!;
      const hour = 8 + Math.floor(r() * 11);
      const ts = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, Math.floor(r() * 60)).getTime();
      if (ts > now) continue;
      const audio = 2 + r() * (sample.mode === "dictate" ? 24 : 9);
      const stt = 320 + r() * 650;
      const ttft = 180 + r() * 420;
      const llmTotal = ttft + 120 + r() * 600;
      const failed = r() < 0.035;
      const provider = d < 9 && r() < 0.4 ? "comma" : "local";
      out.push({
        id: `run-${d}-${i}`,
        ts,
        mode: sample.mode,
        provider,
        app: sample.app,
        raw_text: sample.raw,
        refined_text: failed ? "" : sample.refined,
        language: sample.language,
        model: failed ? null : MODELS[Math.floor(r() * MODELS.length)]!,
        audio_secs: Math.round(audio * 10) / 10,
        stt_ms: Math.round(stt),
        llm_ttft_ms: failed ? null : Math.round(ttft),
        llm_total_ms: failed ? null : Math.round(llmTotal),
        total_ms: Math.round(stt + (failed ? 0 : llmTotal) + 60),
        prompt_tokens: failed ? null : 380 + Math.floor(r() * 220),
        completion_tokens: failed ? null : 18 + Math.floor(r() * 60),
        stt_cost_usd: Math.round((audio / 3600) * 0.2 * 1.2 * 1e6) / 1e6,
        words: failed ? 0 : words(sample.refined),
        ok: !failed,
        error: failed ? (r() < 0.5 ? "Couldn't reach ElevenLabs. Check your connection" : "magpie did not answer within 60 s") : null,
        output: failed ? null : sample.mode === "ask" && !sample.raw.startsWith("make") ? "answer" : r() < 0.1 ? "copied" : "pasted",
        has_audio: false,
      });
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

let runs = makeRuns();

let terms: DictionaryEntry[] = ["Comma", "ElevenLabs", "DeepSeek", "Priya Raman", "Tauri", "magpie", "Kubernetes", "OKR"].map((term, i) => ({
  id: `term-${i}`,
  term,
  created_at: new Date(Date.now() - (40 - i * 3) * 86_400_000).toISOString(),
}));
let accountTerms: DictionaryEntry[] = terms.slice(0, 3).map((t) => ({ ...t, id: `srv-${t.id}` }));

const DAY = 86_400_000;
const RANGE_DAYS: Record<UsageRange, number> = { today: 1, "7d": 7, "30d": 30, "90d": 90 };

function startOfDay(ts: number) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function inRange(range: UsageRange): RunRecord[] {
  const from = startOfDay(Date.now()) - (RANGE_DAYS[range] - 1) * DAY;
  return runs.filter((r) => r.ts >= from);
}

function totals(list: RunRecord[]): UsageTotals {
  const ok = list.filter((r) => r.ok);
  return {
    runs: ok.length,
    errors: list.length - ok.length,
    words: ok.reduce((n, r) => n + r.words, 0),
    audio_secs: Math.round(list.reduce((n, r) => n + r.audio_secs, 0) * 10) / 10,
    stt_cost_usd: Math.round(list.reduce((n, r) => n + (r.stt_cost_usd ?? 0), 0) * 1e6) / 1e6,
    prompt_tokens: ok.reduce((n, r) => n + (r.prompt_tokens ?? 0), 0),
    completion_tokens: ok.reduce((n, r) => n + (r.completion_tokens ?? 0), 0),
  };
}

function breakdown(list: RunRecord[], key: (r: RunRecord) => string | null): UsageBreakdown {
  const groups = new Map<string, RunRecord[]>();
  for (const r of list) {
    const k = key(r) ?? "Unknown";
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()].map(([k, l]) => ({ key: k, ...totals(l) })).sort((a, b) => b.runs - a.runs);
}

function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const stage = (list: RunRecord[], f: (r: RunRecord) => number | null) => {
  const v = list.map(f).filter((x): x is number => x != null);
  return { p50: pct(v, 50), p95: pct(v, 95) };
};

function summary(range: UsageRange): UsageSummary {
  const list = inRange(range);
  const ok = list.filter((r) => r.ok);
  return {
    range,
    totals: totals(list),
    by_mode: breakdown(list, (r) => r.mode),
    by_model: breakdown(ok, (r) => r.model),
    by_app: breakdown(list, (r) => r.app),
    stages: {
      stt: stage(list, (r) => r.stt_ms),
      llm_ttft: stage(ok, (r) => r.llm_ttft_ms),
      llm_total: stage(ok, (r) => r.llm_total_ms),
      total: stage(ok, (r) => r.total_ms),
    },
  };
}

function daily(range: UsageRange): UsageDay[] {
  const days = RANGE_DAYS[range];
  const today = startOfDay(Date.now());
  return Array.from({ length: days }, (_, i) => {
    const from = today - (days - 1 - i) * DAY;
    const d = new Date(from);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { date, ...totals(runs.filter((r) => r.ts >= from && r.ts < from + DAY)) };
  });
}

function notFound(): never {
  throw { code: "invalid_input", message: "That run no longer exists" };
}

function dictionary(ctx: MockContext) {
  return ctx.mode === "account" ? accountTerms : terms;
}

function setDictionary(ctx: MockContext, next: DictionaryEntry[]) {
  if (ctx.mode === "account") accountTerms = next;
  else terms = next;
}

function checkTerm(list: DictionaryEntry[], term: string, except?: string) {
  if (list.some((t) => t.id !== except && t.term.toLowerCase() === term.toLowerCase()))
    throw { code: "invalid_input", message: `“${term}” is already in your dictionary` };
}

/** History, usage and dictionary commands, with sample data for screenshots. */
export const HISTORY_HANDLERS: MockHandlers = {
  runs_list: (args) => {
    const search = String(args.search ?? "").toLowerCase();
    const before = args.before as number | undefined;
    const limit = (args.limit as number | undefined) ?? 50;
    return runs
      .filter((r) => (before === undefined || r.ts < before) && (!search || `${r.raw_text} ${r.refined_text} ${r.app ?? ""}`.toLowerCase().includes(search)))
      .slice(0, limit);
  },
  run_get: (args) => runs.find((r) => r.id === args.id) ?? notFound(),
  run_delete: (args) => {
    runs = runs.filter((r) => r.id !== args.id);
    return null;
  },
  runs_clear: () => {
    runs = [];
    return null;
  },
  run_rerun: (args, ctx) => {
    if (ctx.mode === "account") throw { code: "unsupported", message: "Rerunning the rewrite needs your own keys" };
    const run = runs.find((r) => r.id === args.id) ?? notFound();
    const next: RunRecord = { ...run, ok: true, error: null, refined_text: run.refined_text || "Rewritten again.", model: ctx.model || run.model, llm_ttft_ms: 301, llm_total_ms: 688 };
    runs = runs.map((r) => (r.id === run.id ? next : r));
    return next;
  },
  run_audio: () => {
    throw { code: "invalid_input", message: "No audio was kept for this run" };
  },
  usage_summary: (args) => summary(args.range as UsageRange),
  usage_daily: (args) => daily(args.range as UsageRange),
  usage_export_csv: (args) => ({ path: `/Users/you/Downloads/comma-usage-${args.range as string}.csv` }),
  dictionary_list: (_args, ctx) => dictionary(ctx),
  dictionary_add: (args, ctx) => {
    const term = String(args.term).trim();
    checkTerm(dictionary(ctx), term);
    const entry = { id: `term-${Date.now()}`, term, created_at: new Date().toISOString() };
    setDictionary(ctx, [...dictionary(ctx), entry]);
    return entry;
  },
  dictionary_update: (args, ctx) => {
    const term = String(args.term).trim();
    checkTerm(dictionary(ctx), term, String(args.id));
    const list = dictionary(ctx).map((t) => (t.id === args.id ? { ...t, term } : t));
    setDictionary(ctx, list);
    return list.find((t) => t.id === args.id) ?? notFound();
  },
  dictionary_delete: (args, ctx) => {
    setDictionary(ctx, dictionary(ctx).filter((t) => t.id !== args.id));
    return null;
  },
  dictionary_import_csv: (args, ctx) => {
    const rows = String(args.csv)
      .split(/\r?\n/)
      .map((line) => line.split(",")[0]!.replace(/^"|"$/g, "").trim())
      .filter((t, i) => t && !(i === 0 && t.toLowerCase() === "term"));
    let added = 0;
    let skipped = 0;
    let list = dictionary(ctx);
    for (const term of rows) {
      if (term.length > 100 || list.some((t) => t.term.toLowerCase() === term.toLowerCase())) {
        skipped++;
        continue;
      }
      list = [...list, { id: `term-${Date.now()}-${added}`, term, created_at: new Date().toISOString() }];
      added++;
    }
    setDictionary(ctx, list);
    return { added, skipped };
  },
};
