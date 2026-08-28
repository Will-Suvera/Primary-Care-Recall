// Local dev API for the Primary Care Tech Overview dashboard — a thin node-http
// wrapper around the shared handlers in onboarding-core.mjs (the prod Netlify
// Function wraps the SAME core). Onboarding step toggles + notes → Neon Postgres.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { neon } from "@neondatabase/serverless";
import {
  makeNotesHub, makeDealLiveSetter, makeDealDroppedSetter,
  getCurrent, getHistory, getEvents, getNotes, postStep, postNote, editNote, deleteNote,
  getBlocks, setBlock, getLive, markLive, getHiddenActivity, hideActivity, getDropped, markDropped,
} from "./onboarding-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv(key) {
  if (process.env[key]) return process.env[key];
  // repo-root .env (this file is apps/primary-care-tech-overview/api/)
  try {
    const env = readFileSync(resolve(__dirname, "..", "..", "..", ".env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* ignore */ }
  return null;
}

const DATABASE_URL = loadEnv("NEON_DATABASE_URL");
if (!DATABASE_URL) {
  console.error("ERROR: NEON_DATABASE_URL not set (in env or repo-root .env)");
  process.exit(1);
}
const sql = neon(DATABASE_URL);
const PORT = process.env.ONBOARDING_API_PORT || 5175;

// In dev the board + visits come from the locally-generated public/data files
// (prod serves them from the bundled API instead, auth-gated). Read fresh per
// request so a pipeline re-run shows up without a server restart.
const DATA_DIR = resolve(__dirname, "..", "public", "data");
const readData = (file, fallback) => {
  try { return { status: 200, body: JSON.parse(readFileSync(resolve(DATA_DIR, file), "utf8")) }; }
  catch {
    if (fallback !== undefined) return { status: 200, body: fallback };
    return { status: 404, body: { error: `${file} not found — run pipeline/build_funnel_board.py` } };
  }
};

// Best-effort HubSpot note sync. OFF unless HUBSPOT_NOTES_SYNC is set, so the
// first real write to HubSpot is a deliberate choice (token + crm.objects.notes
// write scope also required). Notes are always saved to Neon regardless.
const notesHub = makeNotesHub({ token: loadEnv("HUBSPOT_API_TOKEN"), enabled: !!loadEnv("HUBSPOT_NOTES_SYNC") });
// "Mark live" moves the HubSpot deal stage — OFF unless HUBSPOT_DEAL_WRITE is set
// (so it never fires from local dev); the Neon flag is always recorded regardless.
const setDealLive = makeDealLiveSetter({ token: loadEnv("HUBSPOT_API_TOKEN"), enabled: !!loadEnv("HUBSPOT_DEAL_WRITE") });
const setDealDropped = makeDealDroppedSetter({ token: loadEnv("HUBSPOT_API_TOKEN"), enabled: !!loadEnv("HUBSPOT_DEAL_WRITE") });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((res, rej) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { res(b ? JSON.parse(b) : {}); }
      catch { const e = new Error("invalid JSON body"); e.status = 400; rej(e); }
    });
    req.on("error", rej);
  });

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;
    const send = (r) => json(res, r.status, r.body);

    if (req.method === "GET" && p === "/api/onboarding/board") return send(readData("funnel_board.json"));
    if (req.method === "GET" && p === "/api/onboarding/visits") return send(readData("practice_visits.json", {}));
    if (req.method === "GET" && p === "/api/onboarding") return send(await getCurrent(sql));
    if (req.method === "GET" && p === "/api/onboarding/events") return send(await getEvents(sql));
    if (req.method === "GET" && p === "/api/onboarding/history") return send(await getHistory(sql, url.searchParams.get("ods")));
    if (req.method === "GET" && p === "/api/onboarding/notes") return send(await getNotes(sql));
    if (req.method === "POST" && p === "/api/onboarding/step") return send(await postStep(sql, await readBody(req)));
    if (req.method === "POST" && p === "/api/onboarding/notes") return send(await postNote(sql, notesHub, await readBody(req)));
    if (req.method === "PATCH" && p === "/api/onboarding/notes") return send(await editNote(sql, notesHub, await readBody(req)));
    if (req.method === "DELETE" && p === "/api/onboarding/notes") return send(await deleteNote(sql, notesHub, await readBody(req)));
    if (req.method === "GET" && p === "/api/onboarding/blocks") return send(await getBlocks(sql));
    if (req.method === "POST" && p === "/api/onboarding/block") return send(await setBlock(sql, await readBody(req)));
    if (req.method === "GET" && p === "/api/onboarding/live") return send(await getLive(sql));
    if (req.method === "POST" && p === "/api/onboarding/live") return send(await markLive(sql, setDealLive, await readBody(req)));
    if (req.method === "GET" && p === "/api/onboarding/hidden") return send(await getHiddenActivity(sql));
    if (req.method === "POST" && p === "/api/onboarding/hide") return send(await hideActivity(sql, await readBody(req)));
    if (req.method === "GET" && p === "/api/onboarding/dropped") return send(await getDropped(sql));
    if (req.method === "POST" && p === "/api/onboarding/dropped") return send(await markDropped(sql, setDealDropped, await readBody(req)));

    return json(res, 404, { error: "not found" });
  } catch (e) {
    const status = e?.status || 500;
    if (status >= 500) console.error(e);
    return json(res, status, { error: status === 400 ? "invalid JSON body" : String(e) });
  }
});

server.listen(PORT, () => console.log(`onboarding API → http://localhost:${PORT} (Neon)`));
