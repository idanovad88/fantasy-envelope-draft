import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import AcceptInvite from '@/components/AcceptInvite'

export const dynamic = 'force-dynamic'

export default async function AssistInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const admin = createAdminClient()

  const { data: invite } = await admin
    .from('team_invites')
    .select('token, team_id, league_id, used_at, expires_at')
    .eq('token', token)
    .maybeSingle()

  let invalidReason: string | null = null
  let teamName = ''
  let leagueName = ''

  if (!invite) {
    invalidReason = 'ההזמנה אינה תקפה'
  } else if (invite.used_at) {
    invalidReason = 'ההזמנה כבר נוצלה'
  } else if (new Date(invite.expires_at).getTime() < Date.now()) {
    invalidReason = 'תוקף ההזמנה פג'
  } else {
    const [{ data: team }, { data: league }] = await Promise.all([
      admin.from('teams').select('name').eq('id', invite.team_id).maybeSingle(),
      admin.from('leagues').select('name').eq('id', invite.league_id).maybeSingle(),
    ])
    teamName = team?.name ?? 'קבוצה'
    leagueName = league?.name ?? ''
  }

  const supabase = await createClient()
  const user = await getAuthUser(supabase)

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--background)' }}>
      <div className="card w-full max-w-sm text-center">
        <div className="text-4xl mb-3">🏀</div>
        {invalidReason ? (
          <>
            <h1 className="text-xl font-bold mb-2">הזמנה לא תקפה</h1>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>{invalidReason}</p>
            <a href="/" className="btn btn-outline w-full mt-4">לדף הבית</a>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold mb-1">הזמנה לעוזר מנהל קבוצה</h1>
            <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>
              הוזמנת לעזור לנהל את הקבוצה <strong style={{ color: 'var(--text)' }}>{teamName}</strong>
              {leagueName && <> בליגה <strong style={{ color: 'var(--text)' }}>{leagueName}</strong></>}
              {' '}— תוכל להגיש ולעדכן הצעות עבור הקבוצה.
            </p>
            <AcceptInvite token={token} isLoggedIn={!!user} />
          </>
        )}
      </div>
    </div>
  )
}
