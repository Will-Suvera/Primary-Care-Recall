// Sign-up → go-live stall analysis (pure functions; rendered by StallAnalysis.jsx).
//
// Clock starts when the HubSpot deal is CREATED (= joined the signed-up list) and
// stops when the practice has HELD ITS RECALL SESSION (= go-live). Between the two,
// the coarse checkpoints are the HubSpot stage-entry dates; inside "DPA signed →
// go-live" the fine-grained checkpoints are the Neon onboarding step events.
//
// Every date is resolved from the best source available, and each journey carries
// where its go-live date came from so the UI can be honest about precision:
//   visit   — a Notion practice visit that happened (the recall session itself)
//   event   — the Hub's "Recall Session → done" toggle (timestamped in Neon)
//   recalls — first month with recalls in the Omni feed (month precision, day 1)
//   sheet   — the tracker sheet says "Held" but nobody dated it → HubSpot Live date
//   undated — sheet says "Held", no usable date at all → complete, but excluded from timings
import { mergeOnboarding } from "./onboarding.js";

export const CHECKPOINTS = [
  { key: "created",    label: "Signed up",          short: "Signed up" },
  { key: "demo_booked", label: "Demo booked",       short: "Demo booked" },
  { key: "demo_held",  label: "Demo held",          short: "Demo held" },
  { key: "dpa_sent",   label: "Proposal sent",      short: "Proposal" },
  { key: "dpa_signed", label: "DPA signed",         short: "DPA signed" },
  { key: "live",       label: "Functionally live",  short: "Live" },
  { key: "golive",     label: "Recall session held", short: "Go-live" },
];
const CP_INDEX = Object.fromEntries(CHECKPOINTS.map((c, i) => [c.key, i]));

export const DAY = 86400000;
export const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / DAY);

export function median(xs) {
  const a = xs.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}
export function percentile(xs, p) {
  const a = xs.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}

const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// Earliest Notion visit that actually happened (on/after DPA signed when we know it).
function visitGoLive(visits, ods, dpaDate) {
  const v = ods && visits?.[ods];
  if (!v) return null;
  const hist = v.history?.length ? v.history : [v];
  const dates = hist
    .filter((h) => h.status === "happened" && h.date)
    .map((h) => h.date.slice(0, 10))
    .filter((d) => !dpaDate || d >= dpaDate)
    .sort();
  return dates[0] || null;
}

// Earliest human "recall_session → done" toggle for the practice.
function eventGoLive(eventsByOds, ods) {
  const evs = ods && eventsByOds?.[ods];
  if (!evs) return null;
  const done = evs.filter((e) => e.step_key === "recall_session" && e.to_state === "done").map((e) => isoDay(e.changed_at)).sort();
  return done[0] || null;
}

export function resolveGoLive(deal, ctx) {
  const dpa = deal.stage_dates?.dpa_signed || null;
  const fromVisit = visitGoLive(ctx.visits, deal.ods, dpa);
  if (fromVisit) return { date: fromVisit, source: "visit" };
  const fromEvent = eventGoLive(ctx.eventsByOds, deal.ods);
  if (fromEvent) return { date: fromEvent, source: "event" };
  const frm = deal.ods && ctx.firstRecallMonth?.[deal.ods];
  if (frm) return { date: `${frm}-01`, source: "recalls" };
  const steps = deal.onboarding ? mergeOnboarding(deal.onboarding, ctx.liveOnb?.[deal.ods]) : null;
  const rs = steps?.find((s) => s.key === "recall_session");
  if (rs?.state === "done") {
    const approx = deal.stage_dates?.live || null;
    // gone live per the sheet but nobody dated it: counts as complete, excluded from timings
    return approx ? { date: approx, source: "sheet" } : { date: null, source: "undated" };
  }
  return null;
}

// One deal → its dated checkpoints (monotonic), completed segments and current position.
export function buildJourney(deal, ctx, now = new Date()) {
  const goLive = resolveGoLive(deal, ctx);
  const dates = { created: deal.created, ...(deal.stage_dates || {}), golive: goLive?.date || null };
  const kept = [];
  for (const cp of CHECKPOINTS) {
    const d = dates[cp.key];
    if (!d) continue;
    if (kept.length && d < kept[kept.length - 1].date) continue; // out-of-order (bulk catch-ups) — skip
    kept.push({ ...cp, date: d });
  }
  const segments = [];
  for (let i = 0; i < kept.length - 1; i++) {
    segments.push({ from: kept[i].key, to: kept[i + 1].key, fromLabel: kept[i].label, toLabel: kept[i + 1].label,
      days: daysBetween(kept[i].date, kept[i + 1].date) });
  }
  const completed = !!goLive; // an undated go-live still counts as complete (just not timed)
  const last = kept[kept.length - 1] || null;
  const todayIso = now.toISOString().slice(0, 10);
  const current = !completed && last ? { key: last.key, label: last.label, since: last.date, days: daysBetween(last.date, todayIso) } : null;
  const totalDays = !kept.length ? null : completed ? (goLive.date ? daysBetween(kept[0].date, goLive.date) : null) : daysBetween(kept[0].date, todayIso);

  // onboarding position (fine-grained, only meaningful once DPA is signed)
  const steps = deal.onboarding ? mergeOnboarding(deal.onboarding, ctx.liveOnb?.[deal.ods]) : [];
  const applicable = steps.filter((s) => s.state !== "na");
  const nextStep = applicable.find((s) => s.state !== "done") || null;
  const doneCount = applicable.filter((s) => s.state === "done").length;
  const blocks = (deal.ods && ctx.activeBlocks?.[deal.ods]) || {};

  return {
    deal, goLive, checkpoints: kept, segments, completed, current, totalDays, todayIso,
    onboarding: { steps, nextStep, doneCount, total: applicable.length, blocks },
  };
}

// Index helpers built once from the raw feeds.
export function buildContext({ visits, recallers, liveOnb, events }) {
  const eventsByOds = {};
  for (const e of events?.steps || []) (eventsByOds[e.ods] ||= []).push(e);
  const firstRecallMonth = {};
  for (const r of recallers || []) if (r.ods && r.first_recall_month) firstRecallMonth[r.ods] = r.first_recall_month;
  // active blocks: latest un-cleared block per (ods, step)
  const activeBlocks = {};
  for (const b of events?.blocks || []) {
    if (b.cleared_at) continue;
    const cur = activeBlocks[b.ods]?.[b.step_key];
    if (!cur || b.blocked_at > cur.blocked_at) (activeBlocks[b.ods] ||= {})[b.step_key] = b;
  }
  return { visits: visits || {}, eventsByOds, firstRecallMonth, liveOnb: liveOnb || {}, activeBlocks, blocksAll: events?.blocks || [] };
}

const quarterOf = (iso) => {
  if (!iso) return null;
  const y = iso.slice(0, 4), m = +iso.slice(5, 7);
  return `${y} Q${Math.ceil(m / 3)}`;
};

// Roll a set of journeys up into everything the views need.
export function aggregate(journeys, ctx, now = new Date()) {
  const completed = journeys.filter((j) => j.completed);
  const inflight = journeys.filter((j) => !j.completed);
  const todayIso = now.toISOString().slice(0, 10);

  // ---- coarse phases: time spent AT each checkpoint before reaching the next dated one
  const phases = CHECKPOINTS.slice(0, -1).map((cp) => {
    const durs = [];
    for (const j of journeys) for (const s of j.segments) if (s.from === cp.key) durs.push(s.days);
    const here = inflight.filter((j) => j.current?.key === cp.key);
    const hereDays = here.map((j) => j.current.days);
    return {
      key: cp.key, label: cp.label, short: cp.short,
      n: durs.length, median: median(durs), p75: percentile(durs, 75), max: durs.length ? Math.max(...durs) : null,
      inflight: here.length, inflightMedian: median(hereDays), inflightMax: hereDays.length ? Math.max(...hereDays) : null,
      inflightOver30: here.filter((j) => j.current.days > 30).length,
    };
  });

  // ---- end-to-end
  const totals = completed.map((j) => j.totalDays).filter((x) => x != null);
  const sourceCounts = {};
  for (const j of completed) sourceCounts[j.goLive.source] = (sourceCounts[j.goLive.source] || 0) + 1;
  const buckets = [
    { label: "≤ 30d", lo: 0, hi: 30 }, { label: "31–60", lo: 31, hi: 60 }, { label: "61–90", lo: 61, hi: 90 },
    { label: "91–120", lo: 91, hi: 120 }, { label: "121–180", lo: 121, hi: 180 }, { label: "181–365", lo: 181, hi: 365 }, { label: "> 1 yr", lo: 366, hi: Infinity },
  ].map((b) => ({ ...b, n: totals.filter((t) => t >= b.lo && t <= b.hi).length }));

  // ---- stalling now
  const longest = [...inflight].filter((j) => j.current).sort((a, b) => b.current.days - a.current.days);

  // ---- fine-grained onboarding steps (DPA signed onwards, not yet gone live)
  // "past DPA" = a DPA-signed/Live stage date, or the deal sitting in one of those stages
  // (some Live deals were bulk-moved and never got a dpa_signed timestamp).
  const onbStart = (j) => j.deal.stage_dates?.dpa_signed || j.deal.stage_dates?.live || null;
  const onbInflight = inflight.filter((j) => j.onboarding.steps.length && (onbStart(j) || ["dpa_signed", "live"].includes(j.deal.stage)));
  const stepOrder = [];
  for (const j of journeys) for (const s of j.onboarding.steps) if (!stepOrder.find((x) => x.key === s.key)) stepOrder.push({ key: s.key, label: s.step });
  // completed step durations from real (non-seed) events: done(step) − done(previous applicable step), else − DPA signed
  const stepDone = {}; // ods -> step_key -> iso
  for (const [ods, evs] of Object.entries(ctx.eventsByOds)) {
    for (const e of evs) if (e.to_state === "done") {
      const d = isoDay(e.changed_at);
      if (!stepDone[ods]?.[e.step_key] || d < stepDone[ods][e.step_key]) (stepDone[ods] ||= {})[e.step_key] = d;
    }
  }
  const steps = stepOrder.map((st, idx) => {
    const stuck = onbInflight.filter((j) => j.onboarding.nextStep?.key === st.key);
    const waitDays = stuck.map((j) => {
      // waited since the previous step was (human-)completed, else since DPA signed
      const prevKeys = stepOrder.slice(0, idx).map((x) => x.key);
      const prevDates = prevKeys.map((k) => stepDone[j.deal.ods]?.[k]).filter(Boolean).sort();
      const since = prevDates[prevDates.length - 1] || onbStart(j) || j.deal.created;
      return since ? daysBetween(since, todayIso) : null;
    });
    const blocked = stuck.filter((j) => j.onboarding.blocks[st.key]);
    const blockedAny = onbInflight.filter((j) => j.onboarding.blocks[st.key]);
    const byWaiting = {};
    for (const j of blockedAny) { const w = j.onboarding.blocks[st.key].waiting_on || "unknown"; byWaiting[w] = (byWaiting[w] || 0) + 1; }
    const durs = [];
    for (const [ods, done] of Object.entries(stepDone)) {
      if (!done[st.key]) continue;
      const j = journeys.find((x) => x.deal.ods === ods);
      const prevDates = stepOrder.slice(0, idx).map((x) => done[x.key]).filter(Boolean).sort();
      const since = prevDates[prevDates.length - 1] || (j && onbStart(j));
      if (since && done[st.key] >= since) durs.push(daysBetween(since, done[st.key]));
    }
    return {
      key: st.key, label: st.label,
      stuck: stuck.length, stuckMedian: median(waitDays), stuckMax: waitDays.some((d) => d != null) ? Math.max(...waitDays.filter((d) => d != null)) : null,
      blocked: blocked.length, blockedAny: blockedAny.length, byWaiting,
      n: durs.length, median: median(durs), p75: percentile(durs, 75),
      practices: stuck.map((j, i) => ({ name: j.deal.name, ods: j.deal.ods, days: waitDays[i], blocked: !!j.onboarding.blocks[st.key], journey: j }))
        .sort((a, b) => b.days - a.days),
    };
  });
  const clearedBlocks = ctx.blocksAll.filter((b) => b.cleared_at).map((b) => daysBetween(b.blocked_at, b.cleared_at)).filter((d) => d >= 1);
  const activeBlockList = [];
  for (const [ods, m] of Object.entries(ctx.activeBlocks)) for (const [k, b] of Object.entries(m)) {
    const j = journeys.find((x) => x.deal.ods === ods);
    if (!j || j.completed) continue;
    activeBlockList.push({ name: j.deal.name, ods, step: stepOrder.find((s) => s.key === k)?.label || k, waiting_on: b.waiting_on, reason: b.reason, days: daysBetween(b.blocked_at, todayIso), journey: j });
  }
  activeBlockList.sort((a, b) => b.days - a.days);

  // ---- cohorts by sign-up quarter
  const byQ = {};
  for (const j of journeys) {
    const q = quarterOf(j.deal.created);
    if (!q) continue;
    (byQ[q] ||= []).push(j);
  }
  const cohorts = Object.keys(byQ).sort().map((q) => {
    const js = byQ[q];
    const done = js.filter((j) => j.completed);
    const dpa = js.filter((j) => j.deal.stage_dates?.dpa_signed);
    const toDpa = dpa.map((j) => daysBetween(j.deal.created, j.deal.stage_dates.dpa_signed));
    const open = js.filter((j) => !j.completed);
    return {
      quarter: q, n: js.length, live: done.length, livePct: js.length ? Math.round((done.length / js.length) * 100) : 0,
      dpa: dpa.length, dpaPct: js.length ? Math.round((dpa.length / js.length) * 100) : 0,
      medianToDpa: median(toDpa), medianToLive: median(done.map((j) => j.totalDays)),
      inflight: open.length, inflightMedianAge: median(open.map((j) => j.totalDays)),
      stageMix: CHECKPOINTS.slice(0, -1).map((cp) => ({ key: cp.key, short: cp.short, n: open.filter((j) => j.current?.key === cp.key).length })),
    };
  });

  return {
    total: journeys.length, completed: completed.length, inflight: inflight.length,
    medianTotal: median(totals), p75Total: percentile(totals, 75), maxTotal: totals.length ? Math.max(...totals) : null,
    inflightMedianAge: median(inflight.map((j) => j.totalDays)),
    inflightOver90: inflight.filter((j) => (j.totalDays || 0) > 90).length,
    sourceCounts, buckets, phases, longest, steps, onbInflight: onbInflight.length,
    clearedBlocksMedian: median(clearedBlocks), clearedBlocksN: clearedBlocks.length, activeBlockList, cohorts,
  };
}
