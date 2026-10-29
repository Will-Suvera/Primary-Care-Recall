import React, { useMemo, useState } from "react";
import { buildLir, DEFAULT_WEEKS, MIN_WEEK_RECALLS, STATUS, WEEKS_NEEDED, WINDOW } from "../lir.js";

// Leading indicator of retention, Roberge "The Science of Scaling" ch.4: practices
// grouped by the month their DPA was signed, and the share of each cohort using
// Planner in at least K of the last 4 weeks, month by month after signing. Pure
// presentation — maths in ../lir.js.

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

const PaidChip = ({ p }) => (p.paid ? <span className="su-status good lir-paid">PAID</span> : <span className="lir-free">freemium</span>);

// The panel under the cohort table: who is in the hovered/tapped signing month, and
// (for a cell) who was using Suvera Recall regularly at that point.
function CohortDetail({ sel, need }) {
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
                {p.stage === "no_deal" ? `first recall ${fmtDay(p.signed.slice(0, 10))}` : `DPA signed ${fmtDay(p.signed.slice(0, 10))}${p.signed_approx ? " (approx.)" : ""}`}
                {p.contract ? ` · paid contract from ${fmtDay(p.contract.start)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const rows = [...cell.rows].sort((a, b) => Number(b.onTrack) - Number(a.onTrack) || (b.used ?? -1) - (a.used ?? -1));
  return (
    <div className="lir-detail">
      <div className="lir-detail-h">
        <b>Signed {fmtMonth(c.month)}, {cell.k} month{cell.k === 1 ? "" : "s"} later (end of {fmtMonth(cell.month)}):</b>{" "}
        {cell.hit} of {cell.of} using Suvera Recall regularly ({cell.pct}%)
      </div>
      <ul>
        {rows.map((p) => (
          <li key={p.ods}>
            <span>{p.onTrack ? "✓" : "✗"} <b>{p.name}</b> <PaidChip p={p} /></span>
            <span className={p.onTrack ? "" : "st-faint"}>{p.used ?? "–"} of {WINDOW} weeks used{p.onTrack ? "" : ` (needs ${need})`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function LirCohort({ lir, generatedAt }) {
  const [need, setNeed] = useState(DEFAULT_WEEKS);
  const [plan, setPlan] = useState("all");
  const [sel, setSel] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [tipOn, tipEl] = useTip();
  const today = (generatedAt || new Date().toISOString()).slice(0, 10);
  const r = useMemo(() => {
    const keep = (p) => plan === "all" || (plan === "paid") === Boolean(p.paid);
    return buildLir(lir && { ...lir, practices: (lir.practices || []).filter(keep) }, { need, today });
  }, [lir, need, today, plan]);

  if (!lir || r.empty) {
    return (
      <section className="ov-card">
        <p className="ov-sub">No retention data in this build{lir?.error ? ` — ${lir.error}` : " — the Omni recalls sheet isn't configured"}.</p>
      </section>
    );
  }
  const watch = showAll ? r.watch : r.watch.filter((p) => p.status !== "on_track");
  // A PCN contract's practices sit together under a PCN header, placed where its
  // worst practice ranks; once a group shows, all its practices show.
  const watchRows = [];
  const seenPcn = new Set();
  for (const p of watch) {
    if (!p.pcn || p.pcn_placeholder) { watchRows.push({ p }); continue; }
    if (seenPcn.has(p.pcn.ods)) continue;
    seenPcn.add(p.pcn.ods);
    const members = r.watch.filter((q) => q.pcn?.ods === p.pcn.ods && !q.pcn_placeholder);
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
  const filled = r.cohorts.flatMap((c) => c.cells.filter((x) => !x.noData && c.n));
  const pcts = filled.map((x) => x.pct).sort((a, b) => a - b);
  const typical = pcts.length ? pcts[Math.floor(pcts.length / 2)] : null;
  const best = pcts.length ? pcts[pcts.length - 1] : null;
  // worked example: the biggest signing group, at its latest month
  const ex = r.cohorts.filter((c) => c.cells.some((x) => !x.noData)).sort((a, b) => b.n - a.n)[0];
  const exCell = ex?.cells.filter((x) => !x.noData).pop();
  const cols = Array.from({ length: r.maxK }, (_, i) => i + 1);

  return (
    <section className="ov-card lir-card" id="retention">
      <div className="ov-card-head">
        <div>
          <h2 className="ov-card-title">Leading indicator of retention</h2>
          <p className="ov-sub">
            <b>What is this?</b> A leading indicator of retention (LIR) is an early habit that predicts whether a customer
            will renew. Contracts renew 1–3 years after signing; this lets us predict renewal much sooner, from how
            practices use the product today. Ours is <b>using Suvera Recall in at least {need} of every {WINDOW} weeks</b> (a week counts with {MIN_WEEK_RECALLS}+
            recalls). Practices with that habit are the ones likely to renew; practices that lose it are early churn
            warnings we can still act on.
          </p>
          <p className="ov-sub">
            <b>How it should look over time:</b> the on-track % going up, churn signals and “never got going” going down,
            and in the table below, numbers rising left to right and newer signing months beating older ones. Once the
            first contracts reach renewal (from April 2027), we check that on-track practices really did renew more, and
            adjust the definition if not.
          </p>
        </div>
        <div className="lir-controls">
          <div className="st-seg" role="group" aria-label="Paid or freemium">
            {PLANS.map(([k, label]) => (
              <button key={k} className={"st-seg-btn" + (plan === k ? " on" : "")} onClick={() => setPlan(k)}>{label}</button>
            ))}
          </div>
          <div className="st-seg" role="group" aria-label="Weeks needed">
            {WEEKS_NEEDED.map((k) => (
              <button key={k} className={"st-seg-btn" + (need === k ? " on" : "")} onClick={() => setNeed(k)}>{k} of {WINDOW} weeks</button>
            ))}
          </div>
        </div>
      </div>

      <div className="kpis st-kpis">
        <div className="kpi">
          <div className="kpi-label">On track, week of {fmtDay(r.lastWeek)}</div>
          <div className="kpi-value su-num">{r.judged ? Math.round((100 * r.onTrack) / r.judged) : 0}%</div>
          <div className="kpi-sub">{r.onTrack} of {r.judged} {plan === "all" ? "" : `${plan} `}practices</div>
        </div>
        <div className={"kpi" + (r.churnSignals ? " bad" : "")}>
          <div className="kpi-label">Churn signals</div>
          <div className="kpi-value su-num">{r.churnSignals}</div>
          <div className="kpi-sub">stopped using, or dropped off</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Never got going</div>
          <div className="kpi-value su-num">{r.notReached}</div>
          <div className="kpi-sub">2+ months since signing, never on track</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Recalls, last {WINDOW} weeks</div>
          <div className="kpi-value su-num">{r.recentRecalls.toLocaleString("en-GB")}</div>
          <div className="kpi-sub">{r.totalRecalls.toLocaleString("en-GB")} since {fmtDay(lir.from)}</div>
        </div>
        <div className={"kpi" + (renewSoon.some((p) => p.status !== "on_track") ? " bad" : "")}>
          <div className="kpi-label">Renewing in the next 12 months</div>
          <div className="kpi-value su-num">{renewSoon.length}</div>
          <div className="kpi-sub">{renewSoon.filter((p) => p.status === "on_track").length} on track · {renewSoon.filter((p) => p.status !== "on_track").length} at risk</div>
        </div>
      </div>

      <div className="st-h">Do practices become regular users after signing?</div>
      {typical != null && (
        <p className="lir-takeaway">
          <b>In a typical month, {typical}% of a signing group are regular users</b> (best so far: {best}%).
          Good looks like the numbers rising left to right, and newer rows beating older ones.
        </p>
      )}
      {exCell && (
        <p className="st-note lir-howto">
          How to read it: each row is the practices that signed in that month. E.g. <b>{ex.n} practices signed in {fmtMonth(ex.month)}</b> —{" "}
          {exCell.k} month{exCell.k > 1 ? "s" : ""} later, {exCell.hit} of them ({exCell.pct}%) were using Suvera Recall regularly.
          Hover or tap any month or % to see the practices in the panel below the table.
        </p>
      )}
      <div className="lir-scroll">
        <table className="st-table lir-table">
          <thead>
            <tr>
              <th rowSpan={2}>Signed in</th><th rowSpan={2} className="num">Practices<br />signed</th>
              {cols.length > 0 && <th colSpan={cols.length} className="lir-group">% using Suvera Recall regularly, months after signing →</th>}
            </tr>
            <tr>
              {cols.map((k) => <th key={k} className="num">{k === 1 ? "1 month" : `${k} months`}</th>)}
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
                {c.cells.length > 0 && cols.map((k) => {
                  const cell = c.cells[k - 1];
                  if (!cell) return <td key={k} />;
                  if (cell.noData) return <td key={k} className="lir-cell nodata" title={`${fmtMonth(cell.month)}: before the Omni data starts`} />;
                  return (
                    <td key={k} className={`lir-cell h${heat(cell.pct)}` + (sel?.cell === cell ? " sel" : "")}
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
      <CohortDetail sel={sel && r.cohorts.find((c) => c.month === sel.cohort.month) && sel} need={need} />
      <p className="st-note">
        “Regularly” = recalls in at least {need} of the last {WINDOW} weeks, checked at the end of each month. The current
        month is left out until it's complete. Blank cells = before the Omni data starts ({fmtDay(lir.from)}). Practices
        recalling with no Suvera Recall deal in HubSpot are grouped by the month of their first recall.
      </p>

      <div className="st-h lir-watch-h">
        Watchlist <span className="st-hint">worst first · paying practices first within each group</span>
        <button className="ov-more" onClick={() => setShowAll((v) => !v)}>{showAll ? "Hide on-track" : `Show all ${r.watch.length}`}</button>
      </div>
      <table className="st-table">
        <thead>
          <tr>
            <th>Practice</th><th>Signal</th><th className="num">Signed</th><th className="num">Last recall</th><th className="num">Recalls<br />last {WINDOW} wks</th><th className="num">Recalls<br />since {fmtDay(lir.from)}</th>
            <th className="num">Users</th><th className="num">Renews</th><th>Last 12 weeks</th>
          </tr>
        </thead>
        <tbody>
          {watchRows.map(({ p, head }) => head ? (
            <tr key={`pcn-${head.ods}`} className="lir-pcn-head">
              <td colSpan={9}>
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
        Hover or tap a week square, the signal, Users or Renews for details. Users = staff who recalled in the last {WINDOW} weeks; “!” = one person doing it all.
        Renews = end of the initial contract term (1–3 years from commencement), from the finance contracts tracker;
        red when it's within 6 months and the practice isn't on track. As renewals come in, check that on-track practices
        renewed more often than the rest, and tune the bar if not.
      </p>
    </section>
  );
}
