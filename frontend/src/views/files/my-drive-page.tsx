import {
  FolderPlusIcon,
  LayoutGridIcon,
  ListIcon,
  SearchIcon,
  UploadIcon,
} from 'lucide-react'
import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useSearchParams } from 'react-router'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { useConfirm } from '@/components/confirm.tsx'
import { useModal } from '@/components/modal.tsx'
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
  renameNode,
  search,
} from './api'
import { MoveDialog, NameDialog, ShareDialog } from './dialogs'
import { useIsMobile, useRefreshOnUploadComplete, useSelection, useSort } from './hooks'
import { TopBar } from './layout'
import { Breadcrumbs, RowAction, SearchBox, SelectionBar } from './parts'
import { PreviewModal } from './preview'
import { uploadManager } from './upload-manager'
import { useShortcuts } from './use-shortcuts'
import { EmptyState, GridView, ListView } from './views'

type ViewMode = 'list' | 'grid'

export function MyDrivePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const parentID = useMemo(() => {
    const p = searchParams.get('p')
    if (!p) return null
    const n = Number(p)
    return Number.isFinite(n) ? n : null
  }, [searchParams])

  const [items, setItems] = useState<DriveNode[]>([])
  const [crumbs, setCrumbs] = useState<DriveBreadcrumb[]>([])
  const [view, setView] = useState<ViewMode>(
    (localStorage.getItem('drive_view') as ViewMode) || 'list',
  )
  const [query, setQuery] = useState('')
  const [previewIdx, setPreviewIdx] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  const { sortKey, sortDir, onSort } = useSort()
  const { selected, toggle, toggleAll, clear } = useSelection(items)
  const isMobile = useIsMobile()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const confirm = useConfirm()
  const modal = useModal()
  const { lang } = useLang()

  const refresh = useCallback(async () => {
    if (query.trim()) {
      setItems(await search(query.trim()))
    } else {
      setItems(await list(parentID, sortKey, sortDir))
    }
    setCrumbs(parentID == null ? [] : await breadcrumbs(parentID))
    clear()
  }, [parentID, query, sortKey, sortDir, clear])

  useEffect(() => {
    void refresh().catch((err: Error) => toast.error(err.message))
  }, [refresh])

  useRefreshOnUploadComplete(() => {
    void refresh().catch(() => {})
  })

  useEffect(() => {
    localStorage.setItem('drive_view', view)
  }, [view])

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])

  // ---- uploads ------------------------------------------------------------

  const onUploadFiles = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || files.length === 0) return
      // Fire uploads concurrently so the dock reflects all queued files at
      // once (the upload manager itself caps per-file chunk concurrency).
      // Otherwise users see a permanent "uploading 1…" because await-in-loop
      // serializes everything.
      await Promise.all(
        Array.from(files).map((f) => uploadManager.add(f, parentID, 'ask')),
      )
      // The upload-completion hook handles refresh; nothing else to do here.
    },
    [parentID],
  )

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    void onUploadFiles(e.dataTransfer.files)
  }

  // Paste-to-upload: when the user pastes files (or images from the
  // clipboard) anywhere on the page that isn't an editable field, treat the
  // paste as an upload. Skips when the active element is an input/textarea/
  // contenteditable so paste in the search box still works as expected.
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          target.isContentEditable
        ) {
          return
        }
      }
      const files = e.clipboardData?.files
      if (!files || files.length === 0) return
      e.preventDefault()
      void onUploadFiles(files)
    }
    document.addEventListener('paste', handler)
    return () => document.removeEventListener('paste', handler)
  }, [onUploadFiles])

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

  // ---- navigation ---------------------------------------------------------

  const goTo = useCallback(
    (id: number | null) => {
      setQuery('')
      setSearchParams(id == null ? {} : { p: String(id) })
    },
    [setSearchParams],
  )

  const open = useCallback(
    (n: DriveNode, idx: number) => {
      if (n.type === 'folder') {
        goTo(n.id)
        return
      }
      setPreviewIdx(idx)
    },
    [goTo],
  )

  const onAction = useCallback(
    (action: RowAction, n: DriveNode) => {
      if (action === 'download') downloadOne(n)
      else if (action === 'rename') handleRename(n)
      else if (action === 'share') handleShare(n)
      else if (action === 'move') handleMove([n.id])
      else if (action === 'delete') handleDelete([n.id])
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parentID, lang],
  )

  // ---- shortcuts ----------------------------------------------------------

  // Parent of the current folder = next-to-last crumb (or root if at depth 1).
  const parentOfCurrent = useMemo<number | null>(() => {
    if (parentID == null || crumbs.length === 0) return null
    return crumbs.length >= 2 ? crumbs[crumbs.length - 2].id : null
  }, [parentID, crumbs])

  useShortcuts({
    'mod+ArrowUp': {
      run: () => goTo(parentOfCurrent),
      when: () => parentID != null,
    },
    enter: {
      run: () => {
        if (selected.size !== 1) return
        const id = [...selected][0]
        const idx = items.findIndex((n) => n.id === id)
        if (idx >= 0) open(items[idx], idx)
      },
      when: () => selected.size === 1,
    },
    escape: {
      run: () => {
        // Cascade: blur search → clear query → clear selection.
        if (document.activeElement === searchRef.current) {
          searchRef.current?.blur()
          return
        }
        if (query) {
          setQuery('')
          return
        }
        if (selected.size > 0) clear()
      },
    },
    '/': {
      run: () => searchRef.current?.focus(),
    },
    'mod+a': {
      run: () => toggleAll(),
      when: () => items.length > 0,
    },
    backspace: {
      run: () => handleDelete([...selected]),
      when: () => selected.size > 0,
    },
    delete: {
      run: () => handleDelete([...selected]),
      when: () => selected.size > 0,
    },
  })

  return (
    <div
      className={cx(
        'flex flex-1 flex-col',
        dragOver
          ? 'after:ring-primary/50 after:bg-primary/5 after:pointer-events-none after:absolute after:inset-2 after:rounded-2xl after:ring-2 after:ring-inset'
          : undefined,
      )}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      <TopBar
        lang={lang}
        middle={
          <Breadcrumbs
            crumbs={crumbs}
            onRoot={() => goTo(null)}
            onCrumb={goTo}
            isTrash={false}
            lang={lang}
          />
        }
        extra={
          <>
            {/* On mobile the search collapses behind an icon button to keep
                the second header row compact; PC always shows the input.
                Use conditional render rather than .hidden so the button is
                fully removed (avoids subtle stacking with the input icon). */}
            {!searchOpen && (
              <Button
                variant="ghost"
                size="icon"
                className="size-9 md:hidden"
                onClick={() => setSearchOpen(true)}
                aria-label={t('search', lang)}
                title={t('search', lang)}
              >
                <SearchIcon className="size-4" />
              </Button>
            )}
            <SearchBox
              value={query}
              onChange={setQuery}
              placeholder={t('search', lang)}
              inputRef={searchRef}
              className={cx(
                'min-w-0 flex-1 md:flex-initial',
                searchOpen ? '' : 'hidden md:block',
              )}
              onBlur={() => {
                if (!query) setSearchOpen(false)
              }}
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
          </>
        }
      />

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
            onClear={clear}
            onDownload={downloadSelected}
            onMove={() => handleMove([...selected])}
            onDelete={() => handleDelete([...selected])}
            lang={lang}
            floating={isMobile}
          />
        )}
      </div>

      <main className="flex-1 overflow-x-hidden overflow-y-auto">
        {items.length === 0 ? (
          <EmptyState trash={false} lang={lang} />
        ) : view === 'list' ? (
          <ListView
            items={items}
            selected={selected}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onOpen={open}
            onAction={onAction}
            onNavigateToParent={goTo}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
            lang={lang}
            isMobile={isMobile}
          />
        ) : (
          <GridView
            items={items}
            selected={selected}
            onToggle={toggle}
            onOpen={open}
            onAction={onAction}
            lang={lang}
          />
        )}
      </main>

      {previewIdx != null && (
        <PreviewModal
          items={items}
          index={previewIdx}
          onClose={() => setPreviewIdx(null)}
          onDownload={downloadOne}
        />
      )}
    </div>
  )
}
