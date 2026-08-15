import { readFile, writeFile } from 'node:fs/promises'
import vm from 'node:vm'

const SOURCE_FILE = new URL('../metroStationsList.js', import.meta.url)
const OUTPUT_FILE = new URL('../src/data/station-search-index.json', import.meta.url)

const source = await readFile(SOURCE_FILE, 'utf8')
const declarationStart = source.indexOf('var allLineList')
const declarationEnd = source.lastIndexOf('];')

if (declarationStart < 0 || declarationEnd < declarationStart) {
  throw new Error('metroStationsList.js 中未找到 allLineList 数据')
}

const context = {}
vm.runInNewContext(source.slice(declarationStart, declarationEnd + 2), context)

if (!Array.isArray(context.allLineList)) {
  throw new Error('metroStationsList.js 中的 allLineList 格式无效')
}

const stationsByName = new Map()
for (const line of context.allLineList) {
  for (const station of line.stationList || []) {
    const name = station.stationName?.replace(/站$/, '')
    if (!name || stationsByName.has(name)) continue
    stationsByName.set(name, {
      name,
      full: station.stationQP?.toLowerCase() || '',
      initials: station.stationJP?.toLowerCase() || ''
    })
  }
}

const output = {
  schemaVersion: 1,
  stations: [...stationsByName.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

await writeFile(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`)
console.log(`已生成 ${output.stations.length} 个站点的拼音搜索索引`)
