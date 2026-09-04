import { useState, useEffect, useMemo } from 'react'
import { STALE_THRESHOLD_MS } from '../constants'

function formatAge(ms) {
  if (ms < 0) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) {
    const rs = s - m * 60
    return rs > 0 && m < 5 ? `${m}m ${rs}s ago` : `${m}m ago`
  }
  const h = Math.floor(m / 60)
  const rm = m - h * 60
  return `${h}h ${rm}m ago`
}

export default function TopBar({ timeline, tv = false, onToggleTv }) {
  const [now, setNow] = useState(Date.now())

  // Tick every second for live age display
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const { timelineData } = timeline
  const lastEntry = timelineData.length ? timelineData[timelineData.length - 1] : null
  const dataTimestamp = lastEntry?.timestamp

  const ageMs = dataTimestamp ? now - new Date(dataTimestamp).getTime() : null
  const stale = ageMs != null && ageMs > STALE_THRESHOLD_MS

  // Compute median cadence from last ~20 entries
  const cadenceLabel = useMemo(() => {
    if (!timelineData || timelineData.length < 3) return ''
    const recent = timelineData.slice(-20).map(e => new Date(e.timestamp).getTime()).sort((a, b) => a - b)
    const gaps = []
    for (let i = 1; i < recent.length; i++) gaps.push(recent[i] - recent[i - 1])
    if (!gaps.length) return ''
    gaps.sort((a, b) => a - b)
    const median = gaps[Math.floor(gaps.length / 2)]
    const medianMin = Math.round(median / 60000)
    return medianMin <= 0 ? '<1m' : `~${medianMin}m`
  }, [timelineData])

  const ageText = ageMs != null ? formatAge(ageMs) : 'loading...'

  return (
    <div className="top-bar">
      <div className="logo-section">
        <img src={`${import.meta.env.BASE_URL}assets/${tv ? 'suvera-logo-light.png' : 'suvera-logo.png'}`} alt="Suvera" />
        <div className="title-group">
          <h1>Suvera Patient Growth In UK</h1>
          <div className="subtitle">England - Technology Led Growth</div>
        </div>
      </div>
      <div className="top-actions">
        <div className={`live-badge${stale ? ' stale' : ''}`}>
          <div className="dot"></div>
          <span>
            Last updated: <span className={stale ? 'stale' : ''}>
              {stale ? `${ageText} — stale` : ageText}
            </span>
          </span>
        </div>
        {onToggleTv && (
          <button
            type="button"
            className={`tv-toggle${tv ? ' on' : ''}`}
            onClick={onToggleTv}
            aria-pressed={tv}
            title="Toggle TV mode (t)"
          >
            TV {tv ? 'on' : 'off'}
          </button>
        )}
      </div>
    </div>
  )
}
