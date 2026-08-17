import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import "./OnboardingHub.css";
import { useOnboarding, mergeOnboarding, summarizeOnboarding, firstNameFromEmail, WAITING_ON, WAITING_LABEL, STATE_CYCLE } from "../onboarding.js";

// The Onboarding Hub: the CS team's action surface for DPA-signed-onwards
// practices. It answers "who needs to do what, and why can't we move forward":
// progress + blocked-on-whom + booked touchpoints, with one-click mark-live.

const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
const fmtDateTime = (s) =>
  s ? new Date(s).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
const fmtTime = (s) => { try { return new Date(s).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ") : "");
// "in 14h" / "in 3 days" / "in 2 wk" until a session start. dateStr may be a
// timed ISO (used directly) or a bare "YYYY-MM-DD" combined with a "10:30-…" time.
function untilLabel(dateStr, timeStr) {
  if (!dateStr) return null;
  let iso;
  if (String(dateStr).includes("T")) iso = dateStr;
  else {
    const m = (timeStr || "").match(/(\d{1,2}):(\d{2})/);
    iso = `${String(dateStr).slice(0, 10)}T${m ? `${m[1].padStart(2, "0")}:${m[2]}` : "09:00"}:00`;
  }
  const ms = new Date(iso).getTime() - Date.now();
  if (isNaN(ms) || ms < 0) return null;
  const h = ms / 3600000;
  if (h < 1) return `in ${Math.max(1, Math.round(ms / 60000))} min`;
  if (h < 48) return `in ${Math.round(h)}h`;
  const days = Math.round(h / 24);
  return days < 14 ? `in ${days} day${days === 1 ? "" : "s"}` : `in ${Math.round(days / 7)} wk`;
}
const MARK = { done: "✓", pending: "•", todo: "○", na: "–" };
// EHR short tag for the table column: EMIS or S1 (SystmOne/TPP); null otherwise.
const ehrShort = (ehr) => {
  const e = (ehr || "").toLowerCase();
  if (e.includes("emis")) return "EMIS";
  if (e.includes("systm") || e === "s1" || e.includes("tpp")) return "S1";
  return null;
};
const STALL_DAYS = 14; // fallback when funnel_board.json carries no stage threshold
const daysSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400000)) : null);
const localISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// Calendar day key. A timed ISO (has "T", may carry a UTC offset) is placed on its
// LOCAL day so the cell agrees with the local time we show; a plain "YYYY-MM-DD"
// (Notion visit) is a calendar date already and is used verbatim.
const dayKey = (s) => (s && String(s).includes("T") ? localISO(new Date(s)) : String(s || "").slice(0, 10));
// Sort key for calendar events: parse the timestamp; a bare "YYYY-MM-DD" (Notion
// visit, often timeless) is treated as start-of-day so it doesn't jump ahead of
// timed meetings when both land in the same cell.
const evTime = (s) => Date.parse(s) || Date.parse(`${String(s || "").slice(0, 10)}T00:00:00`) || 0;
// Clock label only for a timed ISO; a bare "YYYY-MM-DD" (Notion visit) has no
// time, so don't fabricate one (parsing it as UTC midnight shows a stray 01:00).
const clockTime = (s) => (s && String(s).includes("T") ? fmtTime(s) : "");

// HubSpot deep link — Suvera is on the EU instance, portal 143576889 (see pipeline/refresh_data.py).
const HS_PORTAL = "143576889";
const hubspotDealUrl = (deal_id) => (deal_id ? `https://app-eu1.hubspot.com/contacts/${HS_PORTAL}/record/0-3/${encodeURIComponent(deal_id)}` : null);

// Cohort = HubSpot Planner deals at DPA-signed or beyond, with an ODS code.
const inCohort = (d) => (d.stage === "dpa_signed" || d.stage === "live") && d.ods;

function statusOf(d) {
  if (d.stage === "dpa_signed") return { key: "st-dpa", label: "DPA signed", group: "dpa" };
  if (d.recalling) return { key: "st-recalling", label: "Live — recalling", group: "recalling" };
  return { key: "st-live", label: "Live — not recalling", group: "live" };
}

// Recall/implementation session lookup (Notion practice_visits.json, keyed by ODS).
function recallFor(visits, ods) {
  if (!visits || !ods) return null;
  return visits[ods] || visits[ods.toUpperCase()] || null;
}
// All recorded occurrences of a practice's recall sessions (current + history).
function recallOccurrences(v) {
  if (!v) return [];
  return [{ date: v.date, status: v.status, times: v.times }, ...(v.history || [])].filter((x) => x.date);
}
function futureRecalls(v, todayStr) {
  return recallOccurrences(v)
    .filter((x) => x.date >= todayStr && ["scheduled", "proposed", "to_contact"].includes(x.status))
    .sort((a, b) => a.date.localeCompare(b.date));
}
// Headline recall-booking status for a practice detail page.
function recallStatus(v, todayStr) {
  if (!v) return { label: "No recall session booked yet", cls: "none", booked: false };
  const up = futureRecalls(v, todayStr);
  if (up.length) {
    const n = up[0];
    const when = `${fmtDate(n.date)}${n.times ? ` · ${n.times}` : ""}`;
    const until = untilLabel(n.date, n.times);
    return n.status === "scheduled"
      ? { label: `Booked — ${when}`, cls: "ok", booked: true, until }
      : { label: `${cap(n.status)} — ${when}`, cls: "warn", booked: "tentative", until };
  }
  const past = recallOccurrences(v).filter((x) => x.status === "happened").sort((a, b) => b.date.localeCompare(a.date));
  if (past.length) return { label: `Last session ${fmtDate(past[0].date)} · none upcoming`, cls: "done", booked: "past" };
  return { label: "No recall session booked yet", cls: "none", booked: false };
}

// Active blocks for a practice → labelled items (orthogonal to step progress).
function blockInfo(steps, blocksForOds) {
  const b = blocksForOds || {};
  const label = {};
  steps.forEach((s) => { label[s.key] = s.step; });
  const items = Object.entries(b)
    .map(([key, v]) => ({ key, label: label[key] || key, waiting_on: v.waiting_on, reason: v.reason, days: daysSince(v.blocked_at) }))
    .sort((a, b) => (b.days || 0) - (a.days || 0));
  return { count: items.length, items, oldestDays: items[0]?.days ?? null, waiting: new Set(items.map((i) => i.waiting_on)) };
}

// All-practices table columns — each header is click-to-sort (default dir in COLS).
const COLS = [
  { key: "name", label: "Practice", dir: "asc" },
  { key: "ehr", label: "EHR", dir: "asc" },
  { key: "status", label: "Status", dir: "asc" },
  { key: "action", label: "Next action", dir: "desc" },
  { key: "dpa", label: "Days since DPA", dir: "desc" },
  { key: "amount", label: "Deal size", dir: "desc" },
  { key: "steps", label: "Steps", dir: "asc" },
];
// Days since DPA signed — prefer the pipeline field; fall back to the stage timeline.
const dpaDays = (d) => {
  if (d.days_since_dpa != null) return d.days_since_dpa;
  const e = (d.stage_timeline || []).find((s) => /dpa/i.test(s.stage));
  return e?.date ? daysSince(e.date) : null;
};
const stepFrac = (d) => (d._onb.total ? d._onb.done / d._onb.total : -1);
// Action-state shown in the table's Status column, ranked most-urgent → least.
function statusInfo(d) {
  if (d._blk.count > 0) return { label: "Blocked", cls: "blk", rank: 0 };
  if (d._stalled) return { label: "Action needed", cls: "act", rank: 1 };
  if (d._ready) return { label: "Ready to go live", cls: "ready", rank: 2 };
  if (d._allBooked) return { label: "All booked", cls: "booked", rank: 3 };
  if (!d._isLive) return { label: "On track", cls: "track", rank: 4 };
  return d.recalling ? { label: "Recalling", cls: "live", rank: 6 } : { label: "Live", cls: "live", rank: 5 };
}

// The single next-best action for a practice — drives the table's Next-action
// column (sortable by urgency). A priority cascade over the already-derived flags;
// `urgency` (base band + age-capped tiebreak) sorts most-urgent first. Bands:
// blocked > ready-to-go-live > onboarding stalled > activate (live, not recalling)
// > routine progress > awaiting booked recall > healthy (recalling).
const ACTIVATE_GRACE = 10; // days a practice can be live + not-recalling before it's "behind"
function nextAction(d) {
  const onb = d._onb || { done: 0, total: 0, next: null };
  const blk = d._blk || { count: 0, items: [] };
  const dis = d.days_in_stage ?? 0;
  const age = (n) => Math.min(n || 0, 90); // cap so age never jumps a band
  if (blk.count > 0) {
    const top = blk.items[0] || {};
    // a lab/pathology whitelisting block reads better as "Chase lab" than "Chase Third-party"
    const labish = top.waiting_on === "third_party" && /lab|whitelist|patholog/i.test(`${top.reason || ""} ${top.label || ""}`);
    const who = labish ? "lab" : (WAITING_LABEL[top.waiting_on] || "someone");
    const d0 = top.days ?? blk.oldestDays ?? 0;
    return { key: "unblock", tone: "blocked", label: `Chase ${who}`,
      detail: `${top.label || "blocked"}${top.reason ? ` — ${top.reason}` : ""}`, why: `blocked ${d0}d`, urgency: 1000 + age(d0) };
  }
  if (d._ready) return { key: "golive", tone: "ready", label: "Ready — mark live",
    detail: `all ${onb.total} set-up steps done`, why: `${dis}d in stage`, urgency: 900 + age(dis) };
  if (!d._isLive && d._stalled) return { key: "stalled", tone: "stalled",
    label: onb.next ? `Push: ${onb.next}` : "Re-engage — stalled", detail: `${onb.done}/${onb.total} steps · ${dis}d in stage`, why: `stalled ${dis}d`, urgency: 800 + age(dis) };
  // Activation (live, not recalling) only becomes "needs action today" after a short
  // grace period — a freshly-live practice isn't behind on recalls yet.
  if (d._isLive && !d.recalling && !d._recallBooked) return { key: "book-recall", tone: "activate",
    label: "Await Practice Recall", detail: "live but not recalling yet", why: `live ${dis}d`, urgency: (dis >= ACTIVATE_GRACE ? 720 : 480) + age(dis) };
  if (d._isLive && !d.recalling) return { key: "nudge-recall", tone: "activate",
    label: "Nudge first recall", detail: "recall booked — not recalling yet", why: `live ${dis}d`, urgency: (dis >= ACTIVATE_GRACE ? 700 : 470) + age(dis) };
  if (!d._isLive && d._allBooked) return { key: "await", tone: "good",
    label: "Awaiting booked recall", detail: `${onb.done}/${onb.total} steps`, why: "on track", urgency: 300 };
  if (!d._isLive) return { key: "progress", tone: "progress",
    label: onb.next ? `Next: ${onb.next}` : "Continue onboarding", detail: `${onb.done}/${onb.total} steps · ${dis}d in stage`, why: `${dis}d in stage`, urgency: 400 + age(dis) };
  return { key: "healthy", tone: "good", label: "Recalling — on track", detail: null, why: "no action needed", urgency: 100 };
}

const HUB_NAV = [
  { id: "tracker", label: "Tracker" },
  { id: "all", label: "All practices" },
  { id: "calendar", label: "Calendar" },
];

export default function OnboardingHub({ data, visits = {}, auth = null }) {
  const { liveOnb, toggleStep, setStepState, editor, notes, addNote, editNote, deleteNote, blocks, setStepBlock, hidden, hideActivity, live, markLive, dropped, markDropped, error, setError } = useOnboarding(auth);
  const [selected, setSelected] = useState(() => (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("practice") : null));
  const [monthOffset, setMonthOffset] = useState(0);
  const [confirmLive, setConfirmLive] = useState(null); // deal pending mark-live confirmation
  const [confirmDropped, setConfirmDropped] = useState(null); // deal pending dropped-out confirmation
  const [slot, setSlot] = useState(null);
  // Home-view filter/search/sort live HERE (not in HubHome) so they survive opening a
  // practice and coming back — HubHome unmounts while a practice detail is shown.
  const [tile, setTile] = useState("all");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("status");
  const [sortDir, setSortDir] = useState("asc");
  useEffect(() => { setSlot(document.getElementById("su-hubslot")); }, []);

  const todayStr = useMemo(() => localISO(new Date()), []);

  // The practice detail is a sub-page of the hub: opening one pushes a history
  // entry (with ?practice=ODS) so browser-back returns to the hub home, not the
  // Overview tab. popstate keeps `selected` in sync with that entry.
  const selectPractice = (ods) => {
    if (!ods) return;
    setSelected(ods);
    const u = new URL(window.location.href);
    u.searchParams.set("practice", ods);
    window.history.pushState({ hp: ods }, "", u.pathname + u.search + u.hash);
  };
  const backToHome = () => {
    if (window.history.state?.hp) { window.history.back(); return; }
    setSelected(null);
    const u = new URL(window.location.href);
    u.searchParams.delete("practice");
    window.history.replaceState({}, "", u.pathname + u.search + u.hash);
  };
  useEffect(() => {
    const onPop = () => setSelected(new URLSearchParams(window.location.search).get("practice") || null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // sidebar nav → scroll to a home section (or, from a sub-page, just return home)
  const goSection = (id) => {
    if (selected) { backToHome(); return; }
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // cohort enriched with status, progress, blocked info, recall booking, live + flags
  const cohort = useMemo(() => {
    return (data.deals || [])
      .filter(inCohort)
      .filter((d) => !dropped?.[d.ods]) // dropped-out practices leave the Hub immediately
      .map((d) => {
        const steps = d.onboarding?.length ? mergeOnboarding(d.onboarding, liveOnb?.[d.ods]) : [];
        const onb = summarizeOnboarding(steps);
        const blk = blockInfo(steps, blocks?.[d.ods]);
        const markedLive = live?.[d.ods] || null;
        const isLiveStage = d.stage === "live";
        const allDone = onb.total > 0 && onb.done === onb.total;
        const ready = allDone && !markedLive && !isLiveStage;
        const rec = recallFor(visits, d.ods);
        const recallBooked = !!futureRecalls(rec, todayStr).length
          || /book/i.test((steps.find((s) => s.key === "recall_session") || {}).value || "");
        // "all booked": the only outstanding (applicable, not-done) step is the
        // recall session AND it's booked — so nothing needs chasing right now
        // (the one edge case, a session falling through, isn't trackable). Will #34.
        const outstanding = steps.filter((s) => s.state !== "done" && s.state !== "na");
        const allBooked = outstanding.length > 0 && outstanding.every((s) => s.key === "recall_session") && recallBooked;
        const stallDays = data.stale_thresholds?.[d.stage] ?? STALL_DAYS; // stage-specific (dpa_signed/live = 21)
        const stalled = !ready && !markedLive && !isLiveStage && !allDone && !allBooked && (blk.count > 0 || (d.days_in_stage || 0) > stallDays);
        return {
          ...d, _status: statusOf(d), _steps: steps, _onb: onb, _blk: blk, _live: markedLive,
          _isLive: isLiveStage || !!markedLive, _ready: ready, _stalled: stalled, _allBooked: allBooked,
          _recall: rec, _recallBooked: !!futureRecalls(rec, todayStr).length, _outstanding: Math.max(0, onb.total - onb.done),
        };
      })
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [data, liveOnb, blocks, live, dropped, visits, todayStr]);

  const cohortOds = useMemo(() => new Set(cohort.map((d) => d.ods)), [cohort]);
  const sel = useMemo(() => cohort.find((d) => d.ods === selected) || null, [cohort, selected]);

  // top tracker — the tiles double as filter tabs (see TILES / TILE_PRED).
  // Mutually exclusive + exhaustive so the four state tiles sum to All. Blocked
  // takes precedence: a blocked practice (even a live one) counts only as Blocked,
  // so In progress / Live / Recalling are the *unblocked* lifecycle states.
  const kpis = useMemo(() => ({
    total: cohort.length,
    in_progress: cohort.filter((d) => !d._isLive && d._blk.count === 0).length,
    blocked: cohort.filter((d) => d._blk.count > 0).length,
    live_nr: cohort.filter((d) => d._isLive && !d.recalling && d._blk.count === 0).length,
    recalling: cohort.filter((d) => d._isLive && d.recalling && d._blk.count === 0).length,
  }), [cohort]);

  // calendar events: onboarding calls (blue, HubSpot meetings) + recall/impl
  // sessions (peach, Notion visits — both cohort practices and live recallers)
  const events = useMemo(() => {
    const out = [];
    const seen = new Set();
    const add = (e) => { const k = `${e.ods}|${dayKey(e.date)}|${e.type}`; if (!seen.has(k)) { seen.add(k); out.push(e); } };
    for (const d of cohort) {
      const ns = d.next_step;
      // recall/impl comes from Notion (futureRecalls below). A HubSpot meeting is
      // an onboarding call (Calendly Planner-Onboarding) or a plain Meeting. Skip a
      // Notion-visit next_step — futureRecalls emits it with its real Times.
      if (ns?.date && !(ns.type === "Visit" || ns.source === "Notion")) {
        const kind = ns.meeting_kind || "meeting";
        add({
          date: ns.date, time: clockTime(ns.date), title: d.name, ods: d.ods,
          label: kind === "onboarding" ? "Onboarding call" : "Meeting",
          type: kind,
        });
      }
      for (const v of futureRecalls(d._recall, todayStr)) add({ date: v.date, time: v.times || "", title: d.name, label: "Recall / impl.", type: "recall", ods: d.ods });
    }
    for (const p of (data.recalling_practices || [])) {
      if (p.next_step?.date) add({ date: p.next_step.date, time: clockTime(p.next_step.date), title: p.name, label: "Recall session", type: "recall", ods: p.ods });
      for (const v of (p.visits || [])) {
        if (v.date && v.date >= todayStr && ["scheduled", "proposed", "to_contact"].includes(v.status))
          add({ date: v.date, time: v.times || "", title: p.name, label: "Recall session", type: "recall", ods: p.ods });
      }
    }
    // A recall session OVERRIDES a plain meeting for the same practice + day:
    // a HubSpot meeting that's really the recall lunch (also logged in Notion)
    // shouldn't double up as a grey "Meeting" alongside the peach recall.
    const recallDays = new Set(out.filter((e) => e.type === "recall").map((e) => `${e.ods}|${dayKey(e.date)}`));
    return out.filter((e) => !(e.type === "meeting" && recallDays.has(`${e.ods}|${dayKey(e.date)}`)));
  }, [cohort, data, todayStr]);

  const openIfCohort = (ods) => { if (cohortOds.has(ods)) selectPractice(ods); };

  const sidebar = (
    <>
      <div className="su-onpage oh-hubnav">
        <div className="su-onpage-title">On this page</div>
        {HUB_NAV.map((s) => (
          <a key={s.id} href={`#${s.id}`} onClick={(e) => { e.preventDefault(); goSection(s.id); }}>{s.label}</a>
        ))}
      </div>
      <div className="su-spacer" />
    </>
  );

  return (
    <>
      {slot && createPortal(sidebar, slot)}
      <div className="oh-main">
        {error && (
          <div className="oh-error" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
          </div>
        )}
        <div className="oh-topbar">
          {sel ? (
            <>
              <div className="oh-topbar-detail">
                <h2>{sel.name}</h2>
                <div className="oh-detail-meta">
                  <span className={"oh-pill " + sel._status.key}>{sel._status.label}</span>
                  {sel.tier && <span className="oh-tag">{sel.tier}</span>}
                  {sel._blk.count > 0 && <span className="oh-tag blk">⚑ {sel._blk.count} blocked</span>}
                  {sel._live && <span className="oh-tag livemark">✓ marked live{sel._live.hs_synced ? " · HubSpot" : ""}</span>}
                  {sel._onb.next ? <span className="oh-tag">Next: {sel._onb.next}</span> : sel._onb.total ? <span className="oh-tag">All steps done</span> : null}
                </div>
              </div>
              <div className="oh-topbar-acts">
                {hubspotDealUrl(sel.deal_id) && <a className="oh-hslink" href={hubspotDealUrl(sel.deal_id)} target="_blank" rel="noreferrer"><img className="oh-hs-ico" src="/assets/hubspot-logo.png" alt="" />HubSpot deal ↗</a>}
                {sel._ready && <button className="oh-mark-live sm" onClick={() => setConfirmLive(sel)}>Mark live</button>}
                <button className="oh-drop sm" onClick={() => setConfirmDropped(sel)}>Dropped out</button>
                <button className="oh-back" onClick={backToHome}>← All practices</button>
              </div>
            </>
          ) : (
            <>
              <div>
                <h2>Onboarding Hub — who needs what, and why we're stuck</h2>
                <span className="sub">{kpis.total} practices · click a step to update it · changes timestamped{editor ? ` as ${editor}` : ""}.</span>
              </div>
              {auth?.email && (
                <span className="oh-back" style={{ cursor: "default" }}>Editing as <b>{firstNameFromEmail(auth.email)}</b></span>
              )}
            </>
          )}
        </div>

        <div className="oh-scroll">
          {sel ? (
            <HubDetail key={sel.ods} deal={sel} liveOnb={liveOnb} toggleStep={toggleStep} setStepState={setStepState}
              notes={notes[sel.ods] || []} addNote={addNote} editNote={editNote} deleteNote={deleteNote}
              blocksForOds={blocks?.[sel.ods] || {}} setStepBlock={setStepBlock}
              hiddenForOds={hidden?.[sel.ods] || []} hideActivity={hideActivity}
              recall={recallStatus(sel._recall, todayStr)} onMarkLive={() => setConfirmLive(sel)} />
          ) : (
            <HubHome kpis={kpis} cohort={cohort} events={events}
              monthOffset={monthOffset} setMonthOffset={setMonthOffset}
              tile={tile} setTile={setTile} search={search} setSearch={setSearch}
              sortKey={sortKey} setSortKey={setSortKey} sortDir={sortDir} setSortDir={setSortDir}
              onOpen={selectPractice} openIfCohort={openIfCohort} onMarkLive={setConfirmLive} />
          )}
        </div>
      </div>

      {confirmLive && (
        <ConfirmLive deal={confirmLive} onCancel={() => setConfirmLive(null)}
          onConfirm={() => { markLive(confirmLive); setConfirmLive(null); }} />
      )}
      {confirmDropped && (
        <ConfirmDropped deal={confirmDropped} onCancel={() => setConfirmDropped(null)}
          onConfirm={() => { markDropped(confirmDropped); setConfirmDropped(null); backToHome(); }} />
      )}
    </>
  );
}

/* ---------------- mark-live confirmation ---------------- */

function ConfirmLive({ deal, onCancel, onConfirm }) {
  return (
    <div className="oh-modal-back" onClick={onCancel}>
      <div className="oh-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Mark {deal.name} as live?</h3>
        <p>This records the practice as live in the Hub <b>and moves its deal in HubSpot to “Full Functionality Live”.</b> Only do this once the practice is genuinely live.</p>
        <div className="oh-modal-acts">
          <button className="oh-btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="oh-btn-live" onClick={onConfirm}>Yes, mark live</button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDropped({ deal, onCancel, onConfirm }) {
  return (
    <div className="oh-modal-back" onClick={onCancel}>
      <div className="oh-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Mark {deal.name} as dropped out?</h3>
        <p>This removes the practice from the Hub <b>and moves its deal in HubSpot to “Dropped Out”.</b> Only do this if the practice has genuinely dropped out of onboarding.</p>
        <div className="oh-modal-acts">
          <button className="oh-btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="oh-btn-drop" onClick={onConfirm}>Yes, mark dropped out</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- home (no practice selected) ---------------- */

// Comparator for the all-practices table: a base ascending comparator per
// column, multiplied by the chosen direction, with an alphabetical tiebreak.
function tableCmp(sortKey, sortDir) {
  const byName = (a, b) => (a.name || "").localeCompare(b.name || "");
  const base = {
    name: byName,
    ehr: (a, b) => (ehrShort(a.ehr) || "~").localeCompare(ehrShort(b.ehr) || "~") || byName(a, b),
    status: (a, b) => statusInfo(a).rank - statusInfo(b).rank || byName(a, b),
    action: (a, b) => (nextAction(a).urgency - nextAction(b).urgency) || byName(a, b),
    dpa: (a, b) => ((dpaDays(a) ?? -1) - (dpaDays(b) ?? -1)) || byName(a, b),
    amount: (a, b) => ((a.amount ?? -1) - (b.amount ?? -1)) || byName(a, b),
    steps: (a, b) => (stepFrac(a) - stepFrac(b)) || byName(a, b),
  }[sortKey] || (() => 0);
  const dir = sortDir === "desc" ? -1 : 1;
  return (a, b) => dir * base(a, b);
}

// The square tracker tiles double as the page's filter tabs: click one to scope
// the single "All practices" table to that group and see what's outstanding.
const TILES = [
  { k: "all", l: "All practices", n: "total", tip: "Every practice from DPA-signed onward." },
  { k: "in_progress", l: "In progress", n: "in_progress", info: true, tip: "Being set up — onboarding, with no active blocker." },
  { k: "blocked", l: "Blocked", n: "blocked", bad: true, tip: "Has an active blocker (e.g. waiting on labs). Counted here even if otherwise live, so the tiles add up to All." },
  { k: "live_nr", l: "Live", n: "live_nr", good: true, tip: "Live on Planner but not yet recalling — fewer than 5 recalls this financial year." },
  { k: "recalling", l: "Recalling", n: "recalling", good: true, tip: "Live and actively recalling — 5+ recalls this financial year." },
];
// Mutually exclusive + exhaustive (sum to All). Blocked takes precedence so the
// live/onboarding states are the *unblocked* ones — no practice double-counts.
const TILE_PRED = {
  all: () => true,
  in_progress: (d) => !d._isLive && d._blk.count === 0,
  blocked: (d) => d._blk.count > 0,
  live_nr: (d) => d._isLive && !d.recalling && d._blk.count === 0,
  recalling: (d) => d._isLive && d.recalling && d._blk.count === 0,
};

function HubHome({ kpis, cohort, events, monthOffset, setMonthOffset, onOpen, openIfCohort, onMarkLive, tile, setTile, search, setSearch, sortKey, setSortKey, sortDir, setSortDir }) {
  const onSort = (col) => {
    if (col.key === sortKey) { setSortDir((d) => (d === "asc" ? "desc" : "asc")); return; }
    setSortKey(col.key);
    setSortDir(col.dir || "asc");
  };

  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return cohort.filter(TILE_PRED[tile]).filter((d) => !s
      || (d.name || "").toLowerCase().includes(s) || (d.ods || "").toLowerCase().includes(s)
      || (d.pcn_name || "").toLowerCase().includes(s) || (d.owner || "").toLowerCase().includes(s)
    ).slice().sort(tableCmp(sortKey, sortDir));
  }, [cohort, tile, search, sortKey, sortDir]);
  const activeLabel = TILES.find((t) => t.k === tile)?.l || "All practices";

  return (
    <>
      <div className="oh-tiles" id="tracker">
        {TILES.map((t) => (
          <button key={t.k} title={t.tip}
            className={"oh-tile click" + (t.good ? " good" : "") + (t.bad ? " bad" : "") + (t.warn ? " warn" : "") + (t.info ? " info" : "") + (tile === t.k ? " sel" : "")}
            onClick={() => setTile(t.k)}>
            <div className="num">{kpis[t.n]}</div>
            <div className="lbl">{t.l}{t.tip ? <span className="oh-tile-i" aria-hidden title={t.tip}>ⓘ</span> : null}</div>
          </button>
        ))}
      </div>

      <div className="oh-block" id="all">
        <div className="oh-block-hdr">
          {activeLabel}<span className="n">{list.length}</span>
          <div className="oh-all-tools">
            <input className="oh-all-search" placeholder="Search practice, PCN, owner…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="oh-table-wrap">
          <table className="oh-table">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.key} className={"oh-th " + c.key + (sortKey === c.key ? " sorted" : "")} onClick={() => onSort(c)}
                      title={`Sort by ${c.label.toLowerCase()}`}>
                    {c.label}<span className="oh-sort-ind">{sortKey === c.key ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>
                  </th>
                ))}
                <th className="oh-th act" aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {!list.length && <tr><td className="oh-empty" colSpan={COLS.length + 1}>No practices match.</td></tr>}
              {list.map((d) => <PracticeRow key={d.ods} d={d} onOpen={onOpen} onMarkLive={onMarkLive} />)}
            </tbody>
          </table>
        </div>
      </div>

      <div className="oh-block" id="calendar">
        <div className="oh-block-hdr">Sessions calendar</div>
        <HubCalendar events={events} monthOffset={monthOffset} setMonthOffset={setMonthOffset} onOpen={openIfCohort} />
      </div>
    </>
  );
}

// One table row per practice. Columns: practice · status · next step · days
// since DPA · steps (X/total) — plus an inline Mark-live for finished practices.
// Clicking the row opens the practice; the actions cell stops propagation.
function PracticeRow({ d, onOpen, onMarkLive }) {
  const si = statusInfo(d);
  const na = nextAction(d);
  const dpa = dpaDays(d);
  const pct = d._onb.total ? Math.round((d._onb.done / d._onb.total) * 100) : 0;
  return (
    <tr className="oh-tr" onClick={() => onOpen(d.ods)}>
      <td className="oh-td name"><span className={"dot " + d._status.key} /><span className="nm">{d.name}</span></td>
      <td className="oh-td ehr">{ehrShort(d.ehr) ? <span className={"oh-ehr-tag " + ehrShort(d.ehr).toLowerCase()}>{ehrShort(d.ehr)}</span> : <span className="oh-ehr-tag none">—</span>}</td>
      <td className="oh-td status"><span className={"oh-stat " + si.cls}>{si.label}</span></td>
      <td className="oh-td action"><span className={"oh-na " + na.tone} title={na.detail || undefined}>{na.label}</span></td>
      <td className="oh-td dpa">{dpa != null ? `${dpa}d` : "—"}</td>
      <td className="oh-td amount">{d.amount ? `£${Math.round(d.amount).toLocaleString()}` : "—"}</td>
      <td className="oh-td steps">
        {d._onb.total ? (
          <><span className="oh-steps-bar"><span className="fill" style={{ width: `${pct}%` }} /></span><span className="oh-steps-n">{d._onb.done}/{d._onb.total}</span></>
        ) : <span className="oh-steps-n empty">—</span>}
      </td>
      <td className="oh-td act" onClick={(e) => e.stopPropagation()}>
        {d._ready && <button className="oh-mark-live sm" onClick={() => onMarkLive(d)}>Mark live</button>}
      </td>
    </tr>
  );
}

/* ---------------- month calendar ---------------- */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_CELL_EVENTS = 3;

function HubCalendar({ events, monthOffset, setMonthOffset, onOpen }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const view = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const year = view.getFullYear(), month = view.getMonth();
  const startDow = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0
  const lastDay = new Date(year, month + 1, 0).getDate();
  const rows = Math.ceil((startDow + lastDay) / 7);
  const gridStart = new Date(year, month, 1 - startDow);
  const cells = Array.from({ length: rows * 7 }, (_, i) => { const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); return d; });
  const todayKey = localISO(today);
  const byDay = {};
  for (const e of events) (byDay[dayKey(e.date)] ||= []).push(e);
  const monthLabel = view.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  return (
    <div className="oh-cal month">
      <div className="oh-cal-head">
        <button className="oh-cal-nav" onClick={() => setMonthOffset(monthOffset - 1)} aria-label="Previous month">‹</button>
        <span className="oh-cal-range">{monthLabel}</span>
        <button className="oh-cal-nav" onClick={() => setMonthOffset(monthOffset + 1)} aria-label="Next month">›</button>
        {monthOffset !== 0 && <button className="oh-cal-today" onClick={() => setMonthOffset(0)}>this month</button>}
        <span className="oh-cal-legend">
          <span><i className="lg onboarding" />Onboarding call</span>
          <span><i className="lg meeting" />Meeting</span>
          <span><i className="lg recall" />Recall / impl.</span>
        </span>
      </div>
      <div className="oh-cal-wd">{WEEKDAYS.map((w) => <span key={w}>{w}</span>)}</div>
      <div className="oh-cal-mgrid">
        {cells.map((d, i) => {
          const k = localISO(d);
          const inMonth = d.getMonth() === month;
          const evs = (byDay[k] || []).slice().sort((a, b) => evTime(a.date) - evTime(b.date));
          const shown = evs.slice(0, MAX_CELL_EVENTS);
          return (
            <div key={i} className={"oh-mcell" + (inMonth ? "" : " out") + (k === todayKey ? " today" : "")}>
              <div className="oh-mcell-d">{d.getDate()}</div>
              <div className="oh-mcell-evs">
                {shown.map((e, j) => (
                  <button key={j} className={"oh-mev " + e.type} onClick={() => onOpen(e.ods)} title={`${e.label}: ${e.title}${e.time ? " · " + e.time : ""}`}>
                    {e.time && <span className="t">{e.time}</span>}
                    <span className="n">{e.title}</span>
                  </button>
                ))}
                {evs.length > MAX_CELL_EVENTS && <span className="oh-mev-more">+{evs.length - MAX_CELL_EVENTS} more</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- detail (a practice selected) ---------------- */

function CopyBtn({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button className="oh-copy" onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); })}>
      {done ? "copied" : "copy"}
    </button>
  );
}

// The explicit "what next" choices shown when you click a step card's body.
const STEP_OPTIONS = [
  { state: "done",    label: "Mark done",        hint: "set-up step complete" },
  { state: "pending", label: "Mark in progress", hint: "started, not finished" },
  { state: "todo",    label: "Mark to do",       hint: "not started yet" },
];

// Steps with meaningful sub-statuses get a richer menu (mirroring the onboarding
// sheet's own dropdown options). Each maps a label to a todo/pending/done/na state;
// the label is stored + displayed so two "pending" sub-statuses stay distinct.
const SUB_HINT = { todo: "not started", pending: "in progress", done: "complete", na: "not applicable" };
const STEP_SUBSTATES = {
  onboarding_call: [
    { tag: "Invited", state: "pending" },
    { tag: "Booked",  state: "pending" },
    { tag: "Held",    state: "done" },
  ],
  herohealth: [
    { tag: "Sent",    state: "pending" },
    { tag: "Signed",  state: "pending" },
    { tag: "Set up",  state: "done" },
    { tag: "NA (S1)", state: "na" },
  ],
};

// Popup menu of explicit step actions — so clicking a card is a deliberate choice,
// not a blind one-click cycle. Steps with sub-statuses (`sub`) show those instead of
// the generic done/in-progress/to-do; `curTag` (the live note or sheet value) marks
// which one is current. The express tick handles the quick path.
function StepMenu({ state, curTag, sub, blocked, onChoose, onFlag, onClose }) {
  const cur = (curTag || "").toLowerCase();
  return (
    <>
      <div className="oh-menu-backdrop" onClick={onClose} />
      <div className="oh-stepmenu" onClick={(e) => e.stopPropagation()}>
        {sub ? (
          <>
            {sub.map((o) => {
              const isCur = cur === o.tag.toLowerCase();
              return (
                <button key={o.tag} className={"oh-sm-item" + (isCur ? " current" : "")} onClick={() => onChoose(o)}>
                  <span className={"oh-sm-mark " + o.state}>{MARK[o.state]}</span>
                  <span className="oh-sm-text"><b>{o.tag}</b><span>{SUB_HINT[o.state]}</span></span>
                  {isCur && <span className="oh-sm-now">now</span>}
                </button>
              );
            })}
            <button className={"oh-sm-item" + (state === "todo" ? " current" : "")} onClick={() => onChoose({ state: "todo", tag: null })}>
              <span className="oh-sm-mark todo">{MARK.todo}</span>
              <span className="oh-sm-text"><b>Mark to do</b><span>not started yet</span></span>
            </button>
          </>
        ) : (
          STEP_OPTIONS.map((o) => (
            <button key={o.state} className={"oh-sm-item" + (state === o.state ? " current" : "")} onClick={() => onChoose(o)}>
              <span className={"oh-sm-mark " + o.state}>{MARK[o.state]}</span>
              <span className="oh-sm-text"><b>{o.label}</b><span>{o.hint}</span></span>
              {state === o.state && <span className="oh-sm-now">now</span>}
            </button>
          ))
        )}
        <div className="oh-sm-div" />
        <button className={"oh-sm-item" + (blocked ? " current" : "")} onClick={onFlag}>
          <span className="oh-sm-mark flag">⚑</span>
          <span className="oh-sm-text"><b>{blocked ? "Edit block" : "Flag as blocked"}</b><span>say who we're waiting on</span></span>
        </button>
      </div>
    </>
  );
}

function StepCard({ deal, s, blk, toggleStep, setStepState, setStepBlock }) {
  const [editing, setEditing] = useState(false);   // block form open
  const [menu, setMenu] = useState(false);         // options menu open
  const sub = STEP_SUBSTATES[s.key] || null;
  const curTag = s.note || (s.value && s.state !== "todo" ? s.value : null); // current sub-status label
  const subtitle = s.changed_at ? `${s.note || s.state} · ${fmtDate(s.changed_at)}` : (s.value && s.state !== "todo" ? s.value : s.state);
  return (
    <div className={"oh-step " + s.state + (blk ? " blocked" : "")}>
      {/* express tick: one click advances to do → pending → done */}
      <button className="oh-step-tick" title={`Quick: mark ${STATE_CYCLE[s.state] || "done"}`}
        onClick={(e) => { e.stopPropagation(); setMenu(false); toggleStep(deal, s); }}>
        <span className="ico">{MARK[s.state]}</span>
      </button>
      {/* body: opens a menu of explicit choices instead of a blind cycle */}
      <button className="oh-step-body" onClick={() => { setEditing(false); setMenu((v) => !v); }}
        title={s.changed_at ? `${s.state} · ${s.changed_by || ""} · ${fmtDate(s.changed_at)}` : (s.value || s.state)}>
        <span className="mid">
          <span className="nm">{s.step}</span>
          <span className="st">{subtitle}</span>
        </span>
        <span className="oh-step-caret" aria-hidden>⌄</span>
      </button>
      <button className={"oh-flag" + (blk ? " on" : "")} title={blk ? "blocked — edit" : "flag as blocked"}
        onClick={() => { setMenu(false); setEditing((v) => !v); }}>⚑</button>
      {blk && (
        <div className="oh-step-blk">⚑ waiting on {WAITING_LABEL[blk.waiting_on]}{blk.days != null ? ` · ${blk.days}d` : ""}{blk.reason ? ` — ${blk.reason}` : ""}</div>
      )}
      {menu && (
        <StepMenu state={s.state} curTag={curTag} sub={sub} blocked={!!blk}
          onChoose={(o) => { setStepState(deal, s, o.state, o.tag ?? null); setMenu(false); }}
          onFlag={() => { setMenu(false); setEditing(true); }}
          onClose={() => setMenu(false)} />
      )}
      {editing && <BlockForm blk={blk} onClose={() => setEditing(false)} onSet={(opts) => { setStepBlock(deal, s, opts); setEditing(false); }} />}
    </div>
  );
}

function BlockForm({ blk, onSet, onClose }) {
  const [waiting, setWaiting] = useState(blk?.waiting_on || "third_party");
  const [reason, setReason] = useState(blk?.reason || "");
  return (
    <div className="oh-blockform" onClick={(e) => e.stopPropagation()}>
      <div className="oh-bf-row">
        {WAITING_ON.map((w) => (
          <button key={w} className={"oh-bf-chip" + (waiting === w ? " active" : "")} onClick={() => setWaiting(w)}>{WAITING_LABEL[w]}</button>
        ))}
      </div>
      <input className="oh-bf-reason" placeholder="Why is it blocked? (e.g. labs whitelisting)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="oh-bf-acts">
        {blk && <button className="oh-bf-unblock" onClick={() => onSet({ action: "unblock" })}>Unblock</button>}
        <button className="oh-bf-cancel" onClick={onClose}>Cancel</button>
        <button className="oh-bf-set" onClick={() => onSet({ action: "block", waiting_on: waiting, reason: reason.trim() || null })}>{blk ? "Update" : "Mark blocked"}</button>
      </div>
    </div>
  );
}

function NoteItem({ deal, n, editNote, deleteNote }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(n.body);
  const editable = !n.pending && !String(n.id).startsWith("tmp");
  return (
    <div className={"oh-note" + (n.pending ? " pending" : "")}>
      {editing ? (
        <div className="oh-note-edit">
          <textarea value={val} onChange={(e) => setVal(e.target.value)} rows={2} />
          <div className="oh-note-edit-acts">
            <button className="oh-note-cancel" onClick={() => { setVal(n.body); setEditing(false); }}>Cancel</button>
            <button className="oh-note-save" disabled={!val.trim()} onClick={() => { editNote(deal, n.id, val); setEditing(false); }}>Save</button>
          </div>
        </div>
      ) : (
        <>
          <div className="oh-note-body">{n.body}</div>
          <div className="oh-note-meta">
            <span>{n.author || "—"} · {fmtDateTime(n.created_at)}{n.updated_at ? " · edited" : ""}{n.pending ? " · saving…" : n.hs_synced ? " · synced to HubSpot" : ""}</span>
            {editable && (
              <span className="oh-note-acts">
                <button onClick={() => { setVal(n.body); setEditing(true); }}>edit</button>
                <button onClick={() => { if (window.confirm("Delete this note? This also removes it from HubSpot if it was synced.")) deleteNote(deal, n.id); }}>delete</button>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Canonical ISO for an activity_key timestamp, so the key a user hides byte-matches
// the one re-derived from Neon on reload (independent of driver serialization).
const akeyTs = (t) => { const d = new Date(t); return isNaN(d.getTime()) ? String(t) : d.toISOString(); };

function HubDetail({ deal, liveOnb, toggleStep, setStepState, notes, addNote, editNote, deleteNote, blocksForOds, setStepBlock, hiddenForOds = [], hideActivity, recall, onMarkLive }) {
  const [draft, setDraft] = useState("");
  const steps = deal.onboarding?.length ? mergeOnboarding(deal.onboarding, liveOnb?.[deal.ods]) : [];
  const { done, total, next } = summarizeOnboarding(steps);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const _rank = { done: 0, pending: 1, todo: 2 };
  // Done steps order by when they were done; outstanding steps keep checklist
  // order (not last-touched), so the finale — Recall Session — stays at the end.
  const _order = new Map(steps.map((s, i) => [s.key, i]));
  const stepTimeline = [...steps].sort((a, b) =>
    ((_rank[a.state] ?? 3) - (_rank[b.state] ?? 3)) ||
    (a.state === "done" && b.state === "done"
      ? ((a.changed_at ? Date.parse(a.changed_at) : Infinity) - (b.changed_at ? Date.parse(b.changed_at) : Infinity))
      : (_order.get(a.key) - _order.get(b.key)))
  );
  const facts = [
    { l: "ODS code", v: deal.ods, copy: deal.ods },
    { l: "PCN", v: deal.pcn_name },
    { l: "ICB", v: deal.icb },
    { l: "Owner", v: deal.owner },
    { l: "List size", v: deal.patients ? deal.patients.toLocaleString() : null },
    { l: "Deal size", v: deal.amount ? `£${Math.round(deal.amount).toLocaleString()}` : null },
    { l: "EHR", v: deal.ehr },
    { l: "Stage", v: deal.stage_label },
    { l: "In stage", v: deal.days_in_stage != null ? `${deal.days_in_stage}d` : null },
  ];
  const lastContact = deal.last_contact
    ? `${fmtDate(deal.last_contact)}${deal.days_since_contact != null ? ` · ${deal.days_since_contact}d ago` : ""}`
    : "No logged contact";
  const chasedBy = deal.owner ? `${deal.owner}${deal.owner_email ? ` · ${deal.owner_email}` : ""}` : null;
  const emails = deal.last_emails?.length
    ? deal.last_emails
    : (deal.last_email ? [{ subject: deal.last_email.subject, direction: deal.last_email.direction, by: null, date: null, days_ago: deal.days_since_email }] : []);
  // sessions: onboarding calls (HubSpot, past+future) + recall/impl (Notion visits)
  const todayStr = localISO(new Date());
  const onbSessions = (deal.onboarding_sessions || []).slice().sort();
  // When the onboarding call actually took place: the most recent HELD HubSpot
  // session (past dates only), not the moment someone ticked the step in-app.
  const heldCall = onbSessions.filter((iso) => dayKey(iso) < todayStr).pop() || null;
  const _rseen = new Set();
  const recallSessions = recallOccurrences(deal._recall)
    .filter((x) => { const k = `${x.date}|${x.times || ""}`; if (_rseen.has(k)) return false; _rseen.add(k); return true; })
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const otherMeetings = (deal.other_meetings || []).slice().sort();
  // In-app action log (distinct from the read-only Google-Sheet note): step toggles,
  // blocks, and mark-live — each timestamped with who did it. Built from live Neon
  // state so it appears the moment an action is taken.
  const _stepLabel = {};
  steps.forEach((s) => { _stepLabel[s.key] = s.step; });
  // Each action row carries a stable `akey` (so the user can hide it to declutter
  // the log — see hideActivity. Hiding is log-only; it never changes step/block state).
  const activity = [];
  for (const [key, v] of Object.entries(liveOnb?.[deal.ods] || {})) {
    if (!v || !v.changed_at || v.changed_by === "sheet-seed") continue;
    const st = v.state === "done" ? "done" : v.state === "pending" ? "in progress" : v.state === "na" ? "n/a" : "to do";
    activity.push({ akey: `s:${key}:${akeyTs(v.changed_at)}`, at: v.changed_at, who: v.changed_by, text: `${_stepLabel[key] || cap(key)} → ${st}` });
  }
  for (const [key, b] of Object.entries(blocksForOds || {})) {
    if (b?.blocked_at) activity.push({ akey: `b:${key}:${akeyTs(b.blocked_at)}`, at: b.blocked_at, who: b.blocked_by, text: `${_stepLabel[key] || cap(key)} flagged blocked · waiting on ${WAITING_LABEL[b.waiting_on] || b.waiting_on}${b.reason ? ` — ${b.reason}` : ""}` });
  }
  if (deal._live?.marked_at) activity.push({ akey: `l:${akeyTs(deal._live.marked_at)}`, at: deal._live.marked_at, who: deal._live.marked_by, text: "Marked live" });
  // Unified feed: typed notes + timestamped actions, newest first. Notes are
  // pushed to HubSpot by addNote and shown here; the sheet note renders separately.
  // Action rows the user hid (hiddenForOds) are dropped from the log.
  const hiddenSet = new Set(hiddenForOds);
  const feed = [
    ...activity.filter((a) => !hiddenSet.has(a.akey)).map((a) => ({ ...a, kind: "action" })),
    ...(notes || []).map((n) => ({ at: n.created_at, kind: "note", note: n })),
  ].sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  return (
    <>
      <div className="oh-facts">
        {facts.map((f) => (
          <div key={f.l} className="oh-fact">
            <div className="l">{f.l}</div>
            <div className={"v" + (f.v ? "" : " empty")}>{f.v || "—"}{f.copy && f.v ? <CopyBtn text={f.copy} /> : null}</div>
          </div>
        ))}
      </div>

      {(deal.stage_timeline?.length > 0 || steps.length > 0) && (
        <div className="oh-tlblock">
          <div className="oh-tlblock-head">
            <span className="oh-tlblock-title">Onboarding progress</span>
            <span className="oh-tlblock-pct">{total ? `${done}/${total} · ${pct}%` : "no checklist"}{next ? <> · <span className="next">next: {next}</span></> : null}</span>
          </div>
          {deal.stage_timeline?.length > 0 && (
            <>
              <div className="oh-htl-l">Where they're at</div>
              <ol className="oh-htl">
                {deal.stage_timeline.map((s, i) => (
                  <li key={i} className={s.current ? "current" : ""}>
                    <span className="d" />
                    <span className="s">{s.stage}{s.current && <span className="oh-here">now</span>}</span>
                    <span className="dt">{fmtDate(s.date)}
                      {s.gap_days != null && <span className="oh-gap">+{s.gap_days}d</span>}
                      {s.current && deal.days_in_stage != null && <span className="oh-gap now">{deal.days_in_stage}d</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
          {steps.length > 0 && (
            <>
              <div className="oh-htl-l">Steps — when done</div>
              <ol className="oh-htl oh-htl-steps">
                {stepTimeline.map((s) => {
                  const blk = blocksForOds?.[s.key];
                  // Onboarding Call reads the date the call was HELD (heldCall),
                  // falling back to the in-app done timestamp, + days elapsed.
                  const callAt = s.key === "onboarding_call" && s.state === "done" ? (heldCall || s.changed_at) : null;
                  return (
                    <li key={s.key} className={"st-" + s.state + (blk ? " blocked" : "")}
                        title={blk ? `Blocked — waiting on ${WAITING_LABEL[blk.waiting_on] || blk.waiting_on}${blk.reason ? ` · ${blk.reason}` : ""}` : undefined}>
                      <span className="d" />
                      <span className="s">{s.step}</span>
                      <span className="dt">{blk
                        ? <span className="oh-blk-txt">⚑ blocked · {WAITING_LABEL[blk.waiting_on] || blk.waiting_on}</span>
                        : callAt
                          ? <>{fmtDate(callAt)}<span className="oh-gap">{daysSince(callAt)}d ago</span></>
                          : (s.changed_at ? fmtDate(s.changed_at) : (s.state === "done" ? "done" : s.state === "pending" ? "in progress" : s.state === "na" ? "n/a" : "to do"))}</span>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </div>
      )}

      <div className="oh-sessions oh-sessions-3">
        <div className="oh-session-col">
          <div className="oh-session-l">Onboarding sessions{onbSessions.length > 1 ? ` · ${onbSessions.length}` : ""}</div>
          {onbSessions.length ? (
            <div className="oh-session-chips">
              {onbSessions.map((iso, i) => {
                const past = dayKey(iso) < todayStr;
                return <span key={i} className={"oh-sess " + (past ? "past" : "future")}>{fmtDate(iso)}{fmtTime(iso) ? ` · ${fmtTime(iso)}` : ""} · {past ? "held" : (untilLabel(iso) || "upcoming")}</span>;
              })}
            </div>
          ) : <span className="oh-session-none">No onboarding session recorded</span>}
        </div>
        <div className="oh-session-col">
          <div className="oh-session-l">Recall / implementation</div>
          {recallSessions.length ? (
            <div className="oh-session-chips">
              {recallSessions.map((v, i) => {
                const st = v.status === "happened" ? "held" : v.status === "scheduled" ? "booked" : cap(v.status);
                const u = v.status !== "happened" ? untilLabel(v.date, v.times) : null;
                return <span key={i} className={"oh-sess " + (v.status === "happened" ? "past" : "future")}>{fmtDate(v.date)}{v.times ? ` · ${v.times}` : ""} · {st}{u ? ` · ${u}` : ""}</span>;
              })}
            </div>
          ) : <span className="oh-session-none">No recall/implementation session yet</span>}
        </div>
        <div className="oh-session-col">
          <div className="oh-session-l">Other meetings{otherMeetings.length > 1 ? ` · ${otherMeetings.length}` : ""}</div>
          {otherMeetings.length ? (
            <div className="oh-session-chips">
              {otherMeetings.map((iso, i) => {
                const past = dayKey(iso) < todayStr;
                return <span key={i} className={"oh-sess " + (past ? "past" : "future")}>{fmtDate(iso)}{fmtTime(iso) ? ` · ${fmtTime(iso)}` : ""}{past ? "" : ` · ${untilLabel(iso) || "upcoming"}`}</span>;
              })}
            </div>
          ) : <span className="oh-session-none">No other meetings</span>}
        </div>
      </div>

      <h4 className="oh-sec-title">Set-up steps</h4>
      <p className="oh-hint">Tap the tick to advance a step (to&nbsp;do → pending → done), or click the step for options (mark&nbsp;done / in&nbsp;progress / to&nbsp;do / flag blocked). A blocked step can still be in progress.</p>
      {steps.length ? (
        <div className="oh-steps">
          {steps.map((s) => <StepCard key={s.key} deal={deal} s={s} blk={blocksForOds?.[s.key] ? { ...blocksForOds[s.key], days: daysSince(blocksForOds[s.key].blocked_at) } : null} toggleStep={toggleStep} setStepState={setStepState} setStepBlock={setStepBlock} />)}
        </div>
      ) : (
        <p className="oh-hint" style={{ fontStyle: "italic" }}>No onboarding checklist for this practice yet — it appears once the practice is on the tracker sheet.</p>
      )}

      <div className="oh-callout oh-lastchased">
        <div className="oh-lastchased-top">
          <div><div className="l">Last chased</div><div className="v">{lastContact}</div></div>
          {chasedBy && <div className="oh-lastchased-owner">owner: {chasedBy}</div>}
        </div>
        <div className="oh-chase-emails">
          <div className="oh-chase-emails-l">Email history <span>· HubSpot{emails.length ? ` · ${emails.length}` : ""}</span></div>
          {emails.length ? (
            <div className="oh-email-scroll">
              {emails.map((e, i) => (
                <div key={i} className={"oh-email" + (i === 0 ? " highlight" : "")}>
                  <div className="oh-email-top">
                    <span className={"oh-email-dir " + (e.direction || "email")}>{e.direction || "email"}</span>
                    <span className="oh-email-subj">{e.subject}</span>
                    <span className="oh-email-meta">{[e.by, e.days_ago != null ? `${e.days_ago}d ago` : (e.date ? fmtDate(e.date) : null)].filter(Boolean).join(" · ")}</span>
                  </div>
                  {e.body && <div className="oh-email-body">{e.body}</div>}
                </div>
              ))}
            </div>
          ) : <div className="oh-session-none">No emails synced yet — add the HubSpot <code>sales-email-read</code> scope to populate the email trail.</div>}
        </div>
      </div>

      <h4 className="oh-sec-title">Activity log</h4>
      <div className="oh-note-new oh-note-new-log">
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note — logged below with your name &amp; the time, and pushed to the HubSpot deal…" rows={2} />
        <button className="oh-note-add" disabled={!draft.trim()}
          onClick={() => { addNote(deal, draft); setDraft(""); }}>Add note</button>
      </div>
      <div className="oh-activity">
        <div className="oh-activity-hdr">Notes &amp; timestamped actions <b>·</b> read-only onboarding-sheet note</div>
        {feed.map((item) => item.kind === "note"
          ? <NoteItem key={"n" + item.note.id} deal={deal} n={item.note} editNote={editNote} deleteNote={deleteNote} />
          : (
            <div key={item.akey} className="oh-activity-row">
              <span className="oh-activity-dot" />
              <span className="oh-activity-txt">{item.text}</span>
              <span className="oh-activity-meta">{item.who || "—"} · {fmtDateTime(item.at)}</span>
              {hideActivity && <button className="oh-activity-del" title="Hide from the activity log (doesn't change the step or block)"
                onClick={() => hideActivity(deal, item.akey)}>×</button>}
            </div>
          ))}
        {deal.sheet_notes && (
          <div className="oh-activity-sheet">
            <div className="oh-activity-sheet-hdr">📋 From onboarding sheet · read-only (no timestamp)</div>
            <div className="oh-activity-sheet-body">{deal.sheet_notes}</div>
          </div>
        )}
        {!feed.length && !deal.sheet_notes && <div className="oh-activity-none">No activity yet — add a note above, or complete a step / flag a block to log a timestamped event.</div>}
      </div>
    </>
  );
}
