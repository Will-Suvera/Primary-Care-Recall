// PAID deals by DPA-signed date (HubSpot "PAID -" deals, hs_v2_date_entered_
// DPA Signed, Planner pipeline 3277290730). Pulled 27 Aug 2026 — append new
// paid deals here as they sign.
const PAID_DEALS = [
  { date: '2026-06-12', name: 'Alvaston Medical Centre' },
  { date: '2026-06-12', name: 'Chapelford Primary Care Centre' },
  { date: '2026-07-13', name: 'Wistaria and Milford Surgeries' },
  { date: '2026-07-28', name: 'Bevan Group Practice' },
  { date: '2026-07-30', name: 'Fakenham Medical Practice' },
  { date: '2026-07-31', name: 'Oaklands' },
  { date: '2026-08-19', name: '168 Medical Group' },
  { date: '2026-08-24', name: 'The Pall Mall Surgery (SS9 South PCN)' },
]
const FIRST_PAID_DATE = PAID_DEALS[0].date

function fmtDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function MapTopBar({ timeline }) {
  const { timelineData, sliderIdx, onSliderChange, currentEntry } = timeline

  const dateLabel = currentEntry ? fmtDate(currentEntry.date) : '--'
  const isPaidEra = !!currentEntry && currentEntry.date >= FIRST_PAID_DATE

  // One gold dot per signing date; a date with multiple signings gets a bigger dot.
  const milestones = []
  if (timelineData.length > 1) {
    const byDate = new Map()
    for (const deal of PAID_DEALS) {
      if (!byDate.has(deal.date)) byDate.set(deal.date, [])
      byDate.get(deal.date).push(deal.name)
    }
    for (const [date, names] of byDate) {
      const idx = timelineData.findIndex(e => e.date >= date)
      if (idx === -1) continue
      milestones.push({
        date,
        pct: (idx / (timelineData.length - 1)) * 100,
        names,
        title: `${fmtDate(date)} — PAID: ${names.join(', ')}`,
      })
    }
  }

  return (
    <div className="timeline-mini">
      <span className={`timeline-mini-date${isPaidEra ? ' paid-era' : ''}`}>{dateLabel}</span>
      <div className="timeline-mini-track-wrap">
        <input
          className={`timeline-mini-slider${isPaidEra ? ' paid-era' : ''}`}
          type="range"
          min={0}
          max={timelineData.length - 1 || 0}
          value={sliderIdx}
          onChange={e => onSliderChange(Number(e.target.value))}
        />
        {milestones.map(m => (
          <span
            key={m.date}
            className={`timeline-mini-milestone${m.names.length > 1 ? ' multi' : ''}`}
            style={{ left: `${m.pct}%` }}
            title={m.title}
          />
        ))}
      </div>
    </div>
  )
}
