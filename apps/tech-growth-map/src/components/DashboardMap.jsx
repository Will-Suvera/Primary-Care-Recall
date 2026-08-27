import { useCallback, useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { MAP_CENTER, MAP_ZOOM, MARKER_STYLES, ICB_STYLES } from '../constants'
import MapTopBar from './MapTopBar'
import MapSearch from './MapSearch'
import PracticeTicker from './PracticeTicker'
import BottomStrip from './BottomStrip'

const snapshotCache = {}
const BASE = import.meta.env.BASE_URL

// PAID deals by DPA-signed date (HubSpot "PAID -" deals, Planner pipeline).
// Authoritative for when each gold dot appears while scrubbing the timeline —
// snapshots predating the paid tier have no paid_ods, so without this the
// gold would pop in at the wrong date. Pulled 27 Aug 2026; append new
// signings here (ods: 'YYYY-MM-DD').
const PAID_SIGNED_DATES = {
  C81047: '2026-06-12', // Alvaston Medical Centre
  Y04925: '2026-06-12', // Chapelford Primary Care Centre
  J82139: '2026-07-13', // Wistaria and Milford Surgeries
  N81011: '2026-07-28', // Bevan Group Practice
  D82054: '2026-07-30', // Fakenham Medical Practice
  N81039: '2026-07-31', // Oaklands
  L81051: '2026-08-19', // 168 Medical Group
  F81144: '2026-08-24', // The Pall Mall Surgery (SS9 South PCN)
}

function paidOdsOnDate(dateStr) {
  const set = new Set()
  for (const [ods, signed] of Object.entries(PAID_SIGNED_DATES)) {
    if (signed <= dateStr) set.add(ods)
  }
  return set
}

async function loadSnapshot(dateStr) {
  if (snapshotCache[dateStr]) return snapshotCache[dateStr]
  try {
    const resp = await fetch(`${BASE}snapshots/${dateStr}.json`, { cache: 'no-cache' })
    if (!resp.ok) return null
    const data = await resp.json()
    snapshotCache[dateStr] = data
    return data
  } catch {
    return null
  }
}

function getStatus(ods, paidOds, fullPlannerOds, onboardingOds, waitlistOds) {
  if (paidOds && paidOds.has(ods)) return 'paid'
  if (fullPlannerOds && fullPlannerOds.has(ods)) return 'fullPlanner'
  if (onboardingOds && onboardingOds.has(ods)) return 'inProgress'
  if (waitlistOds.has(ods)) return 'waitlist'
  return 'notSigned'
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

function buildPopupContent(p, status, isActive) {
  const labels = {
    paid: 'Gold',
    fullPlanner: 'Live - Full Planner',
    inProgress: 'In Progress',
    waitlist: 'On Signed-Up List',
    notSigned: 'Not Signed Up',
  }
  const label = labels[status] || 'Not Signed Up'
  const statusClass = status === 'fullPlanner' ? 'live' : status === 'notSigned' ? 'not-signed' : status === 'inProgress' ? 'in-progress' : status
  return `
    <div class="popup-title">${escapeHtml(p.name)}</div>
    <div class="popup-ods">${escapeHtml(p.ods)} &bull; ${escapeHtml(p.postcode)}</div>
    ${p.patients ? `<div class="popup-patients">Patients: ${Number(p.patients).toLocaleString()}</div>` : ''}
    ${p.pcn_name ? `<div class="popup-pcn">PCN: ${escapeHtml(p.pcn_name)}${p.pcn_code ? ' (' + escapeHtml(p.pcn_code) + ')' : ''}</div>` : ''}
    ${p.icb ? `<div class="popup-icb">ICB: ${escapeHtml(p.icb)}</div>` : ''}
    <div class="popup-status ${statusClass}">${label}</div>
    ${isActive ? `<div class="popup-active"><span class="popup-active-dot"></span>Actively Recalling</div>` : ''}`
}

export default function DashboardMap({ practices, liveOds, fullPlannerOds, onboardingOds, paidOds, waitlistOds, setLiveOds, setFullPlannerOds, setOnboardingOds, setPaidOds, setWaitlistOds, timeline, recalls }) {
  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const layersRef = useRef({})
  const markersRef = useRef({})
  const currentOdsRef = useRef({ paid: paidOds, fullPlanner: fullPlannerOds, inProgress: onboardingOds, waitlist: waitlistOds, active: new Set() })
  const [liveCounted, setLiveCounted] = useState(0)
  const [waitlistCounted, setWaitlistCounted] = useState(0)

  useEffect(() => {
    const activeSet = new Set(recalls?.active_ods_this_month || [])
    currentOdsRef.current = { paid: paidOds, fullPlanner: fullPlannerOds, inProgress: onboardingOds, waitlist: waitlistOds, active: activeSet }
  }, [paidOds, fullPlannerOds, onboardingOds, waitlistOds, recalls])

  useEffect(() => {
    const container = mapRef.current
    if (!container || container._leaflet_id) return

    const map = L.map(container, {
      center: MAP_CENTER,
      zoom: MAP_ZOOM,
      zoomControl: true,
      attributionControl: true,
    })

    // CARTO free basemaps started requiring an API key (Aug 2026) — Esri's
    // Light Gray Canvas is keyless and matches the muted style the status
    // dots depend on. Native tiles stop at z16; Leaflet upscales beyond.
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; &copy; OpenStreetMap contributors',
      maxNativeZoom: 16,
      maxZoom: 19,
    }).addTo(map)
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 16,
      maxZoom: 19,
      pane: 'tilePane',
    }).addTo(map)

    map.createPane('icbPane')
    map.getPane('icbPane').style.zIndex = 350

    let selectedIcb = null

    fetch(`${BASE}data/icb_boundaries.geojson`, { cache: 'no-cache' })
      .then(r => r.json())
      .then(geojson => {
        if (!mapInstanceRef.current) return
        L.geoJSON(geojson, {
          pane: 'icbPane',
          bubblingMouseEvents: true,
          style: ICB_STYLES.default,
          onEachFeature(feature, layer) {
            layer.on('mouseover', function () {
              if (selectedIcb !== this) { this.setStyle(ICB_STYLES.hover); this.bringToFront() }
              this.bindTooltip(feature.properties.name, {
                className: 'icb-tooltip', sticky: true, direction: 'top', offset: [0, -10], opacity: 0.95,
              }).openTooltip()
            })
            layer.on('mouseout', function () {
              if (selectedIcb !== this) this.setStyle(ICB_STYLES.default)
              this.closeTooltip()
            })
            layer.on('click', function (e) {
              L.DomEvent.stopPropagation(e)
              if (selectedIcb && selectedIcb !== this) selectedIcb.setStyle(ICB_STYLES.default)
              if (selectedIcb === this) { this.setStyle(ICB_STYLES.default); selectedIcb = null }
              else { this.setStyle(ICB_STYLES.active); this.bringToFront(); selectedIcb = this }
            })
          },
        }).addTo(map)
      })
      .catch(e => console.warn('ICB boundaries not loaded:', e))

    map.on('click', () => {
      if (selectedIcb) { selectedIcb.setStyle(ICB_STYLES.default); selectedIcb = null }
    })

    layersRef.current = {
      notSigned: L.layerGroup().addTo(map),
      waitlist: L.layerGroup().addTo(map),
      inProgress: L.layerGroup().addTo(map),
      fullPlanner: L.layerGroup().addTo(map),
      paid: L.layerGroup().addTo(map),
    }

    mapInstanceRef.current = map

    return () => {
      map.remove()
      mapInstanceRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!mapInstanceRef.current || practices.length === 0) return

    const layers = layersRef.current
    Object.values(layers).forEach(l => l.clearLayers())
    markersRef.current = {}

    let live = 0, waitlist = 0
    practices.forEach(p => {
      const ods = p.ods.toUpperCase()
      const status = getStatus(ods, paidOds, fullPlannerOds, onboardingOds, waitlistOds)
      if (status === 'fullPlanner') live++
      if (status === 'waitlist') waitlist++
      const activeSet = recalls?.active_ods_this_month ? new Set(recalls.active_ods_this_month) : new Set()
      const isActive = activeSet.has(ods)
      const markerOpts = { ...MARKER_STYLES[status] }
      // Paid practices keep their gold identity while pulsing; everyone else flashes green.
      if (isActive) markerOpts.className = status === 'paid' ? 'marker-flashing marker-gold' : 'marker-flashing'
      const marker = L.circleMarker([p.lat, p.lng], markerOpts)
      marker.bindPopup(() => {
        const cur = currentOdsRef.current
        const currentStatus = getStatus(ods, cur.paid, cur.fullPlanner, cur.inProgress, cur.waitlist)
        const isActive = cur.active ? cur.active.has(ods) : false
        return buildPopupContent(p, currentStatus, isActive)
      })
      layers[status].addLayer(marker)
      markersRef.current[ods] = { marker, layer: status, practice: p }
    })
    setLiveCounted(live)
    setWaitlistCounted(waitlist)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [practices, recalls, paidOds])

  useEffect(() => {
    if (Object.keys(markersRef.current).length === 0) return

    const layers = layersRef.current
    let live = 0, waitlist = 0

    for (const [ods, entry] of Object.entries(markersRef.current)) {
      const status = getStatus(ods, paidOds, fullPlannerOds, onboardingOds, waitlistOds)
      if (status === 'fullPlanner') live++
      if (status === 'waitlist') waitlist++
      entry.marker.setStyle(MARKER_STYLES[status])
      entry.marker.setRadius(MARKER_STYLES[status].radius)
      if (entry.layer !== status) {
        layers[entry.layer].removeLayer(entry.marker)
        layers[status].addLayer(entry.marker)
        entry.layer = status
      }
    }
    setLiveCounted(live)
    setWaitlistCounted(waitlist)
  }, [paidOds, fullPlannerOds, onboardingOds, waitlistOds])

  const debounceRef = useRef(null)
  const { sliderIdx, timelineData } = timeline

  useEffect(() => {
    if (!timelineData.length || !practices.length) return
    const entry = timelineData[sliderIdx]
    if (!entry) return

    let cancelled = false
    clearTimeout(debounceRef.current)

    debounceRef.current = setTimeout(async () => {
      const snap = await loadSnapshot(entry.date)
      if (cancelled) return
      if (!snap?.live_ods || !snap?.waitlist_ods) return

      const toSet = (arr) => new Set((arr || []).map(c => c.toUpperCase()))
      setLiveOds(toSet(snap.live_ods))
      setWaitlistOds(toSet(snap.waitlist_ods))
      // Apply every tier the snapshot carries, so scrubbing shows the tier a
      // practice actually had on that date. Onboarding keeps the current set
      // when absent (its practices were still live/waitlist members back then).
      setFullPlannerOds(toSet(snap.live_full_planner_ods))
      // Paid (gold): union of the snapshot's set with the authoritative
      // signed-date list, so each gold dot appears exactly when its deal
      // signed — including on snapshots that predate the paid tier — and
      // deals signed after the hardcoded list still show via the snapshot.
      const paid = paidOdsOnDate(entry.date)
      for (const ods of toSet(snap.paid_ods)) paid.add(ods)
      setPaidOds(paid)
      if (snap.onboarding_ods) setOnboardingOds(toSet(snap.onboarding_ods))
    }, 80)

    return () => {
      cancelled = true
      clearTimeout(debounceRef.current)
    }
  }, [sliderIdx, timelineData, practices, setLiveOds, setWaitlistOds, setFullPlannerOds, setOnboardingOds, setPaidOds])

  const isLatest = timelineData.length === 0 || sliderIdx === timelineData.length - 1
  const currentEntry = timelineData[sliderIdx]
  const liveCount = !isLatest && currentEntry ? currentEntry.practices.live : liveCounted
  const waitlistCount = !isLatest && currentEntry ? currentEntry.practices.waitlist : waitlistCounted

  const searchTokenRef = useRef(0)
  const handleSearchSelect = useCallback((practice) => {
    const map = mapInstanceRef.current
    if (!map || !practice || practice.lat == null || practice.lng == null) return
    const entry = markersRef.current[practice.ods?.toUpperCase()]
    // Token guards against a stale flyTo: an interrupted flyTo never fires
    // 'moveend', so its once-listener lingers and would fire on the next
    // flyTo. Only the latest selection's listener is allowed to open a popup.
    const token = ++searchTokenRef.current
    map.flyTo([practice.lat, practice.lng], 13, { duration: 0.8 })
    if (entry?.marker) {
      map.once('moveend', () => {
        if (token === searchTokenRef.current) entry.marker.openPopup()
      })
    }
  }, [])

  return (
    <div className="map-container">
      <div id="map" ref={mapRef}></div>
      <PracticeTicker
        practices={practices}
        timelineData={timeline.timelineData}
      />
      <BottomStrip recalls={recalls} />
      <MapSearch practices={practices} onSelect={handleSearchSelect} />
      <MapTopBar
        liveCount={liveCount}
        waitlistCount={waitlistCount}
        timeline={timeline}
      />
    </div>
  )
}
