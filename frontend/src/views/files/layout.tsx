import {
  ChevronLeftIcon,
  CloudUploadIcon,
  FolderIcon,
  HomeIcon,
  LinkIcon,
  Share2Icon,
  StarIcon,
  Trash2Icon,
} from 'lucide-react'
import { ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { useStableNavigate } from '@/components/router.tsx'
import { T, t, useLang } from '@/components/translation.tsx'

import { humanSize } from './api'
import { useCookieAuthSync, useDriveUsage } from './hooks'
import { UploadDock } from './upload-dock'

type Lang = 'en' | 'zh'

export function FilesLayout() {
  useCookieAuthSync()
  const { lang } = useLang()
  return (
    <div className="text-foreground vh-full flex flex-col md:flex-row md:gap-3 md:p-3">
      <FilesRail lang={lang} />
      {/* 桌面端的「画布」：内容区抬升为带描边圆角的卡片，导航轨留在底色上 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:overflow-hidden md:rounded-[calc(var(--radius)+7px)] md:border md:border-border md:bg-card md:shadow-xs">
        <Outlet />
      </div>
      <UploadDock lang={lang} />
    </div>
  )
}

// 桌面左侧导航轨：返回、品牌、三个入口。动作按钮集中在顶栏，轨道只做导航，
// 为将来的新入口留出位置。
function FilesRail({ lang }: { lang: Lang }) {
  const navigate = useStableNavigate()
  const usage = useDriveUsage()
  return (
    <aside className="hidden w-[210px] flex-none flex-col px-1 py-1 md:flex">
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground mb-4 w-fit justify-start gap-1 rounded-lg px-2!"
        onClick={() => navigate('/')}
      >
        <ChevronLeftIcon className="size-4" />
        <T name="backToNotes" />
      </Button>
      <div className="mb-5 flex items-center gap-2.5 px-2.5">
        <i className="logo-dot" aria-hidden="true" />
        <span className="text-[17px] font-semibold tracking-wide">mote</span>
      </div>
      <nav className="flex flex-col gap-0.5" aria-label="drive navigation">
        <RailLink
          to="/files"
          end
          icon={<CloudUploadIcon className="size-4" />}
          label={t('myDrive', lang)}
        />
        <RailLink
          to="/files/shared"
          icon={<LinkIcon className="size-4" />}
          label={t('sharedFiles', lang)}
        />
        <RailLink
          to="/files/starred"
          icon={<StarIcon className="size-4" />}
          label={t('starred', lang)}
        />
        <RailLink
          to="/files/trash"
          icon={<Trash2Icon className="size-4" />}
          label={t('trash', lang)}
        />
      </nav>
      <div className="mt-auto px-2.5 pb-2">
        {usage && (
          <p
            className="text-muted-foreground/60 text-[11.5px] leading-relaxed tabular-nums"
            title={t('onDisk', lang, true, humanSize(usage.physical_bytes))}
          >
            {t('usageSummary', lang, true, humanSize(usage.active_bytes), humanSize(usage.trash_bytes))}
          </p>
        )}
        {usage && usage.total_bytes > 0 && (
          <p className="text-muted-foreground/60 pb-1 text-[11.5px] leading-relaxed tabular-nums">
            {t('diskFree', lang, true, humanSize(usage.free_bytes), humanSize(usage.total_bytes))}
          </p>
        )}
        <p className="text-muted-foreground/60 text-[11.5px] leading-relaxed">
          <T name="uploadHint" />
        </p>
      </div>
    </aside>
  )
}

function RailLink({
  to,
  end,
  icon,
  label,
}: {
  to: string
  end?: boolean
  icon: ReactNode
  label: string
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
          isActive
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )
      }
    >
      {icon}
      {label}
    </NavLink>
  )
}

// Sticky top header used by all three /files pages. Pages compose their own
// middle content (breadcrumbs, search, view toggle…). On desktop the rail
// handles section navigation, so the home button and nav pills only render
// on mobile; on <md the header keeps its two-row layout.
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
    <header className="border-border bg-card/95 supports-[backdrop-filter]:bg-card/80 sticky top-0 z-20 flex flex-col gap-2 border-b px-3 py-2.5 backdrop-blur md:flex-row md:flex-wrap md:items-center md:gap-2 md:px-4">
      <div className="flex items-center gap-3 md:hidden">
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
        <div className="ml-auto flex items-center gap-1.5">
          <FilesNavPills lang={lang} />
        </div>
      </div>
      {hasSecondRow && (
        <div className="flex min-w-0 items-center gap-2 md:contents">
          {middle}
          <div className="ml-auto flex items-center gap-1.5">{extra}</div>
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
        to="/files/starred"
        label={t('starred', lang)}
        icon={<StarIcon className="size-4" />}
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
