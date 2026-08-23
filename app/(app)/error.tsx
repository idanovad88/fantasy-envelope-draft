'use client'

// Without a boundary here, a throw inside any authenticated page unmounts the
// whole React tree and the user is left on a blank white page — no message, no
// way back, nothing to report.

import ErrorScreen from '@/components/ErrorScreen'

export default function AppError(props: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <ErrorScreen {...props} />
}
