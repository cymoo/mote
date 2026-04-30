import { ArrowLeftIcon, FolderIcon, Share2Icon, Trash2Icon } from 'lucide-react'
import { ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { useModal } from '@/components/modal.tsx'
import { useStableNavigate } from '@/components/router.tsx'
import { T, t, useLang } from '@/components/translation.tsx'

import { useCookieAuthSync } from './hooks'
import { ShortcutsCheatsheet } from './shortcuts-cheatsheet'
import { UploadDock } from './upload-dock'
import { ShortcutsProvider, useShortcuts } from './use-shortcuts'

type Lang = 'en' | 'zh'

export function FilesLayout() {
  useCookieAuthSync()
  const { lang } = useLang()
  return (
    <ShortcutsProvider>
      <div className="bg-background text-foreground flex h-screen flex-col">
        <GlobalShortcuts lang={lang} />
        <Outlet />
        <UploadDock lang={lang} />
      </div>
    </ShortcutsProvider>
  )
}

function GlobalShortcuts({ lang }: { lang: Lang }) {
  const modal = useModal()
  const open = () => {
    modal.open({
      heading: t('shortcuts', lang),
      headingVisible: true,
      content: <ShortcutsCheatsheet lang={lang} />,
    })
  }
  useShortcuts({
    '?': { run: open, desc: t('shortcuts', lang) },
  })
  return null
}

// Sticky top header used by all three /files pages. Pages compose their own
// middle content (breadcrumbs, search, view toggle…) and the nav pills are
// rendered consistently on the right.
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
  return (
    <header className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b px-4 py-3 backdrop-blur">
      <Button
        variant="ghost"
        size="icon"
        className="size-9"
        onClick={() => navigate('/')}
        aria-label={t('back', lang)}
        title={t('back', lang)}
      >
        <ArrowLeftIcon className="size-4" />
      </Button>
      <h1 className="text-base font-semibold tracking-tight">
        <T name="files" />
      </h1>
      {middle}
      <div className="ml-auto flex items-center gap-1.5">
        {extra}
        <FilesNavPills lang={lang} />
      </div>
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
        activeColor="text-destructive"
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
