#!/usr/bin/env node
/**
 * Records, for every unfinished league, the pool players it does not currently
 * have — so the nightly `top-up-pools` job starts from "the pool as this league
 * has it today is the intended pool" and adds only what is genuinely new.
 *
 *   node scripts/baseline-pool-exclusions.mjs           dry run, prints only
 *   node scripts/baseline-pool-exclusions.mjs --write   actually record
 *
 * Same idea as the baseline at the end of `migration_open_notifications.sql`:
 * switching a sweep on mid-season has to claim what is already true, or the
 * first run fires a backlog at a live league. Here the backlog would be every
 * player an admin has ever trimmed out plus every player the league simply
 * predates — the live league had been cut from 474 to 317 by hand, and a dry
 * run of the job showed it about to restore all 157.
 *
 * ⚠️ It only ever *adds* exclusions, so run it once the pool is trimmed the way
 * you want it. Re-running is harmless (upsert, ignore duplicates) but it will
 * also claim anything deleted in between, which is usually what you want.
 *
 * Prerequisites: supabase/migration_player_exclusions.sql applied, and
 * `.env.local` carrying NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { fetchRankedPlayers, fetchRosteredExtras, withRookies, withExtras, defaultSeason, MIN_RANKED } from '../lib/espnPool.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WRITE = process.argv.includes('--write')

for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=')
  if (i > 0 && !line.startsWith('#')) process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim()
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

/** Mirrors normalizePlayerName() in lib/utils.ts — keep the two bodies identical. */
const normalizePlayerName = n =>
  n.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[.'`\-]/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/, '').replace(/\s+/g, ' ').trim()

const CORRUPTED = /[?�]/
/** Mirrors matchPlayerName() in lib/utils.ts. */
function matchPlayerName(name, keys) {
  const key = normalizePlayerName(name)
  if (keys.includes(key)) return key
  if (!CORRUPTED.test(key)) return null
  const pattern = [...key]
    .map(c => (CORRUPTED.test(c) ? '.' : /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c))
    .join('')
  const hits = keys.filter(k => new RegExp(`^${pattern}$`).test(k))
  return hits.length === 1 ? hits[0] : null
}

const season = defaultSeason()
const ranked = await fetchRankedPlayers({ season })
if (ranked.length < MIN_RANKED) {
  console.error(`only ${ranked.length} ranked players came back — refusing to baseline off a truncated pool`)
  process.exit(2)
}
const rookieFile = path.join(ROOT, 'data', `rookies-${season - 1}.json`)
const rookies = fs.existsSync(rookieFile) ? JSON.parse(fs.readFileSync(rookieFile, 'utf8')) : null
const pool = withExtras(withRookies(ranked, rookies, season), await fetchRosteredExtras({ season }))
console.log(`pool: ${pool.length} players\n`)

const { data: leagues, error } = await sb
  .from('leagues').select('id, name, status').in('status', ['setup', 'lottery', 'active', 'paused'])
if (error) { console.error(error); process.exit(1) }

for (const l of leagues) {
  const existing = []
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from('players').select('name').eq('league_id', l.id).range(from, from + 999)
    if (!data?.length) break
    existing.push(...data)
    if (data.length < 1000) break
  }

  const byKey = new Map()
  for (const p of pool) {
    const key = normalizePlayerName(p.name)
    if (key && !byKey.has(key)) byKey.set(key, p)
  }
  const keys = [...byKey.keys()]
  for (const row of existing) {
    const hit = matchPlayerName(row.name, keys)
    if (hit) byKey.delete(hit)
  }

  const rows = [...byKey.entries()].map(([name_key, p]) => ({ league_id: l.id, name_key, name: p.name }))
  console.log(`${l.status.padEnd(8)} ${String(existing.length).padStart(4)} players  →  ${String(rows.length).padStart(4)} to exclude   ${l.name}`)
  if (!WRITE || !rows.length) continue

  let written = 0
  for (let i = 0; i < rows.length; i += 200) {
    const { error: e } = await sb.from('league_player_exclusions')
      .upsert(rows.slice(i, i + 200), { onConflict: 'league_id,name_key', ignoreDuplicates: true })
    if (e) { console.error(`  ${l.name}: ${e.message}`); break }
    written += rows.slice(i, i + 200).length
  }
  console.log(`         recorded ${written}`)
}

if (!WRITE) console.log('\nDRY RUN — pass --write to record')
