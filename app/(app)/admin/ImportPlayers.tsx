'use client'

import { useState } from 'react'

interface Props {
  leagueId: string
}

export default function ImportPlayers({ leagueId }: Props) {
  const [csvText, setCsvText] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState('')

  async function handleImport() {
    setLoading(true)
    setResult('')
    const lines = csvText.trim().split('\n').filter(Boolean)
    if (lines.length < 2) { setResult('CSV ריק'); setLoading(false); return }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
    const players = lines.slice(1).map(line => {
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

    const res = await fetch('/api/import-players', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ league_id: leagueId, players }),
    })
    const data = await res.json()
    setResult(data.error ? `שגיאה: ${data.error}` : `יובאו ${data.imported} שחקנים ✓`)
    setLoading(false)
  }

  return (
    <div className="card mt-4">
      <h2 className="font-bold mb-2">ייבוא שחקנים (CSV)</h2>
      <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
        עמודות נדרשות: name, team, pos, rank, value, ppg, rpg, apg, spg, bpg
      </p>
      <textarea
        className="input font-mono text-xs"
        rows={6}
        placeholder="name,team,pos,rank,value&#10;LeBron James,LAL,SF,10,45&#10;..."
        value={csvText}
        onChange={e => setCsvText(e.target.value)}
        dir="ltr"
      />
      {result && <p className="text-sm mt-2" style={{ color: result.startsWith('שגיאה') ? 'var(--danger)' : 'var(--success)' }}>{result}</p>}
      <button className="btn btn-primary mt-3" onClick={handleImport} disabled={loading || !csvText.trim()}>
        {loading ? 'מייבא...' : 'ייבא שחקנים'}
      </button>
    </div>
  )
}
