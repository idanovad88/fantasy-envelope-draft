'use client'

// Last resort: a failure in the root layout replaces the document itself, so
// this boundary has to ship its own <html> and <body>. It also loses the app's
// stylesheet, hence the inline styles.

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="he" dir="rtl">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0f1117',
          color: '#e5e7eb',
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center',
          padding: '1rem',
        }}
      >
        <div>
          <div style={{ fontSize: '3rem' }}>🏀</div>
          <h1 style={{ fontSize: '1.25rem' }}>האפליקציה נתקלה בתקלה</h1>
          <p style={{ fontSize: '0.8rem', color: '#94a3b8', direction: 'ltr' }}>
            {error.message || 'Unknown error'}
            {error.digest && <><br />digest: {error.digest}</>}
          </p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: '1rem',
              padding: '0.6rem 1.4rem',
              borderRadius: '0.5rem',
              border: 'none',
              background: '#6366f1',
              color: 'white',
              fontSize: '1rem',
              cursor: 'pointer',
            }}
          >
            נסה שוב
          </button>
        </div>
      </body>
    </html>
  )
}
