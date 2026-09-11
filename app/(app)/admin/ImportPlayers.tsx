'use client'

import { useState, useRef } from 'react'
import rookieData from '@/data/rookies-2026.json'

interface Props {
  leagueId: string
}

/**
 * `import` inserts the whole file, `update` re-ranks what is already there, and
 * `add` inserts only the names the league is missing. They map one-to-one onto
 * the three routes; the third exists because the first two leave a real gap —
 * see `app/api/admin/add-missing-players/route.ts`.
 */
type Mode = 'import' | 'update' | 'add'

type UpdateReport = { total: number; matched: number; willUpdate: number; unmatched: string[] }
type AddReport = { inLeague: number; inFile: number; willAdd: number; previouslyRemoved?: number; names: string[] }

const MODES: { value: Mode; label: string; hint: string }[] = [
  {
    value: 'import',
    label: 'ייבא את כל השחקנים בקובץ',
    hint: 'מוסיף כל שורה כשחקן חדש. מיועד לליגה ריקה — בליגה שכבר דראפטה זה ייצור עותק שני של כל שחקן.',
  },
  {
    value: 'update',
    label: 'עדכן דירוג לשחקנים קיימים (בלי להוסיף חדשים)',
    hint: 'משדך לפי שם ומעדכן דירוג בלבד. לא נוגע במי שכבר נבחר — סטטוס, קבוצה ומחיר נשארים כמו שהם.',
  },
  {
    value: 'add',
    label: 'הוסף רק שחקנים שחסרים בליגה',
    hint: 'משדך לפי שם ומוסיף רק את מי שאין. שחקנים קיימים לא נוגעים בהם בכלל — בטוח גם באמצע דראפט.',
  },
]

/** The bundled draft class as a `name,pos` CSV, ready to review before adding. */
function rookieCsv() {
  return ['name,pos', ...rookieData.players.map(p => `${p.name},${p.position}`)].join('\n')
}

export default function ImportPlayers({ leagueId }: Props) {
  const [csvText, setCsvText] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState('')
  const [mode, setMode] = useState<Mode>('import')
  const [report, setReport] = useState<UpdateReport | null>(null)
  const [addReport, setAddReport] = useState<AddReport | null>(null)
  const [poolLoading, setPoolLoading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /**
   * Fills the textarea with the *current* pool and switches to "add missing".
   *
   * The gap this closes: `create-league` seeds a league from the live pool, so
   * a league is complete on the day it is created and never again. ESPN ranks
   * more players as the season starts, and a player nobody rostered in
   * September is rostered in November — but nothing topped an existing league
   * up, and the admin's only route was finding a CSV somewhere and pasting it.
   *
   * It loads rather than writes on purpose: what follows is the same dry-run
   * report as any other paste, listing every name it would add, so this stays
   * a review step and not a button that silently changes a running draft.
   */
  async function loadCurrentPool() {
    setPoolLoading(true)
    const res = await fetch('/api/admin/pool')
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'שגיאה' }))
      setResult('שגיאה: ' + error)
      setPoolLoading(false)
      return
    }
    const { csv, count, source } = await res.json()
    setCsvText(csv)
    reset()
    setMode('add')
    setResult(
      source === 'espn'
        ? `נטענו ${count} שחקנים מ-ESPN. לחץ "בדוק מה חסר" כדי לראות מי חסר בליגה.`
        : `ESPN לא הגיבה — נטענו ${count} שחקנים מהמאגר המצורף. לחץ "בדוק מה חסר".`
    )
    setPoolLoading(false)
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => { setCsvText((ev.target?.result as string) ?? ''); reset() }
    reader.readAsText(file, 'UTF-8')
  }

  function reset() {
    setReport(null)
    setAddReport(null)
    setResult('')
  }

  function parseCsv() {
    const lines = csvText.trim().split('\n').filter(Boolean)
    if (lines.length < 2) return null

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
    return lines.slice(1).map(line => {
      const vals = line.split(',').map(v => v.trim())
      const obj: Record<string, string> = {}
      headers.forEach((h, i) => { obj[h] = vals[i] ?? '' })
      return {
        name: obj['name'] || obj['player'] || obj['player name'] || '',
        nba_team: obj['team'] || obj['nba_team'] || undefined,
        position: obj['pos'] || obj['position'] || undefined,
        ranking: obj['rank'] || obj['ranking'] ? Number(obj['rank'] || obj['ranking']) : undefined,
        auction_value: obj['value'] || obj['$value'] ? Number(obj['value'] || obj['$value']) : undefined,
        stats: {
          ppg: Number(obj['ppg'] || obj['p/g'] || 0) || undefined,
          rpg: Number(obj['rpg'] || obj['r/g'] || 0) || undefined,
          apg: Number(obj['apg'] || obj['a/g'] || 0) || undefined,
          spg: Number(obj['spg'] || obj['s/g'] || 0) || undefined,
          bpg: Number(obj['bpg'] || obj['b/g'] || 0) || undefined,
        },
      }
    }).filter(p => p.name)
  }

  async function handleImport() {
    setLoading(true)
    setResult('')
    const players = parseCsv()
    if (!players) { setResult('CSV ריק'); setLoading(false); return }

    const res = await fetch('/api/import-players', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ league_id: leagueId, players }),
    })
    const data = await res.json()
    setResult(data.error ? `שגיאה: ${data.error}` : `יובאו ${data.imported} שחקנים ✓`)
    setLoading(false)
  }

  /** `dryRun` reports what would change without writing — always run first. */
  async function handleUpdate(dryRun: boolean) {
    setLoading(true)
    setResult('')
    const parsed = parseCsv()
    if (!parsed) { setResult('CSV ריק'); setLoading(false); return }
    const players = parsed.map(p => ({ name: p.name, ranking: p.ranking ?? null, nba_team: p.nba_team }))

    const res = await fetch('/api/admin/update-player-rankings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ league_id: leagueId, players, dry_run: dryRun }),
    })
    const data = await res.json()
    setLoading(false)

    if (data.error) { setResult(`שגיאה: ${data.error}`); return }
    if (dryRun) { setReport(data); return }
    setReport(null)
    setResult(`עודכנו ${data.updated} שחקנים ✓`)
  }

  /** Same two-step shape as the update: report first, then commit. */
  async function handleAdd(dryRun: boolean) {
    setLoading(true)
    setResult('')
    const parsed = parseCsv()
    if (!parsed) { setResult('CSV ריק'); setLoading(false); return }
    const players = parsed.map(p => ({
      name: p.name,
      position: p.position ?? null,
      // A file with no rank column lets the server number them from the top of
      // this league's own list, rather than importing a foreign scale.
      ranking: p.ranking ?? null,
      auction_value: p.auction_value ?? null,
    }))

    const res = await fetch('/api/admin/add-missing-players', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ league_id: leagueId, players, dry_run: dryRun }),
    })
    const data = await res.json()
    setLoading(false)

    if (data.error) { setResult(`שגיאה: ${data.error}`); return }
    if (dryRun) { setAddReport(data); return }
    setAddReport(null)
    setResult(`נוספו ${data.added} שחקנים ✓`)
  }

  return (
    <div className="card mt-4">
      <h2 className="font-bold mb-2">ייבוא שחקנים (CSV)</h2>
      <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
        עמודות נדרשות: name — אופציונלי: pos, team, rank, value, ppg, rpg, apg, spg, bpg
      </p>
      <div className="flex gap-2 mb-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt"
          className="hidden"
          onChange={handleFile}
        />
        <button
          type="button"
          className="btn btn-outline flex-1"
          onClick={() => fileRef.current?.click()}
        >
          בחר קובץ CSV
        </button>
        <button
          type="button"
          className="btn btn-outline text-sm"
          onClick={loadCurrentPool}
          disabled={poolLoading}
          title="מושך את המאגר העדכני מ-ESPN ומכין הוספה של מי שחסר בליגה הזו"
        >
          {poolLoading ? '...' : 'טען מאגר עדכני'}
        </button>
        <button
          type="button"
          className="btn btn-outline text-sm"
          onClick={() => { setCsvText(rookieCsv()); reset(); setMode('add') }}
          title="מחזור הדראפט של 2026 — ESPN עוד לא דירגו אותם"
        >
          טען רוקיז 2026
        </button>
        {csvText && (
          <button
            type="button"
            className="btn btn-outline text-sm"
            onClick={() => { setCsvText(''); reset(); if (fileRef.current) fileRef.current.value = '' }}
          >
            נקה
          </button>
        )}
      </div>
      <textarea
        className="input font-mono text-xs"
        rows={6}
        placeholder="name,pos&#10;LeBron James,SF&#10;..."
        value={csvText}
        onChange={e => { setCsvText(e.target.value); reset() }}
        dir="ltr"
      />

      <div className="mt-3 flex flex-col gap-2">
        {MODES.map(m => (
          <label key={m.value} className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="import-mode"
              className="mt-1"
              checked={mode === m.value}
              onChange={() => { setMode(m.value); reset() }}
            />
            <span>
              {m.label}
              <span className="block text-xs" style={{ color: 'var(--muted)' }}>{m.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {report && (
        <div className="mt-3 p-3 text-sm" style={{ background: 'var(--background)', borderRadius: '8px', border: '1px solid var(--border)' }}>
          <p>
            <strong>{report.matched}</strong> מתוך <strong>{report.total}</strong> שחקנים בליגה שודכו ·{' '}
            <strong>{report.willUpdate}</strong> יעודכנו
          </p>
          {report.unmatched.length > 0 && (
            <>
              <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
                {report.unmatched.length} לא נמצאו בקובץ ויישארו ללא דירוג (ירדו לתחתית הרשימה):
              </p>
              <p className="text-xs mt-1 overflow-y-auto" style={{ color: 'var(--muted)', maxHeight: '120px' }} dir="ltr">
                {report.unmatched.join(', ')}
              </p>
            </>
          )}
        </div>
      )}

      {addReport && (
        <div className="mt-3 p-3 text-sm" style={{ background: 'var(--background)', borderRadius: '8px', border: '1px solid var(--border)' }}>
          <p>
            בקובץ <strong>{addReport.inFile}</strong> שמות · בליגה <strong>{addReport.inLeague}</strong> שחקנים ·{' '}
            <strong>{addReport.willAdd}</strong> יתווספו
            {!!addReport.previouslyRemoved && (
              <>
                {' '}·{' '}
                <span style={{ color: 'var(--warning)' }}>
                  מתוכם <strong>{addReport.previouslyRemoved}</strong> שהסרת בעבר מהליגה — אישור יחזיר אותם
                </span>
              </>
            )}
          </p>
          {addReport.willAdd === 0 ? (
            <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
              כל השמות בקובץ כבר קיימים בליגה — אין מה להוסיף.
            </p>
          ) : (
            <>
              <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
                השחקנים שיתווספו (עברו על הרשימה לפני אישור):
              </p>
              <p className="text-xs mt-1 overflow-y-auto" style={{ color: 'var(--muted)', maxHeight: '120px' }} dir="ltr">
                {addReport.names.join(', ')}
              </p>
            </>
          )}
        </div>
      )}

      {result && <p className="text-sm mt-2" style={{ color: result.startsWith('שגיאה') ? 'var(--danger)' : 'var(--success)' }}>{result}</p>}

      {mode === 'import' && (
        <button className="btn btn-primary mt-3" onClick={handleImport} disabled={loading || !csvText.trim()}>
          {loading ? 'מייבא...' : 'ייבא שחקנים'}
        </button>
      )}

      {mode === 'update' && (
        <div className="flex gap-2 mt-3">
          <button className="btn btn-outline" onClick={() => handleUpdate(true)} disabled={loading || !csvText.trim()}>
            {loading ? 'בודק...' : 'בדוק התאמה'}
          </button>
          {report && (
            <button className="btn btn-primary" onClick={() => handleUpdate(false)} disabled={loading || report.willUpdate === 0}>
              {loading ? 'מעדכן...' : `אשר ועדכן ${report.willUpdate}`}
            </button>
          )}
        </div>
      )}

      {mode === 'add' && (
        <div className="flex gap-2 mt-3">
          <button className="btn btn-outline" onClick={() => handleAdd(true)} disabled={loading || !csvText.trim()}>
            {loading ? 'בודק...' : 'בדוק מה חסר'}
          </button>
          {addReport && (
            <button className="btn btn-primary" onClick={() => handleAdd(false)} disabled={loading || addReport.willAdd === 0}>
              {loading ? 'מוסיף...' : `אשר והוסף ${addReport.willAdd}`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
