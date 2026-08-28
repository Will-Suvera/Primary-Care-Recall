# Planner Outreach Email — Playbook

How we generate personalised HTML outreach emails for every target GP practice. One ODS code → three sequenced emails (V1 / V2 / V3), each with a practice-specific map, local social-proof breakdown, and ICB-aware content. ~140 generated for the Herts/Hemel/St Albans/Watford run; same playbook works for any target list.

The generator is a single Python script. Inputs come from the live pipeline (HubSpot + NHS ODS + onboarding tracker), so the emails always reflect *today's* live + onboarding + signed-up picture.

---

## 0. Quickstart (read this first)

The data refreshes itself. A GitHub Action in this repo pulls HubSpot every 5 minutes and commits the result to `public/data/*.json`. So you don't need a HubSpot token, a Google account, or anything on your machine beyond Python and three pip packages. Every time you `git pull`, you get the latest live picture.

**One-time setup (~3 min):**

```bash
git clone https://github.com/Will-Suvera/Primary-Care-Recall.git
cd Primary-Care-Recall
pip install -r requirements.txt        # staticmap, Pillow, openpyxl
```

**Every time you want to render a batch:**

```bash
git pull                                # gets the most recent 5-min data refresh
python3 scripts/render_planner_outreach_email.py --top 10 --variant all
open public/email/                      # drag HTML files into Gmail / HubSpot
```

That's it. The rest of this doc is reference for *why* the emails look the way they do and how to customise them.

If you don't have Python, install it from python.org (3.10 or later) — macOS already has it; on Windows tick "Add to PATH" during install.

---

---

## 1. The three-email cadence

Send one per week, in order. Each lands on a different lever.

| # | Subject | Lever | Send |
|---|---|---|---|
| **V1** | "Planner is growing in your area" | **Local social proof.** Full map + practice-name breakdown of who in their PCN / 10 mi / ICB is Live / Onboarding / Signed-up. Voice-of-customer testimonials. | Week 1 |
| **V2** | "Recall, on autopilot." | **Feature-led + ICB blocker removed.** Three theme cards (recall that runs itself / one invite per patient / LES built in), same map as social proof, then a "your ICB has signed off Planner's DPA" line — with the named local incentive scheme if applicable. | Week 2 |
| **V3** | "Avoid the end of year scramble." | **Urgency.** QOF-year deadline. No map. Two short testimonials + 3-bullet feature recap + soft CTA. | Week 3 |

The opener in V1 adapts to how close the local proof is:

- **PCN match** (Tier 1–3): "Practices in your PCN have taken it on…"
- **Within 10 mi** (Tier 4): "Practices on your doorstep have taken it on…"
- **Same ICB** (Tier 5): "Practices in your area have taken it on…"

---

## 2. Running it

```bash
# One practice, V1 only (the default)
python3 scripts/render_planner_outreach_email.py F85007

# One practice, all three variants
python3 scripts/render_planner_outreach_email.py F85007 --variant all

# Top 5 practices from the prioritised hitlist, all variants
python3 scripts/render_planner_outreach_email.py --top 5 --variant all

# Every Tier-1 "Not signed up" practice, V2 only
python3 scripts/render_planner_outreach_email.py --tier 1 --status "Not signed up" --variant 2
```

Output lands in `public/email/`:

```
outreach_<ODS>_<slug>_v<N>.html
```

e.g. `outreach_F85007_lawrence-house-surgery_v1.html`. Drag-and-drop into HubSpot, Gmail, or open in a browser to preview.

The hitlist (the ranking + per-practice tier / PCN / ICB anchors) comes from `scripts/push_hitlist_to_sheet.py` — same logic that drives the sales sheet, so emails and the sheet stay in sync.

---

## 3. What gets personalised

Every render pulls live data and renders these per-practice signals into the email:

| Field | Source | Used in |
|---|---|---|
| Target practice name + ODS | `practices_geocoded.json` | Header, map red pin, footer |
| PCN partners who are Live & recalling | `live_customers.json` × PCN join | V1 opener · "Live and recalling" line |
| Practices within 10 mi (Live) | distance calc on `practices_geocoded.json` | Map green pins, breakdown |
| Onboarding practices nearby | snapshots + onboarding sheet | Map blue pins, breakdown |
| Signed-up practices nearby | `waitlist_ods.json` | Map amber pins, breakdown |
| Pre-merger ICB | `practices_geocoded.json` | V2 ICB sign-off line |
| Post-merger ICB | `icb_mapper.py` | V2 ICB display name |
| Named local scheme | hard-coded `ICB_SCHEMES` table | V2 — gets named if known, otherwise generic "we can build LIS/LES" |
| Auto-zoom map | 70th-percentile pin distance | V1/V2 — keeps frame tight even when one anchor is far away |

The hitlist tier (1–5) drives which of {same-PCN / 10-mi / same-ICB} anchors get surfaced as "primary social proof".

---

## 4. Map design

Static OpenStreetMap render (`staticmap`), 900×540 viewport, then resized to 1120 px wide for retina email clients, JPEG q82.

Pin colours (consistent across V1/V2 — print these in the colleague's onboarding):

| Colour | Meaning | Hex | Used by |
|---|---|---|---|
| 🔴 Red, biggest | Target practice (you) | `#e63946` outline `#a91d2b` | the practice we're emailing |
| 🟢 Green | Live + actively recalling | `#16a34a` outline `#0e7c37` | social proof anchors |
| 🔵 Blue | In Progress (onboarding) | `#2563eb` outline `#1e40af` | "your neighbours have committed" |
| 🟡 Amber | Signed-up | `#f59e0b` outline `#b45309` | "your neighbours are interested" |

A custom Pillow renderer draws the pins as PNGs into `/tmp/` once per run.

**Auto-zoom logic** (`_zoom_for_spread`): we pick zoom by the **70th-percentile** pin distance, not the max. That stops a single outlier (e.g. one onboarding practice 4 mi from the target while everything else is within 2 mi) yanking the zoom out and wasting the frame on empty space.

Zoom levels (at UK lat, 900 px wide):
- z=14 ≈ 3 mi
- z=13 ≈ 6.5 mi
- z=12 ≈ 13 mi
- z=11 ≈ 26 mi
- z=10 ≈ 53 mi

---

## 5. ICB-aware content (V2)

V2 closes with a "blocker removed" hook. The script matches the practice's pre- AND post-merger ICB names against this table:

| Pre-merger ICB substring | Scheme display name |
|---|---|
| `north west london` | NWL Enhanced Services |
| `north central london` | NCL LTC LCS Scheme |
| `black country` | Primary Care Capacity Fund (PCCF) |
| `central east` | Enhanced Capacity Framework (ECF) |

If matched: *"And one less thing to worry about: NHS Central East ICB has signed Planner's DPA at ICB level, and Enhanced Capacity Framework (ECF) is designed into Planner."*

If unmatched: generic fallback — *"We can build LIS / LES schemes into Planner for your ICB."*

**To add a new ICB scheme**, append a tuple to `ICB_SCHEMES` in the script:

```python
ICB_SCHEMES = [
    ("north west london", "NWL Enhanced Services", "NHS North West London ICB"),
    # ... existing entries ...
    ("south yorkshire", "Your New Scheme Name", "NHS South Yorkshire ICB"),  # NEW
]
```

The substring is matched case-insensitively against both pre- and post-merger ICB labels, so it works through the 2026-04-01 boundary change.

---

## 6. Brand styling (for hand-edits or new variants)

| Element | Rule |
|---|---|
| Primary navy | `#0E3D89` — headlines, CTAs, attribution names |
| Body slate | `#23496d` — body copy |
| Pale fill | `#EAF0F6` — testimonial cards, value cards, page background |
| Rule colour | `#d4dbe6` — divider above signature |
| Font stack | `Arial, Helvetica, sans-serif` (email-safe; the rendered logo handles brand voice) |
| Headline size | 28 px / line-height 1.2 / weight 700 / letter-spacing –0.3 px |
| Body size | 15 px / line-height 175% |
| Max width | 600 px (the inner white card), 1120 px max image |
| Logo | `https://hub.suvera.co.uk/hs-fs/hubfs/Logo-1.png?width=260` (HubSpot CDN — stable) |
| Signature | Will Gao, Co-Founder, CCO · "Suvera · Proactive Care. Trusted Outcomes." |
| Footer | Aylesbury Works address + unsubscribe line |

### Email-client gotchas (please respect these)

These rules are why the HTML looks the way it does — fight them and you'll see broken renders in Outlook / Gmail dark mode / iOS Mail:

1. **No `<style>` blocks. Every style is inline.** Gmail strips `<head><style>`.
2. **No `em-dash` (`—`).** The script asserts on this — Outlook 2016 still renders em-dashes as `?` in some font stacks. Use `–` or rewrite.
3. **Layout uses `<table role="presentation">` for any 2- or 3-column row**, not flex/grid. The value-strip in V2 and the testimonial pair in V1 both do this. Outlook ignores flexbox.
4. **Images get `width="600"` (or similar) attribute AND `style="width:600px"`** — Outlook reads the attribute, Webmail reads the style. Belt and braces.
5. **Map is base64-inlined** (`data:image/jpeg;base64,…`) so the recipient doesn't need to load a remote image to see the social proof. Big file but worth it.
6. **CTA button** is an `<a>` with `display:inline-block` and inline padding — `<button>` elements are unreliable across clients.
7. **Card heights match via `<tr>` siblings + `height:100%; min-height:140px; box-sizing:border-box`** on the inner div — pure-CSS equal-height tricks don't survive Outlook.

---

## 7. The HTML skeleton (every variant)

All three variants share this shell (`EMAIL_SHELL` in the script). The `{body}` is built per variant from these reusable components:

| Component | Renders |
|---|---|
| `headline(text)` | 28 px navy `<h1>` |
| `intro_para(text)` | "Hi (First name)," and lead paragraphs |
| `body_para(text)` | Normal-weight body paragraphs |
| `map_block(b64, name)` | Inlined JPEG map, alt text = practice name |
| `practice_table(row, …)` | The 4-row "You / Live / Onboarding / Signed up" coloured-dot list |
| `quotes_block()` | Two-column testimonial pair (V1) |
| `_short_quote_card(quote, attribution)` | Single compact testimonial (V3) |
| `value_columns([(title, body), …])` | 3-card value strip (V2) |
| `value_line(strong, rest)` | Single bold-prefix bullet line |
| `cta_block(lead, label, url)` | Single navy button |
| `dual_cta_block(...)` | Two-button row (primary navy + outlined secondary) — used in V1 for webinar link |
| `caption_block(html)` | Small italic caption under the map |
| `legend_block(name)` | Inline coloured-dot legend (alternative to practice_table) |

If you want to hand-author a one-off (e.g. a webinar follow-up to a specific list), copy `EMAIL_SHELL` and compose the body from these helpers — that's how `webinar-email-multi-morbidity-may28.html` was built.

---

## 8. Adding a new variant (V4 etc.)

1. Write a `body_v4(row, green, blue, amber, map_b64, target_name)` function. Compose with the helpers above.
2. Add it to the dispatch tables:
   ```python
   VARIANT_TITLES = { ..., 4: "Your subject line here" }
   VARIANT_BUILDERS = { ..., 4: body_v4 }
   ```
3. Update `render_email_for_row` to call it.
4. Update `--variant` arg validation to accept `4` and `all`.
5. If V4 doesn't need a map, gate the `render_map` call (V3 already does this — map render is ~3 s/practice).

That's it. Run with `--variant 4` to test.

---

## 9. Cost & limits

- Map render is ~3 s/practice (OSM tile fetch). V1 + V2 share the same map within one run — the script renders it once. V3 skips it.
- Output is ~250–330 KB per V1/V2 HTML (base64 map dominates), ~4 KB per V3.
- 140-practice batch (× 3 variants) ≈ 7 min wall time + ~80 MB of HTML on disk.

The `public/email/` folder is gitignored by convention but the files committed in the repo today were intentional (delivery to the colleague who sent the round). If sharing, zip the relevant slice — don't expect the colleague to navigate 420 files.

---

## 10. File pointers

| File | What |
|---|---|
| `scripts/render_planner_outreach_email.py` | The generator (entry point) |
| `scripts/push_hitlist_to_sheet.py` | Hitlist + PCN/ICB anchor logic (imported as `phs`) |
| `scripts/icb_mapper.py` | Pre→post 2026-04-01 ICB merger resolution |
| `public/email/` | Output dir |
| `public/data/practices_geocoded.json` | England GP universe (lat/lng/PCN/ICB/patients) |
| `public/data/live_customers.json` | Live cohort (green pins) |
| `public/data/waitlist_ods.json` | Sign-ups (amber pins) |

Everything else flows out of those three JSONs — refreshed every 5 min by the dashboard's CI cron, so the next batch you render reflects the latest pipeline.
