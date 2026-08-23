import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

  // Only honor relative same-origin paths to avoid an open redirect.
  const nextParam = searchParams.get('next')
  const next = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//')
    ? nextParam
    : '/leagues'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
    // Carry the reason to the login screen. Without it a failed exchange is
    // indistinguishable from a user who never signed in, on both sides of the
    // support conversation.
    console.error('auth callback: code exchange failed', error.message)
    return NextResponse.redirect(
      `${origin}/login?error=auth&reason=${encodeURIComponent(error.message)}`
    )
  }

  // No code at all — Google itself refused, and puts the reason in the query.
  const providerError = searchParams.get('error_description') || searchParams.get('error')
  if (providerError) {
    console.error('auth callback: provider returned an error', providerError)
    return NextResponse.redirect(
      `${origin}/login?error=auth&reason=${encodeURIComponent(providerError)}`
    )
  }

  return NextResponse.redirect(`${origin}/login?error=auth`)
}
