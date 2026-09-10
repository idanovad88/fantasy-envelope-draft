/**
 * Hold the reader's position steady across a `router.refresh()`.
 *
 * Next.js is not the problem: a refresh is dispatched with
 * `ScrollBehavior.NoScroll` ("suppress scroll entirely"), so the framework
 * never moves the page. The browser does. A refresh re-renders the server
 * components in place, and on a live board that means whole elements appear and
 * disappear — an auction card closing, a PASS row landing, a player leaving the
 * available list. Anything removed *above* the viewport slides everything the
 * reader was looking at up the screen.
 *
 * Chrome, Edge and Firefox fix this themselves: scroll anchoring picks a node
 * near the top of the viewport and scrolls to compensate. **Safari implements
 * none of it** — `overflow-anchor` is unsupported on every version, iPhone
 * included — which is why this is another iPhone-only complaint waiting to
 * happen, exactly like the `vh` trap under **Styling** in CLAUDE.md.
 *
 * So this is scroll anchoring, hand-rolled, scoped to the one thing that moves
 * the page without being asked to: the realtime refresh.
 *
 * ⚠️ **It measures a delta, it does not restore a saved `scrollY`** — and that
 * is what makes it safe to ship to every browser rather than sniffing for
 * Safari. Where the browser already anchors, the correction has landed before
 * this looks, the delta is 0, and it does nothing at all.
 */

/** How long to keep compensating after the refresh is dispatched. */
const SETTLE_MS = 4000

/** How far to descend looking for a small anchor instead of a whole section. */
const MAX_DEPTH = 12

/** The watch in flight, if any. Module scope: there is one page. */
let cancelCurrent: (() => void) | null = null

/**
 * The element the reader is looking at: the first one that has not yet scrolled
 * off the top. Descends so the anchor is a row or a card rather than the list
 * containing it — a coarse anchor moves whenever anything inside it does.
 */
function pickAnchor(): { el: Element; top: number } | null {
  // Nothing above the fold to preserve, and nowhere to be pushed from.
  if (window.scrollY <= 0) return null

  let el: Element = document.querySelector('main') ?? document.body
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const next = Array.from(el.children).find(child => {
      const r = child.getBoundingClientRect()
      return r.height > 0 && r.bottom > 0
    })
    if (!next) break
    el = next
  }
  return { el, top: el.getBoundingClientRect().top }
}

/**
 * Run `refresh`, then keep the anchor pinned where it was while the new server
 * render lands. Returns immediately; the watch tears itself down.
 */
export function withScrollAnchor(refresh: () => void): void {
  if (typeof window === 'undefined') {
    refresh()
    return
  }

  const anchor = pickAnchor()
  refresh()
  if (!anchor) return

  // A newer refresh supersedes this one: two watches pulling towards two
  // different anchors would fight each other.
  cancelCurrent?.()

  const abort = new AbortController()
  let selfScroll = false

  const correct = () => {
    // React reuses DOM nodes across a patch, so the anchor normally survives.
    // When it does not — its whole branch was replaced — leave the page alone
    // rather than guess at a substitute.
    if (!anchor.el.isConnected) return
    const delta = anchor.el.getBoundingClientRect().top - anchor.top
    if (Math.abs(delta) < 1) return
    selfScroll = true
    window.scrollBy(0, delta)
  }

  // Fires as a microtask after React commits, i.e. before the browser paints,
  // so the correction is never visible as a jump-and-return.
  const observer = new MutationObserver(correct)

  // Idempotent, and deliberately so: the settle timeout below is never
  // cleared, so a watch the reader already cancelled stops a second time when
  // it fires. The `cancelCurrent === stop` guard is what keeps that late call
  // from clearing a newer watch's registration.
  const stop = () => {
    abort.abort()
    observer.disconnect()
    if (cancelCurrent === stop) cancelCurrent = null
  }

  observer.observe(document.body, { childList: true, subtree: true })

  // The reader moving the page outranks anything this was about to restore —
  // a swipe, a wheel, a key, or iOS momentum still running after touchend,
  // which fires no touch events at all and is only visible as `scroll`.
  const opts: AddEventListenerOptions = { passive: true, signal: abort.signal }
  window.addEventListener('scroll', () => {
    if (selfScroll) {
      selfScroll = false
      return
    }
    stop()
  }, opts)
  for (const event of ['wheel', 'touchstart', 'keydown'] as const) {
    window.addEventListener(event, stop, opts)
  }

  setTimeout(stop, SETTLE_MS)
  cancelCurrent = stop
}
