import 'photoswipe/style.css'

import PhotoSwipeLightbox from 'photoswipe/lightbox'
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  FileTextIcon,
  FilmIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  ImageIcon,
  LayoutGridIcon,
  ListIcon,
  MoreVerticalIcon,
  MusicIcon,
  PencilIcon,
  RotateCcwIcon,
  SearchIcon,
  Share2Icon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from 'lucide-react'
import {
  ChangeEvent,
  DragEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import toast from 'react-hot-toast'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { useConfirm } from '@/components/confirm.tsx'
import { useModal } from '@/components/modal.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/popover.tsx'
import { useStableNavigate } from '@/components/router.tsx'
import { T, t, useLang } from '@/components/translation.tsx'

import {
  CollisionPolicy,
  DriveBreadcrumb,
  DriveNode,
  breadcrumbs,
  createFolder,
  createShare,
  deleteNodes,
  downloadURL,
  downloadZipURL,
  humanSize,
  list,
  moveNodes,
  previewURL,
  purgeNodes,
  renameNode,
  restoreNode,
  search,
  trash,
} from './api'
import { uploadManager, UploadItem } from './upload-manager'

type ViewMode = 'list' | 'grid'

// Ensure the auth cookie is in sync with localStorage on page mount; downloads
// and PhotoSwipe images rely on cookie auth (no Authorization header).
function syncCookieFromLocalStorage() {
  const tok = localStorage.getItem('token')
  if (!tok) return
  if (!document.cookie.split(';').some((c) => c.trim().startsWith('token='))) {
    const expires = new Date()
    expires.setDate(expires.getDate() + 365 * 10)
    document.cookie = `token=${tok}; expires=${expires.toUTCString()}; path=/`
  }
}

export function FilesPage() {
  const [parentID, setParentID] = useState<number | null>(null)
  const [items, setItems] = useState<DriveNode[]>([])
  const [crumbs, setCrumbs] = useState<DriveBreadcrumb[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [view, setView] = useState<ViewMode>(
    (localStorage.getItem('drive_view') as ViewMode) || 'list',
  )
  const [query, setQuery] = useState('')
  const [showTrash, setShowTrash] = useState(false)
  const [trashItems, setTrashItems] = useState<DriveNode[]>([])
  const [previewIdx, setPreviewIdx] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const navigate = useStableNavigate()
  const confirm = useConfirm()
  const modal = useModal()
  const { lang } = useLang()

  useEffect(() => {
    syncCookieFromLocalStorage()
  }, [])

  const refresh = useCallback(async () => {
    if (showTrash) {
      setTrashItems(await trash())
      return
    }
    if (query.trim()) {
      setItems(await search(query.trim()))
    } else {
      setItems(await list(parentID))
    }
    setCrumbs(parentID == null ? [] : await breadcrumbs(parentID))
    setSelected(new Set())
  }, [parentID, query, showTrash])

  useEffect(() => {
    void refresh().catch((err: Error) => toast.error(err.message))
  }, [refresh])

  useEffect(() => {
    localStorage.setItem('drive_view', view)
  }, [view])

  const toggle = (
    id: number,
    ev: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean },
  ) => {
    setSelected((s) => {
      const additive = ev.shiftKey || ev.metaKey || ev.ctrlKey
      const next = new Set(additive ? s : [])
      if (additive && s.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    setSelected((s) =>
      s.size === items.length ? new Set() : new Set(items.map((n) => n.id)),
    )
  }

  const onUploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    for (const f of Array.from(files)) {
      try {
        const r = await uploadManager.add(f, parentID, 'ask')
        if (!r.conflict) await refresh()
      } catch (err) {
        toast.error((err as Error).message)
      }
    }
    await refresh()
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    void onUploadFiles(e.dataTransfer.files)
  }

  const handleNewFolder = () => {
    modal.open({
      heading: t('newFolder', lang),
      headingVisible: true,
      content: (
        <NameDialog
          placeholder={t('folderName', lang)}
          submitLabel={t('create', lang)}
          onSubmit={async (name) => {
            try {
              await createFolder(parentID, name)
              modal.close()
              await refresh()
            } catch (err) {
              toast.error((err as Error).message)
            }
          }}
          onCancel={() => modal.close()}
        />
      ),
    })
  }

  const handleRename = (n: DriveNode) => {
    modal.open({
      heading: t('rename', lang),
      headingVisible: true,
      content: (
        <NameDialog
          initial={n.name}
          submitLabel={t('rename', lang)}
          onSubmit={async (name) => {
            try {
              await renameNode(n.id, name)
              modal.close()
              await refresh()
            } catch (err) {
              toast.error((err as Error).message)
            }
          }}
          onCancel={() => modal.close()}
        />
      ),
    })
  }

  const handleShare = (n: DriveNode) => {
    modal.open({
      heading: `${t('shareLink', lang)} — ${n.name}`,
      headingVisible: true,
      content: <ShareDialog node={n} onClose={() => modal.close()} lang={lang} />,
    })
  }

  const handleMove = (ids: number[]) => {
    modal.open({
      heading: t('moveTo', lang),
      headingVisible: true,
      content: (
        <MoveDialog
          movingIDs={new Set(ids)}
          currentParentID={parentID}
          onCancel={() => modal.close()}
          onSelect={async (target) => {
            try {
              await moveNodes(ids, target)
              modal.close()
              await refresh()
            } catch (err) {
              toast.error((err as Error).message)
            }
          }}
        />
      ),
    })
  }

  const handleDelete = (ids: number[]) => {
    confirm.open({
      heading: t('moveToTrash', lang, true, String(ids.length)),
      okText: t('delete', lang),
      cancelText: t('cancel', lang),
      onOk: async () => {
        try {
          await deleteNodes(ids)
          await refresh()
        } catch (err) {
          toast.error((err as Error).message)
        }
      },
    })
  }

  const handlePurge = (id: number) => {
    confirm.open({
      heading: t('purgePermanent', lang),
      description: t('irreversible', lang),
      okText: t('delete', lang),
      cancelText: t('cancel', lang),
      onOk: async () => {
        try {
          await purgeNodes([id])
          await refresh()
        } catch (err) {
          toast.error((err as Error).message)
        }
      },
    })
  }

  const downloadOne = (n: DriveNode) => {
    const url = n.type === 'folder' ? downloadZipURL(n.id) : downloadURL(n.id)
    const a = document.createElement('a')
    a.href = url
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const downloadSelected = () => {
    selected.forEach((id) => {
      const n = items.find((x) => x.id === id)
      if (n) downloadOne(n)
    })
  }

  // Locate or open preview for a node.
  const open = (n: DriveNode, idx: number) => {
    if (n.type === 'folder') {
      // Navigate into the folder. For search results clear the query.
      setQuery('')
      setParentID(n.id)
      return
    }
    setPreviewIdx(idx)
  }

  const list_ = showTrash ? trashItems : items

  const goTo = (id: number | null) => {
    setShowTrash(false)
    setQuery('')
    setParentID(id)
  }

  return (
    <div
      className={cx(
        'bg-background text-foreground relative flex h-screen flex-col',
        dragOver ? 'after:ring-primary/50 after:bg-primary/5 after:pointer-events-none after:absolute after:inset-2 after:rounded-2xl after:ring-2 after:ring-inset' : undefined,
      )}
      onDragOver={(e) => {
        e.preventDefault()
        if (!showTrash) setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      {/* Header */}
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

        <Breadcrumbs
          crumbs={showTrash ? null : crumbs}
          onRoot={() => goTo(null)}
          onCrumb={(id) => goTo(id)}
          isTrash={showTrash}
          lang={lang}
        />

        <div className="ml-auto flex items-center gap-1.5">
          <SearchBox
            value={query}
            onChange={setQuery}
            disabled={showTrash}
            placeholder={t('search', lang)}
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            onClick={() => setView(view === 'list' ? 'grid' : 'list')}
            aria-label={view === 'list' ? t('viewGrid', lang) : t('viewList', lang)}
            title={view === 'list' ? t('viewGrid', lang) : t('viewList', lang)}
          >
            {view === 'list' ? (
              <LayoutGridIcon className="size-4" />
            ) : (
              <ListIcon className="size-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cx('size-9', showTrash ? 'text-destructive' : undefined)}
            onClick={() => {
              setShowTrash(!showTrash)
              setSelected(new Set())
              setQuery('')
            }}
            aria-label={t('trash', lang)}
            title={t('trash', lang)}
          >
            <Trash2Icon className="size-4" />
          </Button>
        </div>
      </header>

      {/* Toolbar */}
      {!showTrash && (
        <div className="border-border flex items-center gap-2 border-b px-4 py-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            title={t('upload', lang)}
          >
            <UploadIcon className="mr-1.5 size-4" />
            <T name="upload" />
          </Button>
          <input
            type="file"
            multiple
            hidden
            ref={fileInputRef}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              void onUploadFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleNewFolder}
            title={t('newFolder', lang)}
          >
            <FolderPlusIcon className="mr-1.5 size-4" />
            <T name="newFolder" />
          </Button>
          {selected.size > 0 && (
            <SelectionBar
              count={selected.size}
              onClear={() => setSelected(new Set())}
              onDownload={downloadSelected}
              onMove={() => handleMove([...selected])}
              onDelete={() => handleDelete([...selected])}
              lang={lang}
            />
          )}
        </div>
      )}

      {/* Listing */}
      <main className="flex-1 overflow-auto">
        {list_.length === 0 ? (
          <EmptyState trash={showTrash} lang={lang} />
        ) : showTrash ? (
          <TrashView
            items={trashItems}
            onRestore={async (id) => {
              try {
                await restoreNode(id)
                await refresh()
              } catch (err) {
                toast.error((err as Error).message)
              }
            }}
            onPurge={handlePurge}
            lang={lang}
          />
        ) : view === 'list' ? (
          <ListView
            items={list_}
            selected={selected}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onOpen={open}
            onAction={(action, n) => {
              if (action === 'download') downloadOne(n)
              else if (action === 'rename') handleRename(n)
              else if (action === 'share') handleShare(n)
              else if (action === 'move') handleMove([n.id])
              else if (action === 'delete') handleDelete([n.id])
            }}
            lang={lang}
          />
        ) : (
          <GridView
            items={list_}
            selected={selected}
            onToggle={toggle}
            onOpen={open}
          />
        )}
      </main>

      <UploadDock onRefresh={refresh} lang={lang} />

      {previewIdx != null && (
        <PreviewModal
          items={list_}
          index={previewIdx}
          onClose={() => setPreviewIdx(null)}
          onDownload={downloadOne}
        />
      )}
    </div>
  )
}

// ---------- breadcrumbs ----------

function Breadcrumbs({
  crumbs,
  onRoot,
  onCrumb,
  isTrash,
  lang,
}: {
  crumbs: DriveBreadcrumb[] | null
  onRoot: () => void
  onCrumb: (id: number) => void
  isTrash: boolean
  lang: 'en' | 'zh'
}) {
  return (
    <nav className="text-muted-foreground flex items-center gap-0.5 text-sm">
      <button
        type="button"
        className="hover:bg-accent hover:text-accent-foreground inline-flex items-center gap-1 rounded px-2 py-1 transition-colors"
        onClick={onRoot}
        title={t('myDrive', lang)}
      >
        <FolderIcon className="size-3.5" />
        <T name="myDrive" />
      </button>
      {!isTrash &&
        crumbs?.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <span key={c.id} className="flex items-center">
              <ChevronRightIcon className="size-3.5 opacity-60" />
              <button
                type="button"
                disabled={last}
                className={cx(
                  'rounded px-2 py-1 transition-colors',
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
      {isTrash && (
        <span className="flex items-center">
          <ChevronRightIcon className="size-3.5 opacity-60" />
          <span className="text-foreground rounded px-2 py-1 font-medium">
            <T name="trash" />
          </span>
        </span>
      )}
    </nav>
  )
}

function SearchBox({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  placeholder: string
}) {
  return (
    <div className="relative">
      <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
      <input
        type="search"
        placeholder={placeholder}
        className={cx(
          'border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring h-9 w-44 rounded-md border py-1 pr-2 pl-8 text-sm transition-colors outline-none focus-visible:ring-1',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    </div>
  )
}

function SelectionBar({
  count,
  onClear,
  onDownload,
  onMove,
  onDelete,
  lang,
}: {
  count: number
  onClear: () => void
  onDownload: () => void
  onMove: () => void
  onDelete: () => void
  lang: 'en' | 'zh'
}) {
  return (
    <div className="bg-accent text-accent-foreground ml-3 flex animate-[fadeIn_120ms_ease-out] items-center gap-1 rounded-md px-2 py-1 text-sm">
      <span className="px-1 text-xs">
        {count} <T name="selected" />
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        onClick={onDownload}
        title={t('download', lang)}
      >
        <DownloadIcon className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        onClick={onMove}
        title={t('move', lang)}
      >
        <FolderInputIcon className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive h-7 px-2"
        onClick={onDelete}
        title={t('delete', lang)}
      >
        <Trash2Icon className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        onClick={onClear}
        title={t('clearSelection', lang)}
      >
        <XIcon className="size-4" />
      </Button>
    </div>
  )
}

function EmptyState({ trash, lang }: { trash: boolean; lang: 'en' | 'zh' }) {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-sm animate-[fadeIn_200ms_ease-out]">
      {trash ? (
        <>
          <Trash2Icon className="size-10 opacity-40" />
          <span>{t('trashEmpty', lang)}</span>
        </>
      ) : (
        <>
          <UploadIcon className="size-10 opacity-40" />
          <span>{t('dropFiles', lang)}</span>
        </>
      )}
    </div>
  )
}

// ---------- list view ----------

interface ListViewProps {
  items: DriveNode[]
  selected: Set<number>
  onToggle: (
    id: number,
    ev: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean },
  ) => void
  onToggleAll: () => void
  onOpen: (n: DriveNode, idx: number) => void
  onAction: (
    action: 'download' | 'rename' | 'share' | 'move' | 'delete',
    n: DriveNode,
  ) => void
  lang: 'en' | 'zh'
}

function ListView({
  items,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
  onAction,
  lang,
}: ListViewProps) {
  const allSelected = items.length > 0 && selected.size === items.length
  return (
    <table className="w-full table-fixed text-sm">
      <thead className="text-muted-foreground bg-background sticky top-0 z-10 text-left text-xs">
        <tr className="border-border border-b">
          <th className="w-10 px-3 py-2">
            <Checkbox checked={allSelected} onChange={onToggleAll} title={t('selectAll', lang)} />
          </th>
          <th className="w-9"></th>
          <th className="px-2 py-2 font-medium">
            <T name="name" />
          </th>
          <th className="w-24 px-2 font-medium">
            <T name="size" />
          </th>
          <th className="w-44 px-2 font-medium">
            <T name="modified" />
          </th>
          <th className="w-10"></th>
        </tr>
      </thead>
      <tbody>
        {items.map((n, idx) => (
          <tr
            key={n.id}
            className={cx(
              'group hover:bg-accent/50 cursor-default border-b transition-colors',
              'border-border/50',
              selected.has(n.id) ? 'bg-accent' : undefined,
            )}
            onClick={(e) => onToggle(n.id, e)}
            onDoubleClick={() => onOpen(n, idx)}
          >
            <td className="px-3" onClick={(e) => e.stopPropagation()}>
              <Checkbox
                checked={selected.has(n.id)}
                onChange={() => onToggle(n.id, {})}
              />
            </td>
            <td className="px-1">
              <NodeIcon node={n} />
            </td>
            <td className="py-2.5 pr-2 pl-1">
              <button
                className="hover:text-primary text-left transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpen(n, idx)
                }}
                title={n.type === 'folder' ? t('openFolder', lang) : t('preview', lang)}
              >
                <span className="font-medium break-all">{n.name}</span>
                {n.path !== undefined && n.path !== '' && (
                  <span className="text-muted-foreground mt-0.5 block truncate text-xs">
                    <T name="in" /> {n.path}
                  </span>
                )}
                {n.path === '' && (
                  <span className="text-muted-foreground mt-0.5 block text-xs">
                    <T name="in" /> <T name="myDrive" />
                  </span>
                )}
              </button>
            </td>
            <td className="text-muted-foreground px-2 text-xs">{humanSize(n.size)}</td>
            <td className="text-muted-foreground px-2 text-xs">
              {new Date(n.updated_at).toLocaleString()}
            </td>
            <td className="px-1" onClick={(e) => e.stopPropagation()}>
              <RowMenu node={n} onAction={onAction} lang={lang} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---------- grid view ----------

interface GridViewProps {
  items: DriveNode[]
  selected: Set<number>
  onToggle: (
    id: number,
    ev: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean },
  ) => void
  onOpen: (n: DriveNode, idx: number) => void
}

function GridView({ items, selected, onToggle, onOpen }: GridViewProps) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3 p-4">
      {items.map((n, idx) => (
        <button
          key={n.id}
          type="button"
          className={cx(
            'group flex flex-col items-center gap-2 rounded-xl border p-3 text-center transition-all',
            'hover:bg-accent border-transparent hover:scale-[1.02]',
            selected.has(n.id) ? 'border-primary/40 bg-accent ring-primary/20 ring-2' : undefined,
          )}
          onClick={(e) => onToggle(n.id, e)}
          onDoubleClick={() => onOpen(n, idx)}
          title={n.name}
        >
          <div className="flex size-14 items-center justify-center">
            <NodeIcon node={n} large />
          </div>
          <div className="line-clamp-2 text-xs leading-tight break-all">{n.name}</div>
          <div className="text-muted-foreground text-[10px]">{humanSize(n.size)}</div>
        </button>
      ))}
    </div>
  )
}

// ---------- trash view ----------

interface TrashViewProps {
  items: DriveNode[]
  onRestore: (id: number) => void | Promise<void>
  onPurge: (id: number) => void
  lang: 'en' | 'zh'
}

function TrashView({ items, onRestore, onPurge, lang }: TrashViewProps) {
  return (
    <ul className="divide-border/60 divide-y">
      {items.map((n) => (
        <li
          key={n.id}
          className="hover:bg-accent/40 flex items-center gap-3 px-4 py-2.5 transition-colors"
        >
          <NodeIcon node={n} />
          <span className="flex-1 truncate text-sm">{n.name}</span>
          <span className="text-muted-foreground text-xs">
            {n.deleted_at ? new Date(n.deleted_at).toLocaleString() : ''}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onRestore(n.id)}
            title={t('restore', lang)}
          >
            <RotateCcwIcon className="mr-1 size-4" />
            <T name="restore" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => onPurge(n.id)}
            title={t('delete', lang)}
          >
            <Trash2Icon className="mr-1 size-4" />
            <T name="delete" />
          </Button>
        </li>
      ))}
    </ul>
  )
}

// ---------- icons ----------

function NodeIcon({ node, large }: { node: DriveNode; large?: boolean }) {
  const cls = large ? 'size-10' : 'size-5'
  if (node.type === 'folder')
    return <FolderIcon className={cx(cls, 'text-primary fill-primary/15')} />
  const mt = node.mime_type ?? ''
  const tone = 'text-muted-foreground'
  if (mt.startsWith('image/')) return <ImageIcon className={cx(cls, 'text-emerald-500')} />
  if (mt.startsWith('video/')) return <FilmIcon className={cx(cls, 'text-rose-500')} />
  if (mt.startsWith('audio/')) return <MusicIcon className={cx(cls, 'text-amber-500')} />
  if (mt.includes('pdf')) return <FileTextIcon className={cx(cls, 'text-red-500')} />
  if (mt.startsWith('text/')) return <FileTextIcon className={cx(cls, 'text-blue-500')} />
  return <FileIcon className={cx(cls, tone)} />
}

function Checkbox({
  checked,
  onChange,
  title,
}: {
  checked: boolean
  onChange: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onChange()
      }}
      className={cx(
        'flex size-4 items-center justify-center rounded border transition-colors',
        checked
          ? 'bg-primary border-primary text-primary-foreground'
          : 'border-input hover:border-ring bg-background',
      )}
    >
      {checked && <CheckIcon className="size-3" />}
    </button>
  )
}

// ---------- row menu (Popover) ----------

interface RowMenuProps {
  node: DriveNode
  onAction: (
    action: 'download' | 'rename' | 'share' | 'move' | 'delete',
    n: DriveNode,
  ) => void
  lang: 'en' | 'zh'
}

function RowMenu({ node, onAction, lang }: RowMenuProps) {
  const [open, setOpen] = useState(false)
  const close = (action: 'download' | 'rename' | 'share' | 'move' | 'delete') => {
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
          className="size-8 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
          aria-label="more actions"
          title="more actions"
        >
          <MoreVerticalIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <ul className="min-w-44 py-1 text-sm">
          <MenuItem icon={<DownloadIcon className="size-4" />} onClick={() => close('download')}>
            {node.type === 'folder' ? <T name="downloadZip" /> : <T name="download" />}
          </MenuItem>
          {node.type === 'file' && (
            <MenuItem icon={<Share2Icon className="size-4" />} onClick={() => close('share')}>
              <T name="shareLink" />
            </MenuItem>
          )}
          <MenuItem icon={<PencilIcon className="size-4" />} onClick={() => close('rename')}>
            <T name="rename" />
          </MenuItem>
          <MenuItem icon={<FolderInputIcon className="size-4" />} onClick={() => close('move')}>
            <T name="move" />
          </MenuItem>
          <li className="border-border/60 my-1 border-t" />
          <MenuItem
            danger
            icon={<Trash2Icon className="size-4" />}
            onClick={() => close('delete')}
          >
            <T name="delete" />
          </MenuItem>
        </ul>
      </PopoverContent>
    </Popover>
  )
  void lang
}

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
          'hover:bg-accent flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
          danger ? 'text-destructive' : undefined,
        )}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
      >
        {icon}
        {children}
      </button>
    </li>
  )
}

// ---------- preview (PhotoSwipe for images, modal for others) ----------

function PreviewModal({
  items,
  index,
  onClose,
  onDownload,
}: {
  items: DriveNode[]
  index: number
  onClose: () => void
  onDownload: (n: DriveNode) => void
}) {
  const node = items[index]
  const isImage = (n: DriveNode | undefined) => !!n && (n.mime_type ?? '').startsWith('image/')
  const galleryRef = useRef<HTMLDivElement>(null)

  // PhotoSwipe gallery — captures all sibling images.
  const galleryImages = useMemo(
    () => items.filter(isImage).map((n) => ({ node: n, url: previewURL(n.id) })),
    [items],
  )
  const galleryIdx = useMemo(
    () => galleryImages.findIndex((g) => g.node.id === node?.id),
    [galleryImages, node?.id],
  )

  useEffect(() => {
    if (!isImage(node)) return
    if (!galleryRef.current) return
    const lightbox = new PhotoSwipeLightbox({
      gallery: galleryRef.current,
      bgOpacity: 0.92,
      children: 'a',
      pswpModule: () => import('photoswipe'),
    })
    lightbox.addFilter('domItemData', (data, _el, linkEl) => {
      data.src = linkEl.href
      const img = linkEl.querySelector('img')
      data.w = img?.naturalWidth || 1600
      data.h = img?.naturalHeight || 1200
      return data
    })
    lightbox.on('close', onClose)
    lightbox.init()
    if (galleryIdx >= 0) lightbox.loadAndOpen(galleryIdx)
    return () => {
      lightbox.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Hidden gallery anchors for PhotoSwipe to read from.
  if (isImage(node)) {
    return (
      <div ref={galleryRef} className="hidden">
        {galleryImages.map((g) => (
          <a key={g.node.id} href={g.url} target="_blank" rel="noreferrer">
            <img src={g.url} alt={g.node.name} />
          </a>
        ))}
      </div>
    )
  }

  if (!node) return null
  const url = previewURL(node.id)
  const mt = node.mime_type ?? ''
  let body: ReactNode
  if (mt.startsWith('video/'))
    body = (
      <video
        src={url}
        controls
        autoPlay
        className="max-h-[80vh] max-w-[80vw] rounded-lg shadow-2xl"
      />
    )
  else if (mt.startsWith('audio/')) body = <audio src={url} controls autoPlay />
  else if (mt === 'application/pdf')
    body = <iframe src={url} className="h-[85vh] w-[85vw] rounded-lg bg-white" title={node.name} />
  else body = <TextPreview url={url} />

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-[fadeIn_120ms_ease-out]"
      onClick={onClose}
    >
      <div className="absolute top-4 right-4 flex gap-1.5">
        <button
          type="button"
          className="hover:bg-white/20 rounded-full bg-white/10 p-2 text-white transition-colors"
          onClick={(e) => {
            e.stopPropagation()
            onDownload(node)
          }}
          title="download"
          aria-label="download"
        >
          <DownloadIcon className="size-4" />
        </button>
        <button
          type="button"
          className="hover:bg-white/20 rounded-full bg-white/10 p-2 text-white transition-colors"
          onClick={onClose}
          title="close"
          aria-label="close"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div onClick={(e) => e.stopPropagation()}>{body}</div>
    </div>
  )
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        const tok = localStorage.getItem('token') ?? ''
        const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })
        const tx = await res.text()
        setText(tx.slice(0, 500_000))
      } catch {
        setText('(unable to load preview)')
      }
    })()
  }, [url])
  return (
    <pre className="bg-card text-foreground border-border max-h-[80vh] max-w-[80vw] overflow-auto rounded-lg border p-4 font-mono text-xs whitespace-pre-wrap shadow-xl">
      {text ?? 'Loading…'}
    </pre>
  )
}

// ---------- name dialog (used for new folder + rename) ----------

function NameDialog({
  initial = '',
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: string
  placeholder?: string
  submitLabel: string
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial)
  const valid = name.trim().length > 0 && name !== initial
  return (
    <div className="space-y-4">
      <input
        autoFocus
        placeholder={placeholder}
        className="border-input bg-background focus-visible:ring-ring h-10 w-full rounded-md border px-3 text-sm transition-colors outline-none focus-visible:ring-1"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && valid) onSubmit(name.trim())
          if (e.key === 'Escape') onCancel()
        }}
      />
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          <T name="cancel" />
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => onSubmit(name.trim())}
          disabled={!valid}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}

// ---------- share dialog ----------

function ShareDialog({
  node,
  onClose,
  lang,
}: {
  node: DriveNode
  onClose: () => void
  lang: 'en' | 'zh'
}) {
  const [withPassword, setWithPassword] = useState(false)
  const [pw, setPw] = useState('')
  const [show, setShow] = useState(false)
  const [exp, setExp] = useState<'1' | '7' | '30' | 'never'>('never')
  const [created, setCreated] = useState<{ url: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (withPassword && pw.length < 4) {
      setErr(t('passwordTooShort', lang))
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const expiresAt =
        exp === 'never' ? null : Date.now() + Number(exp) * 24 * 60 * 60 * 1000
      const sh = await createShare(node.id, withPassword ? pw : null, expiresAt)
      setCreated({ url: sh.url ?? '' })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!created) return
    await navigator.clipboard.writeText(created.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (created) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">{t('linkReady', lang)}</p>
        <div className="flex items-stretch gap-2">
          <input
            readOnly
            value={created.url}
            className="border-input bg-background focus-visible:ring-ring h-10 flex-1 rounded-md border px-3 text-sm focus-visible:ring-1"
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <Button
            variant={copied ? 'secondary' : 'primary'}
            size="sm"
            onClick={() => void copy()}
            title={t('copy', lang)}
          >
            {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
          </Button>
        </div>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            <T name="done" />
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <Checkbox
          checked={withPassword}
          onChange={() => setWithPassword((v) => !v)}
          title={t('requirePassword', lang)}
        />
        <T name="requirePassword" />
      </label>

      {withPassword && (
        <div className="relative">
          <input
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder={t('password', lang)}
            className="border-input bg-background focus-visible:ring-ring h-10 w-full rounded-md border px-3 pr-10 text-sm focus-visible:ring-1"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 p-1"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? t('hidePassword', lang) : t('showPassword', lang)}
            title={show ? t('hidePassword', lang) : t('showPassword', lang)}
          >
            {show ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
          </button>
        </div>
      )}

      <div>
        <label className="text-muted-foreground mb-1 block text-xs">
          <T name="expires" />
        </label>
        <select
          className="border-input bg-background focus-visible:ring-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-1"
          value={exp}
          onChange={(e) => setExp(e.target.value as typeof exp)}
        >
          <option value="1">{t('day1', lang)}</option>
          <option value="7">{t('day7', lang)}</option>
          <option value="30">{t('day30', lang)}</option>
          <option value="never">{t('never', lang)}</option>
        </select>
      </div>

      {err && <p className="text-destructive text-xs">{err}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>
          <T name="cancel" />
        </Button>
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={busy}>
          <T name="createLink" />
        </Button>
      </div>
    </div>
  )
}

// ---------- move dialog ----------

interface MoveNode {
  id: number
  name: string
  expanded: boolean
  loaded: boolean
  children: MoveNode[]
}

function MoveDialog({
  movingIDs,
  currentParentID,
  onSelect,
  onCancel,
}: {
  movingIDs: Set<number>
  currentParentID: number | null
  onSelect: (target: number | null) => void
  onCancel: () => void
}) {
  const [tree, setTree] = useState<MoveNode[]>([])
  const [target, setTarget] = useState<number | null>(currentParentID)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const rows = await list(null)
        setTree(
          rows
            .filter((n) => n.type === 'folder' && !movingIDs.has(n.id))
            .map((n) => ({
              id: n.id,
              name: n.name,
              expanded: false,
              loaded: false,
              children: [],
            })),
        )
        setLoaded(true)
      } catch (err) {
        toast.error((err as Error).message)
      }
    })()
  }, [movingIDs])

  const expand = async (n: MoveNode) => {
    if (n.loaded) {
      n.expanded = !n.expanded
      setTree([...tree])
      return
    }
    try {
      const rows = await list(n.id)
      n.children = rows
        .filter((r) => r.type === 'folder' && !movingIDs.has(r.id))
        .map((r) => ({
          id: r.id,
          name: r.name,
          expanded: false,
          loaded: false,
          children: [],
        }))
      n.loaded = true
      n.expanded = true
      setTree([...tree])
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setTarget(null)}
        className={cx(
          'hover:bg-accent flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
          target === null ? 'bg-accent text-accent-foreground' : undefined,
        )}
      >
        <FolderOpenIcon className="text-primary size-4" />
        <T name="myDrive" />
      </button>
      <div className="border-border/60 max-h-72 overflow-auto rounded-md border p-1">
        {!loaded ? (
          <div className="text-muted-foreground p-3 text-sm">…</div>
        ) : (
          tree.map((n) => (
            <TreeNode
              key={n.id}
              node={n}
              depth={0}
              target={target}
              onSelect={setTarget}
              onExpand={expand}
            />
          ))
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          <T name="cancel" />
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || target === currentParentID}
          onClick={async () => {
            setBusy(true)
            try {
              await onSelect(target)
            } finally {
              setBusy(false)
            }
          }}
        >
          <T name="moveHere" />
        </Button>
      </div>
    </div>
  )
}

function TreeNode({
  node,
  depth,
  target,
  onSelect,
  onExpand,
}: {
  node: MoveNode
  depth: number
  target: number | null
  onSelect: (id: number) => void
  onExpand: (n: MoveNode) => void
}) {
  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        className={cx(
          'hover:bg-accent flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
          target === node.id ? 'bg-accent text-accent-foreground' : undefined,
        )}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        <span
          role="button"
          aria-label="expand"
          tabIndex={-1}
          className="hover:bg-background/60 -m-1 inline-flex size-5 items-center justify-center rounded p-1"
          onClick={(e) => {
            e.stopPropagation()
            void onExpand(node)
          }}
        >
          <ChevronRightIcon
            className={cx(
              'size-3 transition-transform',
              node.expanded ? 'rotate-90' : undefined,
            )}
          />
        </span>
        <FolderIcon className="text-primary fill-primary/15 size-4" />
        <span className="flex-1 truncate">{node.name}</span>
      </button>
      {node.expanded &&
        node.children.map((c) => (
          <TreeNode
            key={c.id}
            node={c}
            depth={depth + 1}
            target={target}
            onSelect={onSelect}
            onExpand={onExpand}
          />
        ))}
    </div>
  )
}

// ---------- upload dock ----------

function useUploads(): UploadItem[] {
  return useSyncExternalStore(
    (cb) => uploadManager.subscribe(cb),
    () => uploadsSnapshot,
    () => [],
  )
}

let uploadsSnapshot: UploadItem[] = []
uploadManager.subscribe((items) => {
  uploadsSnapshot = items
})

function UploadDock({
  onRefresh,
  lang,
}: {
  onRefresh: () => Promise<void> | void
  lang: 'en' | 'zh'
}) {
  const items = useUploads()
  const [collapsed, setCollapsed] = useState(false)
  if (items.length === 0) return null

  const active = items.filter((i) => i.status === 'uploading' || i.status === 'pending').length

  return (
    <div className="border-border bg-popover text-popover-foreground fixed right-4 bottom-4 z-30 w-80 animate-[fadeIn_160ms_ease-out] rounded-xl border shadow-xl">
      <div className="border-border/60 flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">
          {active > 0 ? t('uploading', lang, true, String(active)) : t('uploads', lang)}
        </span>
        <div className="flex gap-0.5">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground rounded p-1 text-xs transition-colors"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? t('expand', lang) : t('collapse', lang)}
            aria-label={collapsed ? t('expand', lang) : t('collapse', lang)}
          >
            <ChevronRightIcon className={cx('size-4', collapsed ? '-rotate-90' : 'rotate-90')} />
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground rounded p-1 transition-colors"
            onClick={() => uploadManager.clearDone()}
            title={t('clear', lang)}
            aria-label={t('clear', lang)}
          >
            <XIcon className="size-4" />
          </button>
        </div>
      </div>
      {!collapsed && (
        <ul className="max-h-72 overflow-auto">
          {items.map((it) => (
            <UploadRow key={it.id} item={it} onRefresh={onRefresh} lang={lang} />
          ))}
        </ul>
      )}
    </div>
  )
}

function UploadRow({
  item,
  onRefresh,
  lang,
}: {
  item: UploadItem
  onRefresh: () => Promise<void> | void
  lang: 'en' | 'zh'
}) {
  const pct = item.size > 0 ? Math.round((item.loaded / item.size) * 100) : 0

  const resolve = async (policy: CollisionPolicy) => {
    await uploadManager.resolveConflict(
      item.id,
      policy === 'ask' ? 'rename' : (policy as 'overwrite' | 'rename' | 'skip'),
    )
    await onRefresh()
  }

  return (
    <li className="border-border/60 px-3 py-2 text-xs last:border-0 [&:not(:last-child)]:border-b">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{item.name}</span>
        <span className="text-muted-foreground shrink-0">{humanSize(item.size)}</span>
      </div>
      {item.status === 'uploading' && (
        <div className="bg-muted mt-1.5 h-1 overflow-hidden rounded-full">
          <div
            className="bg-primary h-full transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <div className="text-muted-foreground mt-1 flex items-center justify-between text-[11px]">
        <span>{statusLabel(item, lang)}</span>
        {item.status === 'uploading' && (
          <button
            type="button"
            onClick={() => uploadManager.cancel(item.id)}
            className="hover:text-destructive transition-colors"
            title={t('cancel', lang)}
          >
            <T name="cancel" />
          </button>
        )}
      </div>
      {item.status === 'conflict' && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            onClick={() => void resolve('rename')}
          >
            <T name="keepBoth" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            onClick={() => void resolve('overwrite')}
          >
            <T name="replace" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => void resolve('skip')}
          >
            <T name="skip" />
          </Button>
        </div>
      )}
    </li>
  )
}

function statusLabel(i: UploadItem, lang: 'en' | 'zh'): string {
  switch (i.status) {
    case 'pending':
      return t('queued', lang)
    case 'uploading':
      return `${Math.round((i.loaded / Math.max(i.size, 1)) * 100)}%`
    case 'done':
      return t('done', lang)
    case 'cancelled':
      return t('cancel', lang)
    case 'failed':
      return i.error ?? 'failed'
    case 'conflict':
      return t('namingExists', lang)
  }
}
