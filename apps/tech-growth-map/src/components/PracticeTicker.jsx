import { useState, useEffect, useMemo } from 'react'

const BASE = import.meta.env.BASE_URL

function fmtDate(dateStr) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export default function PracticeTicker({ practices, timelineData }) {
  const [recentChanges, setRecentChanges] = useState([])

  // Build an ODS → practice name lookup
  const odsToName = useMemo(() => {
    const map = {}
    practices.forEach(p => { map[p.ods.toUpperCase()] = p.name })
    return map
  }, [practices])

  // Load last ~7 daily snapshots and diff them to find new additions
  useEffect(() => {
    if (!timelineData || timelineData.length < 2 || !practices.length) return

    const recent = timelineData.slice(-7)
    const dates = recent.map(e => e.date)

    Promise.all(
      dates.map(d =>
        fetch(`${BASE}snapshots/${d}.json`, { cache: 'no-cache' })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    ).then(snapshots => {
      const changes = []
      for (let i = 1; i < snapshots.length; i++) {
        const prev = snapshots[i - 1]
        const curr = snapshots[i]
        if (!prev || !curr) continue

        const prevLive = new Set(prev.live_ods || [])
        const currLive = new Set(curr.live_ods || [])
        const prevWaitlist = new Set(prev.waitlist_ods || [])
        const currWaitlist = new Set(curr.waitlist_ods || [])

        // New go-lives
        for (const ods of currLive) {
          if (!prevLive.has(ods)) {
            changes.push({ ods, status: 'live', date: curr.date })
          }
        }
        // New sign-ups
        for (const ods of currWaitlist) {
          if (!prevWaitlist.has(ods)) {
            changes.push({ ods, status: 'signup', date: curr.date })
          }
        }
      }
      // Live first (most exciting), then by most recent date
      changes.sort((a, b) => {
        if (a.status !== b.status) return a.status === 'live' ? -1 : 1
        return b.date.localeCompare(a.date)
      })
      setRecentChanges(changes)
    })
  }, [timelineData, practices.length])

  const items = useMemo(() => {
    return recentChanges.map(c => ({
      key: `${c.ods}-${c.date}`,
      name: odsToName[c.ods] || c.ods,
      status: c.status,
      label: c.status === 'live' ? 'Went Live' : 'Signed Up',
      date: fmtDate(c.date),
    }))
  }, [recentChanges, odsToName])

  if (items.length === 0) return null

  // Duplicate for seamless loop
  const display = items.length < 10 ? [...items, ...items, ...items] : [...items, ...items]

  return (
    <div className="practice-ticker">
      <div className="ticker-track" style={{ animationDuration: `${Math.max(display.length * 3, 60)}s` }}>
        {display.map((item, i) => (
          <span className="ticker-item" key={i}>
            <span className={`ticker-dot ${item.status}`} />
            <span className="ticker-name">{item.name}</span>
            <span className={`ticker-label ${item.status}`}>{item.label} {item.date}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
