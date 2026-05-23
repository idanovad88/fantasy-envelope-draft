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

// Bid reveal: soft bell (fundamental A5 + inharmonic partial for natural bell timbre)
export function playBidReveal(): void {
  const ctx = getCtx()
  if (!ctx) return
  try {
    const pairs: [number, number, number][] = [
      [880,   0.35, 0.45],  // A5 fundamental
      [2112,  0.10, 0.20],  // 2.4× inharmonic partial — gives bell character
    ]
    pairs.forEach(([freq, amp, dur]) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(amp, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + dur)
    })
  } catch {}
}

// Fanfare: warm sine arpeggio C5→E5→G5→C6, notes cascade in and sustain together
export function playFanfare(): void {
  const ctx = getCtx()
  if (!ctx) return
  try {
    const comp = ctx.createDynamicsCompressor()
    comp.connect(ctx.destination)

    // Higher octave (C5–C6) + sine = bell-like, pleasant, not tense
    const notes =       [523.25, 659.25, 783.99, 1046.50]
    const startDelays = [0,      0.22,   0.44,   0.66]
    const totalLen = 1.9

    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq

      const t = ctx.currentTime + startDelays[i]
      const dur = totalLen - startDelays[i]

      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.22, t + 0.07)   // gentle attack
      gain.gain.setValueAtTime(0.22, t + dur - 0.3)
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur)

      osc.connect(gain)
      gain.connect(comp)
      osc.start(t)
      osc.stop(t + dur)
    })
  } catch {}
}
