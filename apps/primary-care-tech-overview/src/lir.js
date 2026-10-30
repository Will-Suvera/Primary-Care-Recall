// Leading indicator of retention (LIR) — Roberge, "The Science of Scaling" ch.4.
// "P% of practices use Planner in at least K of every 4 weeks", read by acquisition
// cohort (the month the DPA was signed, so onboarding drag shows). Weekly usage was
// picked over "% of list" and "% bulk recall" because it rates the accounts CS knows
// correctly: steady single-recallers healthy, one-off bulk weeks not. Pure functions; rendered by LirCohort.jsx. Data: funnel_board.json `lir`.

export const WEEKS_NEEDED = [2, 3, 4];
export const DEFAULT_WEEKS = 3;
export const WINDOW = 4;
// a week counts as "used" with this many recalls — one test click isn't usage
// (same floor as MIN_ACTIVE_RECALLS in build_funnel_board.py)
export const MIN_WEEK_RECALLS = 5;
export const MAX_TENURE = 12;
export const STRIP_WEEKS = 12;
// no verdict until a practice has had two months to get going
const RAMP_WEEKS = 8;
// Bulk and Suggestions are shares of patients recalled, so a practice needs this many
// recalls (or judged recalls) before its % means anything — 4 recalls all in bulk isn't "100% bulk"
export const MIN_MIX = 20;
// a practice's last 4 weeks this far from its all-time share counts as a change of direction
const TREND_POINTS = 10;

// The three ways of reading how well a practice uses Suvera Recall. Consistency is the
// LIR (weeks used); Bulk and Suggestions are how well it's used, read all-time to date
// so one bulk run doesn't flip a practice from one week to the next.
export const METRICS = {
  consistency: { label: "Consistency", options: WEEKS_NEEDED, def: DEFAULT_WEEKS, unit: (k) => `${k} of ${WINDOW} weeks` },
  bulk: { label: "Bulk", options: [30, 50, 70], def: 50, unit: (k) => `${k}%+ bulk` },
  sugg: { label: "Suggestions", options: [80, 90, 95], def: 90, unit: (k) => `${k}%+ accepted` },
};

const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const monday = (s) => addDays(s, -((D(s).getUTCDay() + 6) % 7));
export const addMonths = (ym, k) => {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
export const monthsBetween = (a, b) => {
  const [ya, ma] = a.split("-").map(Number);
  const [yb, mb] = b.split("-").map(Number);
  return (yb - ya) * 12 + (mb - ma);
};
// the week a month is judged on: the last one starting inside it
export const lastMondayOf = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return monday(iso(new Date(Date.UTC(y, m, 0))));
};
const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 86400000);

export const STATUS = {
  stopped:     { rank: 0, tone: "bad",     label: "Stopped using" },
  dropped:     { rank: 1, tone: "bad",     label: "Dropped off" },
  not_reached: { rank: 2, tone: "warn",    label: "Never got going" },
  ramping:     { rank: 3, tone: "neutral", label: "Ramping up" },
  unknown:     { rank: 4, tone: "neutral", label: "No data" },
  on_track:    { rank: 5, tone: "good",    label: "On track" },
};

// Patients recalled in bulk, and automated recalls where every suggestion was kept,
// between two dates (inclusive). Shares are % of patients, null below MIN_MIX.
export function mix(p, from, to) {
  const inRange = (d) => (!from || d >= from) && d <= to;
  let total = 0, bulk = 0, kept = 0, judged = 0;
  for (const [d, n] of Object.entries(p.days || {})) if (inRange(d)) total += n;
  for (const [d, n] of Object.entries(p.bulk || {})) if (inRange(d)) bulk += n;
  for (const [d, [k, j]] of Object.entries(p.sugg || {})) if (inRange(d)) { kept += k; judged += j; }
  return {
    total, bulkN: bulk, kept, judged,
    bulk: total >= MIN_MIX ? (100 * bulk) / total : null,
    sugg: judged >= MIN_MIX ? (100 * kept) / judged : null,
  };
}

// Recalls per week (keyed by Monday) and the staff who recalled each week.
export function weekly(p) {
  const weeks = new Map();
  for (const [day, n] of Object.entries(p.days || {})) {
    const w = monday(day);
    weeks.set(w, (weeks.get(w) || 0) + n);
  }
  const bulk = new Map(), sugg = new Map();
  for (const [day, n] of Object.entries(p.bulk || {})) bulk.set(monday(day), (bulk.get(monday(day)) || 0) + n);
  for (const [day, [k, j]] of Object.entries(p.sugg || {})) {
    const s = sugg.get(monday(day)) || [0, 0];
    sugg.set(monday(day), [s[0] + k, s[1] + j]);
  }
  const users = new Map();
  for (const [email, days] of Object.entries(p.users || {})) {
    for (const day of days) {
      const w = monday(day);
      if (!users.has(w)) users.set(w, new Set());
      users.get(w).add(email);
    }
  }
  return { weeks, users, bulk, sugg };
}

// Weeks used in the 4 weeks ending `w`, or null when part of that window predates
// the data — a gap in the feed must never read as "stopped".
export function usedWeeksAt(weeks, w, firstWeek) {
  if (addDays(w, -7 * (WINDOW - 1)) < firstWeek) return null;
  let n = 0;
  for (let i = 0; i < WINDOW; i++) if ((weeks.get(addDays(w, -7 * i)) || 0) >= MIN_WEEK_RECALLS) n++;
  return n;
}

// One practice's state at the last full week, plus what the watchlist shows.
export function practiceSignal(p, { need, lastWeek, firstWeek }) {
  const { weeks, users, bulk, sugg } = weekly(p);
  const signedWeek = monday(p.signed.slice(0, 10));
  const tenureWeeks = Math.floor(daysBetween(signedWeek, lastWeek) / 7) + 1;
  const used = usedWeeksAt(weeks, lastWeek, firstWeek);
  const strip = [];
  for (let i = STRIP_WEEKS - 1; i >= 0; i--) {
    const w = addDays(lastWeek, -7 * i);
    strip.push({ week: w, count: weeks.get(w) || 0, bulk: bulk.get(w) || 0, sugg: sugg.get(w) || [0, 0], users: [...(users.get(w) || [])], noData: w < firstWeek });
  }
  const recent = new Set();
  for (let i = 0; i < WINDOW; i++) for (const e of users.get(addDays(lastWeek, -7 * i)) || []) recent.add(e);
  const days = Object.keys(p.days || {}).filter((d) => d <= addDays(lastWeek, 6));
  const lastRecall = days.length ? days[days.length - 1] : null;
  // totals stop at the last full week, like everything else on the tab
  const totalRecalls = days.reduce((n, d) => n + p.days[d], 0);
  const recentRecalls = strip.slice(-WINDOW).reduce((n, w) => n + w.count, 0);

  let status;
  if (tenureWeeks < 1) status = "ramping";
  else if (used == null) status = "unknown";
  else if (used >= need) status = "on_track";
  else if (used === 0 && [...weeks].some(([w, n]) => w < addDays(lastWeek, -7 * (WINDOW - 1)) && n >= MIN_WEEK_RECALLS)) status = "stopped";
  else if (Array.from({ length: 8 }, (_, i) => usedWeeksAt(weeks, addDays(lastWeek, -7 * (i + 1)), firstWeek)).some((u) => u != null && u >= need)) status = "dropped";
  else if (tenureWeeks >= RAMP_WEEKS) status = "not_reached";
  else status = "ramping";

  // Bulk and Suggestions: all-time share (the kind of practice it is) and whether the
  // last 4 weeks are heading above or below it
  const end = addDays(lastWeek, 6);
  const allMix = mix(p, null, end);
  const recentMix = mix(p, addDays(lastWeek, -7 * (WINDOW - 1)), end);
  const trend = (k) => (allMix[k] == null || recentMix[k] == null ? null
    : recentMix[k] - allMix[k] >= TREND_POINTS ? "up" : allMix[k] - recentMix[k] >= TREND_POINTS ? "down" : "flat");

  return {
    ...p, cohort: p.signed.slice(0, 7), tenureWeeks, used, status, strip, weeks,
    activeUsers: [...recent].sort(), lastRecall, totalRecalls, recentRecalls,
    allMix, recentMix, trends: { bulk: trend("bulk"), sugg: trend("sugg") },
  };
}

// Does a practice meet the selected bar? null = can't say (too few recalls).
export const passes = (p, metric, k) =>
  metric === "consistency" ? (p.used == null ? null : p.used >= k)
    : p.allMix[metric] == null ? null : p.allMix[metric] >= k;

export function buildLir(lir, { need = DEFAULT_WEEKS, today, metric = "consistency", bars = {} }) {
  const bar = { bulk: METRICS.bulk.def, sugg: METRICS.sugg.def, ...bars, consistency: need };
  const all = lir?.practices || [];
  if (!lir?.from) return { need, cohorts: [], maxK: 0, watch: [], onTrack: 0, judged: 0, churnSignals: 0, notReached: 0, empty: true };
  // the current week and month are still in progress — judging them would read as a drop
  const lastWeek = addDays(monday(today), -7);
  const lastFull = addMonths(today.slice(0, 7), -1);
  const firstWeek = lir.from === monday(lir.from) ? lir.from : addDays(monday(lir.from), 7);
  const practices = all.filter((p) => p.signed).map((p) => practiceSignal(p, { need, lastWeek, firstWeek }));

  const byCohort = new Map();
  for (const p of practices) {
    if (!byCohort.has(p.cohort)) byCohort.set(p.cohort, []);
    byCohort.get(p.cohort).push(p);
  }
  const cohorts = [...byCohort.keys()].sort().map((month) => {
    const members = byCohort.get(month);
    const span = Math.min(MAX_TENURE, monthsBetween(month, lastFull));
    const cells = [];
    // k = 0 is the signing month itself: practices should be live within 2–3 weeks,
    // so signing on 1 Sep should already show by the end of Sep (onboarding speed)
    for (let k = 0; k <= span; k++) {
      const m = addMonths(month, k);
      const w = lastMondayOf(m);
      if (usedWeeksAt(new Map(), w, firstWeek) == null) { cells.push({ k, month: m, noData: true }); continue; }
      // per practice: weeks used in the 4 weeks ending that month, or its bulk/suggestions
      // share from the start of the data to the end of that month
      const vals = members.map((p) => (metric === "consistency" ? usedWeeksAt(p.weeks, w, firstWeek) : mix(p, null, addDays(w, 6))[metric]));
      const rows = members.map((p, i) => ({ name: p.name, ods: p.ods, paid: p.paid, value: vals[i], onTrack: vals[i] != null && vals[i] >= bar[metric] }));
      // consistency judges every practice; bulk/suggestions only those with enough recalls
      const of = metric === "consistency" ? members.length : vals.filter((v) => v != null).length;
      if (!of) { cells.push({ k, month: m, empty: true, rows }); continue; }
      const hit = rows.filter((x) => x.onTrack).length;
      cells.push({ k, month: m, hit, of, pct: Math.round((100 * hit) / of), rows });
    }
    return { month, n: members.length, members, cells };
  });
  const maxK = Math.max(0, ...cohorts.map((c) => c.cells.length));

  const judged = practices.filter((p) => p.used != null && p.tenureWeeks >= 1);
  // the three headline cards: practices meeting each bar now, plus the patient-level share
  const sum = (key, part) => practices.reduce((n, p) => n + p[part][key], 0);
  const share = (num, den) => (den ? Math.round((100 * num) / den) : null);
  const card = (m) => {
    const able = practices.filter((p) => passes(p, m, bar[m]) != null);
    return { pass: able.filter((p) => passes(p, m, bar[m])).length, of: able.length };
  };
  const cards = {
    consistency: { pass: judged.filter((p) => p.status === "on_track").length, of: judged.length },
    bulk: { ...card("bulk"), all: share(sum("bulkN", "allMix"), sum("total", "allMix")), recent: share(sum("bulkN", "recentMix"), sum("total", "recentMix")) },
    sugg: { ...card("sugg"), all: share(sum("kept", "allMix"), sum("judged", "allMix")), recent: share(sum("kept", "recentMix"), sum("judged", "recentMix")) },
  };
  const watch = [...practices].sort((a, b) =>
    STATUS[a.status].rank - STATUS[b.status].rank || Number(b.paid) - Number(a.paid) || (b.patients || 0) - (a.patients || 0));
  return {
    need, bar, metric, cards, lastWeek, lastFull, cohorts, maxK, watch,
    onTrack: judged.filter((p) => p.status === "on_track").length,
    judged: judged.length,
    churnSignals: practices.filter((p) => p.status === "stopped" || p.status === "dropped").length,
    notReached: practices.filter((p) => p.status === "not_reached").length,
    totalRecalls: practices.reduce((n, p) => n + p.totalRecalls, 0),
    recentRecalls: practices.reduce((n, p) => n + p.recentRecalls, 0),
  };
}
