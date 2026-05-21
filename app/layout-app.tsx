import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Navbar from '@/components/Navbar'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: adminRow } = await supabase
    .from('admin_users')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle()

  return (
    <div className="flex min-h-screen">
      <Navbar isAdmin={!!adminRow} />
      <main className="flex-1 p-4 md:p-6 pb-20 md:pb-6 max-w-5xl w-full">
        {children}
      </main>
    </div>
  )
}
