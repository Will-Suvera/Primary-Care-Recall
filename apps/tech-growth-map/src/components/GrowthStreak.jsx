import { useMemo } from 'react'

export default function GrowthStreak({ timelineData }) {
  const streak = useMemo(() => {
    if (!timelineData || timelineData.length < 2) return 0
    let count = 0
    for (let i = timelineData.length - 1; i > 0; i--) {
      const curr = timelineData[i].practices.pipeline
      const prev = timelineData[i - 1].practices.pipeline
      if (curr > prev) count++
      else break
    }
    return count
  }, [timelineData])

  if (streak < 2) return null

  return <div className="growth-streak">{streak} consecutive periods of growth</div>
}
