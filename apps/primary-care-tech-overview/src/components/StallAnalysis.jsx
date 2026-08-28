import React, { useEffect, useMemo, useState } from "react";
import { ONB_BASE, WAITING_LABEL } from "../onboarding.js";
import { aggregate, buildContext, buildJourney, CHECKPOINTS } from "../stalls.js";

// Sign-up → go-live: how long deals take, where they sit, and what's blocking them.
// Pure presentation — the maths lives in ../stalls.js.

const VIEWS = [
  { key: "journey", label: "Journey" },
  { key: "now", label: "Stalling now" },
  { key: "steps", label: "Onboarding steps" },
  { key: "cohorts", label: "Cohorts" },
];
const EHR_OPTS = ["All", "EMIS", "SystmOne", "Other"];
const SOURCE_LABEL = { visit: "Notion visit", event: "Hub toggle", recalls: "first recall month", sheet: "sheet 'Held' (Live date)", undated: "sheet 'Held', undated (not timed)" };

const d = (n) => (n == null ? "–" : `${n}d`);
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" }) : "");
const ehrBucket = (e) => {
  const t = (e || "").toLowerCase();
  if (t.includes("emis")) return "EMIS";
  if (t.includes("systm") || t === "s1" || t.includes("tpp")) return "SystmOne";
  return "Other";
};

export default function StallAnalysis({ deals, recallers, visits, liveOnb, auth, onOpen }) {
  const [events, setEvents] = useState(null);
  const [view, setView] = useState("journey");
  const [ehr, setEhr] = useState("All");
  const [showAll, setShowAll] = useState(false);
  const [openStep, setOpenStep] = useState(null);

  useEffect(() => {
    const headers = auth?.token ? { Authorization: `Bearer ${auth.token}` } : {};
    fetch(`${ONB_BASE}/events`, { headers })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setEvents)
      .catch(() => setEvents({ steps: [], blocks: [], failed: true }));
  }, [auth?.token]);

  const { agg, journeys } = useMemo(() => {
    const ctx = buildContext({ visits, recallers, liveOnb, events });
    const pool = (deals || []).filter((x) => x.created && (ehr === "All" || ehrBucket(x.ehr) === ehr));
    const js = pool.map((x) => buildJourney(x, ctx));
    return { agg: aggregate(js, ctx), journeys: js };
  }, [deals, recallers, visits, liveOnb, events, ehr]);

  const open = (j) => onOpen && onOpen(j.deal);

  return (
    <section className="ov-card st-card" id="stalls">
      <div className="ov-card-head">
        <div>
          <h2 className="ov-card-title">Sign-up → go-live: time & stalls</h2>
          <p className="ov-sub st-sub">Clock starts when the HubSpot deal is created and stops when the recall session has been held. Every deal still in the pipeline (dropped excluded).</p>
        </div>
        <div className="st-controls">
          <div className="st-seg">
            {EHR_OPTS.map((o) => (
              <button key={o} className={"st-seg-btn" + (ehr === o ? " on" : "")} onClick={() => setEhr(o)}>{o}</button>
            ))}
          </div>
        </div>
      </div>

      {/* headline */}
      <div className="kpis st-kpis">
        <div className="kpi">
          <div className="kpi-label">Median sign-up → go-live</div>
          <div className="kpi-value su-num">{d(agg.medianTotal)}</div>
          <div className="kpi-sub">p75 {d(agg.p75Total)} · slowest {d(agg.maxTotal)} · {agg.completed} gone live</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Still in flight</div>
          <div className="kpi-value su-num">{agg.inflight}</div>
          <div className="kpi-sub">of {agg.total} · median age {d(agg.inflightMedianAge)}</div>
        </div>
        <div className={"kpi" + (agg.inflightOver90 ? " bad" : "")}>
          <div className="kpi-label">In flight &gt; 90 days</div>
          <div className="kpi-value su-num">{agg.inflightOver90}</div>
          <div className="kpi-sub">signed up 3+ months ago, no recall session yet</div>
        </div>
        <div className={"kpi" + (agg.activeBlockList.length ? " bad" : "")}>
          <div className="kpi-label">Actively blocked</div>
          <div className="kpi-value su-num">{agg.activeBlockList.length}</div>
          <div className="kpi-sub">{agg.clearedBlocksN ? `cleared blocks took a median ${d(agg.clearedBlocksMedian)}` : "no cleared blocks yet"}</div>
        </div>
      </div>

      <div className="st-tabs">
        {VIEWS.map((v) => (
          <button key={v.key} className={"st-tab" + (view === v.key ? " on" : "")} onClick={() => setView(v.key)}>{v.label}</button>
        ))}
      </div>

      {view === "journey" && <JourneyView agg={agg} />}
      {view === "now" && <NowView agg={agg} showAll={showAll} setShowAll={setShowAll} open={open} />}
      {view === "steps" && <StepsView agg={agg} openStep={openStep} setOpenStep={setOpenStep} open={open} />}
      {view === "cohorts" && <CohortView agg={agg} />}

      <div className="card-foot st-foot">
        Go-live dates: {Object.entries(agg.sourceCounts).map(([k, n]) => `${n} from ${SOURCE_LABEL[k] || k}`).join(" · ") || "none yet"}.
        {" "}Stage dates are HubSpot stage-entry timestamps (bulk catch-ups can lag reality); onboarding-step timings use human Hub toggles only (from Jun 2026), so early practices have stage-level timing but no step-level detail.
        {events?.failed && <span style={{ color: "var(--su-bad)" }}> Couldn’t load Hub events — step-level timing is from the sheet only.</span>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Journey
function JourneyView({ agg }) {
  const max = Math.max(1, ...agg.phases.map((p) => p.p75 || p.median || 0));
  const bmax = Math.max(1, ...agg.buckets.map((b) => b.n));
  const worst = [...agg.phases].sort((a, b) => (b.median || 0) - (a.median || 0))[0];
  return (
    <div className="st-two">
      <div>
        <div className="st-h">Days spent at each stage before moving on <span className="st-hint">median · p75 bar · n completed</span></div>
        {agg.phases.map((p) => (
          <div key={p.key} className={"st-prow" + (worst && p.key === worst.key && p.median ? " worst" : "")}>
            <span className="st-plabel">{p.label}<em>→ next</em></span>
            <div className="st-ptrack">
              <div className="st-pfill p75" style={{ width: `${Math.round(((p.p75 || 0) / max) * 100)}%` }} />
              <div className="st-pfill" style={{ width: `${Math.round(((p.median || 0) / max) * 100)}%` }} />
            </div>
            <span className="st-pnum su-num">{d(p.median)}<small> p75 {d(p.p75)} · n={p.n}</small></span>
          </div>
        ))}
        {worst?.median != null && (
          <p className="st-note">Biggest single wait is <b>{worst.label}</b> — a median {worst.median} days before the next dated step, {worst.p75} at p75.</p>
        )}
      </div>
      <div>
        <div className="st-h">How long completed journeys took <span className="st-hint">sign-up → recall session, {agg.completed} practices</span></div>
        <div className="st-hist">
          {agg.buckets.map((b) => (
            <div key={b.label} className="st-hcol" title={`${b.n} practice${b.n === 1 ? "" : "s"}`}>
              <div className="st-hbar" style={{ height: `${Math.round((b.n / bmax) * 100)}%` }}><span className="su-num">{b.n || ""}</span></div>
              <span className="st-hlabel">{b.label}</span>
            </div>
          ))}
        </div>
        <div className="st-h" style={{ marginTop: 18 }}>Where the in-flight deals sit today <span className="st-hint">count · median days there</span></div>
        {agg.phases.map((p) => (
          <div key={p.key} className="st-irow">
            <span className="st-plabel">{p.short}</span>
            <div className="st-ptrack"><div className="st-pfill inflight" style={{ width: `${Math.round((p.inflight / Math.max(1, agg.inflight)) * 100)}%` }} /></div>
            <span className="st-pnum su-num">{p.inflight}<small> · {d(p.inflightMedian)} · {p.inflightOver30} &gt;30d</small></span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Stalling now
function NowView({ agg, showAll, setShowAll, open }) {
  const rows = showAll ? agg.longest : agg.longest.slice(0, 15);
  return (
    <div>
      <div className="st-h">Longest sitting in their current stage <span className="st-hint">what they're waiting on, if we know</span>
        <span className="ov-more" onClick={() => setShowAll(!showAll)}>{showAll ? "Top 15" : `All ${agg.longest.length}`}</span>
      </div>
      <table className="st-table">
        <thead><tr><th>Practice</th><th>EHR</th><th>Stage</th><th className="num">Days here</th><th className="num">Since sign-up</th><th>Next / blocker</th><th>Owner</th></tr></thead>
        <tbody>
          {rows.map((j) => {
            const nb = j.onboarding.nextStep;
            const blk = nb && j.onboarding.blocks[nb.key];
            const anyBlk = Object.values(j.onboarding.blocks)[0];
            return (
              <tr key={j.deal.deal_id} className="st-row" onClick={() => open(j)}>
                <td><b>{j.deal.name}</b></td>
                <td>{ehrBucket(j.deal.ehr)}</td>
                <td>{j.current.label}<small className="st-since"> since {fmtDate(j.current.since)}</small></td>
                <td className={"num su-num" + (j.current.days > 60 ? " bad" : j.current.days > 30 ? " warn" : "")}>{j.current.days}</td>
                <td className="num su-num">{j.totalDays}</td>
                <td>
                  {(j.current.key === "dpa_signed" || j.current.key === "live") && nb
                    ? <>{nb.step} <small className="st-since">({j.onboarding.doneCount}/{j.onboarding.total})</small></>
                    : j.deal.next_step?.date ? <>{j.deal.next_step.type} booked {fmtDate(j.deal.next_step.date)}</> : <span className="st-faint">nothing booked</span>}
                  {(blk || anyBlk) && <span className="st-blk">blocked · {WAITING_LABEL[(blk || anyBlk).waiting_on] || (blk || anyBlk).waiting_on}{(blk || anyBlk).reason ? ` · ${(blk || anyBlk).reason}` : ""}</span>}
                </td>
                <td>{j.deal.owner || ""}</td>
              </tr>
            );
          })}
          {!rows.length && <tr><td colSpan={7} className="st-faint">Nothing in flight for this filter.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- Onboarding steps
function StepsView({ agg, openStep, setOpenStep, open }) {
  const max = Math.max(1, ...agg.steps.map((s) => s.stuck));
  return (
    <div>
      <div className="st-h">Inside DPA signed → go-live: which step are the {agg.onbInflight} practices waiting on? <span className="st-hint">stuck here · median wait · blocked · completed-step median (n)</span></div>
      {agg.steps.map((s) => (
        <React.Fragment key={s.key}>
          <div className={"st-srow" + (openStep === s.key ? " open" : "")} onClick={() => setOpenStep(openStep === s.key ? null : s.key)}>
            <span className="st-slabel">{s.label}</span>
            <div className="st-ptrack"><div className={"st-pfill" + (s.blocked ? " blocked" : "")} style={{ width: `${Math.round((s.stuck / max) * 100)}%` }} /></div>
            <span className="st-snum su-num"><b>{s.stuck}</b> stuck</span>
            <span className="st-snum su-num">{d(s.stuckMedian)}<small> wait · max {d(s.stuckMax)}</small></span>
            <span className={"st-snum su-num" + (s.blockedAny ? " bad" : "")}>{s.blockedAny ? `${s.blockedAny} blocked` : ""}<small>{s.blockedAny ? " · " + Object.entries(s.byWaiting).map(([w, n]) => `${n} ${WAITING_LABEL[w] || w}`).join(", ") : ""}</small></span>
            <span className="st-snum su-num st-faint">{s.n ? `${d(s.median)} to complete (n=${s.n})` : "no timed completions"}</span>
          </div>
          {openStep === s.key && (
            <ul className="tw-list st-steplist">
              {s.practices.map((p) => (
                <li key={p.ods || p.name} onClick={() => open(p.journey)} className="st-row">
                  <b>{p.name}{p.blocked ? <span className="st-blk">blocked</span> : null}</b><span className="su-num">{d(p.days)} waiting</span>
                </li>
              ))}
              {!s.practices.length && <li><span>Nobody waiting on this step right now.</span></li>}
            </ul>
          )}
        </React.Fragment>
      ))}

      <div className="st-h" style={{ marginTop: 22 }}>Active blocks <span className="st-hint">who we're waiting on, longest first</span></div>
      <table className="st-table">
        <thead><tr><th>Practice</th><th>Step</th><th>Waiting on</th><th>Reason</th><th className="num">Days blocked</th></tr></thead>
        <tbody>
          {agg.activeBlockList.map((b) => (
            <tr key={b.ods + b.step} className="st-row" onClick={() => open(b.journey)}>
              <td><b>{b.name}</b></td><td>{b.step}</td><td>{WAITING_LABEL[b.waiting_on] || b.waiting_on}</td><td>{b.reason || <span className="st-faint">–</span>}</td>
              <td className={"num su-num" + (b.days > 30 ? " bad" : "")}>{b.days}</td>
            </tr>
          ))}
          {!agg.activeBlockList.length && <tr><td colSpan={5} className="st-faint">No active blocks.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- Cohorts
function CohortView({ agg }) {
  return (
    <div>
      <div className="st-h">By sign-up quarter <span className="st-hint">is it getting faster? where is each cohort parked?</span></div>
      <table className="st-table">
        <thead>
          <tr>
            <th>Signed up</th><th className="num">Deals</th><th className="num">DPA signed</th><th className="num">Gone live</th>
            <th className="num">Median → DPA</th><th className="num">Median → go-live</th><th className="num">In flight</th><th className="num">Median age</th><th>Where the in-flight sit</th>
          </tr>
        </thead>
        <tbody>
          {agg.cohorts.map((c) => (
            <tr key={c.quarter}>
              <td><b>{c.quarter}</b></td>
              <td className="num su-num">{c.n}</td>
              <td className="num su-num">{c.dpa} <small className="st-faint">({c.dpaPct}%)</small></td>
              <td className="num su-num">{c.live} <small className="st-faint">({c.livePct}%)</small></td>
              <td className="num su-num">{d(c.medianToDpa)}</td>
              <td className="num su-num">{d(c.medianToLive)}</td>
              <td className="num su-num">{c.inflight}</td>
              <td className={"num su-num" + ((c.inflightMedianAge || 0) > 90 ? " bad" : "")}>{d(c.inflightMedianAge)}</td>
              <td>
                <div className="st-mix">
                  {c.stageMix.filter((m) => m.n).map((m) => (
                    <span key={m.key} className={"st-mix-seg " + m.key} style={{ flex: m.n }} title={`${m.n} at ${m.short}`}>{m.n}</span>
                  ))}
                </div>
                <div className="st-mix-legend">{c.stageMix.filter((m) => m.n).map((m) => `${m.short} ${m.n}`).join(" · ")}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="st-note">Recent cohorts naturally show fewer go-lives — read “median → DPA” and “median age” for whether the newer deals are moving faster than the older ones did.</p>
    </div>
  );
}
