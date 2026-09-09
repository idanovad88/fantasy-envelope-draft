// Regenerates public/icons/badge-96.png — the monochrome "small icon" Android
// draws in the status bar and overlays on a notification.
//
// Android reads ONLY the alpha channel of that image and paints the result
// white. public/logo.png (and every icon derived from it) is a fully opaque
// PNG with no alpha at all, so pointing `badge` at one asks Android to paint a
// 192x192 solid rectangle — the blank white square this file exists to fix.
//
// So the badge has to be a silhouette: white where the mark is, transparent
// everywhere else. It is derived from the logo rather than drawn by hand, so
// re-running this after a logo change keeps the two in sync.
//
//   node scripts/generate-notification-badge.mjs
//
// The large, full-colour icon in the notification body is a separate image and
// stays public/icons/icon-192.png — that one is the logo as designed.

import sharp from 'sharp'

const SRC = 'public/logo.png'
const OUT = 'public/icons/badge-96.png'
const N = 512            // work large, downscale once at the end
const BG = [0, 6, 28]    // the logo's dark navy field

const { data, info } = await sharp(SRC).resize(N, N).raw().toBuffer({ resolveWithObject: true })
const ch = info.channels

const shape = new Uint8Array(N * N)  // anything that is not the navy field
const seam = new Uint8Array(N * N)   // the near-black lines drawn on top of it
const ball = new Uint8Array(N * N)   // the orange basketball

for (let i = 0, j = 0; i < N * N; i++, j += ch) {
  const [r, g, b] = [data[j], data[j + 1], data[j + 2]]
  shape[i] = Math.hypot(r - BG[0], g - BG[1], b - BG[2]) > 50 ? 1 : 0
  // Threshold at 45, not higher: the envelope's blue sits at luminance ~76 and
  // must survive, or the badge collapses to the ball alone.
  if (shape[i] && 0.299 * r + 0.587 * g + 0.114 * b < 45) seam[i] = 1
  if (r > 120 && r > g + 30 && g > b + 20) ball[i] = 1
}

const dilate = (src, radius) => {
  const out = new Uint8Array(N * N)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!src[y * N + x]) continue
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= N) continue
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= N) continue
          out[yy * N + xx] = 1
        }
      }
    }
  }
  return out
}

// Every line has to be widened before the downscale to 24dp, or it closes up
// and the whole mark reads as one blob. Two sets of knockouts: the seams the
// logo already draws, and a gap where the ball meets the envelope — without
// that second one the ball is the same white as the envelope behind it and
// disappears into it.
const ballEdge = new Uint8Array(N * N)
const ballGrown = dilate(ball, 1)
for (let i = 0; i < N * N; i++) ballEdge[i] = ballGrown[i] && !ball[i] ? 1 : 0

const knockout = dilate(seam, 3)
const separation = dilate(ballEdge, 3)

const rgba = Buffer.alloc(N * N * 4)
let minX = N, minY = N, maxX = 0, maxY = 0
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const i = y * N + x
    const on = shape[i] && !knockout[i] && !separation[i]
    rgba[i * 4] = 255
    rgba[i * 4 + 1] = 255
    rgba[i * 4 + 2] = 255
    rgba[i * 4 + 3] = on ? 255 : 0
    if (on) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
}

// The logo carries its own padding inside the square. A status-bar icon is
// already tiny, so crop to the mark and re-pad to a fixed 8%.
const w = maxX - minX + 1
const h = maxY - minY + 1
const side = Math.max(w, h)
const left = Math.max(0, Math.min(N - side, minX - ((side - w) >> 1)))
const top = Math.max(0, Math.min(N - side, minY - ((side - h) >> 1)))

const PAD = 8
await sharp(rgba, { raw: { width: N, height: N, channels: 4 } })
  .extract({ left, top, width: side, height: side })
  .resize(96 - PAD * 2, 96 - PAD * 2, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
  .extend({ top: PAD, bottom: PAD, left: PAD, right: PAD, background: { r: 255, g: 255, b: 255, alpha: 0 } })
  .png()
  .toFile(OUT)

console.log(`wrote ${OUT} (mark cropped from ${side}x${side} at ${left},${top})`)
