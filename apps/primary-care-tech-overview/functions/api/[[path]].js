// Cloudflare Pages Function: production transport for the onboarding API.
// Same shared handlers as local dev (api/onboarding-core.mjs) and the (legacy)
// Netlify function — only the wrapper differs. Runs at /api/onboarding* on the
// Cloudflare Pages project, same origin as the SPA (no CORS).
//
// Secrets/vars come from `context.env` (set in the Pages project → Settings →
// Environment variables, or via `wrangler pages secret put`):
//   NEON_DATABASE_URL   (required) — Neon Postgres connection string
//   GOOGLE_CLIENT_ID    (optional) — an ADDITIONAL trusted OAuth client for the
//                        @suvera.co.uk token check. The primary client id is baked
//                        in from VITE_GOOGLE_CLIENT_ID at build (auth-config.json),
//                        so this env var is no longer required and can't lock users
//                        out if it's missing or stale.
//   HUBSPOT_API_TOKEN   (optional) — only used when the sync flags below are set
//   HUBSPOT_NOTES_SYNC  (optional) — truthy → push notes to the HubSpot deal
//   HUBSPOT_DEAL_WRITE  (optional) — truthy → mark-live moves the HubSpot deal stage
//
// This is the ONLY gate (no Cloudflare Access in front): every read AND write
// requires a valid @suvera.co.uk Google token, so the deal/CS data stays private.
import { neon } from "@neondatabase/serverless";
import {
  makeNotesHub, makeDealLiveSetter, makeDealDroppedSetter, firstNameFromEmail,
  getCurrent, getHistory, getEvents, getNotes, postStep, postNote, editNote, deleteNote,
  getBlocks, setBlock, getLive, markLive, getHiddenActivity, hideActivity, getDropped, markDropped,
} from "../../api/onboarding-core.mjs";
// The dashboard data (generated fresh in CI) is bundled into this Function and
// served only to authenticated users — NOT a public static asset, so the internal
// data stays private without an edge gate. CI overwrites these before the deploy;
// the committed copies are empty placeholders.
import boardData from "../../server-data/funnel_board.json";
import visitsData from "../../server-data/practice_visits.json";
// The OAuth client id the SPA was built with, baked in from VITE_GOOGLE_CLIENT_ID
// at deploy time (same secret, same run) so the server's token check can NEVER
// drift from the frontend. CI overwrites this; the committed copy is the current
// public client id as a safe default. See deploy-planner-cf.yml.
import authConfig from "../../server-data/auth-config.json";

const ALLOWED_DOMAIN = "suvera.co.uk";
const J = (r) => new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
const err = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// Verify a Google ID token via Google's tokeninfo endpoint (no extra deps).
// Returns { email } when valid; null otherwise. FAILS CLOSED: with no accepted
// client ids we can't verify anyone, so every read AND write is rejected rather
// than served unauthenticated (these endpoints read private CS data + write Neon
// + move HubSpot deals). `clientIds` is the set of OAuth clients we trust — the
// token's `aud` must match one of them, so a token minted for some other app by a
// @suvera.co.uk user can't be replayed here.
async function verifyGoogle(req, clientIds) {
  if (!clientIds.length) return null;
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
    if (!r.ok) return null;
    const p = await r.json();
    if (!clientIds.includes(p.aud)) return null;
    const email = (p.email || "").toLowerCase();
    const domainOk = p.hd === ALLOWED_DOMAIN || email.endsWith("@" + ALLOWED_DOMAIN);
    if (!domainOk || p.email_verified === "false") return null;
    return { email };
  } catch {
    return null;
  }
}

// --- Omni webhook: /api/omni/recalls ----------------------------------------
// Receives scheduled "Planner Recalls by Day" deliveries from Omni. Omni can
// only be given a bare URL (no auth headers), so the shared secret travels in
// the URL — either ?key=... or as a trailing path segment
// (/api/omni/recalls/<key>, for webhook forms that reject query strings) —
// and is checked against the `webhook_keys` Neon table (name='omni_recalls'),
// stored in the DB rather than a Pages env var so rotating it needs no
// redeploy. Deliveries are stored RAW (jsonb when the body parses as JSON,
// text otherwise): the payload shape isn't pinned down yet, so we capture
// everything and build the per-practice cumulative recall parsing once we've
// seen a real delivery. GET (same key) returns the latest deliveries so a
// test send can be verified from a browser. Rejected POSTs are logged too
// (content_type 'rejected: ...', body truncated) — otherwise a sender whose
// URL mangling dropped the key is indistinguishable from one that never sent.
async function handleOmniRecalls(req, sql, url, pathKey) {
  const presented = pathKey || url.searchParams.get("key") || "";
  const rows = await sql`select key from webhook_keys where name = 'omni_recalls'`;
  if (!presented || !rows.length || rows[0].key !== presented) {
    if (req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      const ua = req.headers.get("user-agent") || "";
      const body = (await req.text()).slice(0, 2000);
      await sql`insert into omni_recall_deliveries (content_type, body_text)
                values (${"rejected: bad key; ct=" + ct + "; ua=" + ua}, ${body})`;
    }
    return err({ error: "unauthorized" }, 401);
  }

  if (req.method === "GET") {
    const recent = await sql`
      select id, received_at, content_type, octet_length(body_text) as bytes,
             left(body_text, 2000) as preview, payload is not null as parsed_json
      from omni_recall_deliveries order by id desc limit 5`;
    return J({ status: 200, body: { deliveries: recent } });
  }

  if (req.method !== "POST") return err({ error: "method not allowed" }, 405);

  const contentType = req.headers.get("content-type") || "";
  let bodyText;
  if (contentType.includes("multipart/form-data")) {
    // Omni "file" deliveries arrive as a form upload — flatten every part
    // (string or file) into one JSON object so nothing is lost.
    const form = await req.formData();
    const parts = {};
    for (const [name, value] of form.entries()) {
      parts[name] = typeof value === "string" ? value : await value.text();
    }
    bodyText = JSON.stringify(parts);
  } else {
    bodyText = await req.text();
  }

  let payloadJson = null;
  try { JSON.parse(bodyText); payloadJson = bodyText; } catch { /* keep raw text only */ }

  const inserted = await sql`
    insert into omni_recall_deliveries (content_type, body_text, payload)
    values (${contentType}, ${bodyText}, ${payloadJson}::jsonb)
    returning id, received_at`;
  return J({ status: 200, body: { ok: true, ...inserted[0] } });
}

export async function onRequest(context) {
  const { request: req, env } = context;
  // Pages Functions expose env per-request, so build the clients here (not at module scope).
  const sql = neon(env.NEON_DATABASE_URL);
  // Accept tokens minted for the client the SPA was built with (baked-in, can't
  // drift from the frontend) PLUS an optional GOOGLE_CLIENT_ID Pages env var as an
  // additional trusted client. Using a set means a missing/stale env var can no
  // longer lock every signed-in user out — the cause of the 401 outage.
  const CLIENT_IDS = [authConfig.google_client_id, env.GOOGLE_CLIENT_ID].filter(Boolean);
  const notesHub = makeNotesHub({ token: env.HUBSPOT_API_TOKEN || "", enabled: !!env.HUBSPOT_NOTES_SYNC });
  const setDealLive = makeDealLiveSetter({ token: env.HUBSPOT_API_TOKEN || "", enabled: !!env.HUBSPOT_DEAL_WRITE });
  const setDealDropped = makeDealDroppedSetter({ token: env.HUBSPOT_API_TOKEN || "", enabled: !!env.HUBSPOT_DEAL_WRITE });

  const url = new URL(req.url);
  // Machine-to-machine webhook (key-authed, not Google-authed) — handled first.
  // The key may ride as ?key=... or as a trailing path segment.
  const omni = url.pathname.match(/\/api\/omni\/recalls(?:\/([^/]+))?\/?$/);
  if (omni) {
    try {
      return await handleOmniRecalls(req, sql, url, omni[1] ? decodeURIComponent(omni[1]) : "");
    } catch (e) {
      return err({ error: String(e) }, 500);
    }
  }

  const sub = url.pathname.replace(/^.*\/onboarding/, ""); // "" | "/step" | "/history" | "/notes" | ...
  // anything under /api/ that isn't /api/onboarding* is not ours
  if (!url.pathname.includes("/onboarding")) return err({ error: "not found" }, 404);

  const gate = async () => {
    const a = await verifyGoogle(req, CLIENT_IDS);
    return a?.email ? a : null;
  };
  const unauth = () => err({ error: "unauthorized — sign in with a @suvera.co.uk Google account" }, 401);

  try {
    // Every GET is auth-gated (the data is private, served only to a signed-in
    // @suvera.co.uk user). /board + /visits serve the bundled dashboard data.
    if (req.method === "GET") {
      const auth = await gate(); if (!auth) return unauth();
      if (sub === "/board") return J({ status: 200, body: boardData });
      if (sub === "/visits") return J({ status: 200, body: visitsData });
      if (sub === "/history") return J(await getHistory(sql, url.searchParams.get("ods")));
      if (sub === "/events") return J(await getEvents(sql));
      if (sub === "/notes") return J(await getNotes(sql));
      if (sub === "/blocks") return J(await getBlocks(sql));
      if (sub === "/live") return J(await getLive(sql));
      if (sub === "/hidden") return J(await getHiddenActivity(sql));
      if (sub === "/dropped") return J(await getDropped(sql));
      return J(await getCurrent(sql));
    }

    if (req.method === "POST" && sub === "/step") {
      const auth = await gate(); if (!auth) return unauth();
      const body = await req.json();
      return J(await postStep(sql, { ...body, changed_by: auth.email || body.changed_by || null }));
    }
    if (req.method === "POST" && sub === "/notes") {
      const auth = await gate(); if (!auth) return unauth();
      const body = await req.json();
      const author = firstNameFromEmail(auth.email) || body.author || null;
      return J(await postNote(sql, notesHub, { ods: body.ods, deal_id: body.deal_id ?? null, body: body.body, author }));
    }
    if (req.method === "PATCH" && sub === "/notes") {
      const auth = await gate(); if (!auth) return unauth();
      const body = await req.json();
      const author = firstNameFromEmail(auth.email) || body.author || null;
      return J(await editNote(sql, notesHub, { id: body.id, body: body.body, author }));
    }
    if (req.method === "DELETE" && sub === "/notes") {
      const auth = await gate(); if (!auth) return unauth();
      const body = await req.json();
      return J(await deleteNote(sql, notesHub, { id: body.id }));
    }
    if (req.method === "POST" && sub === "/block") {
      const auth = await gate(); if (!auth) return unauth();
      const body = await req.json();
      return J(await setBlock(sql, { ...body, by: firstNameFromEmail(auth.email) || body.by || null }));
    }
    if (req.method === "POST" && sub === "/live") {
      const auth = await gate(); if (!auth) return unauth();
      const body = await req.json();
      return J(await markLive(sql, setDealLive, { ods: body.ods, deal_id: body.deal_id ?? null, by: firstNameFromEmail(auth.email) || body.by || null }));
    }
    if (req.method === "POST" && sub === "/hide") {
      const auth = await gate(); if (!auth) return unauth();
      const body = await req.json();
      return J(await hideActivity(sql, { ods: body.ods, activity_key: body.activity_key, by: firstNameFromEmail(auth.email) || body.by || null }));
    }
    if (req.method === "POST" && sub === "/dropped") {
      const auth = await gate(); if (!auth) return unauth();
      const body = await req.json();
      return J(await markDropped(sql, setDealDropped, { ods: body.ods, deal_id: body.deal_id ?? null, by: firstNameFromEmail(auth.email) || body.by || null }));
    }
    return err({ error: "not found" }, 404);
  } catch (e) {
    return err({ error: String(e) }, 500);
  }
}
