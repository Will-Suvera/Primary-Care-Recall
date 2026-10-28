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

// Recalls per week (keyed by Monday) and the staff who recalled each week.
export function weekly(p) {
  const weeks = new Map();
  for (const [day, n] of Object.entries(p.days || {})) {
    const w = monday(day);
    weeks.set(w, (weeks.get(w) || 0) + n);
  }
  const users = new Map();
  for (const [email, days] of Object.entries(p.users || {})) {
    for (const day of days) {
      const w = monday(day);
      if (!users.has(w)) users.set(w, new Set());
      users.get(w).add(email);
    }
  }
  return { weeks, users };
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
  const { weeks, users } = weekly(p);
  const signedWeek = monday(p.signed.slice(0, 10));
  const tenureWeeks = Math.floor(daysBetween(signedWeek, lastWeek) / 7) + 1;
  const used = usedWeeksAt(weeks, lastWeek, firstWeek);
  const strip = [];
  for (let i = STRIP_WEEKS - 1; i >= 0; i--) {
    const w = addDays(lastWeek, -7 * i);
    strip.push({ week: w, count: weeks.get(w) || 0, users: [...(users.get(w) || [])], noData: w < firstWeek });
  }
  const recent = new Set();
  for (let i = 0; i < WINDOW; i++) for (const e of users.get(addDays(lastWeek, -7 * i)) || []) recent.add(e);
  const days = Object.keys(p.days || {}).filter((d) => d <= addDays(lastWeek, 6));
  const lastRecall = days.length ? days[days.length - 1] : null;

  let status;
  if (tenureWeeks < 1) status = "ramping";
  else if (used == null) status = "unknown";
  else if (used >= need) status = "on_track";
  else if (used === 0 && [...weeks].some(([w, n]) => w < addDays(lastWeek, -7 * (WINDOW - 1)) && n >= MIN_WEEK_RECALLS)) status = "stopped";
  else if (Array.from({ length: 8 }, (_, i) => usedWeeksAt(weeks, addDays(lastWeek, -7 * (i + 1)), firstWeek)).some((u) => u != null && u >= need)) status = "dropped";
  else if (tenureWeeks >= RAMP_WEEKS) status = "not_reached";
  else status = "ramping";

  return {
    ...p, cohort: p.signed.slice(0, 7), tenureWeeks, used, status, strip, weeks,
    activeUsers: [...recent].sort(), lastRecall,
  };
}

export function buildLir(lir, { need = DEFAULT_WEEKS, today }) {
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
    for (let k = 1; k <= span; k++) {
      const m = addMonths(month, k);
      const w = lastMondayOf(m);
      const hits = members.map((p) => usedWeeksAt(p.weeks, w, firstWeek));
      if (hits.every((u) => u == null)) { cells.push({ k, month: m, noData: true }); continue; }
      const hit = members.filter((_, i) => hits[i] != null && hits[i] >= need);
      cells.push({ k, month: m, hit: hit.length, of: members.length, pct: Math.round((100 * hit.length) / members.length), hitNames: hit.map((p) => p.name) });
    }
    return { month, n: members.length, members, cells };
  });
  const maxK = Math.max(0, ...cohorts.map((c) => c.cells.length));

  const judged = practices.filter((p) => p.used != null && p.tenureWeeks >= 1);
  const watch = [...practices].sort((a, b) =>
    STATUS[a.status].rank - STATUS[b.status].rank || Number(b.paid) - Number(a.paid) || (b.patients || 0) - (a.patients || 0));
  return {
    need, lastWeek, lastFull, cohorts, maxK, watch,
    onTrack: judged.filter((p) => p.status === "on_track").length,
    judged: judged.length,
    churnSignals: practices.filter((p) => p.status === "stopped" || p.status === "dropped").length,
    notReached: practices.filter((p) => p.status === "not_reached").length,
  };
}
