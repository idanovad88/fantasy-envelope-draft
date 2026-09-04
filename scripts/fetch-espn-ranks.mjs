#!/usr/bin/env node
/**
 * Pulls ESPN's preseason draft rankings and writes the two files the app seeds
 * new leagues from: the CSV the admin panel still accepts by hand, and the
 * JSON `create-league` falls back to when ESPN is unreachable.
 *
 *   node scripts/fetch-espn-ranks.mjs           write both files
 *   node scripts/fetch-espn-ranks.mjs --check   compare only; exit 1 if the
 *                                               ranks actually moved
 *   node scripts/fetch-espn-ranks.mjs --season 2028
 *
 * CLAUDE.md used to call regenerating this a browser job. That is true of
 * `WebFetch`, which cannot send the `x-fantasy-filter` header the endpoint
 * requires — but `fetch` can, so this runs unattended in ~2s.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRankedPlayers, defaultSeason, seasonSlug, MIN_RANKED } from '../lib/espnPool.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const CHECK_ONLY = argv.includes('--check')

const seasonArg = argv.indexOf('--season')
const SEASON = seasonArg !== -1 ? Number(argv[seasonArg + 1]) : defaultSeason()
if (!Number.isInteger(SEASON) || SEASON < 2000) {
  console.error(`bad --season: ${argv[seasonArg + 1]}`)
  process.exit(2)
}

const CSV_PATH = path.join(ROOT, `nba_players_${seasonSlug(SEASON)}.csv`)
const JSON_PATH = path.join(ROOT, 'data', 'nba-pool.json')

/**
 * No `team` column, deliberately. The `proTeamId` mapping in the original
 * scrape was wrong (Giannis -> MIA, LeBron -> PHI, Zubac -> IND) and it wrote
 * 250 bad teams into the live pool on 2026-09-04. Anyone restoring it must
 * check a handful of known players first.
 */
function toCsv(players) {
  const lines = ['name,pos,rank,value']
  for (const p of players) lines.push(`${p.name},${p.position},${p.ranking},${p.auction_value}`)
  return lines.join('\n') + '\n'
}

function toJson(players) {
  return JSON.stringify(players, null, 0) + '\n'
}

/** What actually moved, ignoring how the files are formatted. */
function summarise(previous, next) {
  const before = new Map(previous.map(p => [p.name, p]))
  const after = new Map(next.map(p => [p.name, p]))

  const added = next.filter(p => !before.has(p.name))
  const removed = previous.filter(p => !after.has(p.name))
  const moved = []
  for (const p of next) {
    const was = before.get(p.name)
    if (was && (was.ranking !== p.ranking || was.auction_value !== p.auction_value)) {
      moved.push({ name: p.name, from: was.ranking, to: p.ranking })
    }
  }
  moved.sort((a, b) => Math.abs(b.from - b.to) - Math.abs(a.from - a.to))
  return { added, removed, moved }
}

function readPrevious() {
  if (!fs.existsSync(CSV_PATH)) return null
  return fs
    .readFileSync(CSV_PATH, 'utf8')
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map(l => {
      const [name, position, ranking, value] = l.split(',')
      return { name, position, ranking: Number(ranking), auction_value: Number(value) }
    })
}

const players = await fetchRankedPlayers({ season: SEASON })

if (players.length < MIN_RANKED) {
  console.error(
    `only ${players.length} ranked players came back (expected >= ${MIN_RANKED}) — not writing`
  )
  process.exit(2)
}

const previous = readPrevious()
const { added, removed, moved } = previous
  ? summarise(previous, players)
  : { added: players, removed: [], moved: [] }
const changed = added.length > 0 || removed.length > 0 || moved.length > 0

console.log(`season ${seasonSlug(SEASON).replace('_', '-')} · ${players.length} ranked players`)
if (!previous) {
  console.log('no previous file — this is the first write')
} else if (!changed) {
  console.log('no change')
} else {
  console.log(`changed: ${moved.length} moved, ${added.length} added, ${removed.length} dropped`)
  for (const m of moved.slice(0, 10)) console.log(`  ${m.name}: ${m.from} -> ${m.to}`)
  for (const a of added.slice(0, 10)) console.log(`  + ${a.name} (${a.ranking})`)
  for (const r of removed.slice(0, 10)) console.log(`  - ${r.name} (was ${r.ranking})`)
}

if (CHECK_ONLY) process.exit(changed ? 1 : 0)

fs.mkdirSync(path.dirname(JSON_PATH), { recursive: true })
fs.writeFileSync(CSV_PATH, toCsv(players), 'utf8')
fs.writeFileSync(JSON_PATH, toJson(players), 'utf8')
console.log(`wrote ${path.relative(ROOT, CSV_PATH)} and ${path.relative(ROOT, JSON_PATH)}`)
