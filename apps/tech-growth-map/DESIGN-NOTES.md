# Growth Map — Suvera Flow restyle (design/flow-restyle)

Visual-only. No data logic, hooks, counting, set membership, tests or `public/data` touched.
Tokens: `src/suvera-flow.css` (copy of `docs/design/suvera-flow.css`). Spec: `docs/design/suvera-flow.md`.

## What changed, by file

| File | Change |
|---|---|
| `src/index.css` | Rewritten on top of `@import './suvera-flow.css'`. Every size is now `rem` off one root font-size so TV mode scales the whole UI. Dark aubergine gradient header → paper header with hairline (laptop) / `--su-brand-deep` (TV). `#f0f3f9` panel → paper column with white 14px cards, no shadows. Purple tooltips / ICB tooltip / popups → white `.su-pop`-style cards. Tier colours → `--su-cat-*`; status colours → `--su-good/warn/bad`. Bitter 500 for hero and card numbers, Inter elsewhere, tabular figures throughout. Sign-in gate is now a card. All class names kept. |
| `src/constants.js` | `MARKER_STYLES` and `ICB_STYLES` moved to the Flow categorical set (Leaflet paints SVG attributes, so the hex values are repeated with a comment). Paid = brand fill + heavy ink ring; Live = brand; Onboarding = amber; Signed-up = sage; Not signed = quiet grey. |
| `src/App.jsx` | `useTvMode()` hook (≈25 lines): `?tv=1` / `?tv=0`, the `t` key (ignored while typing in an input), persisted in `localStorage['growthmap.tv']`, toggles `html.tv`. Passes `tv` / `onToggleTv` to TopBar. |
| `src/components/TopBar.jsx` | Dark logo on laptop, light logo in TV mode; live/stale pill is a Flow status pill; small "TV on/off" toggle. "STALE" → "stale" (rule: labels not ALL CAPS). |
| `src/components/StatsPanel.jsx` | All inline hex styles removed. Patient-lives hero is a white card with a hairline-split pair of sub-figures (`.hero-split`); progress block uses `.hero-progress`; coverage values inherit ink. Sparkline defaults to the brand colour. |
| `src/components/Sparkline.jsx` | Default colour `var(--su-brand)`; colour applied via `style` so CSS variables work. |
| `src/components/LoadingOverlay.jsx` | Inline red/grey → `.loading-error`. |
| `src/components/BottomStrip.jsx`, `PracticeTicker.jsx`, `GrowthStreak.jsx` | Emoji markers (🏆, 🔥) removed per Flow rule 2; the ticker's "live" items now use the brand dot. |
| `index.html` | `theme-color` → paper `#FBFAF8`. |

## TV mode

* Open with `?tv=1`, press `t`, or click the "TV" toggle in the header. It sticks across the 5-minute auto-reload.
* Effect: `--su-scale: 1.45` (root font-size 15px → ~21.75px, everything scales with it), header goes deep brand with white text, search box, zoom control and hover tooltips are hidden. Nothing else changes.
* `?tv=0` or `t` again turns it off.

## Deliberately left

* **Basemap kept as Esri Light Gray Canvas** (not CARTO Positron). The existing comment records that CARTO's free tiles started requiring an API key in Aug 2026; Esri's canvas is keyless and already light/low-saturation, which is what the spec asks for.
* **Legend label "Gold"** and popup label "Gold" for the paid tier are unchanged copy (the colour is no longer gold; the tier name is a business term and a test looks for legend text).
* **Auto-refresh, stale threshold, ticker/mover rotation timings** untouched.
* `has-tooltip` hover tooltips are disabled in TV mode only.

## Verified

`npm test` → 4 files, 35 tests passed. `npm run build` → OK.
`grep -rniE "3f2e5e|6b46c1|e0a06a|f8fafc|1e293b|hanken|readex" src index.html` → nothing.
Not opened in a browser (per instructions); please eyeball `npm run dev` on a laptop and once with `?tv=1`.
