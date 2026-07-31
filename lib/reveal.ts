// Shared "reveal seen" state between the animated BidRevealOverlay and the
// static AuctionHistory list. The overlay owns the dramatic reveal; the history
// must not spoil the same player's result before the animation has played, so
// both read the same localStorage key and the overlay broadcasts when a reveal
// ends so the history can un-mask that row in the same tab (the `storage` event
// only fires in *other* tabs, hence the custom event).

export const REVEAL_SEEN_KEY = 'auction-reveal-seen'
export const REVEAL_SEEN_EVENT = 'auction-reveal-seen'

// Only the most recently completed auction can ever trigger a reveal, so a
// single id is enough to remember — the next auction to close overwrites it.
export function getSeenRevealId(): string | null {
  try { return localStorage.getItem(REVEAL_SEEN_KEY) } catch { return null }
}

export function hasSeenReveal(auctionId: string): boolean {
  return getSeenRevealId() === auctionId
}

export function markRevealSeen(auctionId: string): void {
  try { localStorage.setItem(REVEAL_SEEN_KEY, auctionId) } catch {}
  try { window.dispatchEvent(new CustomEvent(REVEAL_SEEN_EVENT, { detail: auctionId })) } catch {}
}
