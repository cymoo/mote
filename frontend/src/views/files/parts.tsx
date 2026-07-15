import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  CopyPlusIcon,
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
  StarIcon,
  StarOffIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { CSSProperties, ReactNode, Ref, memo, useRef, useState } from 'react'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { MenuItem, MenuList, MenuSeparator } from '@/components/menu.tsx'
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
  onCopy?: () => void
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
  onCopy,
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
        'border-border bg-popover/90 text-popover-foreground flex animate-[fadeIn_160ms_ease-out] items-center border text-sm shadow-xl backdrop-blur-md',
        floating
          ? 'fixed inset-x-0 bottom-5 z-30 mx-auto w-fit max-w-[94vw] gap-0.5 rounded-full py-1.5 pr-1.5 pl-4 max-md:bottom-24'
          : 'ml-auto gap-0.5 rounded-full px-2 py-1',
      )}
    >
      <span className="pr-2 text-[13px] font-semibold tabular-nums">
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
      {onCopy && (
        <Button
          variant="ghost"
          size="sm"
          className={btnSize}
          onClick={onCopy}
          title={t('copyTo', lang)}
          aria-label={t('copyTo', lang)}
        >
          <CopyIcon className="size-4" />
        </Button>
      )}
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

// 类型着色的图标底块：色相跨主题固定（.fico 样式定义于 index.css），
// 让文件类型在任何主题下都保持可辨识。
function IconTile({
  hue,
  sat,
  large,
  children,
}: {
  hue: number
  sat: number
  large?: boolean
  children: ReactNode
}) {
  return (
    <span
      className={cx(
        'fico flex flex-none items-center justify-center overflow-hidden',
        large ? 'size-11 rounded-[calc(var(--radius)+1px)]' : 'size-[34px] rounded-[calc(var(--radius)-2px)]',
      )}
      style={{ '--fh': hue, '--fs': `${String(sat)}%` } as CSSProperties}
    >
      {children}
    </span>
  )
}

export const NodeIcon = memo(function NodeIcon({
  node,
  large,
}: {
  node: DriveNode
  large?: boolean
}) {
  const cls = large ? 'size-[22px]' : 'size-[17px]'
  if (node.type === 'folder')
    return (
      <IconTile hue={36} sat={80} large={large}>
        <FolderIcon className={cls} />
      </IconTile>
    )
  const mt = node.mime_type ?? ''
  if (mt.startsWith('image/')) return <ImageThumb node={node} large={large} />
  if (mt.startsWith('video/'))
    return (
      <IconTile hue={340} sat={60} large={large}>
        <FilmIcon className={cls} />
      </IconTile>
    )
  if (mt.startsWith('audio/'))
    return (
      <IconTile hue={190} sat={62} large={large}>
        <MusicIcon className={cls} />
      </IconTile>
    )
  if (mt.includes('pdf'))
    return (
      <IconTile hue={4} sat={64} large={large}>
        <FileTextIcon className={cls} />
      </IconTile>
    )
  if (mt.startsWith('text/'))
    return (
      <IconTile hue={210} sat={62} large={large}>
        <FileTextIcon className={cls} />
      </IconTile>
    )
  return (
    <IconTile hue={220} sat={12} large={large}>
      <FileIcon className={cls} />
    </IconTile>
  )
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
  const cls = large ? 'size-11' : 'size-[34px]'
  if (failed) {
    return (
      <IconTile hue={262} sat={62} large={large}>
        <ImageIcon className={large ? 'size-[22px]' : 'size-[17px]'} />
      </IconTile>
    )
  }
  return (
    <div
      className={cx(
        cls,
        large ? 'rounded-[calc(var(--radius)+1px)]' : 'rounded-[calc(var(--radius)-2px)]',
        'bg-muted/50 ring-border/40 flex flex-none items-center justify-center overflow-hidden ring-1',
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
        'flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
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

export type RowAction =
  | 'download'
  | 'rename'
  | 'share'
  | 'move'
  | 'copy'
  | 'duplicate'
  | 'star'
  | 'unstar'
  | 'delete'

// The shared action list for a single node — used by both the kebab RowMenu
// and the desktop right-click context menu so they never drift apart.
export function NodeMenuItems({
  node,
  fire,
}: {
  node: DriveNode
  fire: (action: RowAction) => void
}) {
  return (
    <>
      <MenuItem icon={<DownloadIcon className="size-3.5" />} onClick={() => fire('download')}>
        {node.type === 'folder' ? <T name="downloadZip" /> : <T name="download" />}
      </MenuItem>
      <MenuItem icon={<Share2Icon className="size-3.5" />} onClick={() => fire('share')}>
        <T name="shareLink" />
      </MenuItem>
      <MenuSeparator />
      {node.starred_at ? (
        <MenuItem icon={<StarOffIcon className="size-3.5" />} onClick={() => fire('unstar')}>
          <T name="unstar" />
        </MenuItem>
      ) : (
        <MenuItem icon={<StarIcon className="size-3.5" />} onClick={() => fire('star')}>
          <T name="star" />
        </MenuItem>
      )}
      <MenuItem icon={<CopyIcon className="size-3.5" />} onClick={() => fire('copy')}>
        <T name="copyTo" />
      </MenuItem>
      <MenuItem icon={<CopyPlusIcon className="size-3.5" />} onClick={() => fire('duplicate')}>
        <T name="duplicate" />
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<PencilIcon className="size-3.5" />} onClick={() => fire('rename')}>
        <T name="rename" />
      </MenuItem>
      <MenuItem icon={<FolderInputIcon className="size-3.5" />} onClick={() => fire('move')}>
        <T name="move" />
      </MenuItem>
      <MenuSeparator />
      <MenuItem danger icon={<Trash2Icon className="size-3.5" />} onClick={() => fire('delete')}>
        <T name="delete" />
      </MenuItem>
    </>
  )
}

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
        <MenuList className="min-w-40">
          <NodeMenuItems node={node} fire={fire} />
        </MenuList>
      </PopoverContent>
    </Popover>
  )
})


// ---------- star badge ----------

export const StarBadge = memo(function StarBadge({ lang }: { lang: Lang }) {
  return (
    <span
      title={t('starred', lang)}
      aria-label={t('starred', lang)}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-amber-500"
    >
      <StarIcon className="size-3 fill-current" />
    </span>
  )
})

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
