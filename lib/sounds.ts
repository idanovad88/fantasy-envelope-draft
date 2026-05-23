const MUTE_KEY = 'auction-sound-muted'

let _ctx: AudioContext | null = null

function isMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === 'true' } catch { return false }
}

export function toggleMute(): boolean {
  const next = !isMuted()
  try { localStorage.setItem(MUTE_KEY, String(next)) } catch {}
  return next
}

export function getMuted(): boolean {
  return isMuted()
}

// Call during ANY user gesture (click, submit, keydown) to unlock the AudioContext
export function unlockAudio(): void {
  if (typeof AudioContext === 'undefined') return
  try {
    if (!_ctx || _ctx.state === 'closed') _ctx = new AudioContext()
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {})
  } catch {}
}

function getCtx(): AudioContext | null {
  if (typeof AudioContext === 'undefined' || isMuted()) return null
  try {
    if (!_ctx || _ctx.state === 'closed') {
      _ctx = new AudioContext()
      // Attempt resume immediately — works on localhost (high MEI), might need gesture elsewhere
      _ctx.resume().catch(() => {})
    } else if (_ctx.state === 'suspended') {
      _ctx.resume().catch(() => {})
    }
    return _ctx
  } catch {
    return null
  }
}

// Drumroll: triangle-wave thumps at increasing tempo (5→28 beats/sec)
export function playDrumroll(duration = 2.5): void {
  const ctx = getCtx()
  if (!ctx) return
  try {
    const comp = ctx.createDynamicsCompressor()
    comp.connect(ctx.destination)

    let t = 0
    while (t < duration) {
      const progress = t / duration
      const bps = 5 + 23 * progress          // beats per second
      const interval = 1 / bps

      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.value = 120 + 60 * progress   // 120→180 Hz — low drum thump

      gain.gain.setValueAtTime(0.9, ctx.currentTime + t)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + Math.min(interval * 0.7, 0.06))

      osc.connect(gain)
      gain.connect(comp)
      osc.start(ctx.currentTime + t)
      osc.stop(ctx.currentTime + t + Math.min(interval * 0.8, 0.07))

      t += interval
    }
  } catch {}
}

// Bid reveal: sharp rising ding (A4 → A5)
export function playBidReveal(): void {
  const ctx = getCtx()
  if (!ctx) return
  try {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = 'sine'
    osc.frequency.setValueAtTime(440, ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15)

    gain.gain.setValueAtTime(0.6, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.25)
  } catch {}
}

// Fanfare: classic C4 → E4 → G4 → C5 trumpet call
export function playFanfare(): void {
  const ctx = getCtx()
  if (!ctx) return
  try {
    const comp = ctx.createDynamicsCompressor()
    comp.connect(ctx.destination)

    const notes =     [261.63, 329.63, 392.0, 523.25]
    const durations = [0.14,   0.14,   0.14,  0.75]
    let t = ctx.currentTime

    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()

      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(freq, t)

      gain.gain.setValueAtTime(0.5, t)
      gain.gain.setValueAtTime(0.5, t + durations[i] - 0.03)
      gain.gain.exponentialRampToValueAtTime(0.001, t + durations[i])

      osc.connect(gain)
      gain.connect(comp)
      osc.start(t)
      osc.stop(t + durations[i])

      t += durations[i] * 0.87
    })
  } catch {}
}
