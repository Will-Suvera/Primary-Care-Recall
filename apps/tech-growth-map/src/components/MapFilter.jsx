// Map filter chips. Each filter is a predicate over (status, isActive), where
// status is the map tier from getStatus() and isActive means the practice sent
// recalls this month (recalls.active_ods_this_month).
export const MAP_FILTERS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'pipeline', label: 'All signed', dot: 'signed', match: (s) => s !== 'notSigned' },
  { key: 'paid', label: 'Paid', dot: 'paid', match: (s) => s === 'paid' },
  { key: 'recallingUnpaid', label: 'Recalling · not paid', dot: 'recalling', match: (s, a) => a && s !== 'paid' },
  { key: 'liveIdle', label: 'Live · not recalling', dot: 'live', match: (s, a) => s === 'fullPlanner' && !a },
  { key: 'onboarding', label: 'Onboarding', dot: 'in-progress', match: (s) => s === 'inProgress' },
  { key: 'signedUp', label: 'Signed up', dot: 'signed', match: (s) => s === 'waitlist' },
]

export const FILTER_BY_KEY = Object.fromEntries(MAP_FILTERS.map(f => [f.key, f]))

export default function MapFilter({ value, onChange, counts }) {
  return (
    <div className="map-filter map-overlay-chip" role="group" aria-label="Filter practices">
      {MAP_FILTERS.map(f => (
        <button
          key={f.key}
          type="button"
          className={`map-filter-btn${value === f.key ? ' active' : ''}`}
          aria-pressed={value === f.key}
          onClick={() => onChange(f.key)}
        >
          {f.dot && <span className={`map-filter-dot ${f.dot}`} />}
          {f.label}
          {f.key !== 'all' && counts?.[f.key] != null && <span className="map-filter-count">{counts[f.key]}</span>}
        </button>
      ))}
    </div>
  )
}
