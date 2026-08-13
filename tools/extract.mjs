import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(root, 'public', 'data')
const allSources = [
  { file: '深圳地铁票价表.xlsx', type: 'standard', label: '普通车厢' },
  { file: '深圳地铁票价表（商务座）.xlsx', type: 'business', label: '商务座' },
]
const requestedType = process.argv[2]
const sources = allSources.filter(source => source.type === requestedType)
if (sources.length !== 1) throw new Error('Pass exactly one fare type: standard or business')

const fillForward = rows => {
  let current = ''
  return rows.map(row => {
    if (row[0] !== null && row[0] !== undefined && String(row[0]).trim()) current = String(row[0]).trim()
    return [current, row[1], row[2]]
  })
}

const fillForwardValues = values => {
  let current = ''
  return values.map(value => {
    if (value !== null && value !== undefined && String(value).trim()) current = String(value).trim()
    return current
  })
}

const parseStationNumber = value => {
  const number = Number(value)
  return Number.isFinite(number) ? number : String(value).trim()
}

const matrixIsSymmetric = matrix => matrix.every((row, i) => row.every((value, j) => value === matrix[j][i]))

await fs.mkdir(outputDir, { recursive: true })
let canonicalStations = null
const summaries = []
const stationOutputPath = path.join(outputDir, 'metro-fare-stations.json')
const existingStationData = requestedType === 'business'
  ? JSON.parse(await fs.readFile(stationOutputPath, 'utf8'))
  : null

for (const source of sources) {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(path.join(root, source.file)))
  const sheet = workbook.worksheets.getItemAt(0)
  const used = sheet.getUsedRange()
  const [rowCount, columnCount] = [used.values.length, used.values[0].length]
  const stationCount = Number(sheet.getRange('A2').values[0][0])

  if (rowCount !== stationCount + 3 || columnCount !== stationCount + 3) {
    throw new Error(`${source.file}: expected ${stationCount + 3}×${stationCount + 3}, got ${rowCount}×${columnCount}`)
  }

  const lastRow = stationCount + 3
  const rowMetadata = fillForward(sheet.getRange(`A4:C${lastRow}`).values)
  const columnMetadata = sheet.getRange(`D1:PS3`).values
  const columnLines = fillForwardValues(columnMetadata[0])
  const columnNumbers = columnMetadata[1]
  const columnNames = columnMetadata[2]

  const stations = rowMetadata.map(([lineName, stationNumber, name], index) => ({
    index,
    id: `${lineName}:${parseStationNumber(stationNumber)}`,
    lineName,
    stationNumber: parseStationNumber(stationNumber),
    name: String(name).trim(),
  }))

  for (let i = 0; i < stationCount; i += 1) {
    const columnLine = String(columnLines[i] ?? '').trim()
    const columnNumber = parseStationNumber(columnNumbers[i])
    const columnName = String(columnNames[i] ?? '').trim()
    const station = stations[i]
    if (station.lineName !== columnLine || station.stationNumber !== columnNumber || station.name !== columnName) {
      throw new Error(`${source.file}: row/column station mismatch at index ${i}: row=${JSON.stringify(station)}, column=${JSON.stringify({ lineName: columnLine, stationNumber: columnNumber, name: columnName })}`)
    }
  }

  if (new Set(stations.map(station => station.id)).size !== stationCount) {
    throw new Error(`${source.file}: duplicate station IDs found`)
  }

  if (canonicalStations === null) canonicalStations = stations
  if (existingStationData && JSON.stringify(existingStationData.stations) !== JSON.stringify(stations)) {
    throw new Error(`${source.file}: station index differs from the standard fare workbook`)
  }

  const rawMatrix = sheet.getRange(`D4:PS${lastRow}`).values
  const matrix = rawMatrix.map((row, rowIndex) => row.map((value, columnIndex) => {
    const fare = Number(value)
    if (!Number.isFinite(fare)) throw new Error(`${source.file}: non-numeric fare at ${rowIndex},${columnIndex}`)
    return fare
  }))

  if (!matrixIsSymmetric(matrix)) throw new Error(`${source.file}: fare matrix is not symmetric`)

  const fareRange = matrix.reduce((range, row) => row.reduce((current, fare) => ({
    min: Math.min(current.min, fare),
    max: Math.max(current.max, fare),
  }), range), { min: Infinity, max: -Infinity })
  const output = {
    schemaVersion: 1,
    fareType: source.type,
    label: source.label,
    currency: 'CNY',
    stationCount,
    lookup: 'matrix[fromStationIndex][toStationIndex]',
    matrix,
  }
  await fs.writeFile(path.join(outputDir, `metro-fares-${source.type}.json`), `${JSON.stringify(output)}\n`)
  summaries.push({
    type: source.type,
    stationCount,
    matrixRows: matrix.length,
    matrixColumns: matrix[0].length,
    minFare: fareRange.min,
    maxFare: fareRange.max,
    symmetric: true,
  })
}

if (requestedType === 'standard') {
  await fs.writeFile(stationOutputPath, `${JSON.stringify({
    schemaVersion: 1,
    stationCount: canonicalStations.length,
    idFormat: '<线路名称>:<线路内站编号>',
    stations: canonicalStations,
  }, null, 2)}\n`)
}

console.log(JSON.stringify(summaries, null, 2))
