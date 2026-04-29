import {
  ArrowLeftIcon,
  FolderPlusIcon,
  LayoutGridIcon,
  ListIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react'
import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { useConfirm } from '@/components/confirm.tsx'
import { useModal } from '@/components/modal.tsx'
import { useStableNavigate } from '@/components/router.tsx'
import { T, t, useLang } from '@/components/translation.tsx'

import {
  DriveBreadcrumb,
  DriveNode,
  breadcrumbs,
  createFolder,
  deleteNodes,
  downloadURL,
  downloadZipURL,
  list,
  moveNodes,
  purgeNodes,
  renameNode,
  restoreNode,
  search,
  trash,
} from './api'
import { MoveDialog, NameDialog, ShareDialog } from './dialogs'
import { Breadcrumbs, RowAction, SearchBox, SelectionBar } from './parts'
import { PreviewModal } from './preview'
import { UploadDock } from './upload-dock'
import { uploadManager } from './upload-manager'
import { EmptyState, GridView, ListView, TrashView } from './views'

type ViewMode = 'list' | 'grid'

// Downloads (`window.location.href = …`) and PhotoSwipe images depend on cookie
// auth; sync from localStorage on mount in case the cookie has expired.
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

  // ---- selection ----------------------------------------------------------

  const toggle = useCallback((id: number, additive: boolean) => {
    setSelected((s) => {
      if (additive) {
        const next = new Set(s)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }
      // Plain click: if already the only selected one, clear; else single-select.
      if (s.size === 1 && s.has(id)) return new Set()
      return new Set([id])
    })
  }, [])

  const list_ = showTrash ? trashItems : items

  const toggleAll = useCallback(() => {
    setSelected((s) =>
      s.size === list_.length ? new Set() : new Set(list_.map((n) => n.id)),
    )
  }, [list_])

  const clearSelection = useCallback(() => setSelected(new Set()), [])

  // ---- uploads ------------------------------------------------------------

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

  // ---- mutations ----------------------------------------------------------

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
      const n = list_.find((x) => x.id === id)
      if (n) downloadOne(n)
    })
  }

  // ---- navigation ---------------------------------------------------------

  const goTo = useCallback((id: number | null) => {
    setShowTrash(false)
    setQuery('')
    setParentID(id)
  }, [])

  const open = useCallback(
    (n: DriveNode, idx: number) => {
      if (n.type === 'folder') {
        setQuery('')
        setParentID(n.id)
        return
      }
      setPreviewIdx(idx)
    },
    [],
  )

  const onAction = useCallback(
    (action: RowAction, n: DriveNode) => {
      if (action === 'download') downloadOne(n)
      else if (action === 'rename') handleRename(n)
      else if (action === 'share') handleShare(n)
      else if (action === 'move') handleMove([n.id])
      else if (action === 'delete') handleDelete([n.id])
    },
    // handlers are recreated each render; they capture parentID/query/showTrash
    // through `refresh`, but those reads are fine as long as we don't memoise
    // the callback against stale state — accept the rerender cost on toolbar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parentID, lang],
  )

  // ---- render -------------------------------------------------------------

  return (
    <div
      className={cx(
        'bg-background text-foreground relative flex h-screen flex-col',
        dragOver
          ? 'after:ring-primary/50 after:bg-primary/5 after:pointer-events-none after:absolute after:inset-2 after:rounded-2xl after:ring-2 after:ring-inset'
          : undefined,
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
          onCrumb={goTo}
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
        <div className="border-border/60 flex items-center gap-2 border-b px-4 py-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            title={t('upload', lang)}
            className="gap-1.5"
          >
            <UploadIcon className="size-4" />
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
            variant="ghost"
            size="sm"
            onClick={handleNewFolder}
            title={t('newFolder', lang)}
            className="gap-1.5"
          >
            <FolderPlusIcon className="size-4" />
            <T name="newFolder" />
          </Button>
          {selected.size > 0 && (
            <SelectionBar
              count={selected.size}
              onClear={clearSelection}
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
            onAction={onAction}
            onNavigateToParent={goTo}
            lang={lang}
          />
        ) : (
          <GridView
            items={list_}
            selected={selected}
            onToggle={toggle}
            onOpen={open}
            onAction={onAction}
            lang={lang}
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
