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

// Bid reveal: card-flip sound — noise whoosh (paper) + descending click (card landing)
export function playBidReveal(): void {
  const ctx = getCtx()
  if (!ctx) return
  try {
    // 1. Noise burst — the "whoosh" of paper flipping
    const dur = 0.09
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1

    const src = ctx.createBufferSource()
    src.buffer = buf

    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 3000
    filter.Q.value = 0.4

    const noiseGain = ctx.createGain()
    noiseGain.gain.setValueAtTime(1.0, ctx.currentTime)
    noiseGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur)

    src.connect(filter)
    filter.connect(noiseGain)
    noiseGain.connect(ctx.destination)
    src.start()

    // 2. Descending click — the "thud" of the card hitting the table
    const click = ctx.createOscillator()
    const clickGain = ctx.createGain()
    click.type = 'sine'
    click.frequency.setValueAtTime(900, ctx.currentTime)
    click.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.05)
    clickGain.gain.setValueAtTime(0.55, ctx.currentTime)
    clickGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05)
    click.connect(clickGain)
    clickGain.connect(ctx.destination)
    click.start()
    click.stop(ctx.currentTime + 0.05)
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
