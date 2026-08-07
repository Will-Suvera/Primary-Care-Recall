import { useState, useEffect } from 'react'

const BASE = import.meta.env.BASE_URL

export function useDashboardData() {
  const [practices, setPractices] = useState([])
  const [liveOds, setLiveOds] = useState(new Set())
  const [fullPlannerOds, setFullPlannerOds] = useState(new Set())
  const [onboardingOds, setOnboardingOds] = useState(new Set())
  const [paidOds, setPaidOds] = useState(new Set())
  const [waitlistOds, setWaitlistOds] = useState(new Set())
  const [waitlistContacts, setWaitlistContacts] = useState(null)
  const [recalls, setRecalls] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    async function load() {
      try {
        const [practicesResp, waitlistResp, liveResp, fullPlannerResp] = await Promise.all([
          fetch(`${BASE}data/practices_geocoded.json`, { cache: 'no-cache' }),
          fetch(`${BASE}data/waitlist_ods.json`, { cache: 'no-cache' }),
          fetch(`${BASE}data/live_customers.json`, { cache: 'no-cache' }),
          fetch(`${BASE}data/live_customers_full_planner.json`, { cache: 'no-cache' }),
        ])

        const practicesData = await practicesResp.json()
        const waitlistArr = await waitlistResp.json()
        const liveArr = await liveResp.json()
        const fullPlannerArr = await fullPlannerResp.json()

        setPractices(practicesData)
        const fullSet = new Set(fullPlannerArr.map(c => c.toUpperCase()))
        setFullPlannerOds(fullSet)
        setLiveOds(new Set(liveArr.map(c => c.toUpperCase())))
        setWaitlistOds(new Set(waitlistArr.map(c => c.toUpperCase())))

        // Onboarding (In Progress) is optional — file may not exist on every deploy
        try {
          const onbResp = await fetch(`${BASE}data/onboarding_ods.json`, { cache: 'no-cache' })
          if (onbResp.ok) {
            const arr = await onbResp.json()
            setOnboardingOds(new Set(arr.map(c => c.toUpperCase())))
          }
        } catch { /* ignore */ }

        // Paid (commercial tier) is optional — purple markers, file may be absent
        try {
          const paidResp = await fetch(`${BASE}data/paid_customers.json`, { cache: 'no-cache' })
          if (paidResp.ok) {
            const arr = await paidResp.json()
            setPaidOds(new Set(arr.map(c => c.toUpperCase())))
          }
        } catch { /* ignore */ }

        try {
          const metaResp = await fetch(`${BASE}data/waitlist_meta.json`, { cache: 'no-cache' })
          if (metaResp.ok) {
            const meta = await metaResp.json()
            if (meta.contacts) setWaitlistContacts(meta.contacts)
          }
        } catch { /* meta file not yet generated, ignore */ }

        try {
          const recallsResp = await fetch(`${BASE}data/recalls.json`, { cache: 'no-cache' })
          if (recallsResp.ok) setRecalls(await recallsResp.json())
        } catch { /* recalls file not yet generated, ignore */ }
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  return { practices, liveOds, fullPlannerOds, onboardingOds, paidOds, waitlistOds, waitlistContacts, recalls, loading, error, setLiveOds, setFullPlannerOds, setOnboardingOds, setPaidOds, setWaitlistOds }
}
