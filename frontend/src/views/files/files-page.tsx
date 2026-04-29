import {
  ChevronRightIcon,
  DownloadIcon,
  FileIcon,
  FileTextIcon,
  FilmIcon,
  FolderIcon,
  FolderPlusIcon,
  ImageIcon,
  MoreVerticalIcon,
  MusicIcon,
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
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import toast from 'react-hot-toast'

import { Button } from '@/components/button.tsx'
import { useStableNavigate } from '@/components/router.tsx'

import { cx } from '@/utils/css.ts'

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
  previewURL,
  purgeNodes,
  renameNode,
  restoreNode,
  search,
  trash,
} from './api'
import { uploadManager, UploadItem } from './upload-manager'

type ViewMode = 'list' | 'grid'

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
  const [previewNode, setPreviewNode] = useState<DriveNode | null>(null)
  const [shareNode, setShareNode] = useState<DriveNode | null>(null)
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const navigate = useStableNavigate()

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

  // Toggle selection.
  const toggle = (id: number, ev: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => {
    setSelected((s) => {
      const next = new Set(ev.shiftKey || ev.metaKey || ev.ctrlKey ? s : [])
      if (s.has(id) && (ev.shiftKey || ev.metaKey || ev.ctrlKey)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Open folder / preview file.
  const open = (n: DriveNode) => {
    if (n.type === 'folder') {
      setQuery('')
      setParentID(n.id)
      return
    }
    setPreviewNode(n)
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
    void onUploadFiles(e.dataTransfer.files)
  }

  const newFolder = async () => {
    const name = window.prompt('Folder name')?.trim()
    if (!name) return
    try {
      await createFolder(parentID, name)
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const removeSelected = async () => {
    if (selected.size === 0) return
    if (!window.confirm(`Move ${selected.size} item(s) to trash?`)) return
    await deleteNodes([...selected])
    await refresh()
  }

  const downloadSelected = () => {
    selected.forEach((id) => {
      const n = items.find((x) => x.id === id)
      if (!n) return
      const a = document.createElement('a')
      a.href = n.type === 'folder' ? downloadZipURL(id) : downloadURL(id)
      a.download = ''
      a.click()
    })
  }

  const list_ = showTrash ? trashItems : items

  return (
    <div
      className="flex h-screen flex-col bg-white text-zinc-900"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-zinc-200 px-4 py-3">
        <Button variant="ghost" onClick={() => navigate('/')} title="Back">
          <XIcon className="size-5" />
        </Button>
        <h1 className="text-lg font-semibold">Files</h1>
        <div className="ml-4 flex items-center gap-1 text-sm">
          <button
            className="text-zinc-600 hover:text-zinc-900"
            onClick={() => {
              setShowTrash(false)
              setParentID(null)
              setQuery('')
            }}
          >
            <FolderIcon className="mr-1 inline size-4" /> My Drive
          </button>
          {!showTrash &&
            crumbs.map((c) => (
              <span key={c.id} className="flex items-center text-zinc-600">
                <ChevronRightIcon className="size-3" />
                <button
                  className="hover:text-zinc-900"
                  onClick={() => setParentID(c.id)}
                >
                  {c.name}
                </button>
              </span>
            ))}
          {showTrash && (
            <span className="flex items-center text-zinc-600">
              <ChevronRightIcon className="size-3" />
              Trash
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <SearchIcon className="absolute top-2 left-2 size-4 text-zinc-400" />
            <input
              type="search"
              placeholder="Search"
              className="rounded-md border border-zinc-200 py-1.5 pr-3 pl-7 text-sm outline-none focus:border-zinc-400"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={showTrash}
            />
          </div>
          <Button variant="ghost" size="icon" onClick={() => setView(view === 'list' ? 'grid' : 'list')}>
            <span className="text-xs">{view === 'list' ? '▤' : '▥'}</span>
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setShowTrash(!showTrash)
              setSelected(new Set())
            }}
            title="Trash"
          >
            <Trash2Icon className="size-5" />
          </Button>
        </div>
      </header>

      {/* Toolbar */}
      {!showTrash && (
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2">
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            <UploadIcon className="mr-2 size-4" /> Upload
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
          <Button variant="outline" size="sm" onClick={newFolder}>
            <FolderPlusIcon className="mr-2 size-4" /> New folder
          </Button>
          {selected.size > 0 && (
            <>
              <span className="ml-3 text-sm text-zinc-500">{selected.size} selected</span>
              <Button variant="ghost" size="sm" onClick={downloadSelected}>
                <DownloadIcon className="mr-1 size-4" /> Download
              </Button>
              <Button variant="ghost" size="sm" onClick={removeSelected}>
                <Trash2Icon className="mr-1 size-4" /> Delete
              </Button>
            </>
          )}
        </div>
      )}

      {/* Listing */}
      <main className="flex-1 overflow-auto">
        {list_.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-400">
            {showTrash ? 'Trash is empty' : 'Drop files here or click Upload'}
          </div>
        ) : view === 'list' && !showTrash ? (
          <ListView
            items={list_}
            selected={selected}
            onToggle={toggle}
            onOpen={open}
            onAction={async (action, n) => {
              if (action === 'download') window.location.href = downloadURL(n.id)
              else if (action === 'zip') window.location.href = downloadZipURL(n.id)
              else if (action === 'rename') setRenaming({ id: n.id, name: n.name })
              else if (action === 'share') setShareNode(n)
              else if (action === 'delete') {
                await deleteNodes([n.id])
                await refresh()
              }
            }}
          />
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
            onPurge={async (id) => {
              if (!window.confirm('Permanently delete?')) return
              await purgeNodes([id])
              await refresh()
            }}
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

      {/* Upload dock */}
      <UploadDock onRefresh={refresh} />

      {/* Modals */}
      {previewNode && (
        <PreviewModal node={previewNode} onClose={() => setPreviewNode(null)} />
      )}
      {shareNode && (
        <ShareDialog node={shareNode} onClose={() => setShareNode(null)} />
      )}
      {renaming && (
        <RenameDialog
          name={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            try {
              await renameNode(renaming.id, name)
              setRenaming(null)
              await refresh()
            } catch (err) {
              toast.error((err as Error).message)
            }
          }}
        />
      )}
    </div>
  )
}

// ---------- list view ----------

interface ListViewProps {
  items: DriveNode[]
  selected: Set<number>
  onToggle: (id: number, ev: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => void
  onOpen: (n: DriveNode) => void
  onAction: (
    action: 'download' | 'zip' | 'rename' | 'share' | 'delete',
    n: DriveNode,
  ) => void | Promise<void>
}

function ListView({ items, selected, onToggle, onOpen, onAction }: ListViewProps) {
  return (
    <table className="w-full table-fixed text-sm">
      <thead className="sticky top-0 bg-white text-left text-xs text-zinc-500">
        <tr>
          <th className="w-12"></th>
          <th className="px-2 py-2">Name</th>
          <th className="w-32 px-2">Size</th>
          <th className="w-44 px-2">Modified</th>
          <th className="w-12"></th>
        </tr>
      </thead>
      <tbody>
        {items.map((n) => (
          <tr
            key={n.id}
            className={cx(
              'group cursor-default border-b border-zinc-100 hover:bg-zinc-50',
              selected.has(n.id) ? 'bg-zinc-100' : undefined,
            )}
            onClick={(e) => onToggle(n.id, e)}
            onDoubleClick={() => onOpen(n)}
          >
            <td className="px-3">
              <NodeIcon node={n} />
            </td>
            <td className="px-2 py-2 font-medium">
              <button
                className="text-left hover:underline"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpen(n)
                }}
              >
                {n.name}
              </button>
            </td>
            <td className="px-2 text-zinc-500">{humanSize(n.size)}</td>
            <td className="px-2 text-zinc-500">{new Date(n.updated_at).toLocaleString()}</td>
            <td className="px-2">
              <RowMenu node={n} onAction={onAction} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface GridViewProps {
  items: DriveNode[]
  selected: Set<number>
  onToggle: (id: number, ev: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => void
  onOpen: (n: DriveNode) => void
}

function GridView({ items, selected, onToggle, onOpen }: GridViewProps) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3 p-4">
      {items.map((n) => (
        <button
          key={n.id}
          className={cx(
            'flex flex-col items-center gap-1 rounded-lg border border-transparent p-3 text-center hover:border-zinc-200 hover:bg-zinc-50',
            selected.has(n.id) ? 'border-zinc-300 bg-zinc-100' : undefined,
          )}
          onClick={(e) => onToggle(n.id, e)}
          onDoubleClick={() => onOpen(n)}
        >
          <div className="size-12">
            <NodeIcon node={n} large />
          </div>
          <div className="line-clamp-2 text-xs">{n.name}</div>
          <div className="text-[10px] text-zinc-400">{humanSize(n.size)}</div>
        </button>
      ))}
    </div>
  )
}

interface TrashViewProps {
  items: DriveNode[]
  onRestore: (id: number) => void | Promise<void>
  onPurge: (id: number) => void | Promise<void>
}

function TrashView({ items, onRestore, onPurge }: TrashViewProps) {
  return (
    <ul className="divide-y divide-zinc-100">
      {items.map((n) => (
        <li key={n.id} className="flex items-center gap-3 px-4 py-2">
          <NodeIcon node={n} />
          <span className="flex-1 text-sm">{n.name}</span>
          <span className="text-xs text-zinc-400">
            {n.deleted_at ? new Date(n.deleted_at).toLocaleString() : ''}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void onRestore(n.id)}>
            <RotateCcwIcon className="mr-1 size-4" /> Restore
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void onPurge(n.id)}>
            <Trash2Icon className="mr-1 size-4" /> Delete
          </Button>
        </li>
      ))}
    </ul>
  )
}

function NodeIcon({ node, large }: { node: DriveNode; large?: boolean }) {
  const cls = large ? 'size-12 text-zinc-500' : 'size-5 text-zinc-500'
  if (node.type === 'folder') return <FolderIcon className={cx(cls, 'fill-zinc-100')} />
  const mt = node.mime_type ?? ''
  if (mt.startsWith('image/')) return <ImageIcon className={cls} />
  if (mt.startsWith('video/')) return <FilmIcon className={cls} />
  if (mt.startsWith('audio/')) return <MusicIcon className={cls} />
  if (mt.includes('text') || mt.includes('pdf')) return <FileTextIcon className={cls} />
  return <FileIcon className={cls} />
}

interface RowMenuProps {
  node: DriveNode
  onAction: (
    action: 'download' | 'zip' | 'rename' | 'share' | 'delete',
    n: DriveNode,
  ) => void | Promise<void>
}

function RowMenu({ node, onAction }: RowMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', fn)
    return () => document.removeEventListener('mousedown', fn)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        className="rounded p-1 opacity-0 hover:bg-zinc-200 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        <MoreVerticalIcon className="size-4" />
      </button>
      {open && (
        <div className="absolute top-7 right-0 z-10 w-44 rounded-md border border-zinc-200 bg-white shadow-lg">
          {node.type === 'file' && (
            <>
              <MenuItem onClick={() => void onAction('download', node)}>
                <DownloadIcon className="size-4" /> Download
              </MenuItem>
              <MenuItem onClick={() => void onAction('share', node)}>
                <Share2Icon className="size-4" /> Share link
              </MenuItem>
            </>
          )}
          {node.type === 'folder' && (
            <MenuItem onClick={() => void onAction('zip', node)}>
              <DownloadIcon className="size-4" /> Download as zip
            </MenuItem>
          )}
          <MenuItem onClick={() => void onAction('rename', node)}>Rename</MenuItem>
          <MenuItem onClick={() => void onAction('delete', node)} danger>
            <Trash2Icon className="size-4" /> Delete
          </MenuItem>
        </div>
      )}
    </div>
  )
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      className={cx(
        'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-50',
        danger ? 'text-red-600' : undefined,
      )}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}

// ---------- preview ----------

function PreviewModal({ node, onClose }: { node: DriveNode; onClose: () => void }) {
  const url = previewURL(node.id)
  const mt = node.mime_type ?? ''

  let body: ReactNode
  if (mt.startsWith('image/'))
    body = <img src={url} alt={node.name} className="max-h-[80vh] max-w-[80vw] object-contain" />
  else if (mt.startsWith('video/'))
    body = <video src={url} controls className="max-h-[80vh] max-w-[80vw]" />
  else if (mt.startsWith('audio/')) body = <audio src={url} controls />
  else if (mt === 'application/pdf')
    body = <iframe src={url} className="h-[85vh] w-[85vw]" title={node.name} />
  else body = <TextPreview url={url} />

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="absolute top-4 right-4 flex gap-2">
        <a
          href={downloadURL(node.id)}
          className="rounded bg-white/10 px-3 py-1 text-sm text-white hover:bg-white/20"
        >
          <DownloadIcon className="mr-1 inline size-4" /> Download
        </a>
        <button
          className="rounded bg-white/10 px-3 py-1 text-sm text-white hover:bg-white/20"
          onClick={onClose}
        >
          <XIcon className="size-5" />
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
        const token = localStorage.getItem('token') ?? ''
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        const t = await res.text()
        setText(t.slice(0, 500_000))
      } catch {
        setText('(unable to load preview)')
      }
    })()
  }, [url])
  return (
    <pre className="max-h-[80vh] max-w-[80vw] overflow-auto rounded bg-white p-4 text-xs text-zinc-800">
      {text ?? 'Loading…'}
    </pre>
  )
}

// ---------- share dialog ----------

function ShareDialog({ node, onClose }: { node: DriveNode; onClose: () => void }) {
  const [pw, setPw] = useState('')
  const [exp, setExp] = useState<'1' | '7' | '30' | 'never'>('never')
  const [created, setCreated] = useState<{ url: string; token: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      const expiresAt =
        exp === 'never' ? null : Date.now() + Number(exp) * 24 * 60 * 60 * 1000
      const sh = await createShare(node.id, pw || null, expiresAt)
      setCreated({ url: sh.url ?? '', token: sh.token ?? '' })
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[420px] rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold">Share “{node.name}”</h2>
        {created ? (
          <>
            <p className="mb-2 text-sm text-zinc-600">Anyone with this link can access the file:</p>
            <input
              readOnly
              value={created.url}
              className="w-full rounded border border-zinc-200 px-3 py-2 text-sm"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(created.url)
                  toast.success('Link copied')
                }}
              >
                Copy
              </Button>
              <Button variant="outline" size="sm" onClick={onClose}>
                Done
              </Button>
            </div>
          </>
        ) : (
          <>
            <label className="mb-1 block text-sm">Password (optional)</label>
            <input
              type="password"
              autoComplete="off"
              className="w-full rounded border border-zinc-200 px-3 py-2 text-sm"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
            <label className="mt-3 mb-1 block text-sm">Expires</label>
            <select
              className="w-full rounded border border-zinc-200 px-3 py-2 text-sm"
              value={exp}
              onChange={(e) => setExp(e.target.value as typeof exp)}
            >
              <option value="1">1 day</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="never">Never</option>
            </select>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={submit} disabled={busy}>
                Create link
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------- rename dialog ----------

function RenameDialog({
  name: initial,
  onClose,
  onSubmit,
}: {
  name: string
  onClose: () => void
  onSubmit: (name: string) => void | Promise<void>
}) {
  const [name, setName] = useState(initial)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[360px] rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-lg font-semibold">Rename</h2>
        <input
          autoFocus
          className="w-full rounded border border-zinc-200 px-3 py-2 text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void onSubmit(name)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void onSubmit(name)}
            disabled={!name.trim() || name === initial}
          >
            Save
          </Button>
        </div>
      </div>
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

function UploadDock({ onRefresh }: { onRefresh: () => Promise<void> | void }) {
  const items = useUploads()
  const [collapsed, setCollapsed] = useState(false)
  if (items.length === 0) return null

  const active = items.filter((i) => i.status === 'uploading' || i.status === 'pending').length

  return (
    <div className="fixed right-4 bottom-4 w-80 rounded-xl border border-zinc-200 bg-white shadow-xl">
      <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
        <span className="text-sm font-medium">
          {active > 0 ? `Uploading ${active}…` : 'Uploads'}
        </span>
        <div className="flex gap-1">
          <button
            className="text-xs text-zinc-500 hover:text-zinc-900"
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? '▲' : '▼'}
          </button>
          <button
            className="text-xs text-zinc-500 hover:text-zinc-900"
            onClick={() => uploadManager.clearDone()}
          >
            ✕
          </button>
        </div>
      </div>
      {!collapsed && (
        <ul className="max-h-72 overflow-auto">
          {items.map((it) => (
            <UploadRow key={it.id} item={it} onRefresh={onRefresh} />
          ))}
        </ul>
      )}
    </div>
  )
}

function UploadRow({
  item,
  onRefresh,
}: {
  item: UploadItem
  onRefresh: () => Promise<void> | void
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
    <li className="border-b border-zinc-100 px-3 py-2 text-xs last:border-0">
      <div className="flex items-center justify-between">
        <span className="truncate font-medium">{item.name}</span>
        <span className="text-zinc-400">{humanSize(item.size)}</span>
      </div>
      {item.status === 'uploading' && (
        <div className="mt-1 h-1 overflow-hidden rounded bg-zinc-100">
          <div className="h-full bg-zinc-700 transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500">
        <span>{statusLabel(item)}</span>
        {item.status === 'uploading' && (
          <button onClick={() => uploadManager.cancel(item.id)} className="hover:text-red-600">
            cancel
          </button>
        )}
      </div>
      {item.status === 'conflict' && (
        <div className="mt-2 flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void resolve('rename')}>
            Keep both
          </Button>
          <Button variant="outline" size="sm" onClick={() => void resolve('overwrite')}>
            Replace
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void resolve('skip')}>
            Skip
          </Button>
        </div>
      )}
    </li>
  )
}

function statusLabel(i: UploadItem): string {
  switch (i.status) {
    case 'pending':
      return 'queued'
    case 'uploading':
      return `${Math.round((i.loaded / Math.max(i.size, 1)) * 100)}%`
    case 'done':
      return 'done'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
      return i.error ?? 'failed'
    case 'conflict':
      return 'name exists — choose action'
  }
}
