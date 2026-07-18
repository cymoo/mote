import { MenuIcon, Search as SearchIcon } from 'lucide-react'
import { ComponentProps } from 'react'
import { useLocation } from 'react-router'

import { cx } from '@/utils/css.ts'
import { useShortcuts } from '@/utils/hooks/use-shortcuts.ts'

import { Button } from '@/components/button.tsx'
import { useStableNavigate } from '@/components/router.tsx'
import { T } from '@/components/translation.tsx'

import { postActions } from '@/views/actions.ts'

import { useIsSmallDevice, useMemoTitle } from './hooks.tsx'

export function MainHeader({ className }: ComponentProps<'header'>) {
  const sm = useIsSmallDevice()
  const title = useMemoTitle()
  const navigate = useStableNavigate()
  const location = useLocation()

  const openSearch = () => {
    void navigate('/search', {
      state: { backgroundLocation: location, isFirstLayer: true },
    })
  }

  // ⌘K / Ctrl+K, or "/", opens search (auto-skips while typing or a dialog is open)
  useShortcuts({
    'mod+k': { run: openSearch, when: () => location.pathname !== '/search' },
    '/': { run: openSearch, when: () => location.pathname !== '/search' },
  })

  return (
    <header
      className={cx(
        'flex h-10 items-center',
        {
          'bg-background/90 fixed top-0 right-0 left-0 z-10 h-12 rounded-b-lg px-4 py-3 shadow-lg':
            sm,
        },
        className,
      )}
    >
      {sm && (
        <Button
          className="mr-2 -ml-4 opacity-75"
          variant="ghost"
          aria-label="toggle sidebar"
          onClick={() => {
            window.toggleSidebar()
          }}
        >
          <MenuIcon />
        </Button>
      )}
      <span
        className="inline-flex items-center truncate text-foreground/80"
        onDoubleClick={() => {
          postActions.refreshMainPosts()
        }}
      >
        {title}
      </span>
      {sm ? (
        <Button
          className="-mr-4 ml-auto"
          variant="ghost"
          aria-label="search"
          onClick={openSearch}
        >
          <SearchIcon className="size-5" />
        </Button>
      ) : (
        <button
          type="button"
          aria-label="search"
          className="text-muted-foreground hover:bg-card hover:shadow-[inset_0_0_0_1px_hsl(var(--border))] ml-auto flex h-9 w-[15rem] items-center gap-2 rounded-lg bg-muted px-3 text-sm transition-colors"
          onClick={openSearch}
        >
          <SearchIcon className="size-4 flex-none opacity-80" />
          <span className="flex-1 truncate text-left">
            <T name="search" />
          </span>
          <kbd className="border-border bg-background/70 text-muted-foreground/70 flex-none rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none">
            ⌘K
          </kbd>
        </button>
      )}
    </header>
  )
}
