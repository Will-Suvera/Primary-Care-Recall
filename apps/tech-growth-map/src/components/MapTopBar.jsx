export default function MapTopBar({ timeline }) {
  const { timelineData, sliderIdx, onSliderChange, currentEntry } = timeline

  const dateLabel = currentEntry
    ? new Date(currentEntry.date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '--'

  return (
    <div className="timeline-mini">
      <span className="timeline-mini-date">{dateLabel}</span>
      <input
        className="timeline-mini-slider"
        type="range"
        min={0}
        max={timelineData.length - 1 || 0}
        value={sliderIdx}
        onChange={e => onSliderChange(Number(e.target.value))}
      />
    </div>
  )
}
