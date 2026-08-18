import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, LocateFixed, Map, Minus, PanelLeftClose, PanelLeftOpen, Plus, Search, X } from 'lucide-react'
import metroNetwork from './data/metro-network.json'
import stationSearchIndex from './data/station-search-index.json'
import { APP_VERSION, STARTUP_LOAD_MODE } from './pwa-updater.js'
import './styles.css'
import './interaction.css'

const FARE_STATIONS_URL = '/data/metro-fare-stations.json'
const STANDARD_FARES_URL = '/data/metro-fares-standard.json'
const BUSINESS_FARES_URL = '/data/metro-fares-business.json'
const LINE_METRICS_URL = '/data/metro-line-metrics.json'
const MIN_ZOOM = 0.65
const MOBILE_MIN_ZOOM = 1
const MOBILE_DEFAULT_ZOOM = 1
const MAX_ZOOM = 5
const MOBILE_MAX_ZOOM = 10
const MAP_VIEWBOX = { x: -40, y: -260, w: 2680, h: 1850 }
const isMobileViewport = () => globalThis.matchMedia?.('(max-width: 720px)').matches ?? false
const normalizeLineName = (name) => name.replace('地铁', '').replace(/（.*?）|\(.*?\)/g, '')
const normalizeStationName = (name) => name.replace(/站$/, '')
const formatLineNumber = (lineNumber) => lineNumber.endsWith('支')
  ? `${lineNumber.slice(0, -1)}号线支线`
  : `${lineNumber}号线`
const normalizeSearchText = (value) => value.trim().toLowerCase().replace(/[\s'’·-]+/g, '')
const stationPinyin = new globalThis.Map(stationSearchIndex.stations.map(station => [station.name, station]))
const centerPanForStation = (station, zoom) => {
  const [stationX, stationY] = station.p.split(' ').map(Number)
  const centerX = MAP_VIEWBOX.x + MAP_VIEWBOX.w / 2
  const centerY = MAP_VIEWBOX.y + MAP_VIEWBOX.h / 2
  return {
    x: centerX - MAP_VIEWBOX.x * (1 - zoom) - stationX * zoom,
    y: centerY - MAP_VIEWBOX.y * (1 - zoom) - stationY * zoom
  }
}
const getStationFocusZoom = (maxZoom) => {
  const viewportShortSide = Math.min(globalThis.innerWidth || 1280, globalThis.innerHeight || 800)
  const responsiveZoom = Math.round((1200 / viewportShortSide) * 10) / 10
  return Math.min(maxZoom, Math.max(2, responsiveZoom))
}

const buildMetricGraph = (edges, transfers, metric) => {
  const graph = new globalThis.Map()
  const stationStates = new globalThis.Map()
  const stateNames = new globalThis.Map()
  const stateId = (lineCode, station) => `${lineCode}\u0000${station}`
  const registerState = (lineCode, station) => {
    const state = stateId(lineCode, station)
    if (!stationStates.has(station)) stationStates.set(station, [])
    if (!stationStates.get(station).includes(state)) stationStates.get(station).push(state)
    stateNames.set(state, station)
    return state
  }
  const addEdge = (from, to, weight) => {
    if (!graph.has(from)) graph.set(from, [])
    graph.get(from).push({ to, weight })
  }
  edges.forEach(edge => {
    const from = registerState(edge.lineCode, edge.from)
    const to = registerState(edge.lineCode, edge.to)
    if (metric === 'duration') {
      const forwardRunning = edge.forwardRunningSeconds ?? edge.runningSeconds
      const reverseRunning = edge.reverseRunningSeconds ?? edge.runningSeconds
      addEdge(from, to, forwardRunning)
      addEdge(to, from, reverseRunning)
    } else {
      addEdge(from, to, edge.distanceMeters)
      addEdge(to, from, edge.distanceMeters)
    }
  })
  transfers.forEach(transfer => {
    const from = registerState(transfer.fromLineCode, transfer.station)
    const to = registerState(transfer.toLineCode, transfer.station)
    addEdge(from, to, metric === 'duration' ? transfer.seconds : 0)
  })
  return { graph, stationStates, stateNames }
}

const shortestPaths = ({ graph, stationStates, stateNames }, origin) => {
  const originStates = stationStates.get(origin) || []
  if (!originStates.length) return new globalThis.Map()
  const distances = new globalThis.Map(originStates.map(state => [state, 0]))
  const queue = originStates.map(state => ({ state, distance: 0 }))
  while (queue.length) {
    let bestIndex = 0
    for (let index = 1; index < queue.length; index += 1) {
      if (queue[index].distance < queue[bestIndex].distance) bestIndex = index
    }
    const [current] = queue.splice(bestIndex, 1)
    if (current.distance !== distances.get(current.state)) continue
    for (const edge of graph.get(current.state) || []) {
      const nextDistance = current.distance + edge.weight
      if (nextDistance >= (distances.get(edge.to) ?? Infinity)) continue
      distances.set(edge.to, nextDistance)
      queue.push({ state: edge.to, distance: nextDistance })
    }
  }
  const stationDistances = new globalThis.Map()
  distances.forEach((distance, state) => {
    const station = stateNames.get(state)
    if (distance < (stationDistances.get(station) ?? Infinity)) stationDistances.set(station, distance)
  })
  return stationDistances
}

const formatMetricValue = (value, mode) => {
  if (mode === 'duration') return String(Math.max(1, Math.round(value / 60)))
  if (mode === 'distance') return String(Math.round(value / 1000))
  return String(value)
}

// Positions emitted by the original page after its `enZdDW2` adjustment.
// The legacy renderer offsets map geometry by (193, 315), so the values are
// converted back to the coordinate system used by metro-network.json below.
const LEGACY_MAP_OFFSET = { x: 193, y: 315 }
const OFFICIAL_LINE_LABEL_POSITIONS = {
  '440300024063': [[381, 812], [1641, 1434]],
  '440300024076': [[310, 1698], [2020, 1237]],
  '200000024038': [[2293, 42]],
  '440300024074': [[1614, 338], [1170, 1521]],
  '440300024058': [[240, 1698], [1760, 1237]],
  '440300024046': [[440, 354], [1483, 1329]],
  '440300024050': [[1092, 730], [1838, 1074]],
  '440300024086': [[2085, 1147], [2815, 1190]],
  '440300024054': [[194, 1411], [1840, 1352]],
  '900000055265': [[1545, 420], [1240, 1521]],
  '440300024056': [[370, 294], [1606, 1332]],
  '200000024056': [[113, 550]],
  '200000024058': [[2443, 250]],
  '200000024060': [[300, 354], [230, 1853]],
  '200000024048': [[2734, 501], [1900, 1010]],
  '200000024066': [[1073, 180]],
  '200000024050': [[730, 190], [730, 1580]]
}

const MapArtwork = React.memo(function MapArtwork({ displayLinePaths, stationGroups, labels, selectedLine, selectedStation, metricOverlay, onStationPointerUp, onStationClick }) {
  return <>
    {displayLinePaths.map(line => <polyline key={`halo-${line.ls}`} className={`line-halo ${selectedLine && selectedLine !== line.ls ? 'line-muted' : ''}`} points={line.pointString} fill="none" stroke="#fff" strokeWidth="17" strokeLinejoin="round" strokeLinecap="round" />)}
    {displayLinePaths.map(line => {
      const muted = selectedLine && selectedLine !== line.ls
      return <polyline key={line.ls} className={`line-route ${muted ? 'line-muted' : ''}`} points={line.pointString} fill="none" stroke={muted ? '#aeb5bf' : `#${line.cl}`} strokeWidth="9" strokeLinejoin="round" strokeLinecap="round" />
    })}
    {stationGroups.map(station => {
      const [x, y] = station.p.split(' ').map(Number)
      const active = selectedStation?.sid === station.sid
      const interchange = station.lines.length > 1
      const selectedStationLine = station.lines.find(line => line.ls === selectedLine)
      const line = selectedStationLine || station.lines[0]
      const muted = selectedLine && !selectedStationLine
      return <g key={`station-${station.p}`} className={`station-node ${muted ? 'station-muted' : ''} ${active ? 'is-active' : ''}`} onPointerUp={event => onStationPointerUp(event, station, line)} onClick={() => onStationClick(station, line)}>
        <circle className="station-hit-target" cx={x} cy={y} r="25" />
        {interchange ? <rect x={x - 12} y={y - 6} width="24" height="12" rx="6" fill="#fff" stroke={active ? '#172033' : '#697887'} strokeWidth={active ? 4 : 3} /> : <circle cx={x} cy={y} r={active ? 10 : 6.5} fill="#fff" stroke={active ? '#172033' : `#${line.cl}`} strokeWidth={active ? 4 : 2.8} />}
      </g>
    })}
    {metricOverlay && stationGroups.map(station => {
      const [x, y] = station.p.split(' ').map(Number)
      const isOrigin = selectedStation?.p === station.p
      const rawValue = metricOverlay.values.get(normalizeStationName(station.n))
      if (!isOrigin && rawValue === undefined) return null
      const color = isOrigin ? '#16a34a' : `#${station.lines[0].cl}`
      const value = isOrigin ? '起' : formatMetricValue(rawValue, metricOverlay.mode)
      const width = isOrigin ? 25 : Math.max(25, 10 + value.length * 8)
      return <g key={`metric-${station.p}`} className={`fare-marker metric-${metricOverlay.mode} ${isOrigin ? 'is-origin' : ''}`} transform={`translate(${x} ${y})`}>
        <rect x={-width / 2} y="-9" width={width} height="18" rx="3" fill={isOrigin ? color : '#fff'} stroke={color} strokeWidth="1.5" />
        <text x="0" y="4.5" textAnchor="middle" fill={isOrigin ? '#fff' : color}>{value}</text>
      </g>
    })}
    {labels.map(({ station, x, y, anchor }) => {
      const direction = station.n === '银湖' ? 3 : Number(station.lg)
      const fareNudge = metricOverlay ? {
        0: [0, -2], 1: [2, -1], 2: [2, 0], 3: [2, 1],
        4: [0, 2], 5: [-2, 1], 6: [-2, 0], 7: [-2, -1]
      }[direction] || [0, 0] : [0, 0]
      return <g key={`label-${station.p}`} className="station-label-group" onPointerUp={event => onStationPointerUp(event, station, station.lines[0])} onClick={() => onStationClick(station, station.lines[0])}>
        <text x={x + fareNudge[0]} y={y + fareNudge[1]} textAnchor={anchor} className="station-label">{station.n}</text>
      </g>
    })}
    {!metricOverlay && displayLinePaths.flatMap(line => {
      const positions = OFFICIAL_LINE_LABEL_POSITIONS[line.ls]
        || line.lp.map(point => {
          const [x, y] = point.split(' ').map(Number)
          return [x + LEGACY_MAP_OFFSET.x, y + LEGACY_MAP_OFFSET.y - 15]
        })
      const branch = line.ln.includes('支')
      const number = line.ln.replace('支', '')
      return positions.map(([legacyX, legacyY], index) => <g key={`line-label-${line.ls}-${index}`} className={`map-line-label ${selectedLine && selectedLine !== line.ls ? 'line-label-muted' : ''}`} transform={`translate(${legacyX - LEGACY_MAP_OFFSET.x} ${legacyY - LEGACY_MAP_OFFSET.y})`}>
        <rect width="65" height="30" rx="3" fill={selectedLine && selectedLine !== line.ls ? '#8f98a3' : `#${line.cl}`} />
        <text x="18" y="24" textAnchor="middle" className="map-line-label-number">{number}</text>
        <text x="48" y="15" textAnchor="middle" className="map-line-label-cn">{branch ? '支线' : '号线'}</text>
        <text x="48" y="25" textAnchor="middle" className="map-line-label-en">Line {number}</text>
      </g>)
    })}
  </>
})

function MetroMap({ lines, selectedLine, selectedStation, onStationSelect, zoom, minZoom, maxZoom, pan, onZoomChange, onPanChange, metricOverlay }) {
  const BASE = MAP_VIEWBOX
  const viewportRef = useRef(null)
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 })
  useEffect(() => {
    const element = viewportRef.current
    if (!element) return undefined
    const update = () => setViewportSize({ width: element.clientWidth || 1, height: element.clientHeight || 1 })
    const preventNativeTouch = (event) => {
      if (event.cancelable) event.preventDefault()
      if (event.type === 'touchstart') globalThis.getSelection?.()?.removeAllRanges()
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    element.addEventListener('touchstart', preventNativeTouch, { passive: false })
    element.addEventListener('touchmove', preventNativeTouch, { passive: false })
    element.addEventListener('touchend', preventNativeTouch, { passive: false })
    element.addEventListener('touchcancel', preventNativeTouch, { passive: false })
    return () => {
      observer.disconnect()
      element.removeEventListener('touchstart', preventNativeTouch)
      element.removeEventListener('touchmove', preventNativeTouch)
      element.removeEventListener('touchend', preventNativeTouch)
      element.removeEventListener('touchcancel', preventNativeTouch)
    }
  }, [])
  // `c` is the cartographic path from the supplied Shenzhen Metro data.
  // `p` is only the station anchor; connecting those anchors produces a
  // geometrically incorrect map (the original map uses hand-routed bends).
  const linePaths = useMemo(() => lines.map(line => ({
    ...line,
    pointString: line.c.join(' '),
    points: line.c.map(point => point.split(' ').map(Number)),
    stations: line.st.map(station => ({ ...station, coords: station.p.split(' ').map(Number) }))
  })), [lines])
  const displayLinePaths = useMemo(() => selectedLine
    ? [...linePaths].sort((a, b) => Number(a.ls === selectedLine) - Number(b.ls === selectedLine))
    : linePaths, [linePaths, selectedLine])
  const stationGroups = useMemo(() => {
    const groups = new globalThis.Map()
    linePaths.forEach(line => line.stations.forEach(station => {
      const key = station.p
      if (!groups.has(key)) groups.set(key, { ...station, lines: [] })
      groups.get(key).lines.push(line)
    }))
    return [...groups.values()]
  }, [linePaths])
  const labels = useMemo(() => {
    // These are the exact offsets used by the original Shenzhen Metro SVG
    // renderer. `lg` is an eight-way label position, not an input to a
    // collision solver. Keeping it deterministic preserves the association
    // between every label and its station.
    const standardOffsets = {
      0: { dx: 0, dy: -10, anchor: 'middle' },
      1: { dx: 10, dy: -10, anchor: 'start' },
      2: { dx: 10, dy: 5, anchor: 'start' },
      3: { dx: 10, dy: 20, anchor: 'start' },
      4: { dx: 0, dy: 20, anchor: 'middle' }
    }
    // The source page adjusts only these names after the SVG is generated.
    const originalSiteOverrides = {
      前湾: { dx: -44, dy: 5, anchor: 'start' },
      前海湾: { dx: -59, dy: 5, anchor: 'start' },
      深圳北: { dx: -56, dy: 20, anchor: 'start' },
      车公庙: { dx: -50, dy: -10, anchor: 'start' },
      南山书城: { dx: 0, dy: 17, anchor: 'start' },
      松岗: { dx: -43, dy: 20, anchor: 'start' },
      福民: { dx: 17, dy: -10, anchor: 'start' },
      机场北: { dx: 16, dy: 5, anchor: 'start' },
      海上世界: { dx: -20, dy: 20, anchor: 'start' }
    }
    return stationGroups.map(station => {
      const [x, y] = station.p.split(' ').map(Number)
      // The official renderer uses the 9-line value for 银湖; its duplicated
      // records are the only interchange whose `lg` values disagree here.
      const direction = station.n === '银湖' ? 3 : Number(station.lg)
      const leftOffset = -(station.n.length * 12 + 10)
      const offset = originalSiteOverrides[station.n]
        || standardOffsets[direction]
        || { dx: leftOffset, dy: direction === 5 ? 20 : direction === 6 ? 5 : -10, anchor: 'start' }
      return { station, x: x + offset.dx, y: y + offset.dy, anchor: offset.anchor }
    })
  }, [stationGroups])
  const pointer = useRef(null)
  const activePointers = useRef(new globalThis.Map())
  const pinch = useRef(null)
  const lastTap = useRef(null)
  const doubleTapZoom = useRef(null)
  const suppressClick = useRef(false)
  const touchStationActivated = useRef(false)
  const animationFrame = useRef(null)
  const pendingView = useRef(null)
  const viewState = useRef({ zoom, pan })
  const onStationSelectRef = useRef(onStationSelect)
  viewState.current = { zoom, pan }
  onStationSelectRef.current = onStationSelect
  useEffect(() => () => {
    if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current)
  }, [])
  const scheduleViewChange = (nextPan, nextZoom) => {
    viewState.current = { pan: nextPan, zoom: nextZoom }
    pendingView.current = viewState.current
    if (animationFrame.current !== null) return
    animationFrame.current = requestAnimationFrame(() => {
      const nextView = pendingView.current
      animationFrame.current = null
      if (!nextView) return
      onPanChange(nextView.pan)
      onZoomChange(nextView.zoom)
    })
  }
  const clientToSvg = (clientX, clientY) => {
    const rect = viewportRef.current.getBoundingClientRect()
    const screenScale = Math.min(rect.width / BASE.w, rect.height / BASE.h)
    const renderedWidth = BASE.w * screenScale
    const renderedHeight = BASE.h * screenScale
    const offsetX = (rect.width - renderedWidth) / 2
    const offsetY = (rect.height - renderedHeight) / 2
    return {
      x: BASE.x + (clientX - rect.left - offsetX) / screenScale,
      y: BASE.y + (clientY - rect.top - offsetY) / screenScale
    }
  }
  const worldPointAt = (cursor, currentZoom, currentPan) => ({
    x: (cursor.x - currentPan.x - BASE.x * (1 - currentZoom)) / currentZoom,
    y: (cursor.y - currentPan.y - BASE.y * (1 - currentZoom)) / currentZoom
  })
  const panForWorldPoint = (cursor, nextZoom, worldPoint) => ({
    x: cursor.x - BASE.x * (1 - nextZoom) - nextZoom * worldPoint.x,
    y: cursor.y - BASE.y * (1 - nextZoom) - nextZoom * worldPoint.y
  })
  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.pointerType !== 'mouse') {
      event.preventDefault()
      globalThis.getSelection?.()?.removeAllRanges()
    }
    if (activePointers.current.size >= 2) return
    activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (activePointers.current.size === 1) {
      const previousTap = lastTap.current
      const isDoubleTap = event.pointerType !== 'mouse'
        && previousTap
        && Date.now() - previousTap.time < 320
        && Math.hypot(event.clientX - previousTap.x, event.clientY - previousTap.y) < 32
      if (isDoubleTap) {
        const cursor = clientToSvg(event.clientX, event.clientY)
        doubleTapZoom.current = {
          id: event.pointerId,
          startY: event.clientY,
          startZoom: zoom,
          cursor,
          worldPoint: worldPointAt(cursor, zoom, pan),
          moved: false
        }
        lastTap.current = null
        pointer.current = null
        suppressClick.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
        event.currentTarget.classList.add('is-one-finger-zoom')
        return
      }
      pointer.current = { id: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY, startX: pan.x, startY: pan.y, moved: false }
      return
    }

    doubleTapZoom.current = null
    lastTap.current = null
    event.currentTarget.classList.remove('is-one-finger-zoom')
    const [first, second] = [...activePointers.current.values()]
    const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
    const cursor = clientToSvg(midpoint.x, midpoint.y)
    pinch.current = {
      startDistance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
      startZoom: zoom,
      worldPoint: worldPointAt(cursor, zoom, pan)
    }
    pointer.current = null
    suppressClick.current = true
    event.currentTarget.classList.add('is-panning')
    for (const pointerId of activePointers.current.keys()) {
      if (!event.currentTarget.hasPointerCapture(pointerId)) event.currentTarget.setPointerCapture(pointerId)
    }
  }
  const onPointerMove = (event) => {
    if (!activePointers.current.has(event.pointerId)) return
    activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (pinch.current && activePointers.current.size === 2) {
      event.preventDefault()
      const [first, second] = [...activePointers.current.values()]
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y))
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
      const nextZoom = Math.min(maxZoom, Math.max(minZoom, pinch.current.startZoom * distance / pinch.current.startDistance))
      const cursor = clientToSvg(midpoint.x, midpoint.y)
      scheduleViewChange(panForWorldPoint(cursor, nextZoom, pinch.current.worldPoint), nextZoom)
      return
    }

    if (doubleTapZoom.current?.id === event.pointerId) {
      event.preventDefault()
      const gesture = doubleTapZoom.current
      const verticalDistance = gesture.startY - event.clientY
      if (Math.abs(verticalDistance) < 2) return
      gesture.moved = true
      const nextZoom = Math.min(maxZoom, Math.max(minZoom, gesture.startZoom * Math.exp(verticalDistance / 180)))
      scheduleViewChange(panForWorldPoint(gesture.cursor, nextZoom, gesture.worldPoint), nextZoom)
      return
    }

    const p = pointer.current
    if (!p || p.id !== event.pointerId) return
    const screenDx = event.clientX - p.x
    const screenDy = event.clientY - p.y
    if (!p.moved && Math.hypot(screenDx, screenDy) < 5) return
    if (!p.moved) {
      p.moved = true
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.classList.add('is-panning')
    }
    const scale = Math.min(viewportSize.width / BASE.w, viewportSize.height / BASE.h)
    const dx = screenDx / scale
    const dy = screenDy / scale
    scheduleViewChange({ x: p.startX + dx, y: p.startY + dy }, viewState.current.zoom)
  }
  const onPointerUp = (event) => {
    if (event.pointerType !== 'mouse') globalThis.getSelection?.()?.removeAllRanges()
    const wasDoubleTapZoom = doubleTapZoom.current?.id === event.pointerId
    const wasPinching = Boolean(pinch.current)
    activePointers.current.delete(event.pointerId)
    if (wasDoubleTapZoom) {
      doubleTapZoom.current = null
      pointer.current = null
      lastTap.current = null
      event.currentTarget.classList.remove('is-one-finger-zoom')
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      window.setTimeout(() => { suppressClick.current = false }, 0)
      return
    }
    if (wasPinching) {
      pointer.current = null
      if (activePointers.current.size === 0) {
        pinch.current = null
        event.currentTarget.classList.remove('is-panning')
        window.setTimeout(() => { suppressClick.current = false }, 0)
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      return
    }
    if (pointer.current?.id === event.pointerId) {
      const completedPointer = pointer.current
      const isTap = event.type !== 'pointercancel' && completedPointer.type !== 'mouse' && !completedPointer.moved
      lastTap.current = isTap ? { time: Date.now(), x: event.clientX, y: event.clientY } : null
      suppressClick.current = pointer.current.moved || touchStationActivated.current
      pointer.current = null
      touchStationActivated.current = false
      window.setTimeout(() => { suppressClick.current = false }, 0)
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    event.currentTarget.classList.remove('is-panning')
  }
  const onWheel = (event) => {
    event.preventDefault()
    const { zoom: oldZoom, pan: currentPan } = viewState.current
    const nextZoom = Math.min(maxZoom, Math.max(minZoom, oldZoom * (event.deltaY > 0 ? .9 : 1.1)))
    if (nextZoom === oldZoom) return

    const cursor = clientToSvg(event.clientX, event.clientY)
    const worldPoint = worldPointAt(cursor, oldZoom, currentPan)
    scheduleViewChange(panForWorldPoint(cursor, nextZoom, worldPoint), nextZoom)
  }
  const onStationPointerUp = useCallback((event, station, line) => {
    if (event.pointerType === 'mouse') return
    const activePointer = pointer.current
    if (!activePointer || activePointer.id !== event.pointerId || activePointer.moved || pinch.current || doubleTapZoom.current) return
    touchStationActivated.current = true
    onStationSelectRef.current(station, line)
  }, [])
  const onStationClick = useCallback((station, line) => {
    if (!suppressClick.current) onStationSelectRef.current(station, line)
  }, [])
  const svgTransform = `translate(${pan.x} ${pan.y}) translate(${BASE.x * (1 - zoom)} ${BASE.y * (1 - zoom)}) scale(${zoom})`
  return <div ref={viewportRef} className="map-viewport" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onWheel={onWheel} onContextMenu={event => event.preventDefault()} onDragStart={event => event.preventDefault()}>
  <svg className={`metro-svg ${metricOverlay ? 'is-fare-mode' : ''}`} viewBox={`${BASE.x} ${BASE.y} ${BASE.w} ${BASE.h}`} preserveAspectRatio="xMidYMid meet" aria-label="深圳地铁线路图">
    <g transform={svgTransform}>
      <MapArtwork displayLinePaths={displayLinePaths} stationGroups={stationGroups} labels={labels} selectedLine={selectedLine} selectedStation={selectedStation} metricOverlay={metricOverlay} onStationPointerUp={onStationPointerUp} onStationClick={onStationClick} />
    </g>
  </svg>
  </div>
}

function App() {
  const searchInputRef = useRef(null)
  const [lines] = useState(() => metroNetwork.l)
  const [query, setQuery] = useState('')
  const [showBuildInfo, setShowBuildInfo] = useState(false)
  const [selectedLine, setSelectedLine] = useState(null)
  const [expandedLine, setExpandedLine] = useState(null)
  const [selectedStation, setSelectedStation] = useState(null)
  const [isMobile, setIsMobile] = useState(isMobileViewport)
  const [zoom, setZoom] = useState(() => isMobileViewport() ? MOBILE_DEFAULT_ZOOM : 1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [fareType, setFareType] = useState('standard')
  const [mapMode, setMapMode] = useState('fare')
  const [fareData, setFareData] = useState(null)
  const [lineMetrics, setLineMetrics] = useState(null)
  const minZoom = isMobile ? MOBILE_MIN_ZOOM : MIN_ZOOM
  const maxZoom = isMobile ? MOBILE_MAX_ZOOM : MAX_ZOOM
  const defaultZoom = isMobile ? MOBILE_DEFAULT_ZOOM : 1
  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)')
    const update = () => setIsMobile(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const handleEscape = event => {
      if (event.key !== 'Escape' || event.isComposing || isMobile) return

      const searchIsActive = query || document.activeElement === searchInputRef.current
      if (searchIsActive) {
        event.preventDefault()
        setQuery('')
        searchInputRef.current?.blur()
        return
      }

      if (!sidebarCollapsed) {
        event.preventDefault()
        setSidebarCollapsed(true)
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isMobile, query, sidebarCollapsed])
  useEffect(() => {
    fetch(LINE_METRICS_URL)
      .then(response => {
        if (!response.ok) throw new Error(`Failed to load ${LINE_METRICS_URL}`)
        return response.json()
      })
      .then(setLineMetrics)
      .catch(() => setLineMetrics(null))
  }, [])
  useEffect(() => {
    if (zoom < minZoom) {
      setZoom(defaultZoom)
      setPan({ x: 0, y: 0 })
    }
  }, [defaultZoom, minZoom, zoom])
  useEffect(() => {
    Promise.all([FARE_STATIONS_URL, STANDARD_FARES_URL, BUSINESS_FARES_URL].map(url => fetch(url).then(response => {
      if (!response.ok) throw new Error(`Failed to load ${url}`)
      return response.json()
    }))).then(([stationIndex, standard, business]) => setFareData({ stationIndex, standard, business })).catch(() => setFareData(null))
  }, [])
  const stationLineCounts = useMemo(() => {
    const counts = new globalThis.Map()
    lines.forEach(line => line.st.forEach(station => counts.set(station.p, (counts.get(station.p) || 0) + 1)))
    return counts
  }, [lines])
  const stations = useMemo(() => {
    const uniqueStations = new globalThis.Map()
    lines.forEach(line => line.st.forEach(station => {
      if (!uniqueStations.has(station.p)) uniqueStations.set(station.p, { ...station, line })
    }))
    return [...uniqueStations.values()]
  }, [lines])
  const filteredStations = useMemo(() => {
    const search = normalizeSearchText(query)
    if (!search) return []
    return stations
      .map(station => {
        const pinyin = stationPinyin.get(normalizeStationName(station.n))
        const terms = [station.n, station.en, pinyin?.full, pinyin?.initials]
          .filter(Boolean)
          .map(normalizeSearchText)
        const matchIndex = terms.findIndex(term => term.includes(search))
        if (matchIndex < 0) return null
        const startsWith = terms.some(term => term.startsWith(search))
        return { ...station, searchScore: startsWith ? matchIndex : matchIndex + 10 }
      })
      .filter(Boolean)
      .sort((a, b) => a.searchScore - b.searchScore || a.n.localeCompare(b.n, 'zh-CN'))
  }, [query, stations])
  const activeLine = selectedStation?.line
  const fareModeLabel = fareType === 'business' ? '商务座票价' : fareType === 'difference' ? '商务座差价' : '普通车厢票价'
  const fareValues = useMemo(() => {
    if (mapMode !== 'fare' || !selectedStation || !fareData) return null
    const stationsByName = new globalThis.Map()
    fareData.stationIndex.stations.forEach(station => {
      const name = normalizeStationName(station.name)
      if (!stationsByName.has(name)) stationsByName.set(name, station.index)
    })
    const originIndex = stationsByName.get(normalizeStationName(selectedStation.n))
    if (originIndex === undefined) return null
    const values = new globalThis.Map()
    stationsByName.forEach((stationIndex, name) => {
      const value = fareType === 'difference'
        ? fareData.business.matrix[originIndex][stationIndex] - fareData.standard.matrix[originIndex][stationIndex]
        : fareData[fareType].matrix[originIndex][stationIndex]
      values.set(name, value)
    })
    return values
  }, [selectedStation, fareData, fareType, mapMode])
  const metricGraph = useMemo(() => mapMode !== 'fare' && lineMetrics
    ? buildMetricGraph(lineMetrics.edges, lineMetrics.transfers || [], mapMode)
    : null, [lineMetrics, mapMode])
  const travelValues = useMemo(() => {
    if (!selectedStation || !metricGraph) return null
    return shortestPaths(metricGraph, normalizeStationName(selectedStation.n))
  }, [selectedStation, metricGraph])
  const metricOverlay = useMemo(() => fareValues
    ? { mode: 'fare', values: fareValues }
    : travelValues
      ? { mode: mapMode, values: travelValues }
      : null, [fareValues, travelValues, mapMode])
  const modeLabel = mapMode === 'duration' ? '含换乘的最短时长' : mapMode === 'distance' ? '最短里程' : fareModeLabel
  const modeUnit = mapMode === 'duration' ? '分钟' : mapMode === 'distance' ? '公里' : '元'

  const selectStation = (station, line) => {
    setSelectedStation(current => current?.p === station.p ? null : { ...station, line })
    setSelectedLine(null)
    if (window.matchMedia('(max-width: 720px)').matches) setSidebarCollapsed(true)
  }
  const selectStationFromList = (station, line) => {
    const focusZoom = getStationFocusZoom(maxZoom)
    setSelectedStation({ ...station, line })
    setSelectedLine(null)
    setZoom(focusZoom)
    setPan(centerPanForStation(station, focusZoom))
    if (window.matchMedia('(max-width: 720px)').matches) setSidebarCollapsed(true)
  }
  const selectLine = (lineId) => {
    const willExpand = expandedLine !== lineId
    setExpandedLine(willExpand ? lineId : null)
    setSelectedLine(willExpand ? lineId : null)
    setSelectedStation(null)
  }
  const clearAll = () => {
    setQuery('')
    setSelectedLine(null)
    setExpandedLine(null)
    setSelectedStation(null)
    setZoom(defaultZoom)
    setPan({ x: 0, y: 0 })
    if (window.matchMedia('(max-width: 720px)').matches) setSidebarCollapsed(true)
  }
  const resetView = () => {
    const targetZoom = selectedStation ? getStationFocusZoom(maxZoom) : defaultZoom
    setZoom(targetZoom)
    setPan(selectedStation ? centerPanForStation(selectedStation, targetZoom) : { x: 0, y: 0 })
  }

  return <div className="app-shell">
    <main className="workspace">
      <aside className={`sidebar ${sidebarCollapsed ? 'is-collapsed' : ''}`} aria-hidden={sidebarCollapsed}>
        <div className="sidebar-heading"><div><button className="eyebrow eyebrow-toggle" type="button" onClick={() => setShowBuildInfo(value => !value)} title="查看版本和加载方式">{showBuildInfo ? `${APP_VERSION.slice(0, 12)} · ${STARTUP_LOAD_MODE}` : 'SHENZHEN METRO'}</button><h1>线路图</h1></div><button className="filter-button" onClick={clearAll}><Map size={17} /> 总览</button></div>
        <div className="search-area">
          <div className="search-box"><Search size={18} /><input ref={searchInputRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索站名、拼音或简拼" />{query && <button onClick={() => setQuery('')} aria-label="清除搜索"><X size={15} /></button>}</div>
          {filteredStations.length > 0 && <div className="search-results">{filteredStations.slice(0, 8).map(item => <button key={`${item.line.ls}-${item.p}`} onClick={() => { selectStationFromList(item, item.line); setQuery('') }}><span className="result-dot" style={{ background: `#${item.line.cl}` }} /><span>{item.n}</span><small>{formatLineNumber(item.line.ln)}</small></button>)}</div>}
        </div>
        <div className="section-label"><span>线路列表</span><span>{lines.length} 条线路</span></div>
        <div className="line-list">{lines.map(line => {
          const expanded = expandedLine === line.ls
          return <div className={`line-group ${expanded ? 'is-expanded' : ''}`} key={line.ls}>
            <button className={`line-item ${selectedLine === line.ls ? 'active' : ''}`} onClick={() => selectLine(line.ls)} aria-expanded={expanded}>
              <span className="line-badge" style={{ background: `#${line.cl}` }}>{line.ln}</span>
              <span className="line-name">{line.kn}</span>
              <span className="station-count">{line.st.length}站</span>
              <ChevronDown size={15} className="line-chevron" />
            </button>
            {expanded && <div className="line-stations" aria-label={`${line.kn}站点列表`}>
              {line.st.map((station, index) => <button
                key={`${line.ls}-${station.sid || station.p}`}
                className={`line-station-item ${selectedStation?.p === station.p ? 'active' : ''}`}
                onClick={() => selectStationFromList(station, line)}
              >
                <span className="station-sequence">{String(index + 1).padStart(2, '0')}</span>
                <span className="station-list-name">{station.n}</span>
                {stationLineCounts.get(station.p) > 1 && <span className="transfer-tag">换乘</span>}
              </button>)}
            </div>}
          </div>
        })}</div>
        <div className="sidebar-footer"><div className="legend"><span><i className="legend-dot interchange" />换乘站</span><span><i className="legend-dot station" />普通站</span></div></div>
      </aside>
      {!sidebarCollapsed && <button className="sidebar-backdrop" onClick={() => setSidebarCollapsed(true)} aria-label="关闭线路侧栏" />}
      <section className="map-panel">
        <button
          className="sidebar-toggle"
          onClick={() => setSidebarCollapsed(collapsed => !collapsed)}
          aria-label={sidebarCollapsed ? '展开线路侧栏' : '收起线路侧栏'}
          title={sidebarCollapsed ? '展开线路侧栏' : '收起线路侧栏'}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
        <div className="map-toolbar">
          <div className="map-title"><span className="map-kicker">{metricOverlay ? `${mapMode.toUpperCase()} MAP` : 'NETWORK OVERVIEW'}</span><h2>{metricOverlay ? `从“${selectedStation.n}”出发的全线网${modeLabel}` : '深圳市城市轨道交通线网'}</h2></div>
          <div className="map-tools">
            <div className={`fare-type-control ${mapMode !== 'fare' ? 'is-placeholder' : ''}`} aria-label="票价类型" aria-hidden={mapMode !== 'fare'}>
              <button disabled={mapMode !== 'fare'} className={fareType === 'standard' ? 'active' : ''} onClick={() => setFareType('standard')}>普通</button>
              <button disabled={mapMode !== 'fare'} className={fareType === 'business' ? 'active' : ''} onClick={() => setFareType('business')}>商务座</button>
              <button disabled={mapMode !== 'fare'} className={fareType === 'difference' ? 'active' : ''} onClick={() => setFareType('difference')}>差价</button>
            </div>
            <div className="map-mode-control" aria-label="地图数据类型"><button className={mapMode === 'fare' ? 'active' : ''} onClick={() => setMapMode('fare')}>票价</button><button className={mapMode === 'duration' ? 'active' : ''} onClick={() => setMapMode('duration')}>时长</button><button className={mapMode === 'distance' ? 'active' : ''} onClick={() => setMapMode('distance')}>里程</button></div>
            <button className="reset-view-button" aria-label="重置视图" title="重置视图" onClick={resetView}><LocateFixed size={17} /></button>
            <div className="zoom-control"><button disabled={zoom <= minZoom} onClick={() => setZoom(z => Math.max(minZoom, +(z - .1).toFixed(2)))}><Minus size={17} /></button><span>{Math.round(zoom * 100)}%</span><button disabled={zoom >= maxZoom} onClick={() => setZoom(z => Math.min(maxZoom, +(z + .1).toFixed(2)))}><Plus size={17} /></button></div>
          </div>
        </div>
        <div className="map-canvas">
          <MetroMap lines={lines} selectedLine={selectedLine} selectedStation={selectedStation} onStationSelect={selectStation} zoom={zoom} minZoom={minZoom} maxZoom={maxZoom} pan={pan} onZoomChange={setZoom} onPanChange={setPan} metricOverlay={metricOverlay} />
        </div>
        {selectedStation && !metricOverlay && <div className="station-card"><button className="card-close" onClick={() => setSelectedStation(null)}><X size={16} /></button><div className="card-line" style={{ background: `#${activeLine.cl}` }}>{normalizeLineName(activeLine.ln).match(/^\d+支?|^\d+/)?.[0] || '•'}</div><div><p className="card-kicker">STATION DETAILS</p><h3>{selectedStation.n}</h3><span>{selectedStation.en}</span></div><div className="card-meta"><span>所属线路</span><b>{normalizeLineName(activeLine.ln)}</b></div></div>}
        <div className="map-note"><span>ⓘ</span> {selectedStation ? `当前显示从“${selectedStation.n}”出发的${modeLabel}（${modeUnit}）` : `点击任意站点，查看从该站前往全线网各站的${modeLabel}`}</div>
      </section>
    </main>
  </div>
}

export default App
