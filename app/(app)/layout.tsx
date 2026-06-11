import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Navbar from '@/components/Navbar'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: adminRow }, { data: createdLeague }] = await Promise.all([
    supabase.from('admin_users').select('role').eq('user_id', user.id).maybeSingle(),
    supabase.from('leagues').select('id').eq('created_by', user.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  return (
    <div className="flex min-h-screen">
      <Navbar isAdmin={!!adminRow || !!createdLeague} />
      <main className="flex-1 p-4 md:p-6 pb-20 md:pb-6 w-full">
        {children}
      </main>
    </div>
  )
}
