import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'פנטזי דראפט מעטפות',
    short_name: 'פנטזי דראפט',
    description: 'NBA Fantasy Basketball Auction Draft',
    start_url: '/',
    display: 'standalone',
    background_color: '#0f1117',
    theme_color: '#0f1117',
    orientation: 'portrait',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  }
}
