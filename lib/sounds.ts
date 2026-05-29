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

// Drumroll: kick-drum sine sweep per hit (180→45 Hz) + sub-bass rumble building over duration
export function playDrumroll(duration = 2.5): void {
  const ctx = getCtx()
  if (!ctx) return
  try {
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -18
    comp.knee.value = 6
    comp.ratio.value = 8
    comp.attack.value = 0.002
    comp.release.value = 0.1
    comp.connect(ctx.destination)

    // Sub-bass rumble: runs full duration, gain builds from ~0 to 0.4 for physical tension
    const subOsc = ctx.createOscillator()
    const subGain = ctx.createGain()
    subOsc.type = 'sine'
    subOsc.frequency.setValueAtTime(40, ctx.currentTime)
    subOsc.frequency.linearRampToValueAtTime(60, ctx.currentTime + duration)
    subGain.gain.setValueAtTime(0.001, ctx.currentTime)
    subGain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + duration)
    subOsc.connect(subGain)
    subGain.connect(comp)
    subOsc.start(ctx.currentTime)
    subOsc.stop(ctx.currentTime + duration + 0.05)

    // Kick hits: sine sweep 180→45 Hz, steeper acceleration curve
    let t = 0
    while (t < duration) {
      const progress = t / duration
      const bps = 5 + 23 * Math.pow(progress, 1.4)
      const interval = 1 / bps
      const hitDur = Math.min(interval * 0.75, 0.07)

      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'

      const tAbs = ctx.currentTime + t
      osc.frequency.setValueAtTime(180, tAbs)
      osc.frequency.exponentialRampToValueAtTime(45, tAbs + hitDur)

      gain.gain.setValueAtTime(0.001, tAbs)
      gain.gain.linearRampToValueAtTime(0.9, tAbs + 0.003)
      gain.gain.exponentialRampToValueAtTime(0.001, tAbs + hitDur)

      osc.connect(gain)
      gain.connect(comp)
      osc.start(tAbs)
      osc.stop(tAbs + hitDur + 0.005)

      t += interval
    }
  } catch {}
}

// Bid reveal: rising noise whoosh + sharp crack + bright reward ping
export function playBidReveal(): void {
  const ctx = getCtx()
  if (!ctx) return
  try {
    const now = ctx.currentTime

    // 1. Rising bandpass noise whoosh: filter sweeps 800 Hz → 4500 Hz over 120 ms
    const whooshDur = 0.12
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * whooshDur), ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1

    const src = ctx.createBufferSource()
    src.buffer = buf

    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.Q.value = 1.2
    filter.frequency.setValueAtTime(800, now)
    filter.frequency.exponentialRampToValueAtTime(4500, now + whooshDur)

    const noiseGain = ctx.createGain()
    noiseGain.gain.setValueAtTime(1.0, now)
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + whooshDur)

    src.connect(filter)
    filter.connect(noiseGain)
    noiseGain.connect(ctx.destination)
    src.start(now)

    // 2. Sharp crack: starts at t+0.08, sine sweep 1200→80 Hz over 50 ms
    const crackStart = now + 0.08
    const crack = ctx.createOscillator()
    const crackGain = ctx.createGain()
    crack.type = 'sine'
    crack.frequency.setValueAtTime(1200, crackStart)
    crack.frequency.exponentialRampToValueAtTime(80, crackStart + 0.05)
    crackGain.gain.setValueAtTime(0.65, crackStart)
    crackGain.gain.exponentialRampToValueAtTime(0.001, crackStart + 0.05)
    crack.connect(crackGain)
    crackGain.connect(ctx.destination)
    crack.start(crackStart)
    crack.stop(crackStart + 0.06)

    // 3. Bright reward ping: sine at 1800 Hz, enters at t+0.10, fades out by t+0.45
    const pingStart = now + 0.10
    const ping = ctx.createOscillator()
    const pingGain = ctx.createGain()
    ping.type = 'sine'
    ping.frequency.value = 1800
    pingGain.gain.setValueAtTime(0.0, pingStart)
    pingGain.gain.linearRampToValueAtTime(0.28, pingStart + 0.005)
    pingGain.gain.exponentialRampToValueAtTime(0.001, now + 0.45)
    ping.connect(pingGain)
    pingGain.connect(ctx.destination)
    ping.start(pingStart)
    ping.stop(now + 0.46)
  } catch {}
}

// Fanfare: 3-phase triumphant sports fanfare
// Phase 0 (t=0):    Timpani bass hit — sine sweep 80→40 Hz, 0.4 s
// Phase 1 (t=0):    4-note ascending fanfare G4→C5→E5→G5, triangle, 150 ms apart
// Phase 2 (t=0.75): Big sustained chord C5+E5+G5+C6 (sine) + bass C3 (sine), 1.5 s
export function playFanfare(): void {
  const ctx = getCtx()
  if (!ctx) return
  try {
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.knee.value = 8
    comp.ratio.value = 6
    comp.attack.value = 0.003
    comp.release.value = 0.15
    comp.connect(ctx.destination)

    const now = ctx.currentTime

    // Phase 0: Timpani hit
    const timp = ctx.createOscillator()
    const timpGain = ctx.createGain()
    timp.type = 'sine'
    timp.frequency.setValueAtTime(80, now)
    timp.frequency.exponentialRampToValueAtTime(40, now + 0.4)
    timpGain.gain.setValueAtTime(0.6, now)
    timpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.4)
    timp.connect(timpGain)
    timpGain.connect(comp)
    timp.start(now)
    timp.stop(now + 0.42)

    // Phase 1: Ascending fanfare G4→C5→E5→G5, triangle, 150 ms each
    const fanfareFreqs = [392.00, 523.25, 659.25, 783.99]
    fanfareFreqs.forEach((freq, i) => {
      const t = now + i * 0.15
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0, t)
      gain.gain.linearRampToValueAtTime(0.30, t + 0.015)
      gain.gain.setValueAtTime(0.30, t + 0.065)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14)
      osc.connect(gain)
      gain.connect(comp)
      osc.start(t)
      osc.stop(t + 0.15)
    })

    // Phase 2: Sustained chord C5+E5+G5+C6 + bass C3
    const chordStart = now + 0.75
    const chordDur = 1.5
    const chordFreqs = [523.25, 659.25, 783.99, 1046.50]
    chordFreqs.forEach((freq) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0, chordStart)
      gain.gain.linearRampToValueAtTime(0.20, chordStart + 0.06)
      gain.gain.setValueAtTime(0.20, chordStart + chordDur - 0.25)
      gain.gain.exponentialRampToValueAtTime(0.001, chordStart + chordDur)
      osc.connect(gain)
      gain.connect(comp)
      osc.start(chordStart)
      osc.stop(chordStart + chordDur + 0.05)
    })

    const bass = ctx.createOscillator()
    const bassGain = ctx.createGain()
    bass.type = 'sine'
    bass.frequency.value = 130.81  // C3
    bassGain.gain.setValueAtTime(0.0, chordStart)
    bassGain.gain.linearRampToValueAtTime(0.35, chordStart + 0.06)
    bassGain.gain.setValueAtTime(0.35, chordStart + chordDur - 0.35)
    bassGain.gain.exponentialRampToValueAtTime(0.001, chordStart + chordDur)
    bass.connect(bassGain)
    bassGain.connect(comp)
    bass.start(chordStart)
    bass.stop(chordStart + chordDur + 0.05)
  } catch {}
}
