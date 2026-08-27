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

export const MARKER_STYLES = {
  // Gold tier (paying customers) — the headline: big, bright, dark ring.
  // Every other tier is deliberately muted so the gold reads first.
  paid: { color: '#78350f', fillColor: '#f5b301', radius: 10, fillOpacity: 1.0, weight: 3, opacity: 1.0 },
  fullPlanner: { color: '#2f9e5f', fillColor: '#86efac', radius: 5.5, fillOpacity: 0.85, weight: 1.5, opacity: 0.85 },
  inProgress: { color: '#5b8def', fillColor: '#a8c8fa', radius: 4, fillOpacity: 0.7, weight: 1, opacity: 0.7 },
  // Signed-up: small purple dots (amber clashed with the gold paid markers)
  waitlist: { color: '#9b7fd4', fillColor: '#c4b0ec', radius: 3.5, fillOpacity: 0.6, weight: 1, opacity: 0.6 },
  notSigned: { color: '#d7defc', fillColor: '#c3cdf7', radius: 3, fillOpacity: 0.42, weight: 0.3, opacity: 0.5 },
}

export const ICB_STYLES = {
  default: { color: '#3f2e5e', weight: 1.2, fillColor: 'rgba(63,46,94,0.04)', fillOpacity: 1 },
  hover: { color: '#3f2e5e', weight: 2, fillColor: 'rgba(63,46,94,0.1)', fillOpacity: 1 },
  active: { color: '#3f2e5e', weight: 2.5, fillColor: 'rgba(63,46,94,0.18)', fillOpacity: 1 },
}
