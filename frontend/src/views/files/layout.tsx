import { FolderIcon, HomeIcon, Share2Icon, Trash2Icon } from 'lucide-react'
import { ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { useStableNavigate } from '@/components/router.tsx'
import { T, t, useLang } from '@/components/translation.tsx'

import { useCookieAuthSync } from './hooks'
import { UploadDock } from './upload-dock'

type Lang = 'en' | 'zh'

export function FilesLayout() {
  useCookieAuthSync()
  const { lang } = useLang()
  return (
    <div className="bg-background text-foreground vh-full flex flex-col">
      <Outlet />
      <UploadDock lang={lang} />
    </div>
  )
}

// Sticky top header used by all three /files pages. Pages compose their own
// middle content (breadcrumbs, search, view toggle…) and the nav pills are
// rendered consistently on the right.
//
// On <md the header is split into two rows: row 1 keeps the back/title/nav
// pills; row 2 holds the page-supplied middle/extra slots. On ≥md `md:contents`
// dissolves the row-2 wrapper so children flow back into row 1, preserving
// the original PC layout exactly.
export function TopBar({
  middle,
  extra,
  lang,
}: {
  middle?: ReactNode
  extra?: ReactNode
  lang: Lang
}) {
  const navigate = useStableNavigate()
  const hasSecondRow = middle != null || extra != null
  return (
    <header className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-20 flex flex-col gap-2 border-b px-4 py-3 backdrop-blur md:flex-row md:flex-wrap md:items-center md:gap-3">
      <div className="flex items-center gap-3 md:contents">
        <Button
          variant="ghost"
          size="icon"
          className="size-9"
          onClick={() => navigate('/')}
          aria-label={t('back', lang)}
          title={t('back', lang)}
        >
          <HomeIcon className="size-4" />
        </Button>
        <button
          type="button"
          className="text-base font-semibold tracking-tight hover:text-primary transition-colors"
          onClick={() => navigate('/files')}
        >
          <T name="myDrive" />
        </button>
        <div className="ml-auto flex items-center gap-1.5 md:hidden">
          <FilesNavPills lang={lang} />
        </div>
      </div>
      {hasSecondRow && (
        <div className="flex min-w-0 items-center gap-2 md:contents">
          {middle}
          <div className="ml-auto flex items-center gap-1.5">
            {extra}
            <span className="hidden md:contents">
              <FilesNavPills lang={lang} />
            </span>
          </div>
        </div>
      )}
      {!hasSecondRow && (
        <div className="ml-auto hidden items-center gap-1.5 md:flex">
          <FilesNavPills lang={lang} />
        </div>
      )}
    </header>
  )
}

function FilesNavPills({ lang }: { lang: Lang }) {
  return (
    <>
      <NavPill to="/files" label={t('files', lang)} icon={<FolderIcon className="size-4" />} end />
      <NavPill
        to="/files/shared"
        label={t('sharedFiles', lang)}
        icon={<Share2Icon className="size-4" />}
        activeColor="text-primary"
      />
      <NavPill
        to="/files/trash"
        label={t('trash', lang)}
        icon={<Trash2Icon className="size-4" />}
      />
    </>
  )
}

function NavPill({
  to,
  label,
  icon,
  end,
  activeColor,
}: {
  to: string
  label: string
  icon: ReactNode
  end?: boolean
  activeColor?: string
}) {
  return (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
      title={label}
      className={({ isActive }) =>
        cx(
          'hover:bg-accent inline-flex size-9 items-center justify-center rounded-md transition-colors',
          isActive ? (activeColor ?? 'text-primary') : 'text-muted-foreground',
        )
      }
    >
      {icon}
    </NavLink>
  )
}
