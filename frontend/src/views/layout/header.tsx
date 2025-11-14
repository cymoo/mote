import { MenuIcon, Search as SearchIcon } from 'lucide-react'
import { ComponentProps } from 'react'
import { useLocation } from 'react-router'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { useStableNavigate } from '@/components/router.tsx'

import { postActions } from '@/views/actions.ts'

import { useIsSmallDevice, useMemoTitle } from './hooks.tsx'

export function MainHeader({ className }: ComponentProps<'header'>) {
  const sm = useIsSmallDevice()
  const title = useMemoTitle()
  const navigate = useStableNavigate()
  const location = useLocation()

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
      <Button
        className="-mr-4 ml-auto"
        variant="ghost"
        aria-label="search"
        onClick={() => {
          void navigate('/search', {
            state: { backgroundLocation: location, isFirstLayer: true },
          })
        }}
      >
        <SearchIcon className="size-5" />
      </Button>
    </header>
  )
}
