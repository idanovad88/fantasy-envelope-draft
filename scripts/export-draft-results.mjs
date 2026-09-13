#!/usr/bin/env node
/**
 * Exports every drafted player and the price he went for, across every league
 * that has *finished* drafting, to one CSV and one Excel workbook.
 *
 *   node scripts/export-draft-results.mjs           write both files
 *   node scripts/export-draft-results.mjs --check   compare only; exit 1 if a
 *                                                   draft closed since the last
 *                                                   write (or any row changed)
 *
 * Covered: `status = 'completed'` leagues whose `draft_type` is `envelope` or
 * `open`. Snake is deliberately out — it has no prices, which is the whole
 * point of this export. A league still `active` is out too: it is not a result
 * yet, and including it would mean the file changes under the reader every time
 * somebody bids.
 *
 * The two formats keep their auction data in different tables (see CLAUDE.md,
 * "Open outcry draft") so each is read separately and then flattened to one row
 * shape. `players.draft_price` is not the source here: the auction row is, so
 * the nominator, the runner-up and the closing time come from the same record
 * as the price. The two agree today — worth re-checking with the cross-check in
 * this file's git history if they ever stop.
 *
 * ⚠️ `--check` compares the **CSV** only. A workbook carries a creation
 * timestamp, so its bytes differ on every run and would report a change every
 * time. The CSV is deterministic by construction: leagues sorted by opening
 * date, rows by closing time then player name.
 *
 * Prerequisite: `.env.local` carrying NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY. Reads only — it writes nothing to the database.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import XLSX from 'xlsx'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ONLY = process.argv.includes('--check')

const CSV_PATH = path.join(ROOT, 'draft_results_all_leagues.csv')
const XLSX_PATH = path.join(ROOT, 'draft_results_all_leagues.xlsx')

for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=')
  if (i > 0 && !line.startsWith('#')) process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim()
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const PAGE = 1000

/** PostgREST caps a response at 1000 rows — `bids` passes that mid-draft. */
async function selectAll(build) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...data)
    if (data.length < PAGE) return rows
  }
}

const TYPE_HE = { envelope: 'מעטפות', open: 'אוקשן לייב' }
const REASON_HE = { all_passed: 'כולם פרשו', timeout: 'נגמר הזמן', admin: 'סגירת מנהל', cancelled: 'בוטל' }

const dateTimeFmt = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
})
const dateFmt = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
})
const whenExact = iso => dateTimeFmt.format(new Date(iso)).replace(',', '')
const whenDay = iso => dateFmt.format(new Date(iso))

const HEADERS = [
  'ליגה', 'סוג דראפט', 'תאריך פתיחת דראפט', '#', 'שחקן', 'עמדה', 'דירוג', 'משבצת',
  'קבוצה', 'מחיר', 'הועלה ע"י', 'הצעה שנייה', 'הפרש', "מס' הצעות",
  'הוכרע בפריוריטי', 'סיבת סגירה', 'תאריך סגירה',
]
const WIDTHS = [26, 11, 17, 5, 22, 7, 7, 8, 18, 7, 18, 11, 7, 10, 14, 12, 17]

/**
 * When the draft actually opened — the first player going up, not the day the
 * league row was created (the gap runs to ten days) and not `draft_start_time`,
 * which is a snake field and is NULL in every league here. The fallbacks are
 * there so a league that somehow has no auctions still gets a date.
 */
async function draftOpenedAt(league) {
  const table = league.draft_type === 'envelope' ? 'auctions' : 'open_auctions'
  const column = league.draft_type === 'envelope' ? 'scheduled_start' : 'created_at'
  const { data, error } = await sb
    .from(table).select(column).eq('league_id', league.id)
    .order(column, { ascending: true }).limit(1)
  if (error) throw new Error(error.message)
  return data[0]?.[column] ?? league.draft_start_time ?? league.created_at
}

/** One flat row per player sold, whichever format sold him. */
async function rowsForLeague(league) {
  const [teams, players] = await Promise.all([
    selectAll(() => sb.from('teams').select('id, name').eq('league_id', league.id)),
    selectAll(() =>
      sb.from('players').select('id, name, position, ranking, roster_slot').eq('league_id', league.id)
    ),
  ])
  const teamName = new Map(teams.map(t => [t.id, t.name]))
  const player = new Map(players.map(p => [p.id, p]))

  const envelope = league.draft_type === 'envelope'
  const auctionTable = envelope ? 'auctions' : 'open_auctions'
  const bidTable = envelope ? 'bids' : 'open_bids'
  const bidParent = envelope ? 'auction_id' : 'open_auction_id'

  let auctionQuery = () =>
    sb.from(auctionTable)
      .select(
        envelope
          ? 'id, player_id, nominating_team_id, winning_team_id, winning_bid, tie_broken_by_priority, updated_at'
          : 'id, player_id, nominating_team_id, winning_team_id, winning_bid, closed_reason, updated_at'
      )
      .eq('league_id', league.id)
      .not('winning_team_id', 'is', null)
  if (!envelope) {
    const base = auctionQuery
    auctionQuery = () => base().eq('status', 'completed')
  }
  const auctions = await selectAll(auctionQuery)

  // Filtered through an embedded !inner join, never `.in(ids)` — an id list is
  // serialised into the URL and grows with the draft.
  const bids = await selectAll(() =>
    sb.from(bidTable)
      .select(`${bidParent}, team_id, amount, parent:${auctionTable}!inner(league_id)`)
      .eq('parent.league_id', league.id)
  )
  const bidsByAuction = new Map()
  for (const b of bids) {
    const list = bidsByAuction.get(b[bidParent])
    if (list) list.push(b)
    else bidsByAuction.set(b[bidParent], [b])
  }

  const openedAt = whenDay(await draftOpenedAt(league))

  return auctions
    .map(a => {
      const all = bidsByAuction.get(a.id) ?? []
      const others = all.filter(b => b.team_id !== a.winning_team_id).map(b => b.amount)
      const second = others.length ? Math.max(...others) : 0
      const p = player.get(a.player_id)
      return {
        sortKey: a.updated_at + '|' + (p?.name ?? ''),
        cells: [
          league.name,
          TYPE_HE[league.draft_type],
          openedAt,
          0, // running number, filled in after the sort
          p?.name ?? '',
          p?.position ?? '',
          p?.ranking ?? '',
          p?.roster_slot ?? '',
          teamName.get(a.winning_team_id) ?? '',
          a.winning_bid,
          a.nominating_team_id ? teamName.get(a.nominating_team_id) ?? '' : '',
          second,
          a.winning_bid - second,
          all.length,
          envelope ? (a.tie_broken_by_priority ? 'כן' : 'לא') : '',
          envelope ? '' : REASON_HE[a.closed_reason] ?? a.closed_reason ?? '',
          whenExact(a.updated_at),
        ],
      }
    })
    .sort((x, y) => x.sortKey.localeCompare(y.sortKey))
    .map((r, i) => {
      r.cells[3] = i + 1
      return r.cells
    })
}

function toCsv(rows) {
  const cell = v => {
    const s = String(v ?? '')
    return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s
  }
  // BOM: Excel opens a UTF-8 CSV as the local codepage without it, and every
  // Hebrew league name in this file turns to mojibake.
  return '﻿' + [HEADERS, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

const EXCEL_FORBIDDEN = '[]:*?/'
const sheetName = name =>
  [...name]
    .map(ch => (EXCEL_FORBIDDEN.includes(ch) || ch.charCodeAt(0) === 92 ? ' ' : ch))
    .join('')
    .slice(0, 31)

/**
 * The workbook goes through openpyxl, not SheetJS: the community build of
 * SheetJS writes no cell styles and no `rightToLeft` sheet view at all (tested
 * — it emits a bare `<sheetView workbookViewId="0"/>`), so a Hebrew workbook
 * comes out left-to-right and unformatted. If Python or openpyxl is missing we
 * still write a plain workbook rather than none.
 */
function writeWorkbook(sheets) {
  const payload = path.join(os.tmpdir(), `draft-export-${process.pid}.json`)
  fs.writeFileSync(payload, JSON.stringify({ headers: HEADERS, widths: WIDTHS, sheets }), 'utf8')
  try {
    for (const exe of ['python', 'py']) {
      const run = spawnSync(exe, [path.join(ROOT, 'scripts', 'xlsx_styled.py'), payload, XLSX_PATH], {
        encoding: 'utf8',
      })
      if (run.error) continue
      if (run.status === 0) return 'openpyxl'
      console.error(`${exe}: ${(run.stderr || '').trim().split('\n').pop()}`)
    }
  } finally {
    fs.rmSync(payload, { force: true })
  }

  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...s.rows])
    ws['!cols'] = WIDTHS.map(wch => ({ wch }))
    XLSX.utils.book_append_sheet(wb, ws, sheetName(s.name))
  }
  XLSX.writeFile(wb, XLSX_PATH)
  return 'sheetjs (plain — no RTL, no styling)'
}

// ── run ──────────────────────────────────────────────────────────────────────

const { data: leagues, error } = await sb
  .from('leagues')
  .select('id, name, draft_type, status, draft_start_time, created_at')
  .eq('status', 'completed')
  .in('draft_type', ['envelope', 'open'])
if (error) {
  console.error(error.message)
  process.exit(2)
}
if (leagues.length === 0) {
  console.error('no completed envelope/open leagues — nothing to export')
  process.exit(2)
}

const groups = []
for (const league of leagues) {
  groups.push({ league, opened: await draftOpenedAt(league), rows: await rowsForLeague(league) })
}
groups.sort((a, b) => a.opened.localeCompare(b.opened) || a.league.name.localeCompare(b.league.name))

const all = groups.flatMap(g => g.rows)
const csv = toCsv(all)
const previous = fs.existsSync(CSV_PATH) ? fs.readFileSync(CSV_PATH, 'utf8') : null
const changed = previous !== csv

for (const g of groups) {
  const spend = g.rows.reduce((s, r) => s + r[9], 0)
  console.log(
    `${g.league.name} · ${TYPE_HE[g.league.draft_type]} · opened ${whenDay(g.opened)} · ` +
      `${g.rows.length} players · $${spend}`
  )
}
console.log(`${groups.length} leagues, ${all.length} players`)

if (!previous) {
  console.log('no previous file — this is the first write')
} else if (!changed) {
  console.log('no change')
} else {
  const leaguesIn = csv => new Set(csv.split(/\r?\n/).slice(1).filter(Boolean).map(l => l.split(',')[0]))
  const before = leaguesIn(previous)
  const added = [...leaguesIn(csv)].filter(n => !before.has(n))
  const rowDelta = all.length - previous.split(/\r?\n/).filter(Boolean).length + 1
  console.log(
    `changed: ${rowDelta >= 0 ? '+' : ''}${rowDelta} players` +
      (added.length ? `, new league(s): ${added.join(', ')}` : '')
  )
}

if (CHECK_ONLY) process.exit(changed ? 1 : 0)

fs.writeFileSync(CSV_PATH, csv, 'utf8')
const how = writeWorkbook([
  { name: 'כל הליגות', rows: all },
  ...groups.map(g => ({ name: g.league.name, rows: g.rows })),
])
console.log(`wrote ${path.basename(CSV_PATH)} and ${path.basename(XLSX_PATH)} (workbook via ${how})`)
