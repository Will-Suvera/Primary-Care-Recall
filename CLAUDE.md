# Dashboard of Technology-Led Growth — Claude reference

> **Monorepo layout (restructured 2026-06-05).** Two independent apps + a shared pipeline:
> - **`apps/tech-growth-map/`** — the Leaflet map (this doc is mostly about it). Its `src/`, `public/data/`, `public/snapshots/`, `vite.config.js` (base `/Tech-growth-map/`) live here. Deployed to GitHub Pages.
> - **`apps/primary-care-tech-overview/`** — the Planner funnel/onboarding dashboard (was `attribution-dashboard/`).
> - **`pipeline/`** — all shared Python + `override_server.js` (was `scripts/`). Scripts resolve paths from the repo root.
> - **Shared data contract:** upstream JSONs (`recalls`, `practices_geocoded`, `waitlist_ods`, `live_customers*`, `onboarding_ods`, `practice_tiers`, snapshots) live in `apps/tech-growth-map/public/data/`; the dashboard's pipeline reads them cross-app and writes its own JSON to `apps/primary-care-tech-overview/public/data/`.
>
> Some inline paths below predate the restructure — mentally map `scripts/`→`pipeline/`, `attribution-dashboard/`→`apps/primary-care-tech-overview/`, and bare `public/data`/`src`→ under `apps/tech-growth-map/`. See `README.md`.

This is the Suvera GP Practice Growth Dashboard: a React + Leaflet map of
every England GP practice, colour-coded by sign-up / onboarding / live status,
with supporting stats, sparklines and target tracking.

## Run

```bash
npm run dev            # Vite dev server (localhost:5173)
npm run build          # production bundle -> dist/
npm test               # vitest (React component tests)
python3 -m unittest discover tests   # Python data + pipeline tests
```

Data refreshes run automatically every 5 minutes via GitHub Actions cron
(`.github/workflows/...`); they call `pipeline/refresh_data.py --waitlist`.

## Architecture at a glance

```
┌──────────────────┐   ┌──────────────────┐   ┌─────────────────────────┐
│  NHS ODS API     │   │  HubSpot List    │   │  Google Sheets          │
│  (RO177 GP practs│   │  1535 — Waitlist │   │  Onboarding tracker     │
│   + RE4/RE6 for  │   │  + PCN expansion │   │  (Col G Status / H ODS) │
│   SICBL lookup)  │   │                  │   │                         │
└────────┬─────────┘   └────────┬─────────┘   └─────────────┬───────────┘
         │                      │                           │
         ▼                      ▼                           ▼
  practices_geocoded.json  waitlist_ods.json     live_customers.json
  (~6,400 England GPs)     (~325 ODS codes)      live_customers_full_planner.json
         │                      │                           │
         └──────────┬───────────┴──────────┬────────────────┘
                    ▼                      ▼
             src/App.jsx  →  DashboardMap.jsx  +  StatsPanel.jsx
                    │
                    ▼
             Leaflet map + stats, served by Vite
```

## Data files (public/data/)

| File | Source | Shape | Written by |
|---|---|---|---|
| `practices_geocoded.json` | NHS ODS API + postcodes.io + NHS Digital (patients) + ODS ePCN | `[{ods, name, postcode, lat, lng, pcn_name, pcn_code, icb, patients}]` | `pipeline/refresh_data.py --practices` (ods/name/postcode/lat/lng), `refresh_patient_sizes()` (patients), `refresh_pcn_icb()` (pcn_name/pcn_code/icb from the live ODS ePCN report via `ods_pcn.py`, 24h cache, runs on the 5-min cron — replaced the legacy name-joined static fields 2026-07-31). |
| `waitlist_ods.json` | HubSpot list 1535 → expanded PCNs | `["A12345", ...]` sorted | `pipeline/refresh_data.py --waitlist` |
| `live_customers.json` | Google Sheet onboarding tracker | `["A12345", ...]` sorted | `pipeline/refresh_data.py` (subset where Status=="Live") |
| `live_customers_full_planner.json` | Manually curated | `["A12345", ...]` | hand-edited |
| `recalls.json` | Omni → Google Sheet | `[{ods, patients_awaiting_recall}]` | `pipeline/refresh_data.py` |
| `waitlist_meta.json` | HubSpot contacts count | `{contacts: N}` | `pipeline/refresh_data.py` |
| `icb_boundaries.geojson` | ONS / NHS | GeoJSON | static |

## Status tiers (single source of truth: `src/components/DashboardMap.jsx:25-30`)

A practice's status is determined purely by **ODS code set membership**,
checked in this priority order:

1. **Live — Full Planner** — ODS ∈ `live_customers_full_planner.json` (booking links + pathology enabled).
2. **Live — Partial Planner** — ODS ∈ `live_customers.json` and NOT in full planner set. Displayed as "Live".
3. **On Sign-Up List** — ODS ∈ `waitlist_ods.json`. Displayed as "Signed up".
4. **Not Signed Up** — none of the above.

The waitlist set is **disjoint from** the live set by construction
(`pipeline/refresh_data.py:565`: `waitlist_ods -= LIVE_CUSTOMER_ODS`). Tests in
`tests/test_data_validity.py` enforce invariants on these files.

## Counting logic (must match the map)

The dashboard iterates `practices_geocoded.json` — the England-only GP
universe — and classifies each practice by set membership. Any ODS code in
waitlist/live but NOT in `practices_geocoded.json` is **silently ignored**
because the map has nowhere to display it. This is deliberate but means the
displayed totals can be slightly lower than HubSpot's raw member count.

Canonical loop (copy when writing downstream scripts):

```python
for p in practices_geocoded:
    ods = p["ods"].upper()
    if ods in live_full:    status = "Live"
    elif ods in live_all:   status = "Onboarding"   # partial planner
    elif ods in waitlist:   status = "Signed up"
    else:                   continue                # not in pipeline
```

At the time of writing this matches the map: **357 signed = 18 Live +
46 Onboarding + 293 Signed up**, down from 389 raw waitlist/live ODS codes —
the 32-code gap is non-England-GP codes (Y/W specials, Scottish/Welsh
practices, PCN-only codes) and is expected.

## Refresh pipeline (`pipeline/refresh_data.py`)

Flow for `--waitlist` (runs every 5 minutes in CI):

1. `GET /crm/v3/lists/1535/memberships` → paginated contact IDs.
2. Batch-read contact details (`/crm/v3/objects/contacts/batch/read`).
3. Filter internal Suvera / test contacts by email+firstname.
4. Batch-read contact → company associations (v4 API).
5. Fetch company properties (name, `practice_code`, `ods_unique`, `organisation_type`).
6. For each company: if ODS present → add; elif PCN → expand via
   `expand_pcn_to_practices` (v4 associations, whitelisted by
   `organisation_type ∈ {gp practice, gp surgery, ...}`).
7. For un-associated contacts → fuzzy search company by name.
8. Subtract live customer ODS set (keeps waitlist disjoint).
9. **Safety nets** before writing `waitlist_ods.json`:
   - Schema validation: list[str], each 3-10 alphanumerics, ≥50 entries.
   - Shrink guard: refuse to write if new file is >10% smaller than previous
     (`WAITLIST_SHRINK_LIMIT`). Stops a partial HubSpot response from wiping
     real sign-ups.

### HubSpot auth

Set `HUBSPOT_API_TOKEN` in `.env` (gitignored) or as a GitHub Actions
secret. Without it the script exits with a clear error.

### NHS ODS API retry policy

`hubspot_request()` retries on 429 + 5xx with exponential backoff
(base 1.5s, max 3 attempts). The ODS directory API is fetched without retry
but tolerates missing postcodes (practice dropped from output).

## ICB merger programme (2026-04-01)

On 2026-04-01, 12 existing ICBs are being abolished to form 6 new ICBs;
Hampshire & IoW gets a boundary change (keeps its name). The dashboard must
group practices by the **post-merger** ICB so that performance metrics are
comparable across the boundary change.

Source of truth: `ODS+Change+Summary+ICB+Mergers+Phase+1+Apr+2026 (2).xlsx`
at the repo root. Two sheets are load-bearing:

- `SICBL Changes` — pre→post ICB + SICBL renames.
- `GP Practice Moves` — the per-practice Frimley destination table (Frimley
  is the only ICB that splits at LSOA level, so SICBL alone can't resolve it).

### Resolution logic (`pipeline/icb_mapper.py`)

Pure-Python module, tested in `tests/test_icb_mapper.py`. Three categories:

1. **Simple 1:1 relabel** (9 ICBs) — just rename. E.g. `NHS North Central
   London ICB` → `NHS West and North London ICB`.
2. **Split by SICBL** (2 ICBs) — disambiguate per-practice by fetching the
   active Sub ICB Location code (`RO98`) via NHS ODS API.
   - Herts & W Essex: 06K/06N → Central East, 07H → Essex
   - Suffolk & NE Essex: 06L/07K → Norfolk & Suffolk, 06T → Essex
3. **Frimley split by LSOA** — use the per-practice map from the xlsx
   (`build_frimley_map`). 68 GP practice rows, each destined for one of
   Thames Valley / Surrey & Sussex / Hampshire & IoW.

SICBL lookups are cached in `pipeline/.sicbl_cache.json` (gitignored; safe
to delete — will rebuild on next run).

### Failure modes — the module raises, not guesses

`resolve_icb` raises `UnresolvableSplit` if:

- a SPLIT practice's SICBL can't be fetched, or
- the fetched SICBL isn't in the known map, or
- a Frimley practice isn't in the xlsx move table, or
- a Frimley practice is passed without a `frimley_map` argument.

This is deliberate — a silent fallback would mislabel practices and the
issue wouldn't surface until someone noticed pipeline numbers in the wrong
ICB. The downstream `build_merged_icb_xlsx.py` collects errors, prints them,
and exits non-zero.

### Using it

```python
from icb_mapper import SicblCache, build_frimley_map, resolve_icb

frimley_map = build_frimley_map("ODS+Change+Summary+...xlsx")
sicbl = SicblCache("pipeline/.sicbl_cache.json")  # disk-backed

for practice in practices:
    new_icb = resolve_icb(
        practice["icb"], practice["ods"],
        sicbl_lookup=sicbl,
        frimley_map=frimley_map,
    )
```

## Frontend components

| Component | Responsibility |
|---|---|
| `App.jsx` | Loads data files, wires sets, timelineData; hosts layout. |
| `DashboardMap.jsx` | Leaflet map + ICB boundary overlay + per-practice markers. Status classification lives here (lines 22-30). |
| `StatsPanel.jsx` | Hero numbers, MoM badges, sparklines, quarterly targets, legend. Counting loop must stay in sync with the map — tests in `src/components/StatsPanel.test.jsx`. |
| `PracticeTicker.jsx` | Rolling "recent activity" ticker. |
| `NewThisWeekBadge.jsx` | "+N this week" pill on the pipeline card. |
| `MilestoneProgressBar.jsx` | Target progress bar. |
| `Sparkline.jsx` | Tiny inline charts for timeline data. |
| `AnimatedNumber.jsx` | Number tween on update. |

## Patient list sizes (`pipeline/patient_list_sizes.py`)

**Source:** NHS Digital "Patients Registered at a GP Practice" — the
authoritative, stable monthly publication. Every other NHS list-size
dataset derives from this one. NHS ODS API does *not* expose list sizes.

Why this over alternatives (hardcoded URLs, NHSBSA open data, internal
sheets): stable landing URL, stable CSV filename (`gp-reg-pat-prac-all.csv`
since 2015), monthly cadence on a fixed day, complete coverage. The only
variable is the CDN hash in the file URL — the module discovers it by
scraping the landing + publication pages.

**Pipeline:**

1. Landing page → extract `/patients-registered-at-a-gp-practice/<month-year>`
   slugs, sort newest-first.
2. For each slug (up to 6 back), fetch the publication page and regex for
   `gp-reg-pat-prac-all.csv`. Walking back covers the case where NHS Digital
   pre-lists an upcoming month before data is actually published.
3. Download + parse CSV, keyed on `CODE` → `NUMBER_OF_PATIENTS`.
4. Schema checks: required columns, integer-only list sizes, no negatives,
   row count within `[MIN_PRACTICES=5500, MAX_PRACTICES=10000]`.
5. 24h disk cache (`pipeline/.patient_list_sizes_cache.json`, gitignored) so
   the 5-min CI refresh loop isn't hitting NHS Digital 12×/hour for a monthly
   dataset.

**Error policy.** All HTTP + parse failures raise specific `PatientListError`
subclasses. In `refresh_data.py` they're caught and logged as a warning,
leaving `practices_geocoded.json` patient values untouched — stale numbers
are better than wiping real ones when the scrape breaks.

**Coverage today.** ~5,900 of ~6,400 England GP practices have list sizes
written from this feed; the remainder are freshly-opened or closing
practices not in the latest month's extract. For signed-up practices (the
users the dashboard actually cares about), coverage is 354/357.

## Known gaps — read before making changes

### `live_customers_full_planner.json` is hand-edited
`tests/test_data_validity.py` has hardcoded expectations on which codes
should be in that set. Keep them in sync when adding a practice to the
full-planner tier, or the existing `TestLiveCustomers` tests will fail.

### 35+ practices have `icb: "#N/A"` or malformed ICB names
Examples: `NHS Shropshire, Telford and Wrekin ICB - M2L0M` (stray SICBL
suffix), `NHS England London`, blank ICB. These pass through the merger
resolver unchanged. Cleaner source data would fix it; until then, they
show as their raw value in the xlsx report.

## Testing

| Suite | Tool | Scope |
|---|---|---|
| `tests/test_data_validity.py` | unittest | Shape + invariants of JSON data files |
| `tests/test_refresh_pipeline.py` | unittest | Mocked end-to-end refresh flow |
| `tests/test_snapshot.py` | unittest | Snapshot script arithmetic |
| `tests/test_icb_mapper.py` | unittest | ICB merger resolution (simple relabels, SPLIT by SICBL, Frimley, cache, end-to-end parity) |
| `tests/test_patient_list_sizes.py` | unittest | NHS Digital list-size fetcher (URL discovery, CSV parse, apply, cache TTL). No live HTTP. |
| `src/**/*.test.jsx` | vitest | React component rendering |

Run everything:
```bash
npm test && python3 -m unittest discover tests
```

## Scripts

| Script | Purpose |
|---|---|
| `pipeline/refresh_data.py` | The refresh pipeline (practices + waitlist + live customers + recalls). Runs every 5 min in CI. |
| `pipeline/snapshot.py` | Writes a timestamped snapshot to `public/snapshots/` for MoM comparisons. |
| `pipeline/icb_mapper.py` | Pure logic for pre→post merger ICB resolution. |
| `pipeline/patient_list_sizes.py` | Fetch + parse NHS Digital monthly patient list sizes. |
| `pipeline/build_merged_icb_xlsx.py` | Generates `signups_by_icb.xlsx` — all 357 signed practices with post-merger ICB labels, PCN, status, patients. Run on demand. |
| `pipeline/run_refresh.sh` / `fire_dispatch.sh` | Thin shell wrappers used by CI. |

## Gotchas

- **Google Sheets onboarding tracker is READ-ONLY.** Never write to it,
  add columns to it, or propose schema changes — it's manually maintained
  by the user as the operational source of truth for onboarding/Live
  status. Programmatic writes risk overwriting in-flight edits. Derive
  any new fields (signup date, live date, transition history) from
  snapshots or HubSpot instead.
- **Never use `git add -A` or `git add .`** — the repo root contains `.env`
  and the large xlsx; stage files by path.
- **Don't rename `waitlist_ods.json`** — the shrink-guard in
  `write_waitlist_safely` keys on the filename.
- **ODS codes must be uppercased** everywhere. Set membership tests fail
  silently otherwise.
- **The 5-min CI cadence matters.** If `refresh_data.py` hangs or throws,
  `waitlist_ods.json` won't update, and the map shows stale data without a
  visible banner. `STALE_THRESHOLD_MS = 15 min` in `src/constants.js` is the
  frontend's freshness check — see `src/hooks/` for where it's used.
