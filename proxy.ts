import { createServerClient } from '@supabase/ssr'
import { getAuthUser } from '@/lib/supabase/auth'
import { NextResponse, type NextRequest } from 'next/server'

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return supabaseResponse

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() { return request.cookies.getAll() },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
        supabaseResponse = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        )
      },
    },
  })

  const user = await getAuthUser(supabase)

  const isAuthPage = request.nextUrl.pathname.startsWith('/login')
  const isPublicApi = request.nextUrl.pathname.startsWith('/api/public')
  // Team-assistant invite pages must be viewable while logged out (the page itself
  // offers a Google sign-in that returns here via ?next=).
  const isInvitePage = request.nextUrl.pathname.startsWith('/assist')
  // The notify cron is called by Supabase pg_cron, which carries no session
  // cookie. It authenticates itself with CRON_SECRET; without this bypass it
  // would silently 307 to /login and the job would never run. The matcher
  // below now excludes /api/cron outright, so this is a fallback that keeps
  // the route working if that exclusion is ever dropped.
  const isCronApi = request.nextUrl.pathname.startsWith('/api/cron')

  if (!user && !isAuthPage && !isPublicApi && !isInvitePage && !isCronApi) {
    const redirectUrl = request.nextUrl.clone()
    redirectUrl.pathname = '/login'
    return NextResponse.redirect(redirectUrl)
  }

  if (user && isAuthPage) {
    const redirectUrl = request.nextUrl.clone()
    redirectUrl.pathname = '/'
    return NextResponse.redirect(redirectUrl)
  }

  return supabaseResponse
}

// `api/cron` is excluded, not just bypassed inside the proxy above: the cron
// runs on a schedule with no session, so every hit was paying for a full auth
// check before the route skipped auth anyway. (That check is now a local
// signature verification rather than a round trip — see lib/supabase/auth.ts —
// but skipping it outright is still free.)
export const config = {
  matcher: ['/((?!_next/static|_next/image|api/cron|favicon.ico|manifest\\.webmanifest|apple-touch-icon\\.png|sw\\.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
