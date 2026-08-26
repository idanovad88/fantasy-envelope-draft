import { createClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import Navbar from '@/components/Navbar'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) redirect('/login')

  const cookieStore = await cookies()
  const selectedLeagueId = cookieStore.get('selected_league_id')?.value

  const [{ data: adminRow }, { data: createdLeague }, { data: league }] = await Promise.all([
    supabase.from('admin_users').select('role').eq('user_id', user.id).maybeSingle(),
    supabase.from('leagues').select('id').eq('created_by', user.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    selectedLeagueId
      ? supabase.from('leagues').select('draft_type, name, logo_url').eq('id', selectedLeagueId).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const selectedLeague = league as { draft_type?: string; name?: string; logo_url?: string | null } | null
  const isSnake = selectedLeague?.draft_type === 'snake'

  return (
    <div className="flex min-h-screen">
      <Navbar
        isAdmin={!!adminRow || !!createdLeague}
        isSnake={isSnake}
        leagueName={selectedLeague?.name}
        leagueLogo={selectedLeague?.logo_url}
      />
      <main className="flex-1 p-4 md:p-6 pb-20 md:pb-6 w-full">
        {children}
      </main>
    </div>
  )
}
