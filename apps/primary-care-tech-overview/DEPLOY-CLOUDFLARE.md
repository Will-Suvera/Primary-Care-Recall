# Deploying the Planner dashboard to Cloudflare Pages

Replaces Netlify. Cloudflare Pages hosts the static SPA **and** runs the
Neon-backed onboarding API (`functions/api/[[path]].js`) at the edge, same origin
as the app. Cloudflare Access gates the whole site to `@suvera.co.uk`, so the
internal CS data is private. The data is generated fresh in CI and built straight
into the deploy — it is **never committed to this public repo**.

Free tier covers all of this (Pages, Functions/Workers, Access for ≤50 users).

---

## What's already in the repo

| File | Purpose |
|---|---|
| `functions/api/[[path]].js` | The onboarding API as a Cloudflare Pages Function (Neon writes + Google-token auth) — port of the old Netlify function. |
| `wrangler.toml` | Pages project name + `nodejs_compat` (for the Neon driver) + `pages_build_output_dir`. |
| `public/_redirects` | SPA fallback (`/* /index.html 200`). |
| `.github/workflows/deploy-planner-cf.yml` | Generates the data from the source APIs, builds the app, deploys `dist/` to Cloudflare. |
| `.gitignore` | `funnel_board.json` / `practice_visits.json` / `attribution.json` are now ignored (generated in CI, not committed). |

---

## One-time Cloudflare setup (you)

1. **Create the Pages project.** Cloudflare dashboard → *Workers & Pages* → *Create* →
   *Pages* → *Upload assets* (Direct Upload). Name it **`planner-onboarding`**
   (must match `wrangler.toml`'s `name` and the `--project-name` in the workflow —
   rename in both if you use a different one). You can upload an empty folder for
   now; CI will push the real build.

2. **Set the project environment variables** (project → *Settings* → *Variables and
   Secrets*, Production):
   - `NEON_DATABASE_URL` — the Neon connection string (same as local `.env`)
   - `GOOGLE_CLIENT_ID` — the OAuth client id (server-side token verification)
   - *(optional)* `HUBSPOT_API_TOKEN` + `HUBSPOT_NOTES_SYNC=1` and/or `HUBSPOT_DEAL_WRITE=1`
     if you want notes / mark-live to push to HubSpot.

3. **Functions compatibility** (project → *Settings* → *Functions*): set
   *Compatibility date* ≥ `2024-09-23` and add the **`nodejs_compat`** flag
   (matches `wrangler.toml`; the dashboard setting is what the runtime honours).

4. **Gate it with Cloudflare Access** (Zero Trust → *Access* → *Applications* →
   *Add a self-hosted application*), policy = **Emails ending in `@suvera.co.uk`**.
   This locks the site, the data files, AND the `/api/onboarding` endpoint to the team.
   - ⚠️ **Cover the preview/alias hostnames too.** Access is per-hostname, so an app
     scoped only to `planner-onboarding.pages.dev` leaves per-deploy URLs like
     `<hash>.planner-onboarding.pages.dev` and `main.planner-onboarding.pages.dev`
     **unprotected** — anyone with the URL could read the data + open GET API. Add the
     wildcard **`*.planner-onboarding.pages.dev`** (plus any custom domain) to the
     Access application, or disable preview deployments for the project.

5. **Google OAuth origins** (Google Cloud console → the OAuth client): add the Pages
   URL(s) to *Authorized JavaScript origins* —
   `https://planner-onboarding.pages.dev` (and your custom domain) — so sign-in works.

## GitHub Actions secrets (you)

Repo → *Settings* → *Secrets and variables* → *Actions*:
- `CLOUDFLARE_API_TOKEN` — token with **Account → Cloudflare Pages → Edit**
  (My Profile → API Tokens → Create Token).
- `CLOUDFLARE_ACCOUNT_ID` — from the dashboard sidebar.
- `VITE_GOOGLE_CLIENT_ID` — the OAuth client id (baked into the build for sign-in).
- `HUBSPOT_API_TOKEN`, `NOTION_API_TOKEN` — likely already set (used by the data refresh).

## HubSpot → Hub auto-create (webhook, you)

When a Planner deal moves to **DPA Signed Onboard Ready**, HubSpot calls
`POST /api/hubspot/deals` and the practice appears in the Onboarding Hub within
seconds (Neon `onboarding_practices`; the Hub re-polls every minute). Deals whose
company has no ODS show as **ODS missing** until someone adds it in the Hub.
Every delivery (incl. rejections) is logged to Neon `hubspot_webhook_log`.

1. HubSpot → Settings → Integrations → **Private Apps** → the app whose token is
   `HUBSPOT_API_TOKEN` → **Webhooks** tab.
   - Target URL: `https://planner-onboarding.pages.dev/api/hubspot/deals`
   - Create subscription: object **Deals**, event **Property changed**, property **`dealstage`**. Activate it.
2. Same app → **Auth** tab → copy the **Client secret**.
3. Pages project → Settings → Variables and Secrets (Production):
   - `HUBSPOT_WEBHOOK_SECRET` = that client secret (verifies HubSpot's v3 signature)
   - `HUBSPOT_API_TOKEN` = the app token (needs deals + companies read — already granted)
4. Test: move a test deal into DPA Signed Onboard Ready, then check
   `select * from hubspot_webhook_log order by id desc limit 5;` in Neon.

Manual adds ("+ New practice" on the Hub home) need no setup — Hub only, nothing
is written to HubSpot.

## Deploy

Push to `main` (or run the workflow manually). `deploy-planner-cf.yml` regenerates
the data, builds, and deploys. The daily `cron` keeps the data fresh. Visit the
Pages URL — you'll hit the Cloudflare Access login first, then the dashboard.

---

## Already done in this change set

- `refresh-funnel-board.yml` (the daily job that **force-committed** the internal
  data with `git add -f`) and `deploy-planner.yml` (Netlify hook) are **deleted** —
  `deploy-planner-cf.yml` now owns both data refresh and deploy.
- `netlify.toml` and `netlify/functions/onboarding.mjs` are **deleted** (Netlify
  can't serve the dashboard once the data is untracked, since it doesn't regenerate it).
- The data files are **gitignored** and the prod API path is **`/api/onboarding`**.

## Cutover (closes the leak + goes live) — needs a deliberate push

`.gitignore` does **not** untrack already-committed files, and the data is **already
public in `main`'s history**. To actually close the leak:

1. **Untrack the data going forward:**
   ```bash
   git rm --cached \
     apps/primary-care-tech-overview/public/data/funnel_board.json \
     apps/primary-care-tech-overview/public/data/practice_visits.json \
     apps/primary-care-tech-overview/public/data/attribution.json \
     notion_practice_visits.json
   ```
   Commit alongside the migration. (Local files stay on disk for `npm run dev`.)

2. **Scrub the data from history** with `git filter-repo` (purge those paths across
   all commits) then **force-push**. This rewrites public history — irreversible-ish
   and disruptive to other clones, so do it deliberately. ⚠️ Until this runs, the
   data remains readable in past commits even after step 1.

3. **Disable the Netlify site** in the Netlify dashboard (the repo files are already
   removed). Confirm the old Netlify URL no longer serves the dashboard.

4. *(Optional legacy cleanup)* `public/data/` still tracks several files from the old
   6-tab dashboard (`growth_dashboard.json`, `hot_zones.json`, `meeting_intelligence.json`,
   `live_enrichment.json`, …) the current app never fetches. `git rm` them too if unused
   (check `manual_overrides.json` — it may be a hand-edited pipeline input).
