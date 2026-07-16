'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { Home, Users, ShoppingBag, List, Settings, Trophy, ArrowLeftRight } from 'lucide-react'

const NAV = [
  { href: '/', label: 'בית', icon: Home },
  { href: '/auction', label: 'מכרז', icon: ShoppingBag },
  { href: '/players', label: 'שחקנים', icon: List },
  { href: '/trades', label: 'טריידים', icon: ArrowLeftRight },
  { href: '/teams', label: 'קבוצות', icon: Users },
  { href: '/leagues', label: 'הליגות שלי', icon: Trophy },
]

// /auction is auction-only; /trades is snake-only.
function visibleNav(isSnake?: boolean) {
  return NAV.filter(n =>
    !(isSnake && n.href === '/auction') &&
    !(!isSnake && n.href === '/trades')
  )
}

interface NavbarProps {
  isAdmin?: boolean
  isSnake?: boolean
}

export default function Navbar({ isAdmin, isSnake }: NavbarProps) {
  const pathname = usePathname()

  return (
    <>
      {/* Desktop sidebar */}
      <nav className="hidden md:flex flex-col gap-1 p-4 h-screen sticky top-0 w-56 border-l" style={{ borderColor: 'var(--border)', background: 'var(--card)' }}>
        <div className="flex items-center gap-2 px-3 py-4 mb-4">
          <Image src="/logo.png" alt="פנטזי דראפט" width={36} height={36} className="rounded-lg" />
          <span className="font-bold text-lg">פנטזי דראפט</span>
        </div>

        {visibleNav(isSnake).map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              pathname === href
                ? 'text-white' : 'hover:text-white'
            }`}
            style={pathname === href
              ? { background: 'var(--primary)', color: 'white' }
              : { color: 'var(--muted)' }
            }
          >
            <Icon size={18} />
            {label}
          </Link>
        ))}

        {isAdmin && (
          <Link
            href="/admin"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
            style={pathname.startsWith('/admin')
              ? { background: 'var(--primary)', color: 'white' }
              : { color: 'var(--muted)' }
            }
          >
            <Settings size={18} />
            ניהול
          </Link>
        )}
      </nav>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex border-t" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
        {visibleNav(isSnake).map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex-1 flex flex-col items-center py-3 gap-1 text-xs"
            style={{ color: pathname === href ? 'var(--primary)' : 'var(--muted)' }}
          >
            <Icon size={20} />
            {label}
          </Link>
        ))}
        {isAdmin && (
          <Link
            href="/admin"
            className="flex-1 flex flex-col items-center py-3 gap-1 text-xs"
            style={{ color: pathname.startsWith('/admin') ? 'var(--primary)' : 'var(--muted)' }}
          >
            <Settings size={20} />
            ניהול
          </Link>
        )}
      </nav>
    </>
  )
}
