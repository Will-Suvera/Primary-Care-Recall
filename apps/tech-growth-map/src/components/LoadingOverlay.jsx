export default function LoadingOverlay({ error }) {
  if (error) {
    return (
      <div className="loading-overlay">
        <div className="loading-error">
          Error loading data.<br />
          <small>{error}</small>
        </div>
      </div>
    )
  }

  return (
    <div className="loading-overlay">
      <div className="loading-spinner"></div>
      <div className="loading-text">Loading GP practices...</div>
    </div>
  )
}
