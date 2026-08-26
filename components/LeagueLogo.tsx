// Presentational only (no hooks), so it renders in both server and client components.
// Falls back to the league's first letter when no logo has been uploaded.
export default function LeagueLogo({ url, name, size = 44 }: { url?: string | null; name: string; size?: number }) {
  const radius = Math.round(size / 4)
  if (url) {
    return (
      <img
        src={url}
        alt=""
        style={{ width: size, height: size, borderRadius: radius, objectFit: 'cover', flexShrink: 0 }}
      />
    )
  }
  return (
    <div
      style={{
        width: size, height: size, borderRadius: radius,
        background: 'var(--border)', color: 'var(--muted)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: Math.round(size * 0.42), fontWeight: 700, flexShrink: 0,
      }}
    >
      {name.charAt(0)}
    </div>
  )
}
