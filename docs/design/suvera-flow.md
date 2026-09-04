# Suvera Flow — design system for internal dashboards

Derived from the Flow Design Guidelines (`Appt-config-update.html`: "one accent,
warm neutrals, Bitter + Inter") and the Practice Insights tool (`globals.css`,
`practice-header.tsx`, `data-cards.tsx`). Applies to **Growth Map**
(`apps/tech-growth-map`) and **Recalls Overview / Planner** (`apps/primary-care-tech-overview`),
both tabs. Tokens: `docs/design/suvera-flow.css` (copy into each app as `src/suvera-flow.css`).

## The six rules

1. **One accent.** `#482190` is for primary actions, active/selected/focus states, the
   "Live" tier and the primary chart series. Never as decoration, never as a big fill
   behind text (the sign-in button and TV-mode header are the exceptions).
2. **Warm paper, white cards, hairlines.** Page `#FBFAF8`, cards `#FFFFFF` with a 1px
   `#E2E1DE` border and 14px radius. No drop shadows on cards; shadows only on
   popovers/menus. No coloured left bars, no tinted card backgrounds, no emoji markers.
3. **Bitter for what is read, Inter for what is scanned.** H1 32/500, section heads
   19/500, hero KPI numbers in Bitter 500 with tabular figures. Everything else Inter.
   Labels are eyebrows: 10.5px, uppercase, .09em tracking, `--su-faint`, 700.
4. **Colour means something.** Green/amber/red only for real status (stale data,
   missed target, blocked). Map tiers and chart series use the categorical set
   (`--su-cat-*`, `--su-series-*`), which is purple / amber / sage / grey. Never
   Tailwind-bright emerald, sky, rose, etc.
5. **Numbers are tabular, everywhere.** `font-variant-numeric: tabular-nums` on any
   digit that sits in a column or updates in place.
6. **One gradient per app, at most.** `--su-hero-grad` (soft lilac → peach, from the
   Insights practice header) may sit behind exactly one hero surface (the revenue
   goal hero, or the map's TV header). Nowhere else. The old aubergine→peach header
   gradient and the "Aurora" page gradient go.

## Components, translated

| Old | New |
|---|---|
| Dark aubergine top bar (growth map) | Laptop: paper header, 1px hairline below, logo left, Bitter title, live/stale as a `.su-status` pill. TV mode: `--su-brand-deep` ground with white type. |
| Left stats panel `#f0f3f9` with shadowed cards | Paper column, `.su-panel` cards, eyebrow label + `.su-kpi` number + one-line Inter caption. MoM badge = `.su-status`. |
| Sparklines (multi-colour) | Line in `--su-brand`, 1.5px, faint area fill `--su-brand-tint`, endpoint dot. Axis text `--su-faint`. |
| Map markers (bright status colours) | `--su-cat-live` / `--su-cat-onboarding` / `--su-cat-signed` / `--su-cat-none`; paid = 2px `--su-cat-paid-ring` outline. Light, low-saturation basemap (CARTO Positron or equivalent) so pins carry the colour. Popups = `.su-pop`. |
| "Aurora" sidebar + page gradient (planner) | Paper sidebar, hairline right border, Inter nav with brand text for the active item and a `.su-chip` count. Content on paper, sections in `.su-panel`. |
| Revenue hero gradient | The one allowed `--su-hero-grad` surface; Bitter number; muted caption. |
| Funnel stage bars / recharts palette | `--su-series-*`; grid lines `--su-line`; tooltips `.su-pop`. |
| Hanken Grotesk / Readex Pro / Inter-300 | Bitter + Inter only. Remove other font links. |
| Tooltips (dark purple boxes) | `.su-pop` white card, ink text, 12.5px. |
| Sign-in gate | Centred `.su-panel`, logo, Bitter H1, muted copy, Google button. |

## Growth map: laptop first, TV mode second

* Default = laptop density (body 15px).
* **TV mode** turns on with `?tv=1`, the `t` key, or a small "TV" toggle in the header;
  persisted in `localStorage`. It sets `html.tv` and `--su-scale: 1.45`, which scales
  type and spacing through `calc(… * var(--su-scale))`, hides search/hover-only
  chrome and the sign-out affordance, and swaps the header to `--su-brand-deep` with
  white text for cross-room contrast. Nothing else changes.
* Auto-refresh and stale banner keep working in both modes.

## Do not

* Change data logic, hooks, counting loops, set membership, tests' expectations, or
  any file under `public/data`.
* Add libraries. Both apps stay on their current dependencies.
* Reintroduce `#3f2e5e`, `#6b46c1`, `#e0a06a`, `#f8fafc`, `#1e293b` or any Tailwind
  palette hex. Grep for them before finishing.
* Use `Kind regards`-style copy changes. Copy stays as-is except where a label was
  ALL CAPS or emoji-prefixed.

## Definition of done (per app)

* `npm run build` passes; `npm test` passes where tests exist.
* No leftover font links other than Bitter + Inter.
* `grep -rniE "3f2e5e|6b46c1|e0a06a|f8fafc|1e293b|hanken|readex" src` returns nothing.
* A short `DESIGN-NOTES.md` in the app root listing what changed and anything deliberately left.
