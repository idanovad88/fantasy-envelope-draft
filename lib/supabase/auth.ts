import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The identity of the caller, verified.
 *
 * Shaped like the subset of Supabase's `User` this app actually reads — `id`
 * and `email` — so call sites keep working unchanged.
 */
export type AuthUser = { id: string; email?: string }

// auth-js does not export its JWK type, so take it from the method signature —
// it cannot drift from what getClaims() actually accepts.
type GetClaimsOptions = NonNullable<Parameters<SupabaseClient['auth']['getClaims']>[1]>
type Jwk = NonNullable<GetClaimsOptions['keys']>[number]
type Jwks = { keys: Jwk[] }

// The JWKS is cached on the GoTrueClient instance, and this app builds a fresh
// client per request — so left alone, every request would refetch it and we
// would have swapped one round trip for another. Hold it at module scope
// instead: one fetch per warm function instance, per TTL.
let jwks: Jwks | null = null
let jwksFetchedAt = 0
const JWKS_TTL_MS = 10 * 60 * 1000

async function getJwks(force = false): Promise<Jwks | null> {
  if (!force && jwks && Date.now() - jwksFetchedAt < JWKS_TTL_MS) return jwks

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null

  try {
    const res = await fetch(`${url}/auth/v1/.well-known/jwks.json`, {
      headers: { apikey: key },
      cache: 'no-store',
    })
    if (!res.ok) return jwks
    const body = (await res.json()) as Jwks
    if (!body?.keys?.length) return jwks
    jwks = body
    jwksFetchedAt = Date.now()
    return jwks
  } catch {
    // A failed refresh must not invalidate a key set that still verifies.
    return jwks
  }
}

/**
 * Resolve the signed-in user from the request's cookies.
 *
 * Why not `auth.getUser()`: that method asks the Auth server to validate the
 * token, i.e. a network round trip on every single request — and this app
 * makes two per page load (the proxy, then the page or layout). When that hop
 * degrades, every authenticated page degrades with it: in the incident this
 * replaced, a page that rendered in 0.4s logged out took 47-61s logged in, and
 * a *deliberately invalid* token was just as slow — proof the cost was the
 * call itself, not the validation.
 *
 * `getClaims()` verifies the JWT signature locally against the project's
 * public JWKS (this project signs with ES256), so it is cryptographically
 * sound — unlike `getSession()`, which trusts the cookie blindly. An expired
 * access token still refreshes: getClaims goes through getSession first. A
 * legacy HS256 token cannot be verified without the shared secret, so auth-js
 * falls back to the server on its own; those disappear as sessions refresh.
 */
export async function getAuthUser(client: SupabaseClient): Promise<AuthUser | null> {
  const keys = (await getJwks())?.keys

  let { data, error } = await client.auth.getClaims(undefined, keys ? { keys } : undefined)

  // A key we have never seen means the project rotated its signing keys since
  // this instance warmed up. Refetch once before calling the token invalid.
  if (error && keys) {
    const fresh = await getJwks(true)
    if (fresh) ({ data, error } = await client.auth.getClaims(undefined, { keys: fresh.keys }))
  }

  if (error || !data?.claims?.sub) return null

  const email = data.claims.email
  return { id: data.claims.sub, email: typeof email === 'string' ? email : undefined }
}
