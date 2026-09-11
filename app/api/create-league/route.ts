import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { loadPool } from '@/lib/pool'

/**
 * Seeding pulls ~15MB from ESPN and parses it. Hobby defaults to 10s, which
 * the fetch alone (~2s) leaves little room over once JSON parsing is counted.
 */
export const maxDuration = 30

type PoolSource = 'espn' | 'fallback' | 'none'

export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { leagueName, joinCode, draftType, numTeams, playersPerTeam, budgetPerTeam, minBid, teamName } = await req.json()
  if (!leagueName?.trim()) return NextResponse.json({ error: 'שם ליגה נדרש' }, { status: 400 })

  // Check whitelist via user's session (RLS: can only see own email row)
  const { data: allowed } = await supabase
    .from('league_creator_whitelist')
    .select('email')
    .eq('email', user.email!)
    .maybeSingle()

  if (!allowed) {
    return NextResponse.json({ error: 'אינך מורשה להקים ליגה. פנה למנהל המערכת.' }, { status: 403 })
  }

  const admin = createAdminClient()

  const { data: existing } = await admin
    .from('leagues')
    .select('id')
    .ilike('name', leagueName.trim())
    .maybeSingle()

  if (existing) {
    return NextResponse.json({ error: 'ליגה בשם זה כבר קיימת — בחר שם אחר' }, { status: 400 })
  }

  // Explicit list, not a two-way ternary: the old form silently turned any
  // unrecognised value into 'envelope', which hides a typo instead of failing.
  const DRAFT_TYPES = ['envelope', 'snake', 'open']
  if (draftType != null && !DRAFT_TYPES.includes(draftType)) {
    return NextResponse.json({ error: 'סוג דראפט לא תקין' }, { status: 400 })
  }

  const { data: league, error: leagueErr } = await admin
    .from('leagues')
    .insert({
      name: leagueName.trim(),
      join_code: joinCode?.trim().toUpperCase() || null,
      draft_type: draftType ?? 'envelope',
      created_by: user.id,
      ...(numTeams != null && { num_teams: numTeams }),
      ...(playersPerTeam != null && { players_per_team: playersPerTeam }),
      ...(budgetPerTeam != null && { budget_per_team: budgetPerTeam }),
      ...(minBid != null && { min_bid: minBid }),
    })
    .select()
    .single()

  if (leagueErr) return NextResponse.json({ error: leagueErr.message }, { status: 500 })

  const { error: adminErr } = await admin.from('admin_users').upsert({
    user_id: user.id,
    league_id: league.id,
    role: 'admin',
  }, { onConflict: 'user_id' })

  if (adminErr) return NextResponse.json({ error: adminErr.message }, { status: 500 })

  if (teamName?.trim()) {
    await admin.from('teams').insert({
      league_id: league.id,
      name: teamName.trim(),
      user_id: user.id,
      budget_remaining: budgetPerTeam ?? 200,
      approved: true,
    })
  }

  // The league already exists by now, so a seeding failure must not 500 —
  // that would leave an orphan league and no obvious way to finish it. The
  // creator is told what happened instead and can import from the admin panel.
  // Row shape is deliberately the one /api/import-players writes, `nba_team`
  // included: ESPN's team mapping is wrong and the column stays empty.
  let seeded = 0
  let seedSource: PoolSource = 'none'
  try {
    const { players, source } = await loadPool()
    const { error: seedErr, count } = await admin.from('players').insert(
      players.map(p => ({
        league_id: league.id,
        name: p.name,
        nba_team: null,
        position: p.position,
        ranking: p.ranking,
        auction_value: p.auction_value,
        stats: {},
        status: 'available',
      })),
      { count: 'exact' }
    )
    if (seedErr) throw seedErr
    seeded = count ?? players.length
    seedSource = source
  } catch (err) {
    console.error('create-league: seeding the player pool failed', err)
  }

  return NextResponse.json({ success: true, seeded, seedSource })
}
