// Browser-only: shrink a picked image before uploading it.
// A league logo is drawn at 44–64px, so anything past MAX_LOGO_PX is bytes the
// phone downloads and throws away. Formats we can't safely re-encode (animated
// GIF, SVG) are passed through untouched.
export const MAX_LOGO_PX = 256

const RESIZABLE = ['image/jpeg', 'image/png', 'image/webp']

export async function downscaleImage(file: File, maxPx = MAX_LOGO_PX): Promise<File> {
  if (!RESIZABLE.includes(file.type)) return file

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return file // undecodable here — let the server store what the admin picked
  }

  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && file.size < 100_000) {
    bitmap.close()
    return file
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return file
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  // PNG keeps transparency; everything else is cheaper as JPEG.
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, 0.85))
  if (!blob || blob.size >= file.size) return file

  const ext = type === 'image/png' ? 'png' : 'jpg'
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.' + ext, { type })
}
