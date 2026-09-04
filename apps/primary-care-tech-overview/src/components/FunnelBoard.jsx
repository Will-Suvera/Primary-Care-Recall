import React, { useEffect, useMemo, useState } from "react";
import { RevenueHero, RevenueDetail } from "./RevenueTarget.jsx";
import StallAnalysis from "./StallAnalysis.jsx";
import { firstNameFromEmail, mergeOnboarding, summarizeOnboarding, useOnboarding } from "../onboarding.js";

// Stage KEYS are stable; display labels come live from the data (funnel_board.json),
// so a HubSpot stage rename flows through without touching this file.
const ORDER = ["waitlist", "demo_booked", "demo_held", "dpa_sent", "dpa_signed", "live", "recalling"];
const MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
const fmtMon = (ym) => (ym ? `${MON[+ym.slice(5, 7)] || ""} ${ym.slice(2, 4)}`.trim() : "");

const SCOPE_DESC = {
  overview: "The whole flow — signed-up through live, recalling and volumes.",
  partnerships: "Sales: signed-up list → DPA signed. Everything here lives in HubSpot.",
  onboarding: "Onboarding: DPA signed & onboard-ready, not yet live. Each step is a button — changes are timestamped.",
  implementation: "Implementation: live practices — first the activation gap (not yet recalling), then the recallers.",
};

const DEAL_ORDER = ["waitlist", "demo_booked", "demo_held", "dpa_sent", "dpa_signed"];

const PAGE_SUB = "Signed-up through functionally live, recalling and not.";

// Week-by-week conversion transitions (Flow 2): each step's CONVERSION lives on
// the destination stage's meta (conv_from_prev / conv_delta_1w); the sparkline
// series comes from the weekly history's per-stage conv values.
const WEEKLY_STEPS = [
  { key: "demo_booked", label: "Signed-up → Demo" },
  { key: "demo_held",   label: "Demo → Held" },
  { key: "dpa_sent",    label: "Held → Proposal" },
  { key: "dpa_signed",  label: "Proposal → DPA" },
];

// Sparkline math (matches the design): a 0–100 series mapped into a 0 0 100 28
// viewBox — x = i/(n-1)·100, y = 27 − v/100·24 (higher % sits higher).
const sparkPoints = (series) => {
  const n = series.length;
  if (n < 2) return { points: "", lastY: 27 };
  const pts = series.map((v, i) => {
    const x = (i / (n - 1)) * 100;
    const y = 27 - (Math.max(0, Math.min(100, v)) / 100) * 24;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const lastY = 27 - (Math.max(0, Math.min(100, series[n - 1])) / 100) * 24;
  return { points: pts.join(" "), lastY: +lastY.toFixed(1) };
};

const fmtDelta = (d) => (d == null ? "" : d > 0 ? `+${d}` : d < 0 ? `−${Math.abs(d)}` : "0");

// Concise funnel-bar labels (the data labels are long, e.g. "DPA Signed Onboard Ready").
const SHORT_LABEL = {
  waitlist: "Signed-up", demo_booked: "Demo Booked", demo_held: "Demo Held",
  dpa_sent: "Proposal Sent", dpa_signed: "DPA Signed",
};

// The 128px note beside each funnel bar — short, derived from stale counts.
const funnelNote = (s) => {
  const stale = s.stale.length;
  if (s.key === "demo_booked") return `${s.count} booked`;
  if (s.key === "dpa_signed") return `${stale} stuck · bottleneck`;
  return stale ? `${stale} stale` : "moving";
};

export default function FunnelBoard({ data, auth = null, visits = {} }) {
  const [ehr] = useState("All");
  const [open, setOpen] = useState(null); // deal-stage key | "live_gap" | "recalling"
  const [showWeekly, setShowWeekly] = useState(false);
  const [showAllSources, setShowAllSources] = useState(false);
  const [openSrc, setOpenSrc] = useState(null); // expanded lead source name
  const [detail, setDetail] = useState(null); // { kind: "deal" | "practice" | "revenue", item }
  const weeklyAvailable = !!data?.weekly_available;

  // live onboarding step state (Neon) — shared with the Onboarding Hub tab via
  // the useOnboarding hook; the checklist toggles live in the DPA-Signed slide-over.
  const { liveOnb, editor, toggleStep } = useOnboarding(auth);
  const onb = { live: liveOnb, who: editor, toggle: toggleStep };

  const deals = useMemo(() => {
    const all = data?.deals || [];
    return ehr === "All" ? all : all.filter((d) => (d.ehr || "Unknown") === ehr);
  }, [data, ehr]);

  const stageMeta = useMemo(
    () => Object.fromEntries((data?.stages || []).map((s) => [s.key, s])),
    [data]
  );
  const labelOf = (key) => stageMeta[key]?.label || key;

  const stageData = DEAL_ORDER.map((key) => {
    const inStage = deals.filter((d) => d.stage === key);
    return { key, label: labelOf(key), deals: inStage, count: inStage.length, stale: inStage.filter((d) => d.stale) };
  });

  // Functionally-live cohorts: ODS-based (recalls feed + Live sheet), broader
  // than HubSpot deals — includes recallers with no Planner deal.
  const rp = data.recalling_practices || [];
  const lnr = data.live_not_recalling || [];
  const liveTotal = rp.length + lnr.length;
  const totRec = rp.reduce((a, p) => a + (p.fy_recalls || 0), 0);
  const totBl = rp.reduce((a, p) => a + (p.fy_bloods || 0), 0);

  const weeks = data.weekly || []; // full history — the table scrolls horizontally
  const convSteps = ORDER.slice(1);
  const [wkView, setWkView] = useState("growth"); // "growth" | "conversion"
  const growthSteps = ORDER.filter((k) => weeks.some((w) => w.reached?.[k] != null));
  const wlDelta = weeks.length > 1 ? (weeks[weeks.length - 1].reached?.waitlist ?? 0) - (weeks[weeks.length - 2].reached?.waitlist ?? 0) : null;

  // shareable deep links: ?p=<ODS or deal id> opens the slide-over directly
  const setParam = (v) => {
    const u = new URL(window.location.href);
    if (v) u.searchParams.set("p", v); else u.searchParams.delete("p");
    window.history.replaceState({}, "", u.toString());
  };
  const openDeal = (d) => { setParam(d.ods || d.deal_id); setDetail({ kind: "deal", item: d }); };
  const openPractice = (p) => { setParam(p.ods); setDetail({ kind: "practice", item: p }); };
  const closeDetail = () => { setParam(null); setDetail(null); };
  useEffect(() => {
    const q = new URL(window.location.href).searchParams.get("p");
    if (!q) return;
    const P = q.toUpperCase();
    const pr = rp.find((x) => x.ods === P) || lnr.find((x) => x.ods === P);
    if (pr) { setDetail({ kind: "practice", item: pr }); return; }
    const dl = (data.deals || []).find((d) => (d.ods || "").toUpperCase() === P || String(d.deal_id) === q);
    if (dl) setDetail({ kind: "deal", item: dl });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // practice search across deals + live cohorts
  const [q, setQ] = useState("");
  const searchResults = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const out = [];
    for (const p of rp) if ((p.name || "").toLowerCase().includes(s) || (p.ods || "").toLowerCase().includes(s))
      out.push({ kind: "practice", item: p, label: p.name, sub: "Recalling" });
    for (const p of lnr) if ((p.name || "").toLowerCase().includes(s) || (p.ods || "").toLowerCase().includes(s))
      out.push({ kind: "practice", item: p, label: p.name, sub: "Live — not recalling" });
    for (const d of data.deals || []) {
      if (out.some((o) => o.item.ods && d.ods && o.item.ods === d.ods)) continue;
      if ((d.name || "").toLowerCase().includes(s) || (d.ods || "").toLowerCase().includes(s))
        out.push({ kind: "deal", item: d, label: d.name, sub: labelOf(d.stage) });
    }
    return out.slice(0, 8);
  }, [q, data, rp, lnr]);

  // week-on-week KPI deltas from the daily kpi_history snapshots
  const hist = data.kpi_history || [];
  const baseline = useMemo(() => {
    if (hist.length < 2) return null;
    const latest = new Date(hist[hist.length - 1].date);
    return [...hist].reverse().find((h) => (latest - new Date(h.date)) / 86400000 >= 6) || null;
  }, [hist]);
  const dlt = (key, cur) => (baseline && baseline[key] != null ? cur - baseline[key] : null);

  const slideover = detail && (
    <SlideOver onClose={closeDetail}>
      {detail.kind === "deal"
        ? <DealPanel d={detail.item} labelOf={labelOf} onb={onb} weeklyAvailable={weeklyAvailable} />
        : detail.kind === "revenue"
          ? <RevenueDetail revenue={data.revenue} deals={data.deals} />
          : <PracticePanel p={detail.item} weeklyAvailable={weeklyAvailable} />}
    </SlideOver>
  );
  const openRevenue = () => { setParam(null); setDetail({ kind: "revenue" }); };

  // ── Flow 2 derived rows ────────────────────────────────────────────────
  // Funnel: the five sales stages, scaled against the largest (max width = top
  // of funnel). Notes + the bottleneck flag come straight from stale counts.
  const funnelMax = Math.max(1, ...stageData.map((s) => s.count));
  const funnelRows = stageData.map((s) => ({
    ...s,
    short: SHORT_LABEL[s.key] || s.label,
    note: funnelNote(s),
    bottleneck: s.key === "dpa_signed",
    barW: `${Math.max(8, Math.round((s.count / funnelMax) * 100))}%`,
  }));

  // Week-by-week conversion sparklines (last 6 weeks of each step's conv %).
  const weeklyRows = WEEKLY_STEPS.map(({ key, label }) => {
    const meta = stageMeta[key] || {};
    const series = weeks.map((w) => w.conv?.[key]).filter((v) => v != null).slice(-6);
    const delta = meta.conv_delta_1w;
    const tone = delta != null && delta < 0 ? "bad" : "good";
    return { key, label, cur: meta.conv_from_prev != null ? `${meta.conv_from_prev}%` : "—",
      delta: fmtDelta(delta), tone, ...sparkPoints(series) };
  });

  // Lead sources → activation rate (recalling / signed).
  const allSources = (data.source_activation || []).map((s) => ({
    ...s,
    rate: s.signed ? Math.round((s.recalling / s.signed) * 100) : 0,
  }));
  const shownSources = showAllSources ? allSources : allSources.slice(0, 6);

  const openStage = funnelRows.find((s) => s.key === open);
  return (
    <div className="board flow2">
      <header className="ov-head">
        <div className="ov-headings">
          <h1 className="ov-title">Recalls Overview</h1>
          <p className="ov-sub">{PAGE_SUB}</p>
        </div>
        <div className="ov-head-right">
          <div className="search-wrap">
            <input className="search-input" placeholder="Search practices…" value={q} onChange={(e) => setQ(e.target.value)} />
            {searchResults.length > 0 && (
              <div className="search-pop">
                {searchResults.map((r, i) => (
                  <button key={i} className="search-hit" onClick={() => { setQ(""); (r.kind === "deal" ? openDeal : openPractice)(r.item); }}>
                    <b>{r.label}</b><span>{r.sub}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {auth?.email && <span className="who-field">Editing as <b>{firstNameFromEmail(auth.email)}</b></span>}
        </div>
      </header>

      {(data.data_warnings || []).length > 0 && (
        <div className="warnstrip" title={data.data_warnings.join("\n")}>
          ⚠ {data.data_warnings.length} data note{data.data_warnings.length > 1 ? "s" : ""}: {data.data_warnings[0]}{data.data_warnings.length > 1 ? " …(hover for all)" : ""}
        </div>
      )}

      <div className="ov-grid">
        {/* LEFT — the flow: funnel + how its conversion is trending */}
        <div className="ov-col">
          {/* Acquisition funnel */}
          <section className="ov-card" id="funnel">
            <div className="ov-card-head">
              <h2 className="ov-card-title">Acquisition funnel</h2>
              <span className="ov-more">Click a stage →</span>
            </div>
            <div className="ov-funnel">
              {funnelRows.map((s) => (
                <div
                  key={s.key}
                  className={"ov-frow" + (s.bottleneck ? " bottleneck" : "") + (open === s.key ? " open" : "")}
                  onClick={() => setOpen(open === s.key ? null : s.key)}
                >
                  <div className="ov-ftrack">
                    <div className="ov-ffill" style={{ width: s.barW }}>
                      <span className="ov-fname">{s.short}</span>
                      <span className="ov-fcount su-num">{s.count}</span>
                    </div>
                  </div>
                  <span className="ov-fnote">{s.note}</span>
                  <Chevron />
                </div>
              ))}

              {/* recalls back in — the functionally-live cohorts (THE metric) */}
              <div className="ov-fdiv">
                <span className="ov-fdiv-label">Functionally live</span>
                <span className="ov-fdiv-count su-num">{liveTotal}</span>
                <span className="ov-fdiv-note">recalls feed + Live sheet</span>
              </div>

              <div
                className={"ov-frow live gap" + (open === "live_gap" ? " open" : "")}
                onClick={() => setOpen(open === "live_gap" ? null : "live_gap")}
              >
                <div className="ov-ftrack">
                  <div className="ov-ffill" style={{ width: `${Math.max(8, Math.round((lnr.length / funnelMax) * 100))}%` }}>
                    <span className="ov-fname">Live — not recalling</span>
                    <span className="ov-fcount su-num">{lnr.length}</span>
                  </div>
                </div>
                <span className="ov-fnote bad">activation gap</span>
                <Chevron />
              </div>

              <div
                className={"ov-frow live" + (open === "recalling" ? " open" : "")}
                onClick={() => setOpen(open === "recalling" ? null : "recalling")}
              >
                <div className="ov-ftrack">
                  <div className="ov-ffill" style={{ width: `${Math.max(8, Math.round((rp.length / funnelMax) * 100))}%` }}>
                    <span className="ov-fname">Recalling</span>
                    <span className="ov-fcount su-num">{rp.length}</span>
                  </div>
                </div>
                <span className="ov-fnote su-num">{totRec.toLocaleString()} recalls · {totBl.toLocaleString()} bloods</span>
                <Chevron />
              </div>
            </div>
          </section>

          {/* Week-by-week conversion */}
          <section className="ov-card" id="weekly">
            <div className="ov-card-head">
              <h2 className="ov-card-title">Week-by-week conversion</h2>
              <span className="ov-more" onClick={() => setShowWeekly((v) => !v)}>{showWeekly ? "Collapse" : "Expand"}</span>
            </div>
            {weeklyRows.map((w) => (
              <div key={w.key} className="ov-wrow">
                <span className="ov-wlabel">{w.label}</span>
                <svg className="ov-wspark" viewBox="0 0 100 28" width="96" height="26">
                  <polyline points={w.points} fill="none"
                    stroke={w.tone === "good" ? "var(--su-good)" : "var(--su-bad)"}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <circle cx="100" cy={w.lastY} r="2.6" fill={w.tone === "good" ? "var(--su-good)" : "var(--su-bad)"} />
                </svg>
                <span className="ov-wcur su-num">{w.cur}</span>
                <span className="ov-wdelta su-num" style={{ color: w.tone === "good" ? "var(--su-good)" : "var(--su-bad)" }}>{w.delta}</span>
              </div>
            ))}
          </section>
        </div>

        {/* RIGHT — the context: revenue goal + where leads come from */}
        <div className="ov-col">
          <div id="revenue"><RevenueHero revenue={data.revenue} deals={data.deals} onOpen={openRevenue} /></div>

          <section className="ov-card" id="sources">
            <div className="ov-card-head">
              <h2 className="ov-card-title">Lead sources</h2>
              <span className="ov-more" onClick={() => setShowAllSources((v) => !v)}>
                {showAllSources ? "Top 6" : `All ${allSources.length}`}
              </span>
            </div>
            {shownSources.map((s) => (
              <React.Fragment key={s.source}>
                <div className="ov-srow" onClick={() => setOpenSrc(openSrc === s.source ? null : s.source)}>
                  <span className="ov-sname">{s.source}</span>
                  <span className="ov-smeta su-num">{s.signed} signed</span>
                  <span className="ov-srate su-num" style={{ color: s.rate ? "var(--su-good)" : "var(--su-faint)" }}>{s.rate}%</span>
                </div>
                {openSrc === s.source && (
                  <ul className="tw-list ov-src-list">
                    {(s.practices || []).map((p, j) => (
                      <li key={j}><b>{p.name}</b><span>{p.stage}</span></li>
                    ))}
                    {!(s.practices || []).length && <li><span>No practices attributed.</span></li>}
                  </ul>
                )}
              </React.Fragment>
            ))}
          </section>
        </div>
      </div>

      {/* ── sign-up → go-live stall analysis: full-width below the grid ── */}
      <StallAnalysis deals={data.deals} recallers={data.recalling_practices} visits={visits} liveOnb={liveOnb} auth={auth} onOpen={openDeal} />

      {/* ── drill-ins: full-width below the grid ── */}
      {openStage && open !== "live_gap" && open !== "recalling" && (
        <section className="card drill-section">
          <header className="card-head">
            <div>
              <h3 className="card-title">{openStage.label} <span className="count-pill">{openStage.count}</span></h3>
              <p className="card-sub">Click a practice for full detail · stale (act-now) first.</p>
            </div>
            <button className="drill-back" onClick={() => setOpen(null)}>Close ×</button>
          </header>
          <DealTable deals={openStage.deals} stageKey={openStage.key} liveOnb={liveOnb} onOpen={openDeal} />
        </section>
      )}

      {open === "live_gap" && (
        <section className="card drill-section">
          <header className="card-head warn">
            <div>
              <h3 className="card-title">Live — not yet recalling <span className="count-pill">{lnr.length}</span></h3>
              <p className="card-sub">Functionally live but fewer than 5 recalls this FY (test blips don’t count) — the activation gap. Longest-live first.</p>
            </div>
            <button className="drill-back" onClick={() => setOpen(null)}>Close ×</button>
          </header>
          <LiveNotRecallingTable practices={lnr} onOpen={openPractice} />
        </section>
      )}

      {open === "recalling" && (
        <section className="card drill-section">
          <header className="card-head ok">
            <div>
              <h3 className="card-title">Recalling <span className="count-pill">{rp.length}</span></h3>
              <p className="card-sub">From the Omni recall feed — every recaller, incl. VC-tier and practices with no HubSpot deal. Green shade = % of list recalled.</p>
            </div>
            <button className="drill-back" onClick={() => setOpen(null)}>Close ×</button>
          </header>
          <RecallingTable practices={rp} onOpen={openPractice} />
        </section>
      )}

      {/* week-by-week expanded table (the "Expand" affordance) */}
      {showWeekly && (
        <section className="card drill-section weekly-card" id="weekly-detail">
          <header className="card-head">
            <div>
              <h3 className="card-title">Week-by-week — full history</h3>
              <p className="card-sub">
                {wkView === "growth"
                  ? "Extra practices that reached each stage per week, with the % growth · scroll for history."
                  : "Step conversion per week · HubSpot stage-entry timestamps; Recalling from the recalls feed (VC excluded)."}
              </p>
            </div>
            <div className="ov-week-tools">
              <div className="gran-toggle" style={{ margin: 0 }}>
                <button className={wkView === "conversion" ? "active" : ""} onClick={() => setWkView("conversion")}>Conversion</button>
                <button className={wkView === "growth" ? "active" : ""} onClick={() => setWkView("growth")}>Growth</button>
              </div>
              <button className="drill-back" onClick={() => setShowWeekly(false)}>Close ×</button>
            </div>
          </header>
          <div className="weekly-scroll">
            {weeks.length === 0 ? (
              <p className="card-sub" style={{ padding: "14px" }}>
                Weekly history is still building — it appears after the next data refresh.
              </p>
            ) : wkView === "conversion" ? (
              <table className="weekly-table">
                <thead>
                  <tr>
                    <th>Conversion %</th>
                    {weeks.map((w) => <th key={w.week}>{fmtDate(w.week)}</th>)}
                    <th>Δ wk</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="wk-step">Signed up</td>
                    {weeks.map((w, i) => <td key={i}><span className="wk-base">{w.reached?.waitlist ?? "—"}</span></td>)}
                    <td className={"wk-delta " + (wlDelta > 0 ? "up" : wlDelta < 0 ? "down" : "")}>
                      {wlDelta == null ? "—" : (wlDelta > 0 ? `+${wlDelta}` : wlDelta)}
                    </td>
                  </tr>
                  {convSteps.map((key, ci) => {
                    const prevKey = ORDER[ci];
                    const d = stageMeta[key]?.conv_delta_1w;
                    return (
                      <tr key={key}>
                        <td className="wk-step">↳ {key === "recalling" ? "Recalling (non-VC)" : labelOf(key)}</td>
                        {weeks.map((w, i) => {
                          const v = w.conv[key];
                          const num = w.reached?.[key], den = w.reached?.[prevKey];
                          return (
                            <td key={i}>
                              {v == null ? "—" : <>{v}%{num != null && den != null && <span className="wk-abs">{num}/{den}</span>}</>}
                            </td>
                          );
                        })}
                        <td className={"wk-delta " + (d > 0 ? "up" : d < 0 ? "down" : "")}>
                          {d == null ? "—" : (d > 0 ? `+${d}` : d)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <table className="weekly-table">
                <thead>
                  <tr>
                    <th>Practices reached</th>
                    {weeks.map((w) => <th key={w.week}>{fmtDate(w.week)}</th>)}
                    <th title={`net growth over the ${weeks.length} weeks shown`}>Σ {weeks.length} wks</th>
                  </tr>
                </thead>
                <tbody>
                  {growthSteps.map((key) => {
                    const series = weeks.map((w) => w.reached?.[key]);
                    const withData = series.filter((v) => v != null);
                    const total = withData.length >= 2 ? withData[withData.length - 1] - withData[0] : null;
                    const totalPct = total != null && withData[0] > 0 ? (total / withData[0]) * 100 : null;
                    return (
                      <tr key={key}>
                        <td className="wk-step">{key === "recalling" ? "Recalling (non-VC)" : labelOf(key)}</td>
                        {weeks.map((w, i) => {
                          const cur = series[i];
                          const prev = i > 0 ? series[i - 1] : null;
                          if (cur == null) return <td key={i}>—</td>;
                          if (prev == null) return <td key={i}><span className="wk-tot">{cur}</span></td>;
                          const n = cur - prev;
                          const pct = prev > 0 ? (n / prev) * 100 : null;
                          return (
                            <td key={i}>
                              <span className="wk-tot">{cur}</span>
                              <span className={"wk-abs" + (n > 0 ? " grow" : n < 0 ? " shrink" : "")}>
                                {n === 0 ? "—" : <>{n > 0 ? `+${n}` : n}{pct != null ? ` · ${n > 0 ? "+" : ""}${pct.toFixed(1).replace(/\.0$/, "")}%` : ""}</>}
                              </span>
                            </td>
                          );
                        })}
                        <td className={"wk-growth" + (total > 0 ? " up" : "")}>
                          {total == null ? "—" : <>{total > 0 ? `+${total}` : total}
                            {totalPct != null && <span className="wk-abs">{total > 0 ? "+" : ""}{totalPct.toFixed(1).replace(/\.0$/, "")}%</span>}</>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {slideover}
    </div>
  );
}

// chevron-right "drill in" cue (Flow 2 funnel + cards)
function Chevron() {
  return (
    <svg className="ov-fchev" width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/* ================= detail tables & panels ================= */

function EmailAge({ days, muteUnknown }) {
  if (days == null) return <span className={muteUnknown ? "t-dim" : "t-bad"}>—</span>;
  return <span className={days > 14 ? "t-bad" : "t-dim"}>{days}d ago</span>;
}

function Badges({ d }) {
  return (
    <>
      {d.ehr === "SystmOne" && <em className="tag">TPP</em>}
      {d.ehr === "EMIS" && <em className="tag emis">EMIS</em>}
      {d.fy_recalls > 1000 && <em className="badge gold" title=">1,000 recalls this FY">1k+ club</em>}
      {(d.tier === "Money-back" || d.tier === "Gold") && <em className="badge mbg" title="Paying customer (money-back guarantee)">Gold</em>}
      {d.tier === "Freemium" && <em className="badge free">Freemium</em>}
      {d.tier === "VC" && <em className="badge vc">VC</em>}
    </>
  );
}

// green shade scales with recall penetration (% of list); deeper = higher
const recallShade = (pct) =>
  pct == null ? undefined : { background: `hsl(158, 52%, ${Math.max(72, 95 - Math.min(pct, 11) * 2.1)}%)` };

// Read-only onboarding roll-up — the real set-up steps (Google Sheet) with any
// in-app Neon toggles merged over, so the Overview reflects what CS updates in the
// Onboarding Hub. Shown next to live practices (DPA-signed rows already carry the
// progress bar in their "Onboarding progress" column).
function TechRoll({ d, live }) {
  if (!d.onboarding?.length) return null;
  const steps = mergeOnboarding(d.onboarding, live);
  const { done, total, next } = summarizeOnboarding(steps);
  const complete = done === total;
  return (
    <em className={"tag tech-roll" + (complete ? " done" : "")}
      title={complete ? "Onboarding complete" : next ? `Onboarding · next: ${next}` : "Onboarding"}>
      ⚙ {done}/{total}
    </em>
  );
}

function OnboardWhy({ steps }) {
  const { done, total, next } = summarizeOnboarding(steps);
  const pct = Math.round((done / total) * 100);
  return (
    <span className="onb-why">
      <span className="onb-bar"><span className="onb-fill" style={{ width: `${pct}%` }} /></span>
      <b>{done}/{total}</b>
      {next && <span className="onb-next">next: {next}</span>}
    </span>
  );
}

/* ================= stage drill-down table ================= */

function DealTable({ deals, stageKey, liveOnb, onOpen }) {
  const isLive = stageKey === "live" || stageKey === "recalling";
  // null = the smart default order (stale first / deepest recall shade first);
  // clicking a header overrides it, clicking again flips direction.
  const [sort, setSort] = useState(null);
  const clickSort = (key) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
      : { key, dir: key === "name" || key === "owner" ? "asc" : "desc" }));
  const arrow = (key) => (sort?.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "");

  const shade = (x) => (x.recalling ? (x.fy_recalls_pct ?? 0.01) : x.stale ? -2 : -1);
  const defaultCmp = (a, b) => {
    if (isLive) {
      const d = shade(b.d) - shade(a.d);
      if (d) return d;
      return (b.d.days_in_stage || 0) - (a.d.days_in_stage || 0);
    }
    const sa = a.d.stale ? 0 : 1, sb = b.d.stale ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return (b.d.days_in_stage || 0) - (a.d.days_in_stage || 0);
  };
  const SORTS = {
    name: (r) => (r.d.name || "").toLowerCase(),
    days: (r) => r.d.days_in_stage || 0,
    next: (r) => (r.d.next_step ? (r.d.next_step.date || "0") : "9999"),
    why: (r) => (isLive ? (r.d.fy_recalls || 0)
      : stageKey === "dpa_signed" ? (r.progress == null ? -1 : r.progress)
      : (r.d.why || "").toLowerCase()),
    email: (r) => { const v = r.d.days_since_contact ?? r.d.days_since_email; return v == null ? -1 : v; },
    owner: (r) => (r.d.owner || "").toLowerCase(),
  };
  const rows = deals.map((d) => {
    const effOnb = d.onboarding ? mergeOnboarding(d.onboarding, liveOnb?.[d.ods]) : null;
    const progress = effOnb ? summarizeOnboarding(effOnb).done / effOnb.length : null;
    return { d, effOnb, progress };
  });
  const sorted = rows.sort((a, b) => {
    if (!sort) return defaultCmp(a, b);
    const f = SORTS[sort.key];
    const av = f(a), bv = f(b);
    const c = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    return (sort.dir === "asc" ? c : -c) || defaultCmp(a, b);
  });
  const whyLabel = isLive ? "Recalls this FY" : stageKey === "dpa_signed" ? "Onboarding progress" : "Why";
  return (
    <table className="dtable">
      <thead>
        <tr>
          <th className="sortable" onClick={() => clickSort("name")}>Practice{arrow("name")}</th>
          <th className="sortable" onClick={() => clickSort("days")}>{isLive ? "Live for" : "In stage"}{arrow("days")}</th>
          {!isLive && <th className="sortable" onClick={() => clickSort("next")}>Next step{arrow("next")}</th>}
          <th className="sortable" onClick={() => clickSort("why")}>{whyLabel}{arrow("why")}</th>
          {!isLive && <th className="sortable" onClick={() => clickSort("email")}>Last contact{arrow("email")}</th>}
          <th className="sortable" onClick={() => clickSort("owner")}>Owner{arrow("owner")}</th>
        </tr>
      </thead>
      <tbody>
        {!sorted.length && <tr className="empty"><td colSpan={6}>No deals in this stage.</td></tr>}
        {sorted.map(({ d, effOnb }) => {
          const recStyle = d.recalling ? recallShade(d.fy_recalls_pct) : undefined;
          return (
            <tr key={d.deal_id} style={recStyle} className={recStyle ? "row-shaded" : ""} onClick={() => onOpen(d)}>
              <td><span className="t-name">{d.name}<Badges d={d} />{isLive && <TechRoll d={d} live={liveOnb?.[d.ods]} />}</span></td>
              <td className="t-dim">{d.days_in_stage != null ? `${d.days_in_stage}d` : "—"}</td>
              {!isLive && (
                <td>{d.next_step
                  ? <span className="t-good">✓ {d.next_step.type}{d.next_step.date ? " " + fmtDate(d.next_step.date) : ""}</span>
                  : <span className="t-bad">none</span>}</td>
              )}
              <td className={d.stale ? "t-bad" : d.recalling ? "t-good" : "t-dim"}>
                {stageKey === "dpa_signed" && effOnb
                  ? <OnboardWhy steps={effOnb} />
                  : isLive
                    ? <>{(d.fy_recalls || 0).toLocaleString()}{d.fy_recalls_pct != null ? ` (${d.fy_recalls_pct}%)` : ""}</>
                    : d.why}
              </td>
              {!isLive && <td><EmailAge days={d.days_since_contact ?? d.days_since_email} muteUnknown /></td>}
              <td className="t-dim">{d.owner || "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ================= implementation tables ================= */

const RECALL_SORTS = {
  name: (p) => (p.name || "").toLowerCase(),
  fy: (p) => p.fy_recalls || 0,
  bloods: (p) => p.fy_bloods || 0,
  mo: (p) => p.recalls_this_month || 0,
  owner: (p) => (p.owner || "").toLowerCase(),
};

function useSort(defaults, sorts) {
  const [sort, setSort] = useState(defaults);
  const clickSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
      : { key, dir: key === "name" || key === "owner" ? "asc" : "desc" }));
  const arrow = (key) => (sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "");
  const sortFn = (a, b, tiebreak) => {
    const f = sorts[sort.key] || sorts[defaults.key];
    const av = f(a), bv = f(b);
    const c = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    return (sort.dir === "asc" ? c : -c) || tiebreak(a, b);
  };
  return { clickSort, arrow, sortFn };
}

function RecallingTable({ practices, onOpen }) {
  const { clickSort, arrow, sortFn } = useSort({ key: "fy", dir: "desc" }, RECALL_SORTS);
  const sorted = [...practices].sort((a, b) => sortFn(a, b, (x, y) => (y.fy_recalls || 0) - (x.fy_recalls || 0)));
  return (
    <table className="dtable">
      <thead>
        <tr>
          <th className="sortable" onClick={() => clickSort("name")}>Practice{arrow("name")}</th>
          <th className="sortable" onClick={() => clickSort("fy")}>Recalls this FY{arrow("fy")}</th>
          <th className="sortable" onClick={() => clickSort("bloods")}>Bloods{arrow("bloods")}</th>
          <th className="sortable td-num" onClick={() => clickSort("mo")}>This mo{arrow("mo")}</th>
          <th className="sortable" onClick={() => clickSort("owner")}>Owner{arrow("owner")}</th>
        </tr>
      </thead>
      <tbody>
        {!sorted.length && <tr className="empty"><td colSpan={5}>No recalling practices yet.</td></tr>}
        {sorted.map((p) => (
          <tr key={p.ods} style={recallShade(p.fy_recalls_pct)} className="row-shaded" onClick={() => onOpen(p)}>
            <td><span className="t-name">{p.name}<PracticeBadges p={p} /></span></td>
            <td className="t-good">{(p.fy_recalls || 0).toLocaleString()}{p.fy_recalls_pct != null ? ` (${p.fy_recalls_pct}%)` : ""}</td>
            <td className="t-dim">{(p.fy_bloods || 0).toLocaleString()}{p.fy_bloods_pct != null ? ` (${p.fy_bloods_pct}%)` : ""}</td>
            <td className="td-num">{(p.recalls_this_month || 0).toLocaleString()}</td>
            <td className="t-dim">{p.owner || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const LIVE_SORTS = {
  name: (p) => (p.name || "").toLowerCase(),
  patients: (p) => p.patients || 0,
  live: (p) => p.live_days || 0,
  next: (p) => (p.next_step?.date ? p.next_step.date : p.last_visit?.date ? "8" + p.last_visit.date : "9999"),
  owner: (p) => (p.owner || "").toLowerCase(),
};

function PracticeBadges({ p }) {
  return (
    <>
      {p.tier === "VC" && <em className="badge vc">VC</em>}
      {p.tier === "Freemium" && <em className="badge free">Freemium</em>}
      {(p.tier === "Money-back" || p.tier === "Gold") && <em className="badge mbg">Gold</em>}
      {p.fy_recalls > 1000 && <em className="badge gold" title=">1,000 recalls this FY">1k+ club</em>}
      {p.no_bloods && <em className="badge quiet" title="recalling but zero bloods automated — pathology not switched on">no bloods</em>}
      {p.gone_quiet && <em className="badge quiet" title="recalled last month, nothing yet this month">quiet this mo</em>}
      {!p.in_pipeline && <em className="tag" title="no HubSpot Planner deal">no HS deal</em>}
    </>
  );
}

const nextIcon = (t) => (t === "Visit" ? "▸" : t === "Meeting" ? "◦" : "•");
const VISIT_LABEL = { happened: "Completed", scheduled: "Confirmed", proposed: "Proposed", to_contact: "To contact" };
const todayISO = () => new Date().toISOString().slice(0, 10);

// "Next booked" cell: a firm booking (Confirmed visit / HubSpot meeting) wins;
// else a future Proposed launch; else the last completed visit.
function NextCell({ p }) {
  const today = todayISO();
  if (p.next_step && (p.next_step.date || p.next_step.type !== "Demo"))
    return <span className="t-good" title={p.next_step.source ? `from ${p.next_step.source}` : ""}>
      {nextIcon(p.next_step.type)} {p.next_step.date ? fmtDate(p.next_step.date) : p.next_step.type}</span>;
  const visits = p.visits || [];
  const prop = visits.find((v) => v.date && v.date >= today && (v.status === "proposed" || v.status === "to_contact"));
  if (prop) return <span className="t-warn">~{fmtDate(prop.date)} proposed</span>;
  const past = [...visits].reverse().find((v) => v.date && v.date <= today);
  if (past) return <span className="t-dim">visited {fmtDate(past.date)}</span>;
  if (visits.some((v) => v.status === "proposed" || v.status === "to_contact"))
    return <span className="t-warn">proposed (TBC)</span>;
  if (p.last_visit?.date) return <span className="t-dim">visited {fmtDate(p.last_visit.date)}</span>;
  return <span className="t-dim">—</span>;
}

function LiveNotRecallingTable({ practices, onOpen }) {
  const { clickSort, arrow, sortFn } = useSort({ key: "live", dir: "desc" }, LIVE_SORTS);
  const sorted = [...practices].sort((a, b) => sortFn(a, b, (x, y) => (y.patients || 0) - (x.patients || 0)));
  return (
    <table className="dtable">
      <thead>
        <tr>
          <th className="sortable" onClick={() => clickSort("name")}>Practice{arrow("name")}</th>
          <th className="sortable td-num" onClick={() => clickSort("patients")}>List size{arrow("patients")}</th>
          <th className="sortable" onClick={() => clickSort("live")}>Live for{arrow("live")}</th>
          <th className="sortable" onClick={() => clickSort("next")}>Next booked{arrow("next")}</th>
          <th className="sortable" onClick={() => clickSort("owner")}>Owner{arrow("owner")}</th>
        </tr>
      </thead>
      <tbody>
        {!sorted.length && <tr className="empty"><td colSpan={5}>Every live practice is recalling.</td></tr>}
        {sorted.map((p) => (
          <tr key={p.ods} onClick={() => onOpen(p)}>
            <td><span className="t-name">{p.name}<PracticeBadges p={p} /></span></td>
            <td className="td-num t-dim">{p.patients ? p.patients.toLocaleString() : "—"}</td>
            <td className="t-warn">{p.live_days != null ? `${p.live_days}d` : "—"}</td>
            <td><NextCell p={p} /></td>
            <td className="t-dim">{p.owner || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ================= slide-over panel ================= */

function SlideOver({ onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);
  return (
    <>
      <div className="slideover-backdrop" onClick={onClose} />
      <aside className="slideover" role="dialog" aria-modal="true">
        {children}
      </aside>
    </>
  );
}

function CopyBtn({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button className="copybtn" title="Copy" onClick={(e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); });
    }}>{done ? "✓" : "⧉"}</button>
  );
}

function MetaItem({ label, value, copy, plain }) {
  return (
    <div className="so-meta-item">
      <div className="so-meta-label">{label}</div>
      <div className={"so-meta-value" + (plain ? " plain" : "")}>{value}{copy && <CopyBtn text={copy} />}</div>
    </div>
  );
}

function SoRow({ label, children }) {
  return <div className="so-row"><span>{label}</span><em>{children}</em></div>;
}

function Sparkbars({ data, current, tone = "recalls", fmt }) {
  const max = Math.max(1, ...data.map((x) => x.value));
  const lbl = fmt || ((k) => MON[+k.slice(5)] || k);
  return (
    <div className={"dd-spark " + tone}>
      {data.map((x) => (
        <div key={x.key} className="spark-col" title={`${lbl(x.key)}: ${x.value}`}>
          <span className="spark-val">{x.value}</span>
          <div
            className="spark-bar"
            data-cur={x.key === current ? "1" : undefined}
            style={{ height: `${Math.max(3, Math.round((x.value / max) * 46))}px` }}
          />
          <span className="spark-m">{lbl(x.key)}</span>
        </div>
      ))}
    </div>
  );
}

// Recalls + Bloods bar charts with an optional Month/Week toggle (toggle shows
// only when weeklyAvailable — i.e. once a daily-granularity feed is connected).
function MonthlyWeeklyGraphs({ item, weeklyAvailable }) {
  const [gran, setGran] = useState("month");
  const g = weeklyAvailable ? gran : "month";
  const recSeries = g === "week" ? (item.recalls_by_week || {}) : (item.recalls_by_month || {});
  const blSeries = g === "week" ? (item.bloods_by_week || {}) : (item.bloods_by_month || {});
  const now = new Date();
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const current = g === "week" ? monday.toISOString().slice(0, 10) : now.toISOString().slice(0, 7);
  const fmt = g === "week" ? ((k) => fmtDate(k)) : undefined;
  const toBars = (obj) => Object.keys(obj).sort().map((k) => ({ key: k, value: obj[k] }));
  const recBars = toBars(recSeries), blBars = toBars(blSeries);
  return (
    <>
      {weeklyAvailable && (
        <div className="gran-toggle">
          <button className={g === "month" ? "active" : ""} onClick={() => setGran("month")}>Month</button>
          <button className={g === "week" ? "active" : ""} onClick={() => setGran("week")}>Week</button>
        </div>
      )}
      <div className="dd-spark-wrap">
        <div className="dd-spark-head">
          <span className="so-section-title" style={{ margin: 0 }}>Recalls / {g}</span>
          <span className="dd-spark-fy"><b>{(item.fy_recalls || 0).toLocaleString()}</b> this FY
            {item.fy_recalls_pct != null ? ` · ${item.fy_recalls_pct}% of list` : ""}
            {item.recalls_avg_mo ? ` · ~${item.recalls_avg_mo.toLocaleString()}/mo` : ""}</span>
        </div>
        {recBars.length > 0
          ? <Sparkbars data={recBars} current={current} fmt={fmt} />
          : <span className="dd-spark-none">No recalls yet this FY</span>}
      </div>
      <div className="dd-spark-wrap">
        <div className="dd-spark-head">
          <span className="so-section-title" style={{ margin: 0 }}>Bloods (pathology) / {g}</span>
          <span className="dd-spark-fy"><b>{(item.fy_bloods || 0).toLocaleString()}</b> automated this FY
            {item.fy_bloods_pct != null ? ` · ${item.fy_bloods_pct}% of list` : ""}</span>
        </div>
        {blBars.length > 0
          ? <Sparkbars data={blBars} current={current} tone="bloods" fmt={fmt} />
          : <span className="dd-spark-none">No pathology automated yet</span>}
      </div>
    </>
  );
}

function StageTimelineV({ timeline, daysInStage }) {
  return (
    <ol className="dd-timeline">
      {timeline.map((s, i) => (
        <li key={i} className={"tl-node" + (s.current ? " current" : "")}>
          <span className="tl-dot" />
          <span className="tl-stage">{s.stage}</span>
          <span className="tl-date">{fmtDate(s.date)}</span>
          {s.gap_days != null && <span className="tl-gap">+{s.gap_days}d</span>}
          {s.current && daysInStage != null && (
            <span className="tl-gap now">{daysInStage}d &amp; counting</span>
          )}
        </li>
      ))}
    </ol>
  );
}

// Full onboarding checklist. Interactive in the Onboarding tab: each step is a
// button that cycles todo→pending→done→todo and POSTs a timestamped event to Neon.
function OnboardChecklist({ steps, interactive, onToggle }) {
  const { done, total } = summarizeOnboarding(steps);
  const mark = { done: "✓", pending: "•", todo: "○" };
  const tip = (s) =>
    s.changed_at
      ? `${s.state}${s.changed_by ? " · " + s.changed_by : ""} · ${fmtDate(s.changed_at)}`
      : (s.value || s.state);
  const complete = done === total;
  return (
    <div className="so-section">
      <div className={"so-banner" + (complete ? " ok" : "")}>
        <b>Onboard-ready checklist ({done}/{total})</b>
        <span className="head-flag">{complete ? "Complete" : "Incomplete"}</span>
      </div>
      {interactive && <p className="muted" style={{ margin: "0 0 8px" }}>Click a step to advance it — to&nbsp;do → pending → done. Every change is timestamped.</p>}
      <div className="onb-steps">
        {steps.map((s, i) =>
          interactive ? (
            <button key={i} className={"onb-step btn " + s.state} title={tip(s)}
              onClick={(e) => { e.stopPropagation(); onToggle(s); }}>
              <em>{mark[s.state]}</em> {s.step}
              {s.changed_at ? <i className="onb-val">{fmtDate(s.changed_at)}</i> : null}
            </button>
          ) : (
            <span key={i} className={"onb-step " + s.state} title={tip(s)}>
              <em>{mark[s.state]}</em> {s.step}
              {s.value && s.state !== "todo" ? <i className="onb-val">{s.value}</i> : null}
            </span>
          )
        )}
      </div>
    </div>
  );
}

// Horizontal lifecycle axis: HubSpot stage-entry dates → go-live → first recall.
function JourneyTimeline({ timeline, goLive, firstRecallMonth }) {
  const nodes = (timeline || []).map((s) => ({ label: s.stage, date: s.date, gap: s.gap_days, current: s.current }));
  if (goLive && !nodes.some((n) => /live/i.test(n.label))) nodes.push({ label: "Go live", date: goLive });
  nodes.push(firstRecallMonth
    ? { label: "First recall", month: firstRecallMonth, recall: true }
    : { label: "First recall", pending: true, recall: true });
  return (
    <div className="so-section">
      <h4 className="so-section-title">Journey — signup → live → first recall</h4>
      <ol className="journey">
        {nodes.map((n, i) => (
          <li key={i} className={"jn" + (n.recall ? " recall" : "") + (n.pending ? " pending" : "") + (n.current ? " current" : "")}>
            <span className="jn-dot" />
            <span className="jn-label">{n.label}</span>
            <span className="jn-date">{n.pending ? "not yet" : n.month ? fmtMon(n.month) : fmtDate(n.date)}</span>
            {n.gap != null && <span className="jn-gap">+{n.gap}d</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

// All recall launches on record (Notion) — completed + confirmed + proposed, newest first.
function VisitsList({ visits }) {
  if (!visits || !visits.length) return null;
  const ordered = [...visits].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return (
    <div className="so-section">
      <h4 className="so-section-title">Recall launches (Notion) <em className="cur-key">{visits.length}</em></h4>
      <ul className="visit-list">
        {ordered.map((v, i) => (
          <li key={i} className="vrow">
            <span className={"status-chip " + (v.status || "")}>{VISIT_LABEL[v.status] || v.status || "Visit"}</span>
            <span className="vdate">{v.date ? fmtDate(v.date) : "—"}</span>
            {v.problems && <span className="vproblems" title={v.problems}>⚠ {v.problems}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ----- deal panel (sales pipeline detail) ----- */

function DealPanel({ d, labelOf, onb, weeklyAvailable }) {
  const effOnb = d.onboarding ? mergeOnboarding(d.onboarding, onb?.live?.[d.ods]) : null;
  return (
    <>
      <div className="so-head">
        <div className="so-titlerow">
          <h2 className="so-title">{d.name}<Badges d={d} /></h2>
        </div>
        <div className="so-sync">{labelOf(d.stage)}{d.recalling ? " · recalling" : ""}{d.stale ? " · stale" : ""}{d.why ? ` — ${d.why}` : ""}</div>
        <div className="so-meta">
          {d.ods && <MetaItem label="ODS code" value={d.ods} copy={d.ods} />}
          <MetaItem label="List size" value={d.patients ? d.patients.toLocaleString() : "—"} plain />
          <MetaItem label="In stage" value={d.days_in_stage != null ? `${d.days_in_stage}d` : "—"} plain />
          <MetaItem label="Owner" value={d.owner || "—"} plain />
        </div>
      </div>
      <div className="so-body">
        <div className="so-section">
          <h4 className="so-section-title">Account details</h4>
          <div className="so-rows">
            <SoRow label="Lead source">{d.source || "—"}</SoRow>
            <SoRow label="ICB">{d.icb || "—"}</SoRow>
            <SoRow label="PCN">{d.pcn_name || "—"}</SoRow>
            <SoRow label="Next step">
              {d.next_step
                ? <>{nextIcon(d.next_step.type)} {d.next_step.type}{d.next_step.date ? ` · ${fmtDate(d.next_step.date)}` : ""}</>
                : <span className="muted">none booked</span>}
            </SoRow>
            <SoRow label="Last contact">
              {d.last_email
                ? <>“{d.last_email.subject}” · {fmtDate(d.last_email.date)} ({d.last_email.direction})</>
                : d.last_contact
                  ? <>{fmtDate(d.last_contact)}{d.days_since_contact != null ? ` · ${d.days_since_contact}d ago` : ""} (HubSpot activity)</>
                  : "—"}
            </SoRow>
          </div>
        </div>

        {d.stage_timeline?.length > 0 && (
          <div className="so-section">
            <h4 className="so-section-title">Stage timeline</h4>
            <StageTimelineV timeline={d.stage_timeline} daysInStage={d.days_in_stage} />
          </div>
        )}

        {effOnb?.length > 0 && (
          <OnboardChecklist
            steps={effOnb}
            interactive={!!onb}
            onToggle={onb ? (step) => onb.toggle(d, step) : null}
          />
        )}

        <div className="so-section">
          <h4 className="so-section-title">This month so far</h4>
          <div className="so-rows">
            <SoRow label="Recalls">
              {(d.recalls_this_month || 0).toLocaleString()}{d.recalls_this_month_pct != null ? ` (${d.recalls_this_month_pct}%)` : ""}
            </SoRow>
            {d.bloods_this_month != null && <SoRow label="Bloods">{(d.bloods_this_month || 0).toLocaleString()}</SoRow>}
          </div>
        </div>

        <MonthlyWeeklyGraphs item={d} weeklyAvailable={weeklyAvailable} />
      </div>
    </>
  );
}

/* ----- practice panel (implementation detail) ----- */

function PracticePanel({ p, weeklyAvailable }) {
  const recalling = (p.fy_recalls || 0) >= 5; // matches the pipeline’s MIN_ACTIVE_RECALLS
  return (
    <>
      <div className="so-head">
        <div className="so-titlerow">
          <h2 className="so-title">{p.name}<PracticeBadges p={p} /></h2>
        </div>
        <div className="so-sync">
          {p.live ? "Live (onboarding sheet)" : "Not in Live sheet"} · {p.in_pipeline ? "in HubSpot Planner pipeline" : "no HubSpot Planner deal"}
        </div>
        <div className="so-meta">
          <MetaItem label="ODS code" value={p.ods} copy={p.ods} />
          <MetaItem label="List size" value={p.patients ? p.patients.toLocaleString() : "—"} plain />
          <MetaItem label="Tier" value={p.tier || "—"} plain />
          <MetaItem label="Owner" value={p.owner || "—"} plain />
        </div>
      </div>
      <div className="so-body">
        <div className={"so-banner" + (recalling ? " ok" : "")}>
          <b>{recalling
            ? `${(p.fy_recalls || 0).toLocaleString()} recalls this FY${p.fy_recalls_pct != null ? ` · ${p.fy_recalls_pct}% of list` : ""}${p.pct_vs_median ? ` · ${p.pct_vs_median}× cohort median` : ""}${p.bloods_attach_pct != null ? ` · bloods attach ${p.bloods_attach_pct}%` : ""}`
            : "Fewer than 5 recalls this FY — activation gap"}</b>
          <span className="head-flag">{recalling ? "Recalling" : "Not recalling"}</span>
        </div>

        <div className="so-section">
          <h4 className="so-section-title">Account details</h4>
          <div className="so-rows">
            <SoRow label="Lead source">{p.source || "—"}</SoRow>
            <SoRow label="ICB">{p.icb || "—"}</SoRow>
            <SoRow label="PCN">{p.pcn_name || "—"}</SoRow>
            <SoRow label="Next booked"><NextCell p={p} /></SoRow>
          </div>
        </div>

        <JourneyTimeline timeline={p.stage_timeline} goLive={p.go_live} firstRecallMonth={p.first_recall_month} />
        <VisitsList visits={p.visits} />
        <MonthlyWeeklyGraphs item={p} weeklyAvailable={weeklyAvailable} />
      </div>
    </>
  );
}
