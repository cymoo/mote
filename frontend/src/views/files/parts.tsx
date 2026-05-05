import {
  CheckIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileIcon,
  FileTextIcon,
  FilmIcon,
  FolderIcon,
  FolderInputIcon,
  ImageIcon,
  MoreVerticalIcon,
  MusicIcon,
  PencilIcon,
  SearchIcon,
  Share2Icon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { ReactNode, Ref, memo, useRef, useState } from 'react'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/popover.tsx'
import { T, t } from '@/components/translation.tsx'

import { DriveBreadcrumb, DriveNode, thumbURL } from './api'

type Lang = 'en' | 'zh'

// ---------- breadcrumbs ----------

interface BreadcrumbsProps {
  crumbs: DriveBreadcrumb[] | null
  onRoot: () => void
  onCrumb: (id: number) => void
  isTrash?: boolean
  label?: string
  lang: Lang
  onSecretActivate?: () => void
}

const SECRET_CLICK_TARGET = 10
const SECRET_CLICK_TIMEOUT_MS = 2000

export const Breadcrumbs = memo(function Breadcrumbs({
  crumbs,
  onRoot,
  onCrumb,
  isTrash,
  label,
  lang,
  onSecretActivate,
}: BreadcrumbsProps) {
  const clickCount = useRef(0)
  const clickTimer = useRef<ReturnType<typeof setTimeout>>(null)

  const handleRootClick = () => {
    onRoot()
    if (!onSecretActivate) return
    clickCount.current++
    if (clickTimer.current) clearTimeout(clickTimer.current)
    if (clickCount.current >= SECRET_CLICK_TARGET) {
      clickCount.current = 0
      onSecretActivate()
    } else {
      clickTimer.current = setTimeout(() => {
        clickCount.current = 0
      }, SECRET_CLICK_TIMEOUT_MS)
    }
  }
  return (
    <nav className="text-muted-foreground flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap text-sm [-ms-overflow-style:none] [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] md:[mask-image:none] md:flex-initial md:overflow-visible md:whitespace-normal [&::-webkit-scrollbar]:hidden">
      <button
        type="button"
        className="hover:bg-accent hover:text-accent-foreground shrink-0 rounded-md px-2 py-1 transition-colors"
        onClick={handleRootClick}
        title={t('myDrive', lang)}
      >
        <T name="myDrive" />
      </button>
      {!isTrash && !label &&
        crumbs?.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <span key={c.id} className="flex shrink-0 items-center">
              <ChevronRightIcon className="size-3.5 opacity-60" />
              <button
                type="button"
                disabled={last}
                className={cx(
                  'rounded-md px-2 py-1 transition-colors',
                  last
                    ? 'text-foreground font-medium'
                    : 'hover:bg-accent hover:text-accent-foreground',
                )}
                onClick={() => onCrumb(c.id)}
              >
                {c.name}
              </button>
            </span>
          )
        })}
      {(isTrash || label) && (
        <span className="flex shrink-0 items-center">
          <ChevronRightIcon className="size-3.5 opacity-60" />
          <span className="text-foreground rounded-md px-2 py-1 font-medium">
            {label ?? <T name="trash" />}
          </span>
        </span>
      )}
    </nav>
  )
})

// ---------- search ----------

export const SearchBox = memo(function SearchBox({
  value,
  onChange,
  disabled,
  placeholder,
  inputRef,
  className,
  onBlur,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  placeholder: string
  inputRef?: Ref<HTMLInputElement>
  className?: string
  onBlur?: () => void
}) {
  return (
    <div className={cx('relative', className)}>
      <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
      <input
        ref={inputRef}
        type="search"
        placeholder={placeholder}
        className={cx(
          'border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring focus-visible:border-ring h-9 w-full rounded-full border py-1 pr-3 pl-8 text-sm transition-colors outline-none focus-visible:ring-2 md:w-44 md:focus-visible:w-56',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        disabled={disabled}
      />
    </div>
  )
})

// ---------- selection bar ----------

interface SelectionBarProps {
  count: number
  onClear: () => void
  onDownload: () => void
  onMove: () => void
  onDelete: () => void
  lang: Lang
  // When true, render as a fixed bottom bar (used on mobile).
  floating?: boolean
}

export const SelectionBar = memo(function SelectionBar({
  count,
  onClear,
  onDownload,
  onMove,
  onDelete,
  lang,
  floating,
}: SelectionBarProps) {
  // Touch targets need to be at least ~40×40 to avoid mistaps; PC keeps the
  // tighter 28-px size to stay visually unobtrusive in the toolbar.
  const btnSize = floating
    ? 'size-10! gap-0! px-0!'
    : 'size-7! px-0!'
  return (
    <div
      className={cx(
        'bg-accent/70 text-accent-foreground flex animate-[fadeIn_120ms_ease-out] items-center text-sm shadow-sm ring-1 ring-black/5 dark:ring-white/5',
        floating
          ? 'fixed inset-x-2 bottom-2 z-30 justify-end gap-1 rounded-full px-2 py-1.5 backdrop-blur'
          : 'ml-auto gap-0.5 rounded-full px-2 py-1',
      )}
    >
      <span className="px-2 text-xs tabular-nums">
        {count} <T name="selected" />
      </span>
      <Button
        variant="ghost"
        size="sm"
        className={btnSize}
        onClick={onDownload}
        title={t('download', lang)}
        aria-label={t('download', lang)}
      >
        <DownloadIcon className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={btnSize}
        onClick={onMove}
        title={t('move', lang)}
        aria-label={t('move', lang)}
      >
        <FolderInputIcon className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cx('text-destructive hover:text-destructive', btnSize)}
        onClick={onDelete}
        title={t('delete', lang)}
        aria-label={t('delete', lang)}
      >
        <Trash2Icon className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={btnSize}
        onClick={onClear}
        title={t('clearSelection', lang)}
        aria-label={t('clearSelection', lang)}
      >
        <XIcon className="size-4" />
      </Button>
    </div>
  )
})

// ---------- node icon ----------

export const NodeIcon = memo(function NodeIcon({
  node,
  large,
}: {
  node: DriveNode
  large?: boolean
}) {
  const cls = large ? 'size-10' : 'size-5'
  if (node.type === 'folder')
    return <FolderIcon className={cx(cls, 'text-primary fill-primary/15')} />
  const mt = node.mime_type ?? ''
  if (mt.startsWith('image/')) return <ImageThumb node={node} large={large} />
  if (mt.startsWith('video/')) return <FilmIcon className={cx(cls, 'text-rose-500')} />
  if (mt.startsWith('audio/')) return <MusicIcon className={cx(cls, 'text-amber-500')} />
  if (mt.includes('pdf')) return <FileTextIcon className={cx(cls, 'text-red-500')} />
  if (mt.startsWith('text/')) return <FileTextIcon className={cx(cls, 'text-blue-500')} />
  return <FileIcon className={cx(cls, 'text-muted-foreground')} />
})

// Renders a server-generated thumbnail for image files; falls back to the
// generic icon if the request fails (e.g. unsupported format / decode error).
const ImageThumb = memo(function ImageThumb({
  node,
  large,
}: {
  node: DriveNode
  large?: boolean
}) {
  const [failed, setFailed] = useState(false)
  const cls = large ? 'size-14' : 'size-6'
  if (failed) {
    return <ImageIcon className={cx(large ? 'size-10' : 'size-5', 'text-emerald-500')} />
  }
  return (
    <div
      className={cx(
        cls,
        'bg-muted/50 ring-border/40 flex items-center justify-center overflow-hidden rounded ring-1',
      )}
    >
      <img
        src={thumbURL(node.id)}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-full object-cover"
        onError={() => setFailed(true)}
      />
    </div>
  )
})

// ---------- checkbox ----------

export const Checkbox = memo(function Checkbox({
  checked,
  indeterminate,
  onChange,
  title,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onChange()
      }}
      className={cx(
        'flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
        checked || indeterminate
          ? 'bg-primary border-primary text-primary-foreground'
          : 'border-input hover:border-ring bg-background',
      )}
    >
      {indeterminate ? (
        <span className="bg-primary-foreground h-0.5 w-2 rounded" />
      ) : checked ? (
        <CheckIcon className="size-3" />
      ) : null}
    </button>
  )
})

// ---------- row menu ----------

export type RowAction = 'download' | 'rename' | 'share' | 'move' | 'delete'

interface RowMenuProps {
  node: DriveNode
  onAction: (action: RowAction, n: DriveNode) => void
  lang: Lang
}

export const RowMenu = memo(function RowMenu({ node, onAction, lang }: RowMenuProps) {
  const [open, setOpen] = useState(false)
  const fire = (action: RowAction) => {
    setOpen(false)
    onAction(action, node)
  }
  return (
    <Popover placement="left-start" open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        asChild
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        <Button
          variant="ghost"
          size="icon"
          className="size-8 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:data-[state=open]:opacity-100"
          aria-label={t('more', lang)}
          title={t('more', lang)}
        >
          <MoreVerticalIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <ul className="min-w-44 py-1.5 text-sm">
          <MenuItem icon={<DownloadIcon className="size-4" />} onClick={() => fire('download')}>
            {node.type === 'folder' ? <T name="downloadZip" /> : <T name="download" />}
          </MenuItem>
          {node.type === 'file' && (
            <MenuItem icon={<Share2Icon className="size-4" />} onClick={() => fire('share')}>
              <T name="shareLink" />
            </MenuItem>
          )}
          <MenuItem icon={<PencilIcon className="size-4" />} onClick={() => fire('rename')}>
            <T name="rename" />
          </MenuItem>
          <MenuItem icon={<FolderInputIcon className="size-4" />} onClick={() => fire('move')}>
            <T name="move" />
          </MenuItem>
          <li className="border-border/60 my-1 border-t" />
          <MenuItem
            danger
            icon={<Trash2Icon className="size-4" />}
            onClick={() => fire('delete')}
          >
            <T name="delete" />
          </MenuItem>
        </ul>
      </PopoverContent>
    </Popover>
  )
})

function MenuItem({
  children,
  icon,
  onClick,
  danger,
}: {
  children: ReactNode
  icon: ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <li>
      <button
        type="button"
        className={cx(
          'hover:bg-accent flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
          danger ? 'text-destructive hover:text-destructive' : undefined,
        )}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
      >
        <span className="text-muted-foreground inline-flex size-4 items-center justify-center">
          {icon}
        </span>
        {children}
      </button>
    </li>
  )
}

// ---------- share badge ----------

export const ShareBadge = memo(function ShareBadge({
  count,
  lang,
}: {
  count: number
  lang: Lang
}) {
  return (
    <span
      title={t('sharedCount', lang, true, String(count))}
      aria-label={t('sharedCount', lang, true, String(count))}
      className="text-primary inline-flex size-5 shrink-0 items-center justify-center rounded-full"
    >
      <Share2Icon className="size-3" />
    </span>
  )
})

// ---------- path chip (used by search results) ----------

export const PathChip = memo(function PathChip({
  path,
  onNavigate,
  lang,
}: {
  path: string // empty string means root
  onNavigate: () => void
  lang: Lang
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onNavigate()
      }}
      className="text-muted-foreground hover:bg-accent hover:text-accent-foreground inline-flex max-w-[18rem] items-center gap-1 truncate rounded-full px-2 py-0.5 text-[11px] transition-colors"
      title={t('openFolder', lang)}
    >
      <FolderIcon className="size-3 shrink-0 opacity-70" />
      <span className="truncate">{path === '' ? t('myDrive', lang) : path}</span>
    </button>
  )
})
