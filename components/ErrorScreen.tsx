'use client'

// Shared body of every error boundary in the app. Kept in one place so the
// three boundaries (page-level, layout-level, root) stay identical.

import { useEffect } from 'react'

export default function ErrorScreen({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('error boundary:', error)
  }, [error])

  return (
    <div className="max-w-md mx-auto mt-10 px-4">
      <div className="card text-center">
        <div className="text-5xl mb-3">🏀</div>
        <h1 className="text-xl font-bold mb-2">משהו נשבר בדף הזה</h1>
        <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>
          אפשר לנסות שוב. אם זה חוזר — תשלח את הקוד שלמטה למנהל הליגה.
        </p>

        {/* The message and digest are what turn a user's screenshot into a
            searchable line in the Vercel runtime log. */}
        <p
          className="text-xs mb-4 p-3 rounded-lg"
          style={{
            background: 'var(--background)',
            color: 'var(--muted)',
            direction: 'ltr',
            textAlign: 'left',
          }}
        >
          {error.message || 'Unknown error'}
          {error.digest && (
            <>
              <br />
              digest: {error.digest}
            </>
          )}
        </p>

        <div className="flex flex-col gap-2">
          <button className="btn btn-primary" onClick={() => reset()}>
            נסה שוב
          </button>
          {/* A hard navigation, not a router push: the tree that failed is the
              one we are trying to get away from. */}
          <a className="btn btn-outline" href="/">
            חזרה לדף הבית
          </a>
        </div>
      </div>
    </div>
  )
}
