import { useState, useEffect, useMemo } from 'react'
import AnimatedNumber from './AnimatedNumber'

function monthLabel(isoMonth) {
  if (!isoMonth) return ''
  return new Date(isoMonth + '-01').toLocaleDateString('en-GB', { month: 'short' })
}

function thisMonth(data) {
  const keys = Object.keys(data?.monthly || {}).sort()
  return keys.length ? { count: data.monthly[keys[keys.length - 1]], label: monthLabel(keys[keys.length - 1]) } : { count: 0, label: '' }
}

function growthMultiple(monthly) {
  const keys = Object.keys(monthly || {}).sort()
  if (keys.length < 2) return null
  const latest = monthly[keys[keys.length - 1]]
  const prev = monthly[keys[keys.length - 2]]
  if (!prev || latest <= prev) return null
  return (latest / prev).toFixed(1)
}

export default function BottomStrip({ recalls }) {
  const [moverIdx, setMoverIdx] = useState(0)
  const [logIdx, setLogIdx] = useState(0)

  // Merge top movers (recalls + bloods combined)
  const topMovers = useMemo(() => {
    if (!recalls) return []
    const combined = {}
    for (const p of recalls.recalls?.practices_this_month || []) {
      if (!combined[p.name]) combined[p.name] = { name: p.name, recalls: 0, bloods: 0, total: 0 }
      combined[p.name].recalls = p.count
      combined[p.name].total += p.count
    }
    for (const p of recalls.bloods?.practices_this_month || []) {
      if (!combined[p.name]) combined[p.name] = { name: p.name, recalls: 0, bloods: 0, total: 0 }
      combined[p.name].bloods = p.count
      combined[p.name].total += p.count
    }
    return Object.values(combined).sort((a, b) => b.total - a.total).slice(0, 5)
  }, [recalls])

  // Activity log entries: mix of recall and bloods events
  const activityEntries = useMemo(() => {
    if (!recalls) return []
    const entries = []
    for (const p of recalls.recalls?.practices_this_month || []) {
      entries.push({ practice: p.name, count: p.count, type: 'recalls' })
    }
    for (const p of recalls.bloods?.practices_this_month || []) {
      entries.push({ practice: p.name, count: p.count, type: 'bloods' })
    }
    return entries.sort((a, b) => b.count - a.count)
  }, [recalls])

  // Rotate biggest mover every 10s (slower = fewer re-renders + fade-ins on the TV)
  useEffect(() => {
    if (topMovers.length === 0) return
    const id = setInterval(() => setMoverIdx(i => (i + 1) % topMovers.length), 10000)
    return () => clearInterval(id)
  }, [topMovers.length])

  // Rotate activity log every 8s
  useEffect(() => {
    if (activityEntries.length === 0) return
    const id = setInterval(() => setLogIdx(i => (i + 1) % activityEntries.length), 8000)
    return () => clearInterval(id)
  }, [activityEntries.length])

  if (!recalls) return null

  const r = thisMonth(recalls.recalls)
  const b = thisMonth(recalls.bloods)
  const rMult = growthMultiple(recalls.recalls?.monthly)
  const bMult = growthMultiple(recalls.bloods?.monthly)
  const mover = topMovers[moverIdx]
  const activity = activityEntries[logIdx]

  return (
    <div className="bottom-strip">
      {/* Patient Care Delivered */}
      <div className="bs-section">
        <div className="bs-header">
          <span className="bs-pulse" />
          <span className="bs-title">Patient Care Delivered</span>
        </div>
        <div className="bs-metrics">
          <div className="bs-metric">
            <div className="bs-value bs-recalls">
              <AnimatedNumber value={recalls.recalls?.total || 0} />
            </div>
            <div className="bs-label">Recalls</div>
            <div className="bs-sub">+{r.count.toLocaleString()} in {r.label}
              {rMult && <span className="bs-mult"> · {rMult}×</span>}
            </div>
          </div>
          <div className="bs-divider" />
          <div className="bs-metric">
            <div className="bs-value bs-bloods">
              <AnimatedNumber value={recalls.bloods?.total || 0} />
            </div>
            <div className="bs-label">Bloods Automated</div>
            <div className="bs-sub">+{b.count.toLocaleString()} in {b.label}
              {bMult && <span className="bs-mult"> · {bMult}×</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Biggest Mover */}
      <div className="bs-section">
        <div className="bs-header">
          <span className="bs-title">Biggest Mover</span>
          {topMovers.length > 0 && <span className="bs-rank">#{moverIdx + 1} of {topMovers.length}</span>}
        </div>
        {mover ? (
          <div className="bs-mover" key={mover.name}>
            <div className="bs-mover-name">{mover.name}</div>
            <div className="bs-mover-stats">
              <span className="bs-mover-stat bs-recalls">{mover.recalls} recalls</span>
              <span className="bs-mover-sep">·</span>
              <span className="bs-mover-stat bs-bloods">{mover.bloods} bloods</span>
            </div>
            <div className="bs-mover-total">{mover.total} total this month</div>
          </div>
        ) : (
          <div className="bs-mover-empty">No activity yet this month</div>
        )}
      </div>

      {/* Live Activity Log */}
      <div className="bs-section">
        <div className="bs-header">
          <span className="bs-live-dot" />
          <span className="bs-title">Live Activity</span>
        </div>
        {activity ? (
          <div className="bs-activity" key={`${activity.practice}-${activity.type}`}>
            <div className="bs-activity-line">
              <strong>{activity.practice}</strong>
            </div>
            <div className="bs-activity-detail">
              sent <strong className={`bs-${activity.type}`}>{activity.count} {activity.type}</strong> this month
            </div>
          </div>
        ) : (
          <div className="bs-activity-empty">Waiting for activity...</div>
        )}
      </div>
    </div>
  )
}
