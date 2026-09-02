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
  /** The two soft-close windows, so the card can explain why the clock jumps. */
  extendShortMinutes: number
  extendLongMinutes: number
  /**
   * Roster slots left once the auctions this team leads are counted as won.
   * At zero the block is the roster, not the money — leading three auctions on
   * a three-slot roster costs $3 and still blocks everything, so the two need
   * different wording.
   */
  slotsLeft: number
  approvedTeamCount: number
  frozenReason: 'paused' | 'night' | null
  /**
   * `leagues.open_frozen_since` — the instant the clocks stopped, read after the
   * tick so it is not a minute stale. While frozen, `deadline_at` is a frozen-
   * time stamp that the morning thaw shifts forward, so the time actually left
   * is `deadline_at − frozenSince` and it does not move. Null when the draft is
   * running, and the live countdown is used instead.
   */
  frozenSince: string | null
}

const PASS_LABEL: Record<OpenPassReason, string> = {
  manual: 'פאס',
  admin: 'פאס (מנהל)',
  timeout: 'לא הגיב בזמן',
  no_budget: 'אין תקציב',
  roster_full: 'אין משבצת פנויה',
  complete: 'סגל מלא',
}

/**
 * How much of the auction's window is left, in frozen time. A live `Countdown`
 * would tick down against a clock that is not running — and at night it would
 * go negative and read "הסתיים" on an auction nobody can lose yet.
 */
function formatFrozenRemaining(deadlineAt: string, frozenSince: string) {
  const mins = Math.floor((new Date(deadlineAt).getTime() - new Date(frozenSince).getTime()) / 60_000)
  if (mins < 1) return 'פחות מדקה'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')} ש׳` : `${m} דק׳`
}

export default function OpenAuctionBoard({
  auctions,
  myTeamId,
  myMaxBid,
  hardMaxBid,
  committed,
  slotsLeft,
  extendShortMinutes,
  extendLongMinutes,
  approvedTeamCount,
  frozenReason,
  frozenSince,
}: Props) {
  // Night stops the clocks, not the managers: nominating, bidding and PASS are
  // all accepted right through it (open_accepts_actions() in SQL), and a
  // deadline written while frozen is expressed in frozen time, so it starts
  // running again in the morning. Only a pause closes the board for input.
  const actionsBlocked = frozenReason === 'paused'

  if (auctions.length === 0) {
    return (
      <div className="card mb-6 text-center py-8" style={{ color: 'var(--muted)' }}>
        <p className="text-4xl mb-2">🏀</p>
        <p>אין שחקנים על הלוח כרגע</p>
        <p className="text-sm mt-1">
          {frozenReason === 'paused'
            ? 'הדראפט מושהה — שחקנים חדשים יעלו כשיתחדש'
            : 'הקבוצות שבתורן יעלו שחקנים בקרוב'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 mb-6">
      {/* The soft close is one league rule, not a property of a single player,
          so it is stated once above the board. Repeating it under every card
          buried the per-auction numbers (minimum, your ceiling) in boilerplate.
          Stated rather than inferred from the clock: without it a manager sees
          the countdown jump after someone bids and cannot tell why. */}
      {myTeamId && !actionsBlocked && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {frozenReason === 'night' && (
            <>🌙 השעונים עצורים — הצעה או PASS עכשיו נספרים כרגיל, והזמן ימשיך לרוץ בבוקר.{' '}</>
          )}
          הצעה מאוחרת דוחה את הסגירה — נשארו פחות מ-{extendShortMinutes} דק&apos; ← {extendShortMinutes} דק&apos;,
          פחות מ-{extendLongMinutes} ← {extendLongMinutes} דק&apos;.
        </p>
      )}

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
          frozenSince={frozenSince}
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
  frozenSince,
}: {
  auction: BoardAuction
  myTeamId: string | null
  myMaxBid: number
  hardMaxBid: number
  committed: number
  slotsLeft: number
  approvedTeamCount: number
  frozenReason: 'paused' | 'night' | null
  frozenSince: string | null
}) {
  const minBid = auction.currentPrice + 1
  // The raw text in the field, or null while the manager has not touched it.
  // It stays a string on purpose: coercing every keystroke to a number and
  // clamping it to minBid meant the field could never be empty and never hold
  // a prefix on the way to a bigger figure — clearing it snapped straight back
  // to the minimum, so the only ways to change it were to select the amount
  // first or to type past it and delete the extra digits.
  const [typed, setTyped] = useState<string | null>(null)
  // The card keeps its state across the live refresh that follows someone
  // else's bid, so a figure typed against the old price would sit below the new
  // minimum. When the floor moves, drop what was typed unless it still clears
  // it — a higher figure they had already entered is preserved. Adjusting state
  // during render rather than in an effect: React re-runs the component before
  // committing, so the stale amount is never painted.
  const [floor, setFloor] = useState(minBid)
  if (floor !== minBid) {
    setFloor(minBid)
    if (typed !== null && !(Number(typed) >= minBid)) setTyped(null)
  }
  const amount = typed === null ? minBid : Number(typed)
  const [busy, setBusy] = useState<'bid' | 'pass' | null>(null)
  const [error, setError] = useState('')
  const router = useRouter()

  // See the note in OpenAuctionBoard: a pause closes the card for input, night
  // only stops the clock.
  const actionsBlocked = frozenReason === 'paused'
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
            {frozenSince && ` · נותרו ${formatFrozenRemaining(auction.deadlineAt, frozenSince)}`}
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
      ) : actionsBlocked ? (
        <div className="p-2 rounded-lg text-center text-sm" style={{ background: 'var(--background)', color: 'var(--muted)' }}>
          הדראפט מושהה על ידי המנהל — השעונים עצורים
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
            value={typed ?? String(minBid)}
            onChange={e => setTyped(e.target.value)}
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

      {!myPass && myTeamId && !iLead && !actionsBlocked && (
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
