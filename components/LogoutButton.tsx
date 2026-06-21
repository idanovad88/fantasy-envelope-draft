'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LogOut } from 'lucide-react'

export default function LogoutButton() {
  const router = useRouter()
  const supabase = createClient()
  const [loading, setLoading] = useState(false)

  async function logout() {
    setLoading(true)
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <button
      onClick={logout}
      disabled={loading}
      className="btn btn-outline w-full flex items-center justify-center gap-2"
      style={{ color: 'var(--muted)' }}
    >
      <LogOut size={18} />
      {loading ? '...' : 'יציאה'}
    </button>
  )
}
