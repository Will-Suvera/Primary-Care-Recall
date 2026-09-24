// Shared onboarding state — the Neon-backed step toggle path, used by both the
// Overview tab (FunnelBoard, read-mostly) and the Onboarding Hub tab (the action
// surface). Extracted from FunnelBoard so there is a single write path and the
// two tabs reflect the same live state.
import { useEffect, useState } from "react";

// Onboarding-toggle API (Neon-backed). Dev: local Node server (/api/onboarding on :5175).
// Prod: same-origin /api/onboarding — a Cloudflare Pages Function (functions/api/[[path]].js).
// Override via VITE_ONB_API. (Also works on Netlify, which rewrites /api/onboarding/*
// to its function — see netlify.toml — so the path is correct on either host.)
export const ONB_BASE =
  (import.meta.env && import.meta.env.VITE_ONB_API) ||
  (import.meta.env && import.meta.env.PROD ? "/api/onboarding" : "http://localhost:5175/api/onboarding");

export const STATE_CYCLE = { todo: "pending", pending: "done", done: "todo" };

// "will@suvera.co.uk" -> "Will"; "will.gao@…" -> "Will". Used so the UI attributes
// changes to a person's first name (taken from the Google login) instead of asking
// them to type a name. Falls back to the cleaned local-part, then null.
export function firstNameFromEmail(email) {
  if (!email) return null;
  const local = String(email).split("@")[0] || "";
  const first = (local.split(/[._\-\s]+/)[0] || local).trim();
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : null;
}

// Merge live (Neon) onboarding state over the sheet-derived steps.
//
// A human in-app toggle is the source of truth and wins. A record that was only
// ever seeded from the Google Sheet ('sheet-seed') defers to the fresh sheet
// value baked into `steps` — funnel_board.json is rebuilt from the read-only
// onboarding sheet on every data refresh, so ongoing sheet edits keep flowing
// through instead of being frozen at the one-time seed. (Without this, a step
// the sheet later marks done stays masked by its stale 5-Jun seed value.)
export function mergeOnboarding(steps, liveForOds) {
  if (!steps || !liveForOds) return steps;
  return steps.map((s) => {
    const live = liveForOds[s.key];
    if (live && live.changed_by !== "sheet-seed") {
      return { ...s, state: live.state, changed_at: live.changed_at, changed_by: live.changed_by, note: live.note ?? null };
    }
    return s; // untouched seed → the fresh sheet value (from funnel_board.json) wins
  });
}

export function summarizeOnboarding(steps) {
  // "na" steps (e.g. EMIS/sharing for SystmOne) are not applicable — they don't
  // count toward the total or the next outstanding step.
  const applicable = steps.filter((s) => s.state !== "na");
  const done = applicable.filter((s) => s.state === "done").length;
  const next = applicable.find((s) => s.state !== "done");
  return { done, total: applicable.length, next: next ? next.step : null };
}

// Effective onboarding steps for a practice: the Google-Sheet-derived business
// steps (carried on the deal as `onboarding`) with any in-app Neon toggles merged
// over the top. This is the single step model both tabs render, so the Hub reflects
// the practice's real set-up state rather than a blank slate.
export function onboardingFor(deal, liveForOds) {
  if (!deal?.onboarding?.length) return [];
  return mergeOnboarding(deal.onboarding, liveForOds) || [];
}

// The implementation checklist, mirroring ONBOARD_STEPS in pipeline/build_funnel_board.py
// (same keys + order). Used as an all-"to do" starting checklist for a practice that
// isn't on the tracker sheet yet — e.g. one just added from HubSpot or by hand — so
// the team can tick steps from day one instead of waiting for the sheet.
export const DEFAULT_STEPS = [
  ["EMIS Notified", "emis_notified"],
  ["IM1 User created", "im1_user_created"],
  ["Sharing agreement accepted", "sharing_agreement"],
  ["Patient Data Sync", "patient_data_sync"],
  ["Practice on dashboard", "practice_on_dashboard"],
  ["HeroHealth", "herohealth"],
  ["Onboarding Call", "onboarding_call"],
  ["Appt Config", "appt_config"],
  ["Bloods automation", "bloods_automation"],
  ["Recall Session", "recall_session"],
];
const isS1 = (ehr) => { const e = (ehr || "").toLowerCase(); return e.includes("systm") || e === "s1" || e.includes("tpp"); };
// SystmOne practices need no EMIS notification or sharing agreement → N/A (as the pipeline does).
export function defaultSteps(ehr) {
  return DEFAULT_STEPS.map(([step, key]) => (isS1(ehr) && (key === "emis_notified" || key === "sharing_agreement")
    ? { step, key, state: "na", value: "N/A · SystmOne" }
    : { step, key, state: "todo", value: "" }));
}

// Hook owning the live onboarding state + the timestamped toggle write path.
// `auth` is the signed-in Google user ({ email, token }) in prod, null in local dev.
// Who we're waiting on for a blocked step — display labels.
export const WAITING_ON = ["us", "practice", "third_party"];
export const WAITING_LABEL = { us: "Us / Suvera", practice: "Practice", third_party: "Third-party" };

export function useOnboarding(auth = null) {
  const [liveOnb, setLiveOnb] = useState({});
  const [notes, setNotes] = useState({}); // ods -> [{id, body, author, created_at, hs_synced}] newest-first
  const [blocks, setBlocks] = useState({}); // ods -> { step_key: {waiting_on, reason, blocked_at, blocked_by} }
  const [hidden, setHidden] = useState({}); // ods -> [activity_key] hidden from the activity log (declutter only)
  const [live, setLive] = useState({});     // ods -> {marked_by, marked_at, hs_synced}
  const [dropped, setDropped] = useState({}); // ods -> {dropped_by, dropped_at, hs_synced}
  const [practices, setPractices] = useState([]); // Hub-added practices (HubSpot webhook + manual) — see onboarding_practices
  const [error, setError] = useState(null); // user-visible "something didn't reach the server" hint
  const [who, setWho] = useState(() => (typeof localStorage !== "undefined" && localStorage.getItem("pcto.who")) || "");
  // Surface load/save failures instead of swallowing them: optimistic UI is great
  // until a request silently drops and the user thinks it saved. Neon stays the
  // source of truth; this only flags that a fetch didn't land.
  const onLoadFail = (what) => (e) => { console.error(`onboarding: failed to load ${what}`, e); setError("Couldn't load the latest onboarding data — showing what we have."); };
  const onSaveFail = (what) => (e) => { console.error(`onboarding: failed to save ${what}`, e); setError("A change may not have saved — check your connection and retry."); };
  useEffect(() => {
    // reads are auth-gated in prod (no edge gate in front) — carry the token
    const headers = auth?.token ? { Authorization: `Bearer ${auth.token}` } : {};
    fetch(ONB_BASE, { headers }).then((r) => r.json()).then(setLiveOnb).catch(onLoadFail("steps"));
    fetch(`${ONB_BASE}/notes`, { headers }).then((r) => r.json()).then(setNotes).catch(onLoadFail("notes"));
    fetch(`${ONB_BASE}/blocks`, { headers }).then((r) => r.json()).then(setBlocks).catch(onLoadFail("blocks"));
    fetch(`${ONB_BASE}/live`, { headers }).then((r) => r.json()).then(setLive).catch(onLoadFail("live"));
    fetch(`${ONB_BASE}/hidden`, { headers }).then((r) => r.json()).then(setHidden).catch(onLoadFail("hidden"));
    fetch(`${ONB_BASE}/dropped`, { headers }).then((r) => r.json()).then(setDropped).catch(onLoadFail("dropped"));
    fetch(`${ONB_BASE}/practices`, { headers }).then((r) => r.json()).then((rows) => setPractices(Array.isArray(rows) ? rows : [])).catch(onLoadFail("practices"));
  }, [auth?.token]);

  // Hub-added practices are written by the HubSpot webhook in the background, so
  // re-poll them every minute while the Hub is open — a deal that moves to DPA
  // signed shows up without a page reload.
  useEffect(() => {
    const headers = auth?.token ? { Authorization: `Bearer ${auth.token}` } : {};
    const t = setInterval(() => {
      fetch(`${ONB_BASE}/practices`, { headers }).then((r) => (r.ok ? r.json() : null))
        .then((rows) => { if (Array.isArray(rows)) setPractices(rows); }).catch(() => {});
    }, 60000);
    return () => clearInterval(t);
  }, [auth?.token]);

  // Attribution = the signed-in person's first name (from the Google login) in
  // prod; the local-dev name field is only a fallback when not signed in.
  const editor = (auth?.email && firstNameFromEmail(auth.email)) || who || null;

  // Set a step to an explicit state (todo|pending|done), optimistically, and POST
  // a timestamped event to Neon. Skips practices with no ODS (the API keys on ods)
  // and no-ops when the step is already in that state. This is the direct path the
  // card's options menu uses; `toggleStep` (the express tick) delegates to it.
  // `note` is an optional sub-status label (e.g. "Booked", "Signed") for steps that
  // have sub-statuses; it's stored + displayed but doesn't change the todo/pending/
  // done/na state. Two sub-statuses can share a state (Invited & Booked are both
  // pending), so the no-op guard checks state AND note.
  async function setStepState(deal, step, toState, note = null) {
    if (!deal?.ods || !toState) return;
    const cur = liveOnb[deal.ods]?.[step.key];
    const curState = cur?.state ?? step.state ?? "todo";
    const curNote = cur?.note ?? null;
    if (curState === toState && (curNote || null) === (note || null)) return; // nothing changed
    const rec = { state: toState, note: note || null, changed_by: editor || "(you)", changed_at: new Date().toISOString() };
    setLiveOnb((prev) => ({ ...prev, [deal.ods]: { ...(prev[deal.ods] || {}), [step.key]: rec } }));
    try {
      const r = await fetch(`${ONB_BASE}/step`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}) },
        body: JSON.stringify({ ods: deal.ods, deal_id: String(deal.deal_id || ""), step_key: step.key, to_state: toState, note: note || null, changed_by: editor }),
      });
      // Reconcile the optimistic timestamp with the server's now() so derived keys
      // (the activity-log akey) match what a reload re-derives from Neon. Mirrors markLive.
      const saved = await r.json().catch(() => null);
      if (saved?.changed_at) setLiveOnb((prev) => ({
        ...prev,
        [deal.ods]: { ...(prev[deal.ods] || {}), [step.key]: { ...rec, changed_at: saved.changed_at } },
      }));
    } catch (e) { onSaveFail("step")(e); /* keep optimistic update */ }
  }

  // Advance a step todo→pending→done→todo (the express tick on the card).
  function toggleStep(deal, step) {
    const cur = liveOnb[deal?.ods]?.[step.key]?.state ?? step.state ?? "todo";
    return setStepState(deal, step, STATE_CYCLE[cur] || "todo");
  }

  // Append a timestamped note for a practice (stored in Neon, best-effort synced
  // to HubSpot server-side). Optimistic so it appears immediately.
  async function addNote(deal, bodyText) {
    const body = (bodyText || "").trim();
    if (!deal?.ods || !body) return;
    const tmpId = `tmp-${Date.now()}`;
    const optimistic = { id: tmpId, body, author: editor || "(you)", created_at: new Date().toISOString(), hs_synced: false, pending: true };
    setNotes((prev) => ({ ...prev, [deal.ods]: [optimistic, ...(prev[deal.ods] || [])] }));
    try {
      const r = await fetch(`${ONB_BASE}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}) },
        body: JSON.stringify({ ods: deal.ods, deal_id: String(deal.deal_id || ""), body, author: editor }),
      });
      const saved = await r.json();
      if (saved && saved.id) {
        setNotes((prev) => ({ ...prev, [deal.ods]: [saved, ...(prev[deal.ods] || []).filter((n) => n.id !== tmpId)] }));
      }
    } catch (e) { onSaveFail("note")(e); /* keep optimistic note */ }
  }

  // Edit a note's body in place (optimistic). Propagates to its HubSpot note server-side.
  async function editNote(deal, id, bodyText) {
    const text = (bodyText || "").trim();
    if (!deal?.ods || !id || !text) return;
    setNotes((prev) => ({ ...prev, [deal.ods]: (prev[deal.ods] || []).map((n) => (n.id === id ? { ...n, body: text, updated_at: new Date().toISOString(), pending: true } : n)) }));
    try {
      const r = await fetch(`${ONB_BASE}/notes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}) },
        body: JSON.stringify({ id, body: text, author: editor }),
      });
      const saved = await r.json();
      if (saved && saved.id) setNotes((prev) => ({ ...prev, [deal.ods]: (prev[deal.ods] || []).map((n) => (n.id === id ? saved : n)) }));
    } catch (e) { onSaveFail("note-edit")(e); /* keep optimistic */ }
  }

  // Delete a note (optimistic removal). Archives its HubSpot note server-side.
  async function deleteNote(deal, id) {
    if (!deal?.ods || !id) return;
    const prevList = notes[deal.ods] || [];
    setNotes((prev) => ({ ...prev, [deal.ods]: (prev[deal.ods] || []).filter((n) => n.id !== id) }));
    try {
      await fetch(`${ONB_BASE}/notes`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}) },
        body: JSON.stringify({ id }),
      });
    } catch (e) { onSaveFail("note-delete")(e); setNotes((prev) => ({ ...prev, [deal.ods]: prevList })); /* restore on failure */ }
  }

  // Set or clear a block on a step (orthogonal to its todo/pending/done progress).
  // opts: { action: "block"|"unblock", waiting_on, reason }
  async function setStepBlock(deal, step, { action, waiting_on = null, reason = null }) {
    if (!deal?.ods || !step?.key) return;
    setBlocks((prev) => {
      const cur = { ...(prev[deal.ods] || {}) };
      if (action === "unblock") delete cur[step.key];
      else cur[step.key] = { waiting_on: waiting_on || "us", reason, blocked_by: editor || "(you)", blocked_at: new Date().toISOString() };
      return { ...prev, [deal.ods]: cur };
    });
    try {
      const r = await fetch(`${ONB_BASE}/block`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}) },
        body: JSON.stringify({ ods: deal.ods, deal_id: String(deal.deal_id || ""), step_key: step.key, action, waiting_on, reason, by: editor }),
      });
      // Reconcile the optimistic blocked_at with the server's so the block's akey
      // (b:<step>:<blocked_at>) matches what a reload re-derives — keeps a hide stuck.
      const saved = await r.json().catch(() => null);
      if (action !== "unblock" && saved?.blocked_at) setBlocks((prev) => {
        const cur = { ...(prev[deal.ods] || {}) };
        if (cur[step.key]) cur[step.key] = { ...cur[step.key], blocked_at: saved.blocked_at };
        return { ...prev, [deal.ods]: cur };
      });
    } catch (e) { onSaveFail("block")(e); /* keep optimistic */ }
  }

  // Hide one activity-log entry to declutter the feed. This does NOT change the
  // step/block/live state it was derived from — it only removes the row from the
  // log. Optimistic; persisted to Neon keyed by (ods, activity_key).
  async function hideActivity(deal, activityKey) {
    if (!deal?.ods || !activityKey) return;
    if ((hidden[deal.ods] || []).includes(activityKey)) return; // already hidden — no-op
    setHidden((prev) => ({ ...prev, [deal.ods]: [...(prev[deal.ods] || []), activityKey] }));
    try {
      await fetch(`${ONB_BASE}/hide`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}) },
        body: JSON.stringify({ ods: deal.ods, activity_key: activityKey, by: editor }),
      });
    } catch (e) { onSaveFail("activity")(e); /* keep optimistic hide */ }
  }

  // Mark a practice live: record a Hub flag + (server-side, gated) move the HubSpot deal stage.
  async function markLive(deal) {
    if (!deal?.ods) return;
    setLive((prev) => ({ ...prev, [deal.ods]: { marked_by: editor || "(you)", marked_at: new Date().toISOString(), hs_synced: false } }));
    try {
      const r = await fetch(`${ONB_BASE}/live`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}) },
        body: JSON.stringify({ ods: deal.ods, deal_id: String(deal.deal_id || ""), by: editor }),
      });
      const saved = await r.json();
      if (saved?.ok) setLive((prev) => ({ ...prev, [deal.ods]: { marked_by: editor || "(you)", marked_at: saved.marked_at, hs_synced: saved.hs_synced } }));
    } catch (e) { onSaveFail("mark-live")(e); /* keep optimistic */ }
  }

  // Mark a practice dropped out: record it (so it leaves the Hub immediately) and,
  // server-side + gated, move its HubSpot deal to the "Dropped Out" stage. On the
  // next data refresh the dropped deal also leaves the cohort naturally.
  async function markDropped(deal) {
    if (!deal?.ods) return;
    setDropped((prev) => ({ ...prev, [deal.ods]: { dropped_by: editor || "(you)", dropped_at: new Date().toISOString(), hs_synced: false } }));
    try {
      const r = await fetch(`${ONB_BASE}/dropped`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}) },
        body: JSON.stringify({ ods: deal.ods, deal_id: String(deal.deal_id || ""), by: editor }),
      });
      const saved = await r.json();
      if (saved?.ok) setDropped((prev) => ({ ...prev, [deal.ods]: { dropped_by: editor || "(you)", dropped_at: saved.dropped_at, hs_synced: saved.hs_synced } }));
    } catch (e) { onSaveFail("dropped")(e); /* keep optimistic */ }
  }

  // Practices CRUD (not optimistic — these return validation errors the form shows).
  // Each returns { ok, row } or { ok: false, error }.
  async function practicesCall(method, payload) {
    try {
      const r = await fetch(`${ONB_BASE}/practices`, {
        method,
        headers: { "Content-Type": "application/json", ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}) },
        body: JSON.stringify({ ...payload, by: editor }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j.error || `Request failed (${r.status})` };
      return { ok: true, row: j };
    } catch (e) { return { ok: false, error: "Couldn't reach the server — check your connection and retry." }; }
  }
  async function addPractice({ ods, name, ehr, deal_id }) {
    const res = await practicesCall("POST", { ods, name, ehr, deal_id });
    if (res.ok) setPractices((prev) => [...prev, res.row]);
    return res;
  }
  // Attach an ODS to a practice flagged "ODS missing" — by Hub row id, or by deal_id
  // for a funnel_board deal the Hub didn't create (the API upserts a row for it).
  async function setPracticeOds({ id, deal_id, name }, ods) {
    const res = await practicesCall("PATCH", { id, deal_id, name, ods });
    if (res.ok) setPractices((prev) => [...prev.filter((p) => p.id !== res.row.id), res.row]);
    return res;
  }
  async function removePractice(id) {
    const res = await practicesCall("DELETE", { id });
    if (res.ok) setPractices((prev) => prev.filter((p) => p.id !== id));
    return res;
  }
  async function lookupOds(ods) {
    try {
      const r = await fetch(`${ONB_BASE}/ods-lookup?ods=${encodeURIComponent(ods)}`, { headers: auth?.token ? { Authorization: `Bearer ${auth.token}` } : {} });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  return { practices, addPractice, setPracticeOds, removePractice, lookupOds, liveOnb, setLiveOnb, notes, addNote, editNote, deleteNote, blocks, setStepBlock, hidden, hideActivity, live, markLive, dropped, markDropped, who, setWho, editor, toggleStep, setStepState, error, setError };
}
