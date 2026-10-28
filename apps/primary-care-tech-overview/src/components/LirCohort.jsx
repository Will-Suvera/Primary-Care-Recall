import React, { useMemo, useState } from "react";
import { buildLir, DEFAULT_WEEKS, MIN_WEEK_RECALLS, STATUS, WEEKS_NEEDED, WINDOW } from "../lir.js";

// Leading indicator of retention, Roberge "The Science of Scaling" ch.4: practices
// grouped by the month their DPA was signed, and the share of each cohort using
// Planner in at least K of the last 4 weeks, month by month after signing. Pure
// presentation — maths in ../lir.js.

const fmtMonth = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
const fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const daysAgo = (d, today) => Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${d}T00:00:00Z`)) / 86400000);
// single-hue sequential (brand purple); ink text until the fill is dark enough for white
// Paid = "PAID -" / "PAID (Trial First) -" on the HubSpot deal; freemium = everyone else
const PLANS = [["all", "All"], ["paid", "Paid"], ["freemium", "Freemium"]];
const heat = (p) => (p >= 75 ? 4 : p >= 50 ? 3 : p >= 25 ? 2 : p > 0 ? 1 : 0);

function cellTitle(c, cohort, need) {
  const miss = cohort.members.map((p) => p.name).filter((n) => !c.hitNames.includes(n));
  return `${fmtMonth(c.month)} · month ${c.k} after signing\n${c.hit} of ${c.of} used Planner in ≥${need} of the last ${WINDOW} weeks` +
    (c.hitNames.length ? `\nOn track: ${c.hitNames.join(", ")}` : "") + (miss.length ? `\nNot: ${miss.join(", ")}` : "");
}

export default function LirCohort({ lir, generatedAt }) {
  const [need, setNeed] = useState(DEFAULT_WEEKS);
  const [plan, setPlan] = useState("all");
  const [showAll, setShowAll] = useState(false);
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
            <b>Using Planner in at least {need} of every {WINDOW} weeks</b> (a week counts with {MIN_WEEK_RECALLS}+ recalls),
            by the month the DPA was signed. Regular use now predicts renewal later, so a practice that stops coming back
            is an early churn signal.
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
          {exCell.k} month{exCell.k > 1 ? "s" : ""} later, {exCell.hit} of them ({exCell.pct}%) were using Planner regularly.
          Hover any cell to see which practices.
        </p>
      )}
      <div className="lir-scroll">
        <table className="st-table lir-table">
          <thead>
            <tr>
              <th rowSpan={2}>Signed in</th><th rowSpan={2} className="num">Practices<br />signed</th>
              {cols.length > 0 && <th colSpan={cols.length} className="lir-group">% using Planner regularly, months after signing →</th>}
            </tr>
            <tr>
              {cols.map((k) => <th key={k} className="num">{k === 1 ? "1 month" : `${k} months`}</th>)}
            </tr>
          </thead>
          <tbody>
            {r.cohorts.map((c) => (
              <tr key={c.month}>
                <td><b>{fmtMonth(c.month)}</b></td>
                <td className="num su-num">{c.n}</td>
                {c.cells.length === 0 && <td colSpan={cols.length} className="st-faint lir-toonew">signed too recently to judge</td>}
                {c.cells.length > 0 && cols.map((k) => {
                  const cell = c.cells[k - 1];
                  if (!cell) return <td key={k} />;
                  if (cell.noData) return <td key={k} className="lir-cell nodata" title={`${fmtMonth(cell.month)}: before the Omni data starts`} />;
                  return (
                    <td key={k} className={`lir-cell h${heat(cell.pct)}`} title={cellTitle(cell, c, need)}>
                      <span className="su-num">{cell.pct}%</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="st-note">
        “Regularly” = recalls in at least {need} of the last {WINDOW} weeks, checked at the end of each month. The current
        month is left out until it's complete. Blank cells = before the Omni data starts ({fmtDay(lir.from)}). Practices
        recalling with no Planner deal in HubSpot are grouped by the month of their first recall.
      </p>

      <div className="st-h lir-watch-h">
        Watchlist <span className="st-hint">worst first · paying practices first within each group</span>
        <button className="ov-more" onClick={() => setShowAll((v) => !v)}>{showAll ? "Hide on-track" : `Show all ${r.watch.length}`}</button>
      </div>
      <table className="st-table">
        <thead>
          <tr>
            <th>Practice</th><th>Signal</th><th className="num">Signed</th><th className="num">Last recall</th>
            <th className="num">Users</th><th>Last 12 weeks</th>
          </tr>
        </thead>
        <tbody>
          {watch.map((p) => (
            <tr key={p.ods}>
              <td>
                <b>{p.name}</b> {p.paid && <span className="su-status good lir-paid">PAID</span>}
                <div className="st-faint">{p.ods}{p.patients ? ` · ${p.patients.toLocaleString("en-GB")} patients` : ""}{p.stage === "no_deal" ? " · no Planner deal" : ""}</div>
              </td>
              <td>
                <span className={"su-status " + STATUS[p.status].tone}>{STATUS[p.status].label}</span>
                {p.used != null && <div className="st-faint">{p.used} of last {WINDOW} weeks</div>}
              </td>
              <td className="num">
                {fmtMonth(p.cohort)}
                {p.signed_approx && <span className="st-faint" title={p.stage === "no_deal" ? "No Planner deal — first recall date used" : "No DPA Signed date in HubSpot — go-live or deal-created date used"}> ~</span>}
              </td>
              <td className={"num" + (p.lastRecall && daysAgo(p.lastRecall, today) > 14 ? " bad" : "")}>
                {p.lastRecall ? `${daysAgo(p.lastRecall, today)}d ago` : "never"}
              </td>
              <td className="num su-num" title={p.activeUsers.join("\n") || "nobody in the last 4 weeks"}>
                {p.activeUsers.length}{p.activeUsers.length === 1 && <span className="st-faint" title="One person doing all the recalls — at risk if they leave or go on leave"> !</span>}
              </td>
              <td>
                <div className="lir-strip">
                  {p.strip.map((w) => (
                    <span key={w.week}
                      className={"lir-wk" + (w.noData ? " nodata" : w.count >= MIN_WEEK_RECALLS ? " hit" : w.count ? " some" : "")}
                      title={w.noData ? `w/c ${fmtDay(w.week)}: before the data starts`
                        : `w/c ${fmtDay(w.week)}: ${w.count.toLocaleString("en-GB")} recalls` + (w.users.length ? `\n${w.users.join("\n")}` : "")} />
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="st-note">
        Users = staff who recalled in the last {WINDOW} weeks (hover for who); “!” = one person doing it all.
        Next step from the book: once the first contracts reach renewal (from mid-2027), check whether practices that
        were on track actually renewed more often than those that weren't, and tune the bar if not.
      </p>
    </section>
  );
}
