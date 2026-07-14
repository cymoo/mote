import {
  BarChart3Icon,
  CircleIcon,
  CloudUploadIcon,
  ExternalLinkIcon,
  LayoutGrid as GridIcon,
  Share2Icon,
} from 'lucide-react'
import { ComponentProps } from 'react'
import { useLocation, useSearchParams } from 'react-router'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { useStableNavigate } from '@/components/router.tsx'
import { T } from '@/components/translation.tsx'

import { HIGHLIGHT_STYLE } from './sidebar.tsx'

export function NavLinks({ className, ...props }: ComponentProps<'nav'>) {
  const navigate = useStableNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()

  const colors = ['red', 'blue', 'green'] as const
  const navigateToMainFilter = (nextParams: Record<string, string>) => {
    const options = { replace: params.get('tag')?.includes('hidden') }

    if (location.pathname === '/') {
      setParams(nextParams, options)
    } else {
      void navigate(
        {
          pathname: '/',
          search: `?${new URLSearchParams(nextParams).toString()}`,
        },
        options,
      )
    }
    window.toggleSidebar()
  }

  return (
    <nav
      className={cx(
        'flex flex-col gap-0.5 *:w-full *:justify-start! *:rounded-lg *:font-medium *:ring-inset',
        className,
      )}
      aria-label="main navigation"
      {...props}
    >
      <Button
        className={location.pathname === '/' && params.size === 0 ? HIGHLIGHT_STYLE : undefined}
        variant="ghost"
        onClick={() => {
          void navigate('/', { replace: params.get('tag')?.includes('hidden') })
          window.toggleSidebar()
        }}
      >
        <GridIcon className="mr-3 size-5" aria-hidden="true" />
        <T name="allMemos" />
      </Button>
      <div className="flex items-center justify-between">
        <Button
          className={cx(
            params.get('shared') === 'true' ? HIGHLIGHT_STYLE : undefined,
            'grow justify-start text-left ring-inset',
          )}
          variant="ghost"
          onClick={() => {
            navigateToMainFilter({ shared: 'true' })
          }}
        >
          <Share2Icon className="mr-3 size-5" aria-hidden="true" />
          <T name="shared" />
        </Button>
        <Button
          className="ring-inset"
          variant="ghost"
          tag="a"
          title="view all shared posts"
          href={import.meta.env.VITE_BLOG_URL}
          target="_blank"
        >
          <ExternalLinkIcon className="size-4 opacity-75" aria-hidden="true" />
        </Button>
      </div>
      {colors.map((color) => (
        <Button
          key={color}
          className={params.get('color') === color ? HIGHLIGHT_STYLE : undefined}
          variant="ghost"
          onClick={() => {
            navigateToMainFilter({ color })
          }}
        >
          <CircleIcon
            className={cx('mx-[3px] mr-[15px] size-3.5 stroke-none', `fill-${color}-500`)}
            aria-hidden="true"
          />
          <T name={color} />
        </Button>
      ))}
      <Button
        className={location.pathname === '/stats' ? HIGHLIGHT_STYLE : undefined}
        variant="ghost"
        onClick={() => {
          void navigate('/stats')
          window.toggleSidebar()
        }}
      >
        <BarChart3Icon className="mr-3 size-5" aria-hidden="true" />
        <T name="statistics" />
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          void navigate('/files')
          window.toggleSidebar()
        }}
      >
        <CloudUploadIcon className="mr-3 size-5" aria-hidden="true" />
        <T name="files" />
      </Button>
    </nav>
  )
}
