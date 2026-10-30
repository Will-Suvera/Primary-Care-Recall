import React, { useEffect, useMemo, useState } from "react";
import { ONB_BASE } from "../onboarding.js";
import { buildLir, METRICS, MIN_MIX, MIN_WEEK_RECALLS, STATUS, WINDOW } from "../lir.js";

// Leading indicator of retention, Roberge "The Science of Scaling" ch.4: practices
// grouped by the month their DPA was signed, and the share of each cohort using
// Planner in at least K of the last 4 weeks, month by month after signing. Two more
// reads of how well it's used sit beside it (Bulk, Suggestions); the selected card
// drives the cohort table. Pure presentation — maths in ../lir.js.

const fmtMonth = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
const fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const monthsTo = (d, today) => Math.max(0, Math.round((new Date(`${d}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / (30.44 * 86400000)));
const daysAgo = (d, today) => Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${d}T00:00:00Z`)) / 86400000);
// single-hue sequential (brand purple); ink text until the fill is dark enough for white
// Paid = "PAID -" / "PAID (Trial First) -" on the HubSpot deal; freemium = everyone else
const PLANS = [["all", "All"], ["paid", "Paid"], ["freemium", "Freemium"]];
const heat = (p) => (p >= 75 ? 4 : p >= 50 ? 3 : p >= 25 ? 2 : p > 0 ? 1 : 0);

// what each watchlist signal means, for the hover card
const STATUS_WHY = {
  on_track: (n) => `Meets the bar of ${n} used weeks out of ${WINDOW}.`,
  stopped: () => `No used weeks in the last ${WINDOW}, after being active earlier.`,
  dropped: () => "Was on track in the last 2 months, now below the bar.",
  not_reached: () => "Signed 2+ months ago and has never hit the bar.",
  ramping: () => "Signed under 2 months ago, so too early to judge.",
  unknown: () => "Not enough Omni data yet to judge.",
};

// Instant hover card (native title tooltips are slow and tiny); tap toggles it on touch.
function useTip() {
  const [tip, setTip] = useState(null);
  const on = (content) => ({
    onMouseEnter: (e) => setTip({ content, x: e.clientX, y: e.clientY }),
    onMouseMove: (e) => setTip((t) => t && { ...t, x: e.clientX, y: e.clientY }),
    onMouseLeave: () => setTip(null),
    onClick: (e) => setTip((t) => (t?.content === content ? null : { content, x: e.clientX, y: e.clientY })),
  });
  const flip = tip && typeof window !== "undefined" && tip.x > window.innerWidth - 300;
  const el = tip && (
    <div className="lir-tip" role="tooltip" style={{ top: tip.y + 16, ...(flip ? { right: window.innerWidth - tip.x + 8 } : { left: tip.x + 12 }) }}>
      {tip.content}
    </div>
  );
  return [on, el];
}

const pct = (v) => (v == null ? "–" : `${Math.round(v)}%`);
const ARROW = { up: "↑", down: "↓", flat: "→" };
const ARROW_WHY = { up: "higher in the last 4 weeks", down: "lower in the last 4 weeks", flat: "about the same in the last 4 weeks" };

// per metric: the cohort table's question, column header and what a passing practice does
const COPY = {
  consistency: {
    q: "Do practices become regular users after signing?",
    group: () => "% using Suvera Recall regularly, months after signing →",
    does: () => "are regular users",
    note: (k) => `“Regularly” = recalls in at least ${k} of the last ${WINDOW} weeks, checked at the end of each month.`,
  },
  bulk: {
    q: "Do practices start recalling in bulk?",
    group: (k) => `% recalling ${k}%+ of patients in bulk (to date), months after signing →`,
    does: (k) => `recall ${k}%+ of their patients in bulk`,
    note: (k) => `Bulk = % of a practice's patients recalled in a bulk run, from the start of the data to the end of each month; ${k}%+ passes. Practices with under ${MIN_MIX} recalls by then aren't counted.`,
  },
  sugg: {
    q: "Do practices trust Planner's suggestions?",
    group: (k) => `% keeping every suggestion for ${k}%+ of patients (to date), months after signing →`,
    does: (k) => `keep every suggestion for ${k}%+ of patients`,
    note: (k) => `Suggestions = % of automated recalls (bulk or single) where staff kept every test Planner suggested, to the end of each month; ${k}%+ passes. Recalls where Planner suggested nothing aren't counted, nor practices with under ${MIN_MIX} such recalls.`,
  },
};

// Bulk / Suggestions cell: all-time share, tinted if it meets the bar, arrow = last 4 weeks
function MixCell({ p, m, k, tipOn }) {
  const v = p.allMix[m], r = p.recentMix[m], t = p.trends[m];
  const what = m === "bulk" ? "of patients recalled in bulk" : "of automated recalls kept every suggestion";
  const counts = m === "bulk"
    ? `${p.allMix.bulkN.toLocaleString("en-GB")} bulk · ${(p.allMix.total - p.allMix.bulkN).toLocaleString("en-GB")} single`
    : `${p.allMix.kept.toLocaleString("en-GB")} of ${p.allMix.judged.toLocaleString("en-GB")} automated recalls`;
  return (
    <td className="num lir-hov" {...tipOn(
      <>
        <b>{v == null ? "Too few recalls to say" : `${pct(v)} ${what}`}</b>
        <div className="st-faint">Since the data starts: {counts}</div>
        {v == null && <div className="st-faint">Needs {MIN_MIX}+ {m === "bulk" ? "recalls" : "automated recalls with suggestions"}.</div>}
        {r != null && <div>Last {WINDOW} weeks: {pct(r)}{t ? ` (${ARROW_WHY[t]})` : ""}</div>}
        {v != null && <div className="st-faint">{v >= k ? "Meets" : "Below"} the {k}% bar</div>}
      </>
    )}>
      <span className={"lir-mixv" + (v == null ? "" : v >= k ? " pass" : " fail")}>{pct(v)}</span>
      {t && <span className="lir-arrow">{ARROW[t]}</span>}
    </td>
  );
}

// sortable watchlist columns: value to sort on, and which way a first click sorts
const SORTS = {
  practice: { get: (p) => p.name.toLowerCase(), first: 1 },
  signal: { get: (p, i) => i, first: 1 },
  signed: { get: (p) => p.signed, first: -1 },
  last: { get: (p) => p.lastRecall, first: -1 },
  recent: { get: (p) => p.recentRecalls, first: -1 },
  total: { get: (p) => p.totalRecalls, first: -1 },
  users: { get: (p) => p.activeUsers.length, first: -1 },
  bulk: { get: (p) => p.allMix.bulk, first: -1 },
  sugg: { get: (p) => p.allMix.sugg, first: -1 },
  renews: { get: (p) => p.contract?.renews, first: 1 },
};

const PaidChip = ({ p }) => (p.paid ? <span className="su-status good lir-paid">PAID</span> : <span className="lir-free">freemium</span>);

// The panel under the cohort table: who is in the hovered/tapped signing month, and
// (for a cell) who was using Suvera Recall regularly at that point.
// leave a practice out of the cohorts (shared, saved to Neon)
const ExcludeBtn = ({ ods, onExclude }) => (
  <button className="lir-excl-btn" title="Leave out of the cohorts, cards and watchlist (e.g. a test site or not a real customer). Everyone sees this."
    onClick={(e) => { e.stopPropagation(); onExclude(ods, true); }}>Exclude</button>
);

function CohortDetail({ sel, metric, k, onExclude }) {
  if (!sel) return <div className="lir-detail lir-detail-empty">Hover or tap a month or a % to see the practices behind it.</div>;
  const { cohort: c, cell } = sel;
  if (!cell) {
    return (
      <div className="lir-detail">
        <div className="lir-detail-h"><b>{c.n} practice{c.n === 1 ? "" : "s"} signed in {fmtMonth(c.month)}</b></div>
        <ul>
          {c.members.map((p) => (
            <li key={p.ods}>
              <span><b>{p.name}</b> <PaidChip p={p} />{p.pcn && !p.pcn_placeholder ? <span className="st-faint"> · {p.pcn.name}</span> : null}</span>
              <span className="st-faint">
                <ExcludeBtn ods={p.ods} onExclude={onExclude} />
                {p.stage === "no_deal" ? `first recall ${fmtDay(p.signed.slice(0, 10))}` : `DPA signed ${fmtDay(p.signed.slice(0, 10))}${p.signed_approx ? " (approx.)" : ""}`}
                {p.contract ? ` · paid contract from ${fmtDay(p.contract.start)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const rows = [...cell.rows].sort((a, b) => Number(b.onTrack) - Number(a.onTrack) || (b.value ?? -1) - (a.value ?? -1));
  const show = (v) => (v == null ? (metric === "consistency" ? "–" : `under ${MIN_MIX} recalls`)
    : metric === "consistency" ? `${v} of ${WINDOW} weeks used` : `${pct(v)} ${metric === "bulk" ? "bulk" : "kept every suggestion"}`);
  return (
    <div className="lir-detail">
      <div className="lir-detail-h">
        <b>Signed {fmtMonth(c.month)}, {cell.k} month{cell.k === 1 ? "" : "s"} later (end of {fmtMonth(cell.month)}):</b>{" "}
        {cell.empty ? `none with ${MIN_MIX}+ recalls yet` : `${cell.hit} of ${cell.of} ${COPY[metric].does(k)} (${cell.pct}%)`}
      </div>
      <ul>
        {rows.map((p) => (
          <li key={p.ods}>
            <span>{p.value == null ? "·" : p.onTrack ? "✓" : "✗"} <b>{p.name}</b> <PaidChip p={p} /></span>
            <span className={p.onTrack ? "" : "st-faint"}><ExcludeBtn ods={p.ods} onExclude={onExclude} />{show(p.value)}{p.value != null && !p.onTrack ? ` (needs ${metric === "consistency" ? k : `${k}%`})` : ""}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function LirCohort({ lir, generatedAt, auth }) {
  const [metric, setMetric] = useState("consistency");
  const [bars, setBars] = useState(() => Object.fromEntries(Object.entries(METRICS).map(([m, x]) => [m, x.def])));
  const [sort, setSort] = useState({ key: "signal", dir: 1 });
  const [plan, setPlan] = useState("all");
  // practices left out of the cohorts — the book counts only ideal-customer-profile
  // customers acquired each month; this is the hand-picked version of that
  const [excluded, setExcluded] = useState({});
  const [exclErr, setExclErr] = useState(null);
  const headers = auth?.token ? { Authorization: `Bearer ${auth.token}` } : {};
  useEffect(() => {
    fetch(`${ONB_BASE}/lir-excluded`, { headers }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((x) => setExcluded(x && typeof x === "object" ? x : {}))
      .catch(() => setExclErr("Couldn't load the excluded practices, so everyone is counted."));
  }, [auth?.token]);
  const setExcl = (ods, on) => {
    setExcluded((prev) => {
      const next = { ...prev };
      if (on) next[ods] = { by: auth?.email ? auth.email.split("@")[0].split(".")[0] : "you", at: new Date().toISOString() };
      else delete next[ods];
      return next;
    });
    setSel(null);
    fetch(`${ONB_BASE}/lir-excluded`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ ods, excluded: on }),
    }).then((r) => { if (!r.ok) throw new Error(r.status); setExclErr(null); })
      .catch(() => setExclErr("That change didn't save. Check your connection and try again."));
  };
  const [sel, setSel] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [tipOn, tipEl] = useTip();
  const today = (generatedAt || new Date().toISOString()).slice(0, 10);
  const r = useMemo(() => {
    const keep = (p) => (plan === "all" || (plan === "paid") === Boolean(p.paid)) && !excluded[p.ods];
    return buildLir(lir && { ...lir, practices: (lir.practices || []).filter(keep) }, { need: bars.consistency, bars, metric, today });
  }, [lir, bars, metric, today, plan, excluded]);
  const left = (lir?.practices || []).filter((p) => excluded[p.ods]);
  const need = bars.consistency, k = bars[metric];

  if (!lir || r.empty) {
    return (
      <section className="ov-card">
        <p className="ov-sub">No retention data in this build{lir?.error ? ` — ${lir.error}` : " — the Omni recalls sheet isn't configured"}.</p>
      </section>
    );
  }
  // r.watch is worst first; any other column re-sorts it (blanks last, worst-first breaks ties)
  const rank = new Map(r.watch.map((p, i) => [p, i]));
  const sorted = sort.key === "signal" && sort.dir === 1 ? r.watch : [...r.watch].sort((a, b) => {
    const get = SORTS[sort.key].get, x = get(a, rank.get(a)), y = get(b, rank.get(b));
    if (x == null || y == null) return (x == null) - (y == null) || rank.get(a) - rank.get(b);
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || rank.get(a) - rank.get(b);
  });
  const sortBy = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: SORTS[key].first }));
  const Th = ({ id, num, children }) => (
    <th className={(num ? "num " : "") + "lir-sort" + (sort.key === id ? " on" : "")} onClick={() => sortBy(id)}
      aria-sort={sort.key === id ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      {children}<span className="lir-sort-ic">{sort.key === id ? (sort.dir === 1 ? "▲" : "▼") : ""}</span>
    </th>
  );
  const watch = showAll ? sorted : sorted.filter((p) => p.status !== "on_track");
  // A PCN contract's practices sit together under a PCN header, placed where its
  // worst practice ranks; once a group shows, all its practices show.
  const watchRows = [];
  const seenPcn = new Set();
  for (const p of watch) {
    if (!p.pcn || p.pcn_placeholder) { watchRows.push({ p }); continue; }
    if (seenPcn.has(p.pcn.ods)) continue;
    seenPcn.add(p.pcn.ods);
    const members = sorted.filter((q) => q.pcn?.ods === p.pcn.ods && !q.pcn_placeholder);
    watchRows.push({ head: { ...p.pcn, paid: p.paid, n: members.length } });
    for (const q of members) watchRows.push({ p: q });
  }
  const yearOut = new Date(`${today}T00:00:00Z`); yearOut.setUTCFullYear(yearOut.getUTCFullYear() + 1);
  // one per contract: a PCN's practices share theirs, on track if any of them is
  const renewByOwner = new Map();
  for (const p of r.watch) {
    if (!p.contract || p.contract.renews > yearOut.toISOString().slice(0, 10)) continue;
    const k = p.pcn?.ods || p.ods;
    const prev = renewByOwner.get(k);
    if (!prev || (p.status === "on_track" && prev.status !== "on_track")) renewByOwner.set(k, p);
  }
  const renewSoon = [...renewByOwner.values()];
  // one-line takeaway: the typical and best share of a signing month that became regular users
  const filled = r.cohorts.flatMap((c) => c.cells.filter((x) => !x.noData && !x.empty && c.n));
  const pcts = filled.map((x) => x.pct).sort((a, b) => a - b);
  const typical = pcts.length ? pcts[Math.floor(pcts.length / 2)] : null;
  const best = pcts.length ? pcts[pcts.length - 1] : null;
  // worked example: the biggest signing group, at its latest month
  const ex = r.cohorts.filter((c) => c.cells.some((x) => !x.noData && !x.empty)).sort((a, b) => b.n - a.n)[0];
  const exCell = ex?.cells.filter((x) => !x.noData && !x.empty).pop();
  const cols = Array.from({ length: r.maxK }, (_, i) => i + 1);

  return (
    <section className="ov-card lir-card" id="retention">
      <div className="ov-card-head">
        <div>
          <h2 className="ov-card-title">Leading indicator of retention</h2>
          <p className="ov-sub">
            Three reads of how practices use Suvera Recall. <b>Consistency</b> is the habit that predicts renewal;{" "}
            <b>Bulk</b> and <b>Suggestions</b> show how well it's used. Click a card to see it by signing month.
          </p>
          <details className="lir-about">
            <summary>How this works</summary>
            <p className="ov-sub">
              A leading indicator of retention (LIR) is an early habit that predicts whether a customer will renew.
              Contracts renew 1–3 years after signing; this lets us predict renewal much sooner. Ours is{" "}
              <b>using Suvera Recall in at least {need} of every {WINDOW} weeks</b> (a week counts with {MIN_WEEK_RECALLS}+
              recalls). Practices that lose it are early churn warnings we can still act on.
            </p>
            <p className="ov-sub">
              <b>Bulk</b> = % of a practice's patients recalled in a bulk run. <b>Suggestions</b> = % of automated recalls
              where staff kept every test Planner suggested. Both are read from the start of the data, so one bulk run
              doesn't swing them; the arrow shows whether the last {WINDOW} weeks are higher or lower. Higher is better for all three.
            </p>
            <p className="ov-sub">
              <b>Good looks like</b> all three cards going up, and in the table, numbers rising left to right with newer
              signing months beating older ones. From April 2027, when the first contracts renew, we check that on-track
              practices really did renew more, and adjust the definitions if not.
            </p>
          </details>
        </div>
        <div className="lir-controls">
          <div className="st-seg" role="group" aria-label="Paid or freemium">
            {PLANS.map(([key, label]) => (
              <button key={key} className={"st-seg-btn" + (plan === key ? " on" : "")} onClick={() => setPlan(key)}>{label}</button>
            ))}
          </div>
          <div className="st-seg" role="group" aria-label={`${METRICS[metric].label} bar`}>
            {METRICS[metric].options.map((o) => (
              <button key={o} className={"st-seg-btn" + (k === o ? " on" : "")} onClick={() => { setBars((b) => ({ ...b, [metric]: o })); setSel(null); }}>
                {METRICS[metric].unit(o)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="lir-cards" role="tablist" aria-label="Metric">
        {Object.entries(METRICS).map(([m, def]) => {
          const c = r.cards[m];
          const missing = m !== "consistency" && !lir.has?.[m];
          return (
            <button key={m} role="tab" aria-selected={metric === m} className={"lir-card-m" + (metric === m ? " on" : "")} onClick={() => { setMetric(m); setSel(null); }}>
              <div className="kpi-label">{def.label}{m === "consistency" ? `, week of ${fmtDay(r.lastWeek)}` : ""}</div>
              <div className="kpi-value su-num">{missing || !c.of ? "–" : `${Math.round((100 * c.pass) / c.of)}%`}</div>
              <div className="kpi-sub">
                {missing ? "Not in the Omni sheet yet"
                  : m === "consistency" ? `${c.pass} of ${c.of} ${plan === "all" ? "" : `${plan} `}practices use it ${bars.consistency}+ of ${WINDOW} weeks`
                  : `${c.pass} of ${c.of} practices ${COPY[m].does(bars[m])}`}
              </div>
              {!missing && m !== "consistency" && c.all != null && (
                <div className="kpi-sub st-faint">{c.all}% of all patients{c.recent != null ? ` · last ${WINDOW} wks ${c.recent}%` : ""}</div>
              )}
            </button>
          );
        })}
      </div>
      <div className="lir-minor">
        <span className={r.churnSignals ? "bad" : ""}><b className="su-num">{r.churnSignals}</b> churn signal{r.churnSignals === 1 ? "" : "s"} <span className="st-faint">(stopped or dropped off)</span></span>
        <span><b className="su-num">{r.notReached}</b> never got going <span className="st-faint">(2+ months, never on track)</span></span>
        <span className={renewSoon.some((p) => p.status !== "on_track") ? "bad" : ""}>
          <b className="su-num">{renewSoon.length}</b> renewing in 12 months <span className="st-faint">({renewSoon.filter((p) => p.status === "on_track").length} on track · {renewSoon.filter((p) => p.status !== "on_track").length} at risk)</span>
        </span>
        <span><b className="su-num">{r.recentRecalls.toLocaleString("en-GB")}</b> recalls in the last {WINDOW} weeks <span className="st-faint">({r.totalRecalls.toLocaleString("en-GB")} since {fmtDay(lir.from)})</span></span>
      </div>

      <div className="st-h">{COPY[metric].q}</div>
      {metric !== "consistency" && !lir.has?.[metric] ? (
        <p className="lir-takeaway st-faint">
          No {METRICS[metric].label.toLowerCase()} data yet: the Omni recalls sheet doesn't have the column. It appears on the next delivery that does.
        </p>
      ) : typical != null && (
        <p className="lir-takeaway">
          <b>In a typical month, {typical}% of a signing group {COPY[metric].does(k)}</b> (best so far: {best}%).
          Good looks like the numbers rising left to right, and newer rows beating older ones.
        </p>
      )}
      {exCell && (
        <p className="st-note lir-howto">
          How to read it: each row is the practices that signed in that month. E.g. <b>{ex.n} practices signed in {fmtMonth(ex.month)}</b> —{" "}
          {exCell.k} month{exCell.k > 1 ? "s" : ""} later, {exCell.hit} of {metric === "consistency" ? "them" : `the ${exCell.of} with ${MIN_MIX}+ recalls`} ({exCell.pct}%){" "}
          {COPY[metric].does(k).replace(/^are /, "were ")}. Hover or tap any month or % to see the practices in the panel below the table.
        </p>
      )}
      <div className="lir-scroll">
        <table className="st-table lir-table">
          <thead>
            <tr>
              <th rowSpan={2}>Signed in</th><th rowSpan={2} className="num">Practices<br />signed</th>
              {cols.length > 0 && <th colSpan={cols.length} className="lir-group">{COPY[metric].group(k)}</th>}
            </tr>
            <tr>
              {cols.map((col) => <th key={col} className="num">{col === 1 ? "1 month" : `${col} months`}</th>)}
            </tr>
          </thead>
          <tbody>
            {r.cohorts.map((c) => (
              <tr key={c.month}>
                <td className={"lir-rowh" + (sel?.cohort.month === c.month && !sel.cell ? " sel" : "")}
                  onMouseEnter={() => setSel({ cohort: c })} onClick={() => setSel({ cohort: c })}>
                  <b>{fmtMonth(c.month)}</b>
                </td>
                <td className="num su-num">{c.n}</td>
                {c.cells.length === 0 && <td colSpan={cols.length} className="st-faint lir-toonew">signed too recently to judge</td>}
                {c.cells.length > 0 && cols.map((col) => {
                  const cell = c.cells[col - 1];
                  if (!cell) return <td key={col} />;
                  if (cell.noData) return <td key={col} className="lir-cell nodata" title={`${fmtMonth(cell.month)}: before the Omni data starts`} />;
                  if (cell.empty) {
                    return (
                      <td key={col} className={"lir-cell h0" + (sel?.cell === cell ? " sel" : "")}
                        onMouseEnter={() => setSel({ cohort: c, cell })} onClick={() => setSel({ cohort: c, cell })}>–</td>
                    );
                  }
                  return (
                    <td key={col} className={`lir-cell h${heat(cell.pct)}` + (sel?.cell === cell ? " sel" : "")}
                      onMouseEnter={() => setSel({ cohort: c, cell })} onClick={() => setSel({ cohort: c, cell })}>
                      <span className="su-num">{cell.pct}%</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CohortDetail sel={sel && r.cohorts.find((c) => c.month === sel.cohort.month) && sel} metric={metric} k={k} onExclude={setExcl} />
      {(left.length > 0 || exclErr) && (
        <div className="lir-excl">
          {exclErr && <div className="lir-tip-warn bad">{exclErr}</div>}
          {left.length > 0 && <>
            <b>Left out of the cohorts ({left.length}):</b>{" "}
            {left.map((p) => (
              <span key={p.ods} className="lir-excl-chip" title={`Excluded by ${excluded[p.ods]?.by || "someone"}${excluded[p.ods]?.at ? ` on ${fmtDay(String(excluded[p.ods].at).slice(0, 10))}` : ""}`}>
                {p.name} <button className="lir-excl-btn" onClick={() => setExcl(p.ods, false)}>Include</button>
              </span>
            ))}
          </>}
        </div>
      )}
      <p className="st-note">
        {COPY[metric].note(k)} The current month is left out until it's complete. To leave a practice out of everything
        on this tab (a test site, or not a real customer), hover its signing month and click Exclude; everyone sees the change. Blank cells = before the Omni data starts ({fmtDay(lir.from)}). Practices
        recalling with no Suvera Recall deal in HubSpot are grouped by the month of their first recall.
      </p>

      <div className="st-h lir-watch-h">
        Watchlist <span className="st-hint">{sort.key === "signal" && sort.dir === 1 ? "worst first · paying practices first within each group · " : ""}click a column to sort</span>
        <button className="ov-more" onClick={() => setShowAll((v) => !v)}>{showAll ? "Hide on-track" : `Show all ${r.watch.length}`}</button>
      </div>
      <table className="st-table">
        <thead>
          <tr>
            <Th id="practice">Practice</Th><Th id="signal">Consistency</Th><Th id="bulk" num>Bulk</Th><Th id="sugg" num>Suggestions</Th>
            <Th id="signed" num>Signed</Th><Th id="last" num>Last recall</Th><Th id="recent" num>Recalls<br />last {WINDOW} wks</Th>
            <Th id="total" num>Recalls<br />since {fmtDay(lir.from)}</Th><Th id="users" num>Users</Th><Th id="renews" num>Renews</Th><th>Last 12 weeks</th>
          </tr>
        </thead>
        <tbody>
          {watchRows.map(({ p, head }) => head ? (
            <tr key={`pcn-${head.ods}`} className="lir-pcn-head">
              <td colSpan={11}>
                <span className="lir-pcn-tag">PCN</span> <b>{head.name}</b>{" "}
                {head.paid && <span className="su-status good lir-paid">PAID</span>}{" "}
                <span className="st-faint">
                  PCN contract · {head.n} of {head.size} practices recalling{head.n ? " (below)" : ""}
                  {head.idle?.length > 0 && <> · not yet: {head.idle.map((m) => m.name).join(", ")}</>}
                </span>
              </td>
            </tr>
          ) : (
            <tr key={p.ods} className={p.pcn && !p.pcn_placeholder ? "lir-pcn-member" : ""}>
              <td>
                <b>{p.name}</b> {p.paid && !p.pcn && <span className="su-status good lir-paid">PAID</span>}
                <div className="st-faint">{p.ods}{p.patients ? ` · ${p.patients.toLocaleString("en-GB")} patients` : ""}{p.stage === "no_deal" ? " · no Suvera Recall deal" : ""}</div>
                {p.pcn_placeholder && <div className="lir-pcn"><span className="lir-pcn-tag">PCN</span> contract · no practice recalling yet</div>}
              </td>
              <td className="lir-hov" {...tipOn(
                <>
                  <b>{STATUS[p.status].label}</b>
                  <div>{STATUS_WHY[p.status](need)}</div>
                  {p.used != null && <div className="st-faint">Used {p.used} of the last {WINDOW} weeks (a week counts with {MIN_WEEK_RECALLS}+ recalls)</div>}
                </>
              )}>
                <span className={"su-status " + STATUS[p.status].tone}>{STATUS[p.status].label}</span>
                {p.used != null && <div className="st-faint">{p.used} of last {WINDOW} weeks</div>}
              </td>
              <MixCell p={p} m="bulk" k={bars.bulk} tipOn={tipOn} />
              <MixCell p={p} m="sugg" k={bars.sugg} tipOn={tipOn} />
              <td className="num">
                {fmtMonth(p.cohort)}
                {p.signed_approx && <span className="st-faint" title={p.stage === "no_deal" ? "No Suvera Recall deal — first recall date used" : "No DPA Signed date in HubSpot — go-live or deal-created date used"}> ~</span>}
              </td>
              <td className={"num" + (p.lastRecall && daysAgo(p.lastRecall, today) > 14 ? " bad" : "")}>
                {p.lastRecall ? `${daysAgo(p.lastRecall, today)}d ago` : "never"}
              </td>
              <td className="num su-num">{p.recentRecalls.toLocaleString("en-GB")}</td>
              <td className="num su-num">{p.totalRecalls.toLocaleString("en-GB")}</td>
              <td className="num su-num lir-hov" {...tipOn(
                <>
                  <b>Recalled in the last {WINDOW} weeks</b>
                  {p.activeUsers.length ? <ul>{p.activeUsers.map((u) => <li key={u}>{u}</li>)}</ul> : <div className="st-faint">Nobody</div>}
                  {p.activeUsers.length === 1 && <div className="lir-tip-warn">One person doing all the recalls: at risk if they leave or go on leave.</div>}
                </>
              )}>
                {p.activeUsers.length}{p.activeUsers.length === 1 && <span className="st-faint"> !</span>}
              </td>
              <td className={"num lir-hov" + (p.contract && monthsTo(p.contract.renews, today) <= 6 && p.status !== "on_track" ? " bad" : "")}
                {...tipOn(p.contract ? (
                  <>
                    <b>{p.contract.contract}</b>
                    <div>{p.contract.months}-month term from {fmtDay(p.contract.start)}</div>
                    <div>Renews {fmtDay(p.contract.renews)} (in {monthsTo(p.contract.renews, today)} months)</div>
                    <div className="st-faint">{p.status === "on_track" ? "On track, so likely to renew." : "Not on track: renewal at risk."}</div>
                  </>
                ) : <div className="st-faint">No contract on the finance tracker</div>)}>
                {p.contract ? <>{fmtMonth(p.contract.renews.slice(0, 7))}<div className="st-faint">in {monthsTo(p.contract.renews, today)} mo</div></> : "–"}
              </td>
              <td>
                <div className="lir-strip">
                  {p.strip.map((w) => (
                    <span key={w.week}
                      className={"lir-wk" + (w.noData ? " nodata" : w.count >= MIN_WEEK_RECALLS ? " hit" : w.count ? " some" : "")}
                      {...tipOn(
                        <>
                          <b>Week of {fmtDay(w.week)}</b>
                          {w.noData ? <div className="st-faint">Before the Omni data starts</div> : (
                            <>
                              <div>
                                {w.count.toLocaleString("en-GB")} recall{w.count === 1 ? "" : "s"}{" "}
                                <span className="st-faint">
                                  {w.count >= MIN_WEEK_RECALLS ? "· counts as a used week" : w.count ? `· under ${MIN_WEEK_RECALLS}, doesn't count` : ""}
                                </span>
                              </div>
                              {w.count > 0 && lir.has?.bulk && <div className="st-faint">{w.bulk.toLocaleString("en-GB")} bulk · {(w.count - w.bulk).toLocaleString("en-GB")} single</div>}
                              {w.sugg[1] > 0 && <div className="st-faint">Every suggestion kept: {pct((100 * w.sugg[0]) / w.sugg[1])} ({w.sugg[0]} of {w.sugg[1]})</div>}
                              {w.users.length > 0 && <ul>{w.users.map((u) => <li key={u}>{u}</li>)}</ul>}
                            </>
                          )}
                        </>
                      )} />
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tipEl}
      <p className="st-note">
        Hover or tap a week square, Consistency, Bulk, Suggestions, Users or Renews for details. Bulk and Suggestions are
        since the data starts and tinted green when they meet that card's bar; the arrow compares the last {WINDOW} weeks. Users = staff who recalled in the last {WINDOW} weeks; “!” = one person doing it all.
        Renews = end of the initial contract term (1–3 years from commencement), from the finance contracts tracker;
        red when it's within 6 months and the practice isn't on track. As renewals come in, check that on-track practices
        renewed more often than the rest, and tune the bar if not.
      </p>
    </section>
  );
}
