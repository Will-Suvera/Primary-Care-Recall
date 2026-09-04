# Recalls Overview — Suvera Flow restyle (design/flow-restyle)

Visual-only. No data logic, stage definitions, Neon calls, onboarding step
toggles, `stalls.js` maths or class names changed. Both tabs (Overview and
Onboarding Hub) now follow `docs/design/suvera-flow.md`.

## What changed, file by file

- **`src/suvera-flow.css`** (new, copied verbatim from `docs/design/suvera-flow.css`) —
  the shared tokens: one accent `#482190`, warm paper neutrals, semantic status
  set, categorical series, Bitter + Inter, radii, the single hero gradient.
- **`src/tokens.css`** — no longer defines the "Aurora" palette. It imports
  `suvera-flow.css` and remaps every legacy `--su-*` name (purple ramp, lilac,
  peach, tint/well/hairline, nav/bar/brand gradients, radii, shadows) onto Flow
  tokens, so every existing `var()` recolours without renaming. Gradients
  collapse to the flat accent; `--su-page-bg` is solid paper; card/hero shadows
  are `none`. Names Flow already owns (`--su-ink`, `--su-card`, `--su-good`,
  `--su-hero-grad`, `--su-font`, radii) are not redefined here.
- **`src/styles.css`** — rewritten value-for-value on the same selectors:
  paper page (no gradient, no `background-attachment: fixed`), paper sidebar
  with a hairline right border, active nav = brand text on a quiet well (no
  gradient pill), sections/`.card`/`.ov-card` = white 14px-radius cards with a
  1px `--su-line` border and no shadow, Bitter 500 for `.ov-title`,
  `.board-title`, `.card-title`, `.ov-card-title`, `.so-title`,
  `.rt-forecast-title`, hero and KPI numbers (`.kpi-value`, `.ov-hero-num`,
  `.rt-now-value`, `.rt-fig-value`), eyebrow labels at 10.5px/.09em, tabular
  numerals on every metric, status pills with hairline borders. The revenue
  hero (`.ov-hero`, `.revtarget-hero`) is the one `--su-hero-grad` surface,
  now with ink type and brand bars instead of white-on-purple. Funnel bars,
  sparkbars, stall bars and the stage-mix strip use `--su-series-1..5`.
  Slide-over, search pop and menus keep `--su-shadow-pop`.
- **`src/components/OnboardingHub.css`** — same approach: `--sv-*` names kept
  and pointed at Flow tokens; every hard-coded hex (blues, oranges, creams,
  purples, greys) replaced with `--su-*` tokens; font-weight 800 → 600/700
  (Inter 800 was never loaded); blocks/tiles/modals at 14px radius, inner rows
  at 8px; Bitter for `.oh-topbar h2`, `.oh-detail-title`, `.oh-block-hdr`,
  `.oh-modal h3`, tile numbers and mini-KPIs; block header bands are white
  with a hairline, not translucent; calendar event kinds use the categorical
  series (onboarding = brand, meeting = grey, recall = amber); the sheet-note
  "cream" becomes the neutral well; the blue "In progress" tile and "booked"
  status use the brand instead of Tailwind blue.
- **`index.html`** — Hanken Grotesk link → Bitter 400/500/600 + Inter 400–700;
  `theme-color` `#482190`.
- **`src/components/OnboardingHub.jsx`, `src/components/FunnelBoard.jsx`** —
  copy untouched except four emoji prefixes removed per the spec
  ("📋 Open Onboarding Form", "📋 From onboarding sheet", "🎉", and the
  📍/📅 next-step icons → plain glyphs). Inline colours in JSX were already
  CSS variables; recharts is in `package.json` but not imported anywhere, so
  there was no chart palette to change.

## Deliberately left

- `recharts` stays in `package.json` (unused; removing a dependency is outside a
  visual restyle).
- `src/stalls.test.js` exists but there is no `npm test` script in this app, so
  no test run was possible; `npm run build` passes.
- Body size stays 14px (denser than Flow's 15px default) because the Overview
  tables and the Hub's all-practices table are read at a desk, not a room.
- Glyph markers (✓ ⚑ ⚠ • ○ –) stay: they are coloured glyphs, which the spec
  allows, not emoji.

## Verify

```
cd apps/primary-care-tech-overview && npm run build
grep -rniE "3f2e5e|6b46c1|e0a06a|f8fafc|1e293b|hanken|readex" src index.html   # → nothing
```
