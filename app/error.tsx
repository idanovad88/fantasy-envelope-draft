'use client'

// Catches what /(app)/error.tsx cannot: a throw inside the (app) layout itself
// — the Navbar query, the auth check — which bubbles up to the parent segment.

import ErrorScreen from '@/components/ErrorScreen'

export default function RootError(props: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <ErrorScreen {...props} />
}
