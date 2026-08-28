// Shared onboarding logic for the Neon-backed onboarding API — the single source
// of truth behind BOTH transports:
//   • local dev   → api/server.mjs (node http)
//   • production  → netlify/functions/onboarding.mjs (Web Request/Response, SSO-gated)
//
// Each handler is transport-agnostic: it takes the `sql` client (+ already-parsed
// inputs) and returns `{ status, body }`. The wrappers own transport, env loading
// and auth — so the two can never drift (e.g. adding an endpoint is a one-file change).

const VALID_STATES = ["todo", "pending", "done", "na"];
const result = (body, status = 200) => ({ status, body });

// First name from a verified Google email (e.g. "will@suvera.co.uk" -> "Will").
export function firstNameFromEmail(email) {
  if (!email) return null;
  const fn = email.split("@")[0].split(/[._-]+/)[0] || "";
  return fn ? fn.charAt(0).toUpperCase() + fn.slice(1) : null;
}

// Best-effort HubSpot notes client (create / update / archive). All methods are
// no-ops returning null/false unless `enabled` + `token` are set, and never throw.
// note→deal associationTypeId = 214. `create` returns the HubSpot note id (so we
// can later edit/delete the same note); `update`/`archive` act on that id.
const HS_NOTE_BODY = (body, author) => `${body}${author ? `\n\n— ${author} (Onboarding Hub)` : ""}`;
export function makeNotesHub({ token, enabled }) {
  const on = () => enabled && token;
  return {
    async create({ deal_id, body, author }) {
      if (!on() || !deal_id) return null;
      try {
        const r = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            properties: { hs_note_body: HS_NOTE_BODY(body, author), hs_timestamp: Date.now() },
            associations: [{ to: { id: String(deal_id) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }] }],
          }),
        });
        if (!r.ok) { console.error(`[hubspot] note create failed (deal ${deal_id}): ${r.status} ${r.statusText}`); return null; }
        const j = await r.json();
        return j?.id ? String(j.id) : null;
      } catch (e) { console.error(`[hubspot] note create error (deal ${deal_id}):`, e?.message || e); return null; }
    },
    async update(hs_note_id, { body, author }) {
      if (!on() || !hs_note_id) return false;
      try {
        const r = await fetch(`https://api.hubapi.com/crm/v3/objects/notes/${encodeURIComponent(hs_note_id)}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ properties: { hs_note_body: HS_NOTE_BODY(body, author) } }),
        });
        if (!r.ok) console.error(`[hubspot] note update failed (${hs_note_id}): ${r.status} ${r.statusText}`);
        return r.ok;
      } catch (e) { console.error(`[hubspot] note update error (${hs_note_id}):`, e?.message || e); return false; }
    },
    async archive(hs_note_id) {
      if (!on() || !hs_note_id) return false;
      try {
        const r = await fetch(`https://api.hubapi.com/crm/v3/objects/notes/${encodeURIComponent(hs_note_id)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok && r.status !== 404) console.error(`[hubspot] note archive failed (${hs_note_id}): ${r.status} ${r.statusText}`);
        return r.ok || r.status === 404;
      } catch (e) { console.error(`[hubspot] note archive error (${hs_note_id}):`, e?.message || e); return false; }
    },
  };
}

// GET /api/onboarding → current state per practice: { ods: { step_key: {state, changed_by, changed_at, note} } }
// Same "latest event per (ods, step_key)" as the onboarding_current view, but read
// straight from the event log so we can also surface `note` — the optional sub-status
// label (e.g. "Booked" / "Signed") the Hub sets for steps with sub-statuses.
export async function getCurrent(sql) {
  const rows = await sql`select distinct on (ods, step_key) ods, step_key, to_state as state, changed_by, changed_at, note
    from onboarding_step_events order by ods, step_key, changed_at desc`;
  const out = {};
  for (const r of rows) (out[r.ods] ||= {})[r.step_key] = { state: r.state, changed_by: r.changed_by, changed_at: r.changed_at, note: r.note };
  return result(out);
}

// GET /api/onboarding/events → the whole event log for the stall analysis:
//   { steps: [{ods, step_key, from_state, to_state, changed_by, changed_at, note}],   // human/app events only
//     blocks: [{ods, step_key, waiting_on, reason, blocked_at, cleared_at}] }          // incl. cleared
// Seed rows are excluded: their changed_at is the seed time, not when the step
// really happened, so they'd poison time-in-step maths.
const SEED_AUTHORS = ["sheet-seed", "seed-correction", "selftest", "hub-verify-reset"];
export async function getEvents(sql) {
  const steps = await sql`select ods, deal_id, step_key, from_state, to_state, changed_by, changed_at, note
    from onboarding_step_events
    where changed_by is null or changed_by <> all(${SEED_AUTHORS})
    order by changed_at asc`;
  const blocks = await sql`select ods, step_key, waiting_on, reason, blocked_by, blocked_at, cleared_at
    from onboarding_blocks order by blocked_at asc`;
  return result({ steps, blocks });
}

// GET /api/onboarding/history?ods= → full event log for one practice (time-in-step / audit)
export async function getHistory(sql, ods) {
  if (!ods) return result({ error: "ods required" }, 400);
  const rows = await sql`select step_key, from_state, to_state, changed_by, changed_at
    from onboarding_step_events where ods=${ods} order by changed_at asc`;
  return result(rows);
}

// GET /api/onboarding/notes → { ods: [ {id, body, author, created_at, updated_at, hs_synced}, … ] } newest-first
export async function getNotes(sql) {
  const rows = await sql`select id, ods, deal_id, author, body, hs_synced, hs_note_id, created_at, updated_at
    from onboarding_notes where deleted_at is null order by created_at desc`;
  const out = {};
  for (const r of rows) (out[r.ods] ||= []).push(r);
  return result(out);
}

// POST /api/onboarding/step → append a timestamped state-change event
export async function postStep(sql, { ods, deal_id = null, step_key, to_state, changed_by = null, note = null }) {
  if (!ods || !step_key || !VALID_STATES.includes(to_state)) {
    return result({ error: "ods, step_key and a valid to_state (todo|pending|done) are required" }, 400);
  }
  const prev = await sql`select state from onboarding_current where ods=${ods} and step_key=${step_key}`;
  const from_state = prev[0]?.state ?? null;
  const ins = await sql`insert into onboarding_step_events
    (ods, deal_id, step_key, from_state, to_state, changed_by, note)
    values (${ods}, ${deal_id}, ${step_key}, ${from_state}, ${to_state}, ${changed_by}, ${note})
    returning changed_at`;
  return result({ ok: true, ods, step_key, state: to_state, from_state, changed_by, changed_at: ins[0].changed_at });
}

// POST /api/onboarding/notes → save a note to Neon + (best-effort) create the HubSpot note,
// storing its id so a later edit/delete can propagate to the same HubSpot note.
export async function postNote(sql, notesHub, { ods, deal_id = null, body, author = null }) {
  const text = String(body || "").trim();
  if (!ods || !text) return result({ error: "ods and body are required" }, 400);
  const hs_note_id = await notesHub.create({ deal_id, body: text, author });
  const ins = await sql`insert into onboarding_notes (ods, deal_id, author, body, hs_synced, hs_note_id)
    values (${ods}, ${deal_id}, ${author}, ${text}, ${!!hs_note_id}, ${hs_note_id})
    returning id, ods, deal_id, author, body, hs_synced, hs_note_id, created_at, updated_at`;
  return result(ins[0]);
}

// PATCH /api/onboarding/notes → edit a note body (propagates to its HubSpot note if synced)
export async function editNote(sql, notesHub, { id, body, author = null }) {
  const text = String(body || "").trim();
  if (!id || !text) return result({ error: "id and body are required" }, 400);
  const rows = await sql`select hs_note_id from onboarding_notes where id=${id} and deleted_at is null`;
  if (!rows[0]) return result({ error: "note not found" }, 404);
  if (rows[0].hs_note_id) await notesHub.update(rows[0].hs_note_id, { body: text, author });
  const upd = await sql`update onboarding_notes set body=${text}, updated_at=now()
    where id=${id} and deleted_at is null
    returning id, ods, deal_id, author, body, hs_synced, hs_note_id, created_at, updated_at`;
  return result(upd[0]);
}

// DELETE /api/onboarding/notes → soft-delete a note (archives its HubSpot note if synced)
export async function deleteNote(sql, notesHub, { id }) {
  if (!id) return result({ error: "id required" }, 400);
  const rows = await sql`select ods, hs_note_id from onboarding_notes where id=${id} and deleted_at is null`;
  if (!rows[0]) return result({ error: "note not found" }, 404);
  if (rows[0].hs_note_id) await notesHub.archive(rows[0].hs_note_id);
  await sql`update onboarding_notes set deleted_at=now() where id=${id}`;
  return result({ ok: true, id, ods: rows[0].ods });
}

/* ---------------- activity-log cleanup (soft-hide, declutter only) ---------------- */
// The Hub's activity feed mixes notes with derived action rows (step toggles,
// blocks, mark-live). Hiding an entry removes it FROM THE LOG only — it does NOT
// change the step/block/live state it was derived from. Keyed by a stable per-entry
// `activity_key` the frontend builds (e.g. "s:<step_key>:<changed_at>").

// GET /api/onboarding/hidden → { ods: [activity_key, …] }
export async function getHiddenActivity(sql) {
  const rows = await sql`select ods, activity_key from onboarding_activity_hidden`;
  const out = {};
  for (const r of rows) (out[r.ods] ||= []).push(r.activity_key);
  return result(out);
}

// POST /api/onboarding/hide → hide one activity-log entry (idempotent; declutter only)
export async function hideActivity(sql, { ods, activity_key, by = null }) {
  if (!ods || !activity_key) return result({ error: "ods and activity_key are required" }, 400);
  await sql`insert into onboarding_activity_hidden (ods, activity_key, hidden_by)
    values (${ods}, ${activity_key}, ${by})
    on conflict (ods, activity_key) do nothing`;
  return result({ ok: true, ods, activity_key });
}

/* ---------------- blocked (orthogonal to progress) ---------------- */
// "Blocked" is a flag layered on a step, not a 4th progress state — a step can be
// in-progress AND blocked-on-labs. waiting_on = who we're waiting on.
export const WAITING_ON = ["us", "practice", "third_party"];

// GET /api/onboarding/blocks → { ods: { step_key: {waiting_on, reason, blocked_by, blocked_at} } } (active only)
export async function getBlocks(sql) {
  const rows = await sql`select distinct on (ods, step_key) ods, step_key, waiting_on, reason, blocked_by, blocked_at
    from onboarding_blocks where cleared_at is null order by ods, step_key, blocked_at desc`;
  const out = {};
  for (const r of rows) (out[r.ods] ||= {})[r.step_key] = { waiting_on: r.waiting_on, reason: r.reason, blocked_by: r.blocked_by, blocked_at: r.blocked_at };
  return result(out);
}

// POST /api/onboarding/block → set or clear a block on a step (one active block per step)
export async function setBlock(sql, { ods, deal_id = null, step_key, action, waiting_on = null, reason = null, by = null }) {
  if (!ods || !step_key) return result({ error: "ods and step_key are required" }, 400);
  if (action === "unblock") {
    await sql`update onboarding_blocks set cleared_at = now(), cleared_by = ${by}
      where ods=${ods} and step_key=${step_key} and cleared_at is null`;
    return result({ ok: true, ods, step_key, blocked: false });
  }
  const w = WAITING_ON.includes(waiting_on) ? waiting_on : "us";
  // Clear any existing active block then insert the new one ATOMICALLY, so two
  // concurrent "block" POSTs for the same step can't both clear-and-insert and
  // leave two active rows. (Single round-trip transaction on the Neon driver.)
  const [, ins] = await sql.transaction([
    sql`update onboarding_blocks set cleared_at = now(), cleared_by = ${by}
      where ods=${ods} and step_key=${step_key} and cleared_at is null`,
    sql`insert into onboarding_blocks (ods, deal_id, step_key, waiting_on, reason, blocked_by)
      values (${ods}, ${deal_id}, ${step_key}, ${w}, ${reason}, ${by}) returning blocked_at`,
  ]);
  return result({ ok: true, ods, step_key, blocked: true, waiting_on: w, reason, blocked_by: by, blocked_at: ins[0].blocked_at });
}

/* ---------------- mark live ---------------- */
// HubSpot Planner pipeline: move a deal to "Full Functionality Live".
const HS_PIPELINE = "3277290730";
const HS_STAGE_LIVE = "4487571659";

// Best-effort HubSpot deal-stage write — OFF unless `enabled` + token + deal_id.
// Never throws; returns whether the deal stage was actually moved.
export function makeDealLiveSetter({ token, enabled }) {
  return async function setDealLive(deal_id) {
    if (!enabled || !token || !deal_id) return false;
    try {
      const r = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(deal_id)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { pipeline: HS_PIPELINE, dealstage: HS_STAGE_LIVE } }),
      });
      if (!r.ok) console.error(`[hubspot] deal-live write failed (deal ${deal_id}): ${r.status} ${r.statusText}`);
      return r.ok;
    } catch (e) {
      console.error(`[hubspot] deal-live write error (deal ${deal_id}):`, e?.message || e);
      return false;
    }
  };
}

// GET /api/onboarding/live → { ods: {marked_by, marked_at, hs_synced} } (active only)
export async function getLive(sql) {
  const rows = await sql`select distinct on (ods) ods, marked_by, marked_at, hs_synced
    from onboarding_live where unmarked_at is null order by ods, marked_at desc`;
  const out = {};
  for (const r of rows) out[r.ods] = { marked_by: r.marked_by, marked_at: r.marked_at, hs_synced: r.hs_synced };
  return result(out);
}

// POST /api/onboarding/live → record a mark-live in the Hub + best-effort HubSpot deal-stage write
export async function markLive(sql, setDealLive, { ods, deal_id = null, by = null }) {
  if (!ods) return result({ error: "ods required" }, 400);
  // Idempotent: if already marked live (active row), don't insert a duplicate or
  // re-fire the HubSpot write — just return the existing record.
  const existing = await sql`select marked_at, hs_synced from onboarding_live
    where ods=${ods} and unmarked_at is null order by marked_at desc limit 1`;
  if (existing[0]) return result({ ok: true, ods, marked_at: existing[0].marked_at, hs_synced: existing[0].hs_synced, already: true });
  const hs_synced = await setDealLive(deal_id);
  const ins = await sql`insert into onboarding_live (ods, deal_id, marked_by, hs_synced)
    values (${ods}, ${deal_id}, ${by}, ${hs_synced}) returning marked_at`;
  return result({ ok: true, ods, marked_at: ins[0].marked_at, hs_synced });
}

/* ---------------- dropped out ---------------- */
// Move a deal to the Planner pipeline's "Dropped Out" stage. On the next data
// refresh the build skips DROP_ID deals, so a dropped practice leaves the Hub;
// the Neon record hides it immediately in the meantime.
const HS_STAGE_DROPPED = "4527836370";

// Best-effort HubSpot deal-stage write to "Dropped Out". OFF unless enabled+token+deal_id.
export function makeDealDroppedSetter({ token, enabled }) {
  return async function setDealDropped(deal_id) {
    if (!enabled || !token || !deal_id) return false;
    try {
      const r = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(deal_id)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { pipeline: HS_PIPELINE, dealstage: HS_STAGE_DROPPED } }),
      });
      if (!r.ok) console.error(`[hubspot] deal-dropped write failed (deal ${deal_id}): ${r.status} ${r.statusText}`);
      return r.ok;
    } catch (e) { console.error(`[hubspot] deal-dropped write error (deal ${deal_id}):`, e?.message || e); return false; }
  };
}

// GET /api/onboarding/dropped → { ods: {dropped_by, dropped_at, hs_synced} } (active only)
export async function getDropped(sql) {
  const rows = await sql`select distinct on (ods) ods, dropped_by, dropped_at, hs_synced
    from onboarding_dropped where restored_at is null order by ods, dropped_at desc`;
  const out = {};
  for (const r of rows) out[r.ods] = { dropped_by: r.dropped_by, dropped_at: r.dropped_at, hs_synced: r.hs_synced };
  return result(out);
}

// POST /api/onboarding/dropped → record a drop + best-effort move the HubSpot deal to "Dropped Out"
export async function markDropped(sql, setDealDropped, { ods, deal_id = null, by = null }) {
  if (!ods) return result({ error: "ods required" }, 400);
  const existing = await sql`select dropped_at, hs_synced from onboarding_dropped
    where ods=${ods} and restored_at is null order by dropped_at desc limit 1`;
  if (existing[0]) return result({ ok: true, ods, dropped_at: existing[0].dropped_at, hs_synced: existing[0].hs_synced, already: true });
  const hs_synced = await setDealDropped(deal_id);
  const ins = await sql`insert into onboarding_dropped (ods, deal_id, dropped_by, hs_synced)
    values (${ods}, ${deal_id}, ${by}, ${hs_synced}) returning dropped_at`;
  return result({ ok: true, ods, dropped_at: ins[0].dropped_at, hs_synced });
}
