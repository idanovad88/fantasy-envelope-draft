/**
 * Export the drafted players (with the price each one went for) as a file.
 * Plain links — `/api/export-players` streams the file, so no client JS is needed.
 */
export default function ExportPlayers({ className = '' }: { className?: string }) {
  return (
    <div className={`flex gap-2 ${className}`}>
      <a href="/api/export-players?format=xlsx" download className="btn btn-outline text-xs py-1 px-2">
        ⬇ אקסל
      </a>
      <a href="/api/export-players?format=csv" download className="btn btn-outline text-xs py-1 px-2">
        ⬇ CSV
      </a>
    </div>
  )
}
