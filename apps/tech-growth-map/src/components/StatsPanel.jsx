import { useMemo } from 'react'
import { ANNUAL_TARGET, PATIENT_TARGET, QUARTERLY_TARGETS } from '../constants'
import AnimatedNumber from './AnimatedNumber'
import Sparkline from './Sparkline'
import NewThisWeekBadge from './NewThisWeekBadge'
import MilestoneProgressBar from './MilestoneProgressBar'

function MomBadge({ current, previous }) {
  if (previous == null || previous === 0 || current === previous) return null
  const delta = current - previous
  const pct = Math.round((delta / previous) * 100)
  if (pct === 0) return null
  const arrow = pct > 0 ? '↑' : '↓'
  const cls = pct > 0 ? 'mom-up' : 'mom-down'
  return <div className={`mom-badge ${cls}`}>{arrow}{Math.abs(pct)}% MoM</div>
}

export default function StatsPanel({ practices, liveOds, fullPlannerOds, onboardingOds, waitlistOds, waitlistContacts, timelineOverride, timelineData }) {
  const liveStats = useMemo(() => {
    // Tier counts come from raw set sizes (matches HubSpot + Sheet truth).
    // Tiers are mutually exclusive by construction (refresh_data.py enforces),
    // so set sizes can be summed directly.
    const fullPlannerCount = fullPlannerOds.size
    const inProgressCount = onboardingOds ? onboardingOds.size : 0
    const waitlistCount = waitlistOds.size

    // Patients only available for codes in practices_geocoded.json — codes not
    // in the geocoded set (Y-codes, closed practices) contribute 0 patients.
    let fullPlannerPatients = 0, inProgressPatients = 0, waitlistPatients = 0
    practices.forEach(p => {
      const ods = p.ods.toUpperCase()
      const pat = p.patients || 0
      if (fullPlannerOds.has(ods)) fullPlannerPatients += pat
      else if (onboardingOds && onboardingOds.has(ods)) inProgressPatients += pat
      else if (waitlistOds.has(ods)) waitlistPatients += pat
    })
    const liveCount = fullPlannerCount
    const livePatients = fullPlannerPatients
    const pipeline = fullPlannerCount + inProgressCount + waitlistCount
    const pct = Math.round((pipeline / ANNUAL_TARGET) * 100)
    const coverage = practices.length ? ((pipeline / practices.length) * 100).toFixed(1) : '0.0'
    return { fullPlannerCount, inProgressCount, liveCount, waitlistCount, fullPlannerPatients, inProgressPatients, livePatients, waitlistPatients, pipeline, pct, coverage }
  }, [practices, fullPlannerOds, onboardingOds, waitlistOds])

  const stats = useMemo(() => {
    if (!timelineOverride) return liveStats
    const { practices: tp, patients: tpat } = timelineOverride
    const inProgressCount = tp.in_progress ?? tp.live_planner ?? 0
    const fullPlannerCount = tp.live_full_planner ?? tp.live ?? 0
    const pipeline = fullPlannerCount + inProgressCount + (tp.waitlist || 0)
    const pct = Math.round((pipeline / ANNUAL_TARGET) * 100)
    const coverage = tp.total ? ((pipeline / tp.total) * 100).toFixed(1) : '0.0'
    return {
      fullPlannerCount,
      inProgressCount,
      liveCount: fullPlannerCount,
      waitlistCount: tp.waitlist,
      fullPlannerPatients: tpat.live_full_planner ?? tpat.live ?? 0,
      inProgressPatients: tpat.in_progress ?? tpat.live_planner ?? 0,
      livePatients: tpat.live_full_planner ?? tpat.live ?? 0,
      waitlistPatients: tpat.waitlist,
      pipeline,
      pct,
      coverage,
    }
  }, [liveStats, timelineOverride])

  const prevMonth = useMemo(() => {
    if (!timelineData || timelineData.length < 2) return null
    const now = new Date()
    const target = new Date(now)
    target.setDate(target.getDate() - 30)
    let best = null
    let bestDiff = Infinity
    for (const e of timelineData) {
      const diff = Math.abs(new Date(e.date) - target)
      if (diff < bestDiff) { bestDiff = diff; best = e }
    }
    return best
  }, [timelineData])

  // Sparkline data: last 12 timeline entries
  const sparklines = useMemo(() => {
    if (!timelineData || timelineData.length < 2) return {}
    const recent = timelineData.slice(-12)
    return {
      waitlist: recent.map(e => e.practices.waitlist),
      liveTotal: recent.map(e => e.practices.live),
      pipeline: recent.map(e => e.practices.pipeline),
    }
  }, [timelineData])

  const today = new Date()
  const totalPractices = timelineOverride ? timelineOverride.practices.total : practices.length

  return (
    <div className="stats-panel">
      {/* Patient lives */}
      <div className="hero-stat patients">
        <div className="label">Patient Lives Covered</div>
        <div className="number">
          <AnimatedNumber value={stats.livePatients + stats.inProgressPatients + stats.waitlistPatients} />
        </div>
        <div className="of-target">
          of <span>{PATIENT_TARGET.toLocaleString()}</span> target
        </div>
        <div className="hero-split">
          <div className="hero-split-item">
            <div className="hero-split-value live"><AnimatedNumber value={stats.livePatients} /></div>
            <div className="hero-split-label">Fully Live</div>
          </div>
          <div className="hero-split-sep"></div>
          <div className="hero-split-item">
            <div className="hero-split-value pending"><AnimatedNumber value={stats.inProgressPatients + stats.waitlistPatients} /></div>
            <div className="hero-split-label">To Be Onboarded</div>
          </div>
        </div>
      </div>

      {/* Pipeline + Progress */}
      <div className="hero-stat">
        <div className="label">Total Active Pipeline</div>
        <NewThisWeekBadge timelineData={timelineData} />
        <div className="number"><AnimatedNumber value={stats.pipeline} /></div>
        <div className="pipeline-breakdown">
          <span className="pb-item pb-live">{stats.fullPlannerCount} Live</span>
          <span className="pb-sep">+</span>
          <span className="pb-item pb-in-progress">{stats.inProgressCount} In Progress</span>
          <span className="pb-sep">+</span>
          <span className="pb-item pb-signup">{stats.waitlistCount} Signed-Up</span>
        </div>
        <div className="of-target">of <span>{ANNUAL_TARGET.toLocaleString()}</span> target practices</div>
        <Sparkline data={sparklines.pipeline} height={32} />
        <div className="hero-progress">
          <div className="section-title">Progress to Target</div>
          <MilestoneProgressBar current={stats.pipeline} target={ANNUAL_TARGET} pct={stats.pct} />
          <div className="progress-stats">
            <span className="pct">{stats.pct}%</span>
            <span>{Math.max(ANNUAL_TARGET - stats.pipeline, 0).toLocaleString()} remaining</span>
          </div>
        </div>
      </div>

      {/* Stat cards — 3 columns */}
      <div className="stat-cards three-col">
        <div className="stat-card live-full-planner">
          <div className="value"><AnimatedNumber value={stats.fullPlannerCount} /></div>
          <MomBadge current={stats.fullPlannerCount} previous={prevMonth?.practices?.live_full_planner} />
          <div className="label">Live - Full Planner</div>
        </div>
        <div className="stat-card in-progress">
          <div className="value"><AnimatedNumber value={stats.inProgressCount} /></div>
          <div className="mom-badge mom-flat">0% MoM</div>
          <div className="label">In Progress</div>
        </div>
        <div className="stat-card waitlist">
          <div className="value"><AnimatedNumber value={stats.waitlistCount} /></div>
          <div className="label">Signed-Up List</div>
        </div>
      </div>

      {/* Coverage */}
      <div className="coverage-card">
        <div className="coverage-row">
          <div className="coverage-metric">
            <div className="coverage-value">{stats.coverage}%</div>
            <div className="coverage-label">{stats.pipeline.toLocaleString()} of {totalPractices.toLocaleString()} practices</div>
          </div>
          <div className="coverage-sep"></div>
          <div className="coverage-metric">
            <div className="coverage-value"><AnimatedNumber value={totalPractices} /></div>
            <div className="coverage-label">Total GP Practices</div>
          </div>
        </div>
        <div className="coverage-title">England Coverage</div>
      </div>

      {/* Quarterly targets */}
      <div className="quarterly-section">
        <div className="section-title">2026 Quarterly Targets</div>
        {QUARTERLY_TARGETS.map((qt, i) => {
          const deadline = new Date(qt.deadline)
          const isPast = today > deadline
          const isCurrent = !isPast && (i === 0 || today > new Date(QUARTERLY_TARGETS[i - 1].deadline))
          const progress = Math.min((stats.pipeline / qt.target) * 100, 100)
          const achieved = stats.pipeline >= qt.target
          const cls = achieved ? 'achieved' : isCurrent ? 'on-track' : 'behind'
          return (
            <div className="quarter-row" key={qt.q}>
              <div className="quarter-label">{qt.q}</div>
              <div className="quarter-bar-container">
                <div className={`quarter-bar-fill ${cls}`} style={{ width: `${progress}%` }}></div>
              </div>
              <div className="quarter-target">
                <span className={`actual ${cls}`}>{achieved ? qt.target : stats.pipeline}</span> / {qt.target}
              </div>
            </div>
          )
        })}
      </div>

      {/* Legend */}
      <div className="legend">
        <div className="section-title">Map Legend</div>
        <div className="legend-item"><div className="legend-dot paid"></div><div><span>Gold</span><div className="legend-desc">Paying customer (signed contract)</div></div></div>
        <div className="legend-item"><div className="legend-dot full-planner"></div><div><span>Live - Full Planner</span><div className="legend-desc">Booking links + Pathology enabled</div></div></div>
        <div className="legend-item"><div className="legend-dot in-progress"></div><div><span>In Progress</span><div className="legend-desc">Actively being onboarded</div></div></div>
        <div className="legend-item"><div className="legend-dot waitlist"></div><span>On Signed-Up List</span></div>
        <div className="legend-item"><div className="legend-dot not-signed"></div><span>Not Signed Up</span></div>
      </div>
    </div>
  )
}
