'use client'

import { useState, useRef } from 'react'

interface Props {
  leagueId: string
}

type Report = { total: number; matched: number; willUpdate: number; unmatched: string[] }

export default function ImportPlayers({ leagueId }: Props) {
  const [csvText, setCsvText] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState('')
  // Update mode fills `ranking` on players that already exist instead of
  // inserting new ones — the only safe way to re-rank a league mid-draft.
  const [updateMode, setUpdateMode] = useState(false)
  const [report, setReport] = useState<Report | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => { setCsvText((ev.target?.result as string) ?? ''); reset() }
    reader.readAsText(file, 'UTF-8')
  }

  function reset() {
    setReport(null)
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

      <label className="flex items-start gap-2 mt-3 text-sm cursor-pointer">
        <input
          type="checkbox"
          className="mt-1"
          checked={updateMode}
          onChange={e => { setUpdateMode(e.target.checked); reset() }}
        />
        <span>
          עדכן דירוג לשחקנים קיימים (בלי להוסיף חדשים)
          <span className="block text-xs" style={{ color: 'var(--muted)' }}>
            משדך לפי שם ומעדכן דירוג בלבד. לא נוגע במי שכבר נבחר — סטטוס, קבוצה ומחיר נשארים כמו שהם.
          </span>
        </span>
      </label>

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

      {result && <p className="text-sm mt-2" style={{ color: result.startsWith('שגיאה') ? 'var(--danger)' : 'var(--success)' }}>{result}</p>}

      {updateMode ? (
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
      ) : (
        <button className="btn btn-primary mt-3" onClick={handleImport} disabled={loading || !csvText.trim()}>
          {loading ? 'מייבא...' : 'ייבא שחקנים'}
        </button>
      )}
    </div>
  )
}
