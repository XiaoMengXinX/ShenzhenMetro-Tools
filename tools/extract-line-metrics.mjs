import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const inputDir = path.join(root, '20260628')
const outputPath = path.join(root, 'public', 'data', 'metro-line-metrics.json')
const CALENDAR_BUCKET_COUNT = 10

const readRows = async (file, delimiter = ',') => {
  const content = await fs.readFile(path.join(inputDir, file), 'utf8')
  return content.split(/\r?\n/).filter(Boolean).map(row => row.split(delimiter))
}
const median = values => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const normalizeStationName = name => String(name).trim().replace(/（.*?）|\(.*?\)/g, '').replace(/站$/, '')
const positiveMinuteDifference = (start, end) => {
  let difference = end - start
  while (difference < 0) difference += 1440
  return difference
}
const uniqueRanges = link => {
  const ranges = []
  for (let bucket = 0; bucket < CALENDAR_BUCKET_COUNT; bucket += 1) {
    const start = link[9 + bucket]
    const end = link[19 + bucket]
    if (start < 0 || end < start) continue
    if (!ranges.some(range => range.start === start && range.end === end)) ranges.push({ start, end })
  }
  return ranges
}
const timingRowsForLink = (link, timingRows) => uniqueRanges(link)
  .flatMap(({ start, end }) => timingRows.slice(start, end + 1))
const runningTimeSeconds = (link, timingRows) => {
  const samples = timingRowsForLink(link, timingRows)
    .map(([departure, arrival]) => positiveMinuteDifference(departure, arrival))
    .filter(minutes => minutes > 0 && minutes <= 30)
  const minutes = median(samples)
  if (minutes === null) throw new Error(`No running-time samples for ${link[1]} -> ${link[2]}`)
  return { seconds: Math.round(minutes * 60), sampleCount: samples.length }
}
const [lineRows, wayRows, rawLinkRows, unoRows, rawTransferRows] = await Promise.all([
  readRows('line.csv'),
  readRows('way.csv'),
  readRows('link.csv'),
  readRows('uno.csv', '<,>'),
  readRows('transferfrom.csv'),
])
const linkRows = rawLinkRows.map(row => row.map(Number))
const transferRows = rawTransferRows.map(row => row.map(Number))
const dictionary = new Map(unoRows.map(row => [row[0], row]))
const stationNames = new Map()
for (let stationIndex = 0; ; stationIndex += 1) {
  const stationId = `SZMS${String(stationIndex + 1).padStart(3, '0')}`
  const entry = dictionary.get(stationId)
  if (!entry) break
  stationNames.set(stationIndex, normalizeStationName(entry[3]))
}

const ways = []
for (let wayIndex = 0; wayIndex < wayRows.length; wayIndex += 1) {
  const [wayId, lineIndex, mode, ...stationIndexes] = wayRows[wayIndex]
  if (!wayId.startsWith('SZMW') || !dictionary.has(wayId)) continue
  let timingRows
  try {
    timingRows = (await readRows(`${wayId}.csv`)).map(row => row.map(Number))
  } catch {
    continue
  }
  ways.push({
    wayIndex,
    wayId,
    lineIndex: Number(lineIndex),
    mode: Number(mode),
    stationIndexes: stationIndexes.map(Number),
    timingRows,
  })
}

const linksByWay = new Map()
for (const link of linkRows) {
  const wayIndex = link[0]
  if (!linksByWay.has(wayIndex)) linksByWay.set(wayIndex, new Map())
  linksByWay.get(wayIndex).set(`${link[1]}:${link[2]}`, link)
}

const directedMetrics = new Map()
for (const way of ways) {
  const links = linksByWay.get(way.wayIndex)
  for (let index = 0; index < way.stationIndexes.length - 1; index += 1) {
    const fromIndex = way.stationIndexes[index]
    const toIndex = way.stationIndexes[index + 1]
    const link = links?.get(`${fromIndex}:${toIndex}`)
    if (!link) throw new Error(`${way.wayId}: missing link ${fromIndex} -> ${toIndex}`)
    const running = runningTimeSeconds(link, way.timingRows)
    directedMetrics.set(`${way.lineIndex}:${fromIndex}:${toIndex}`, {
      distanceMeters: link[3],
      runningSeconds: running.seconds,
      runningSampleCount: running.sampleCount,
      wayId: way.wayId,
    })
  }
}

const edges = []
for (let lineIndex = 0; lineIndex < lineRows.length; lineIndex += 1) {
  const [lineId, ...stationIndexValues] = lineRows[lineIndex]
  if (!lineId.startsWith('SZML') || lineId === 'SZMLYB') continue
  const stationIndexes = stationIndexValues.map(Number)
  const lineCode = lineId.replace('SZML', '')
  for (let index = 0; index < stationIndexes.length - 1; index += 1) {
    const fromIndex = stationIndexes[index]
    const toIndex = stationIndexes[index + 1]
    const forward = directedMetrics.get(`${lineIndex}:${fromIndex}:${toIndex}`)
    const reverse = directedMetrics.get(`${lineIndex}:${toIndex}:${fromIndex}`)
    if (!forward || !reverse) throw new Error(`${lineId}: incomplete directions for ${fromIndex} <-> ${toIndex}`)
    if (forward.distanceMeters !== reverse.distanceMeters) throw new Error(`${lineId}: directional distance mismatch for ${fromIndex} <-> ${toIndex}`)
    edges.push({
      lineCode,
      from: stationNames.get(fromIndex),
      to: stationNames.get(toIndex),
      distanceMeters: forward.distanceMeters,
      forwardRunningSeconds: forward.runningSeconds,
      reverseRunningSeconds: reverse.runningSeconds,
      forwardSampleCount: forward.runningSampleCount,
      reverseSampleCount: reverse.runningSampleCount,
    })
  }
}

const transferSamples = new Map()
for (const [incomingLinkIndex, outgoingLinkIndex, transferType, transferSeconds, transferMinutes] of transferRows) {
  if (transferType !== 2) continue
  const incomingLink = linkRows[incomingLinkIndex]
  const outgoingLink = linkRows[outgoingLinkIndex]
  if (!incomingLink || !outgoingLink || incomingLink[2] !== outgoingLink[1]) continue
  const incomingLineIndex = Number(wayRows[incomingLink[0]]?.[1])
  const outgoingLineIndex = Number(wayRows[outgoingLink[0]]?.[1])
  const incomingLineId = lineRows[incomingLineIndex]?.[0]
  const outgoingLineId = lineRows[outgoingLineIndex]?.[0]
  if (!incomingLineId?.startsWith('SZML') || !outgoingLineId?.startsWith('SZML')) continue
  if (incomingLineId === 'SZMLYB' || outgoingLineId === 'SZMLYB' || incomingLineId === outgoingLineId) continue
  const seconds = transferSeconds || transferMinutes * 60
  if (seconds <= 0) continue
  const station = stationNames.get(incomingLink[2])
  const fromLineCode = incomingLineId.replace('SZML', '')
  const toLineCode = outgoingLineId.replace('SZML', '')
  const key = `${station}\u0000${fromLineCode}\u0000${toLineCode}`
  if (!transferSamples.has(key)) transferSamples.set(key, [])
  transferSamples.get(key).push(seconds)
}
const transfers = [...transferSamples].map(([key, samples]) => {
  const [station, fromLineCode, toLineCode] = key.split('\u0000')
  return {
    station,
    fromLineCode,
    toLineCode,
    seconds: Math.round(median(samples)),
    sampleCount: samples.length,
  }
})

const output = {
  schemaVersion: 2,
  dataVersion: path.basename(inputDir),
  units: {
    runningTime: 'seconds',
    distance: 'meters',
  },
  calculation: {
    intervalTime: 'median scheduled elapsed time for each direction and adjacent-station interval',
    transferTime: 'directed station transfer time from transferfrom.csv',
    duration: 'shortest accumulated directional scheduled interval and transfer time',
    distance: 'shortest accumulated rail-link distance',
  },
  edges,
  transfers,
}

await fs.mkdir(path.dirname(outputPath), { recursive: true })
await fs.writeFile(outputPath, `${JSON.stringify(output)}\n`)

console.log(JSON.stringify({
  dataVersion: output.dataVersion,
  edgeCount: edges.length,
  directionalEdgeCount: edges.length * 2,
  transferCount: transfers.length,
  missingRunningTimeEdges: edges.filter(edge => !edge.forwardRunningSeconds || !edge.reverseRunningSeconds).length,
  missingDistanceEdges: edges.filter(edge => !edge.distanceMeters).length,
  output: path.relative(root, outputPath),
}, null, 2))
