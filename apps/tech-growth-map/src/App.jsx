import { useEffect, useRef, useState } from 'react'
import TopBar from './components/TopBar'
import StatsPanel from './components/StatsPanel'
import DashboardMap from './components/DashboardMap'
import LoadingOverlay from './components/LoadingOverlay'
import { useDashboardData } from './hooks/useDashboardData'
import { useTimeline } from './hooks/useTimeline'
import { useGoogleAuth } from './auth'

// Same Google SSO gate as the Recalls Overview app (@suvera.co.uk only).
function SignInGate({ auth }) {
  const ref = useRef(null)
  useEffect(() => { auth.renderButton(ref.current) }, [auth.ready])
  return (
    <div className="signin-gate">
      <img className="signin-logo" src={`${import.meta.env.BASE_URL}assets/suvera-logo.png`} alt="Suvera" />
      <h1>Suvera Growth Map</h1>
      <p>Sign in with your <b>@suvera.co.uk</b> Google account to continue.</p>
      <div ref={ref} />
    </div>
  )
}

// Auto-refresh the page every 5 minutes so the TV display stays fresh
const AUTO_REFRESH_MS = 5 * 60 * 1000

// TV mode: `?tv=1`, the `t` key, or the header toggle. Persisted so the wall
// display survives the 5-minute reload. Sets html.tv, which the stylesheet
// turns into --su-scale: 1.45 + the dark header (see docs/design/suvera-flow.md).
const TV_KEY = 'growthmap.tv'
function useTvMode() {
  const [tv, setTv] = useState(() => {
    try {
      const q = new URLSearchParams(window.location.search).get('tv')
      if (q === '1') return true
      if (q === '0') return false
      return localStorage.getItem(TV_KEY) === '1'
    } catch { return false }
  })
  useEffect(() => {
    document.documentElement.classList.toggle('tv', tv)
    try { localStorage.setItem(TV_KEY, tv ? '1' : '0') } catch { /* private mode */ }
  }, [tv])
  useEffect(() => {
    const onKey = e => {
      if (e.key !== 't' || e.metaKey || e.ctrlKey || e.altKey) return
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return
      setTv(v => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return [tv, () => setTv(v => !v)]
}

export default function App() {
  const auth = useGoogleAuth()
  const [tv, toggleTv] = useTvMode()
  useEffect(() => {
    const id = setTimeout(() => location.reload(), AUTO_REFRESH_MS)
    return () => clearTimeout(id)
  }, [])
  const { practices, liveOds, fullPlannerOds, onboardingOds, paidOds, waitlistOds, waitlistContacts, recalls, loading, error, setLiveOds, setFullPlannerOds, setOnboardingOds, setPaidOds, setWaitlistOds } = useDashboardData()
  const timeline = useTimeline()

  // Google SSO gate (prod only — enabled when VITE_GOOGLE_CLIENT_ID is set)
  if (auth.enabled && auth.ready && !auth.user) return <SignInGate auth={auth} />
  if (auth.enabled && !auth.ready) return null

  // When timeline slider is not at the latest entry, use the timeline's aggregate
  // counts to override the stats panel (since individual snapshot ODS files may not exist)
  const isLatest = timeline.timelineData.length === 0 || timeline.sliderIdx === timeline.timelineData.length - 1
  const timelineOverride = !isLatest ? timeline.currentEntry : null

  return (
    <>
      <TopBar timeline={timeline} tv={tv} onToggleTv={toggleTv} />
      <div className="main-layout">
        {loading || error ? (
          <>
            <div className="stats-panel" />
            <div className="map-container">
              <LoadingOverlay error={error} />
            </div>
          </>
        ) : (
          <>
            <StatsPanel
              practices={practices}
              liveOds={liveOds}
              fullPlannerOds={fullPlannerOds}
              onboardingOds={onboardingOds}
              waitlistOds={waitlistOds}
              waitlistContacts={waitlistContacts}
              timelineOverride={timelineOverride}
              timelineData={timeline.timelineData}
            />
            <DashboardMap
              practices={practices}
              liveOds={liveOds}
              fullPlannerOds={fullPlannerOds}
              onboardingOds={onboardingOds}
              paidOds={paidOds}
              waitlistOds={waitlistOds}
              setLiveOds={setLiveOds}
              setFullPlannerOds={setFullPlannerOds}
              setOnboardingOds={setOnboardingOds}
              setPaidOds={setPaidOds}
              setWaitlistOds={setWaitlistOds}
              timeline={timeline}
              recalls={recalls}
            />
          </>
        )}
      </div>
    </>
  )
}
