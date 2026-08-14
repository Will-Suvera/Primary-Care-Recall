import { useEffect, useRef } from 'react'
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

export default function App() {
  const auth = useGoogleAuth()
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
      <TopBar timeline={timeline} />
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
