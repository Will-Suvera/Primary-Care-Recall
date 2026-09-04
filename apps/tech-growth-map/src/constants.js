export const ANNUAL_TARGET = 1500
export const PATIENT_TARGET = 10_000_000

export const QUARTERLY_TARGETS = [
  { q: 'Q1', target: 300, deadline: '2026-03-31' },
  { q: 'Q2', target: 600, deadline: '2026-06-30' },
  { q: 'Q3', target: 1000, deadline: '2026-09-30' },
  { q: 'Q4', target: 1500, deadline: '2026-12-31' },
]

export const MAP_CENTER = [52.8, -1.5]
export const MAP_ZOOM = 6

export const STALE_THRESHOLD_MS = 15 * 60 * 1000 // 15 minutes

// Marker + boundary colours are the Suvera Flow categorical set
// (docs/design/suvera-flow.md → --su-cat-*). Leaflet paints SVG attributes, so
// the hex values are repeated here rather than read from CSS variables.
const FLOW = {
  brand: '#482190',      // --su-cat-live
  brandDeep: '#2E1560',
  ink: '#0E0D0B',        // --su-cat-paid-ring
  amber: '#C4813A',      // --su-cat-onboarding
  sage: '#5E8C7A',       // --su-cat-signed
  none: '#D8D4CC',       // --su-cat-none
  faint: '#8A8579',
}

export const MARKER_STYLES = {
  // Paid (Gold tier) — the headline: brand fill with a heavy ink ring.
  paid: { color: FLOW.ink, fillColor: FLOW.brand, radius: 12, fillOpacity: 1.0, weight: 3, opacity: 1.0 },
  // Live — the brand colour, because it is the thing we sell.
  fullPlanner: { color: FLOW.brandDeep, fillColor: FLOW.brand, radius: 6.5, fillOpacity: 0.95, weight: 1.2, opacity: 0.95 },
  // Onboarding — warm amber.
  inProgress: { color: FLOW.amber, fillColor: FLOW.amber, radius: 4.5, fillOpacity: 0.8, weight: 1, opacity: 0.9 },
  // Signed-up — sage.
  waitlist: { color: FLOW.sage, fillColor: FLOW.sage, radius: 4.2, fillOpacity: 0.75, weight: 1, opacity: 0.85 },
  // Not in the pipeline — quiet.
  notSigned: { color: FLOW.none, fillColor: FLOW.none, radius: 3, fillOpacity: 0.55, weight: 0.3, opacity: 0.6 },
}

export const ICB_STYLES = {
  default: { color: FLOW.faint, weight: 1, fillColor: 'rgba(72,33,144,0.03)', fillOpacity: 1 },
  hover: { color: FLOW.brand, weight: 1.6, fillColor: 'rgba(72,33,144,0.08)', fillOpacity: 1 },
  active: { color: FLOW.brand, weight: 2.2, fillColor: 'rgba(72,33,144,0.14)', fillOpacity: 1 },
}
