'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Countdown from './Countdown'
import { formatCurrency, formatTime } from '@/lib/utils'
import type { OpenPassReason } from '@/types'

export interface BoardBid {
  id: string
  teamId: string
  teamName: string
  amount: number
  isAuto: boolean
  createdAt: string
}

export interface BoardPass {
  teamId: string
  teamName: string
  reason: OpenPassReason
}

export interface BoardAuction {
  id: string
  playerName: string
  playerPosition: string | null
  playerTeam: string | null
  nominatorName: string | null
  currentPrice: number
  leaderTeamId: string | null
  leaderName: string | null
  deadlineAt: string
  bids: BoardBid[]
  passes: BoardPass[]
}

interface Props {
  auctions: BoardAuction[]
  /** null for a spectator admin — the board renders read-only. */
  myTeamId: string | null
  /**
   * Ceiling for a NEW bid on any auction this team is not already leading.
   * One number covers the whole board: it already accounts for every auction
   * the team currently leads. The DB re-derives it on every write, so this is
   * only here to keep the form honest.
   */
  myMaxBid: number
  /**
   * Same ceiling with the team's current commitments released. When this is
   * enough but {@link myMaxBid} is not, the team is not out of the auction —
   * its money is just parked in another one, and being outbid there puts it
   * straight back in. The DB draws the same distinction before writing an
   * automatic PASS.
   */
  hardMaxBid: number
  /** Total of the bids this team currently leads, for the explanation text. */
  committed: number
  /**
   * Roster slots left once the auctions this team leads are counted as won.
   * At zero the block is the roster, not the money — leading three auctions on
   * a three-slot roster costs $3 and still blocks everything, so the two need
   * different wording.
   */
  slotsLeft: number
  approvedTeamCount: number
  frozenReason: 'paused' | 'night' | null
}

const PASS_LABEL: Record<OpenPassReason, string> = {
  manual: 'פאס',
  admin: 'פאס (מנהל)',
  timeout: 'לא הגיב בזמן',
  no_budget: 'אין תקציב',
  roster_full: 'אין משבצת פנויה',
  complete: 'סגל מלא',
}

export default function OpenAuctionBoard({
  auctions,
  myTeamId,
  myMaxBid,
  hardMaxBid,
  committed,
  slotsLeft,
  approvedTeamCount,
  frozenReason,
}: Props) {
  if (auctions.length === 0) {
    return (
      <div className="card mb-6 text-center py-8" style={{ color: 'var(--muted)' }}>
        <p className="text-4xl mb-2">🏀</p>
        <p>אין שחקנים על הלוח כרגע</p>
        <p className="text-sm mt-1">
          {frozenReason
            ? 'הדראפט מושהה — שחקנים חדשים יעלו כשיתחדש'
            : 'הקבוצות שבתורן יעלו שחקנים בקרוב'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 mb-6">
      {auctions.map(auction => (
        <OpenAuctionCard
          key={auction.id}
          auction={auction}
          myTeamId={myTeamId}
          myMaxBid={myMaxBid}
          hardMaxBid={hardMaxBid}
          committed={committed}
          slotsLeft={slotsLeft}
          approvedTeamCount={approvedTeamCount}
          frozenReason={frozenReason}
        />
      ))}
    </div>
  )
}

function OpenAuctionCard({
  auction,
  myTeamId,
  myMaxBid,
  hardMaxBid,
  committed,
  slotsLeft,
  approvedTeamCount,
  frozenReason,
}: {
  auction: BoardAuction
  myTeamId: string | null
  myMaxBid: number
  hardMaxBid: number
  committed: number
  slotsLeft: number
  approvedTeamCount: number
  frozenReason: 'paused' | 'night' | null
}) {
  const minBid = auction.currentPrice + 1
  // What the manager typed, or null while they have not touched the field.
  // The card keeps its state across the live refresh that follows someone
  // else's bid, so a raw `useState(minBid)` would leave a stale amount sitting
  // below the new minimum. Clamping up here means the input always tracks the
  // price as it moves, while a higher figure they typed is preserved.
  const [typed, setTyped] = useState<number | null>(null)
  const amount = typed !== null && typed >= minBid ? typed : minBid
  const [busy, setBusy] = useState<'bid' | 'pass' | null>(null)
  const [error, setError] = useState('')
  const router = useRouter()

  const iLead = !!myTeamId && auction.leaderTeamId === myTeamId
  const myPass = myTeamId ? auction.passes.find(p => p.teamId === myTeamId) : undefined
  // Everyone except the leader has to answer, so this is how many replies the
  // auction is still waiting on before it closes.
  const stillIn = Math.max(0, approvedTeamCount - auction.passes.length - (auction.leaderTeamId ? 1 : 0))
  const cannotAfford = myMaxBid < minBid
  // Blocked, but only by money parked in auctions this team is leading. It is
  // still in this auction — no automatic PASS is written for this case — and
  // the moment it is outbid elsewhere it can bid here.
  const blockedByCommitment = cannotAfford && hardMaxBid >= minBid
  // Which commitment is actually in the way. Leading as many auctions as you
  // have slots blocks you no matter how much cash is left, so saying "your
  // money is tied up" there would name the wrong reason.
  const slotBlocked = blockedByCommitment && slotsLeft <= 0

  // An equal bid never wins anything — the standing leader keeps the player —
  // so it is rejected rather than silently accepted. open_place_bid() enforces
  // the same `>= current_price + 1` in SQL; this only saves the round trip.
  function submitBid() {
    if (!Number.isInteger(amount) || amount < minBid) {
      setError(`ההצעה חייבת להיות לפחות $${minBid} — אי-אפשר להשוות למחיר הנוכחי`)
      return
    }
    if (amount > myMaxBid) {
      setError(`ההצעה חורגת מהתקציב הפנוי שלך — מקסימום $${Math.max(myMaxBid, 0)}`)
      return
    }
    post('/api/open/bid', { auction_id: auction.id, amount }, 'bid')
  }

  async function post(url: string, body: object, kind: 'bid' | 'pass') {
    setBusy(kind)
    setError('')
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(null)
    if (!res.ok) {
      setError(data?.error ?? 'הפעולה נכשלה')
      return
    }
    router.refresh()
  }

  return (
    <div className="card" style={iLead ? { borderColor: 'var(--success)' } : undefined}>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold">{auction.playerName}</h2>
          <p className="text-sm mt-0.5" style={{ color: 'var(--muted)' }}>
            {[auction.playerPosition, auction.playerTeam].filter(Boolean).join(' · ')}
          </p>
        </div>
        {frozenReason ? (
          <span className="badge badge-gray">
            {frozenReason === 'paused' ? '⏸ מושהה' : '🌙 שעות לילה'}
          </span>
        ) : (
          <Countdown targetDate={auction.deadlineAt} label="לסגירה" />
        )}
      </div>

      <div className="flex gap-2 mb-3 text-center">
        <div className="flex-1 p-2 rounded-lg" style={{ background: 'var(--background)' }}>
          <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>מחיר נוכחי</p>
          <p className="font-bold text-lg" style={{ color: 'var(--warning)' }}>
            {formatCurrency(auction.currentPrice)}
          </p>
        </div>
        <div className="flex-1 p-2 rounded-lg" style={{ background: 'var(--background)' }}>
          <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>מוביל</p>
          <p className="font-bold text-sm truncate" style={{ color: iLead ? 'var(--success)' : undefined }}>
            {iLead ? 'אתה' : auction.leaderName ?? '—'}
          </p>
        </div>
        <div className="flex-1 p-2 rounded-lg" style={{ background: 'var(--background)' }}>
          <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>עוד במכרז</p>
          <p className="font-bold text-lg">{stillIn}</p>
        </div>
      </div>

      {auction.nominatorName && (
        <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>
          הועלה על ידי: <strong style={{ color: 'var(--text)' }}>{auction.nominatorName}</strong>
        </p>
      )}

      {/* Actions */}
      {!myTeamId ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>אין לך קבוצה בליגה הזו — צפייה בלבד</p>
      ) : myPass ? (
        <div className="p-2 rounded-lg text-center text-sm" style={{ background: 'var(--background)', color: 'var(--muted)' }}>
          {/* A deliberate pass needs no explaining — "יצאת מהמכרז" already says
              it, and the reason label would just read "פאס" again. The other
              reasons are things the manager did not choose, so those keep it. */}
          {myPass.reason === 'manual'
            ? 'יצאת מהמכרז'
            : `יצאת מהמכרז — ${PASS_LABEL[myPass.reason]}`}
        </div>
      ) : frozenReason ? (
        <div className="p-2 rounded-lg text-center text-sm" style={{ background: 'var(--background)', color: 'var(--muted)' }}>
          {frozenReason === 'paused'
            ? 'הדראפט מושהה על ידי המנהל — השעונים עצורים'
            : 'מחוץ לשעות הפעילות — השעונים עצורים עד הבוקר'}
        </div>
      ) : iLead ? (
        <div className="p-2 rounded-lg text-center text-sm" style={{ background: 'var(--background)', color: 'var(--success)' }}>
          אתה ההצעה הגבוהה ביותר — אי-אפשר לסמן PASS
        </div>
      ) : (
        <div className="flex gap-2 items-stretch flex-wrap">
          <input
            type="number"
            className="input font-bold text-center flex-1 min-w-[6rem]"
            min={minBid}
            max={Math.max(myMaxBid, minBid)}
            value={amount}
            onChange={e => setTyped(Number(e.target.value))}
            disabled={!!busy || cannotAfford}
            dir="ltr"
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!busy || cannotAfford}
            onClick={submitBid}
          >
            {busy === 'bid'
              ? 'שולח...'
              : slotBlocked
                ? 'אין משבצת פנויה'
                : blockedByCommitment
                  ? 'הכסף תפוס'
                : cannotAfford
                  ? `אין תקציב ל-${minBid}`
                  : 'הצע'}
          </button>
          <button
            type="button"
            className="btn btn-outline"
            style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
            disabled={!!busy}
            onClick={() => post('/api/open/pass', { auction_id: auction.id }, 'pass')}
          >
            {busy === 'pass' ? '...' : 'PASS'}
          </button>
        </div>
      )}

      {!myPass && myTeamId && !iLead && !frozenReason && (
        slotBlocked ? (
          <p className="text-xs mt-2" style={{ color: 'var(--warning)' }}>
            כל משבצות הסגל שלך כבר מחויבות למכרזים שאתה מוביל בהם. אתה עדיין בפנים —
            ברגע שיעקפו אותך באחד מהם תוכל להציע כאן.
          </p>
        ) : blockedByCommitment ? (
          <p className="text-xs mt-2" style={{ color: 'var(--warning)' }}>
            הכסף שלך תפוס במכרזים שאתה מוביל בהם ({formatCurrency(committed)}). אתה עדיין בפנים —
            ברגע שיעקפו אותך שם תוכל להציע כאן.
          </p>
        ) : (
          <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
            מינימום {formatCurrency(minBid)} · המקסימום שלך {formatCurrency(Math.max(myMaxBid, 0))}
          </p>
        )
      )}

      {error && <p className="text-sm mt-2" style={{ color: 'var(--danger)' }}>{error}</p>}

      {auction.passes.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {auction.passes.map(p => (
            <span key={p.teamId} className="badge badge-gray text-xs">
              {p.teamName} · {PASS_LABEL[p.reason]}
            </span>
          ))}
        </div>
      )}

      {auction.bids.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm" style={{ color: 'var(--muted)' }}>
            היסטוריית הצעות ({auction.bids.length})
          </summary>
          <div className="flex flex-col gap-1 mt-2">
            {auction.bids.map(b => (
              <div key={b.id} className="flex justify-between text-sm py-1 border-b" style={{ borderColor: 'var(--border)' }}>
                <span>
                  {b.teamName}
                  {b.isAuto && <span style={{ color: 'var(--muted)' }}> · הצעת פתיחה</span>}
                </span>
                <span className="flex gap-2">
                  <span style={{ color: 'var(--muted)' }}>{formatTime(b.createdAt)}</span>
                  <strong>{formatCurrency(b.amount)}</strong>
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
