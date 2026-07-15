import {
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderUpIcon,
  LayoutGridIcon,
  ListIcon,
  SearchIcon,
  StarIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from 'lucide-react'
import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useSearchParams } from 'react-router'

import { cx } from '@/utils/css.ts'
import { useShortcuts } from '@/utils/hooks/use-shortcuts.ts'

import { Button } from '@/components/button.tsx'
import { useConfirm } from '@/components/confirm.tsx'
import { MenuItem, MenuList, MenuSeparator } from '@/components/menu.tsx'
import { useModal } from '@/components/modal.tsx'
import { T, t, useLang } from '@/components/translation.tsx'

import {
  DriveBreadcrumb,
  DriveNode,
  breadcrumbs,
  copyNodes,
  createFolder,
  deleteNodes,
  ensureFolderPath,
  downloadURL,
  downloadZipNodesURL,
  downloadZipURL,
  list,
  moveNodes,
  renameNode,
  search,
  setStarred,
} from './api'
import { ContextMenu, useContextMenu } from './context-menu'
import { MoveDialog, NameDialog, ShareDialog } from './dialogs'
import {
  useIsMobile,
  useRefreshOnUploadComplete,
  useSelection,
  useShowDotFiles,
  useSort,
} from './hooks'
import { TopBar } from './layout'
import { Breadcrumbs, NodeMenuItems, RowAction, SearchBox, SelectionBar } from './parts'
import { PreviewModal } from './preview'
import { uploadManager } from './upload-manager'
import { EmptyState, GridView, ListView, SearchEmptyState } from './views'

// Payload for the desktop right-click menu: a single node, the whole
// multi-selection, or the empty canvas.
type CtxPayload = { kind: 'node'; node: DriveNode } | { kind: 'selection' } | { kind: 'empty' }

// ---- folder upload helpers --------------------------------------------------

interface UploadEntry {
  file: File
  relDir?: string
}

// Guard against accidental drops of giant trees.
const MAX_UPLOAD_ENTRIES = 2000

// "/photos/2024/img.jpg" → "photos/2024"
function parentDirOf(fullPath: string): string {
  const p = fullPath.replace(/^\//, '')
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

// Recursively walk dropped FileSystemEntry trees. Chrome's readEntries
// returns at most ~100 entries per call — loop until an empty batch. Empty
// directories are reported separately so the tree structure is preserved.
async function traverseEntries(
  entries: FileSystemEntry[],
): Promise<{ files: UploadEntry[]; emptyDirs: string[] }> {
  const files: UploadEntry[] = []
  const emptyDirs: string[] = []

  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        ;(entry as FileSystemFileEntry).file(resolve, reject)
      })
      const relDir = parentDirOf(entry.fullPath)
      files.push({ file, relDir: relDir || undefined })
      return
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      let any = false
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
          reader.readEntries(resolve, reject)
        })
        if (batch.length === 0) break
        any = true
        for (const child of batch) await walk(child)
      }
      if (!any) emptyDirs.push(entry.fullPath.replace(/^\//, ''))
    }
  }

  for (const e of entries) await walk(e)
  return { files, emptyDirs }
}

// Folder-picker files carry webkitRelativePath ("root/sub/file.txt").
function entriesFromFileList(files: FileList | null): UploadEntry[] {
  if (!files) return []
  return Array.from(files).map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? ''
    const relDir = parentDirOf(rel)
    return { file, relDir: relDir || undefined }
  })
}

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
  const { showDotFiles, toggleShowDotFiles } = useShowDotFiles()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const confirm = useConfirm()
  const modal = useModal()
  const { lang } = useLang()

  // Derived: items with dotfiles filtered out when showDotFiles is false.
  // Used for rendering and selection so toggleAll operates only on visible items.
  const visibleItems = useMemo(
    () => (showDotFiles ? items : items.filter((n) => !n.name.startsWith('.'))),
    [items, showDotFiles],
  )

  const { selected, setSelected, toggle, toggleAll, clear } = useSelection(visibleItems)
  const isMobile = useIsMobile()
  const ctxMenu = useContextMenu<CtxPayload>()

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

  // ---- dotfiles toggle --------------------------------------------------------

  const handleToggleDotFiles = useCallback(() => {
    toggleShowDotFiles()
    setPreviewIdx(null)
    toast(t(showDotFiles ? 'dotFilesHidden' : 'dotFilesShown', lang))
  }, [toggleShowDotFiles, showDotFiles, lang])

  // ---- uploads ------------------------------------------------------------

  const onUploadEntries = useCallback(
    async (entries: UploadEntry[]) => {
      if (entries.length === 0) return
      if (entries.length > MAX_UPLOAD_ENTRIES) {
        toast.error(t('tooManyFiles', lang, true, String(MAX_UPLOAD_ENTRIES)))
        return
      }
      // Fire uploads concurrently so the dock reflects the whole queue at
      // once; the manager itself caps how many files upload simultaneously
      // (and chunk concurrency per file).
      await Promise.all(
        entries.map(({ file, relDir }) => uploadManager.add(file, parentID, 'ask', relDir)),
      )
      // The upload-completion hook handles refresh; nothing else to do here.
    },
    [parentID, lang],
  )

  const onUploadFiles = useCallback(
    (files: FileList | File[] | null) => {
      if (!files || files.length === 0) return Promise.resolve()
      return onUploadEntries(Array.from(files).map((file) => ({ file })))
    },
    [onUploadEntries],
  )

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    // Prefer the entries API (directory support); fall back to plain files.
    const items = e.dataTransfer.items
    const entries: FileSystemEntry[] = []
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.()
        if (entry) entries.push(entry)
      }
    }
    if (entries.length > 0) {
      void (async () => {
        try {
          const { files, emptyDirs } = await traverseEntries(entries)
          if (emptyDirs.length > 0) {
            await Promise.all(emptyDirs.map((d) => ensureFolderPath(parentID, d)))
            if (files.length === 0) await refresh()
          }
          await onUploadEntries(files)
        } catch (err) {
          toast.error((err as Error).message)
        }
      })()
      return
    }
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

  const handleCopy = (ids: number[]) => {
    modal.open({
      heading: t('copyTo', lang),
      headingVisible: true,
      content: (
        <MoveDialog
          movingIDs={new Set(ids)}
          currentParentID={parentID}
          allowCurrent
          submitLabel={<T name="copyHere" />}
          onCancel={() => modal.close()}
          onSelect={async (target) => {
            try {
              const created = await copyNodes(ids, target)
              modal.close()
              toast.success(t('copiedItems', lang, true, String(created.length)))
              await refresh()
            } catch (err) {
              toast.error((err as Error).message)
            }
          }}
        />
      ),
    })
  }

  const handleDuplicate = async (n: DriveNode) => {
    try {
      await copyNodes([n.id], n.parent_id ?? null)
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const handleStar = async (ids: number[], starred: boolean) => {
    try {
      await setStarred(ids, starred)
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    }
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
    const sel = [...selected]
    if (sel.length === 1) {
      const n = items.find((x) => x.id === sel[0])
      if (n) downloadOne(n)
      return
    }
    // One request: the server streams the whole selection as a single zip.
    const a = document.createElement('a')
    a.href = downloadZipNodesURL(sel)
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
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
      else if (action === 'copy') handleCopy([n.id])
      else if (action === 'duplicate') void handleDuplicate(n)
      else if (action === 'star') void handleStar([n.id], true)
      else if (action === 'unstar') void handleStar([n.id], false)
      else if (action === 'delete') handleDelete([n.id])
    },
    [parentID, lang],
  )

  // ---- context menu (desktop only) ----------------------------------------

  const handleNodeCtx = useCallback(
    (e: React.MouseEvent, n: DriveNode) => {
      // Right-click inside a multi-selection acts on the selection; anywhere
      // else it first single-selects the node under the cursor.
      if (selected.size > 1 && selected.has(n.id)) {
        ctxMenu.openAt(e, { kind: 'selection' })
        return
      }
      if (!selected.has(n.id)) setSelected(new Set([n.id]))
      ctxMenu.openAt(e, { kind: 'node', node: n })
    },
    [selected, setSelected, ctxMenu],
  )
  const nodeCtxHandler = isMobile ? undefined : handleNodeCtx

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
    'mod+.': {
      run: handleToggleDotFiles,
    },
  })

  return (
    <div
      className={cx(
        'flex min-h-0 flex-1 flex-col',
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
            onSecretActivate={handleToggleDotFiles}
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
            <Button
              variant="ghost"
              size="icon"
              className="size-9 md:hidden"
              onClick={handleNewFolder}
              aria-label={t('newFolder', lang)}
              title={t('newFolder', lang)}
            >
              <FolderPlusIcon className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleNewFolder}
              title={t('newFolder', lang)}
              className="gap-1.5 rounded-lg max-md:hidden"
            >
              <FolderPlusIcon className="size-4" />
              <T name="newFolder" />
            </Button>
            {/* Folder upload is desktop-only (mobile browsers lack directory pickers). */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => folderInputRef.current?.click()}
              title={t('uploadFolder', lang)}
              aria-label={t('uploadFolder', lang)}
              className="rounded-lg px-2.5 max-md:hidden"
            >
              <FolderUpIcon className="size-4" />
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              title={t('upload', lang)}
              className="gap-1.5 rounded-lg max-md:hidden"
            >
              <UploadIcon className="size-4" />
              <T name="upload" />
            </Button>
          </>
        }
      />

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
      {/* Folder picker (Chromium/WebKit): files arrive flat but each carries
          webkitRelativePath, which the upload manager maps back to folders. */}
      <input
        type="file"
        multiple
        hidden
        ref={folderInputRef}
        {...({ webkitdirectory: '' } as object)}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          void onUploadEntries(entriesFromFileList(e.target.files))
          e.target.value = ''
        }}
      />

      {/* 上传是移动端的高频入口：右下角 FAB（桌面在顶栏） */}
      <Button
        variant="primary"
        className="fixed right-5 bottom-6 z-30 size-13 rounded-full! p-0! shadow-[0_6px_20px_-4px_hsl(var(--primary)/0.55),0_2px_8px_hsl(var(--foreground)/0.15)] md:hidden"
        aria-label={t('upload', lang)}
        title={t('upload', lang)}
        onClick={() => fileInputRef.current?.click()}
      >
        <UploadIcon className="size-5" />
      </Button>

      {selected.size > 0 && (
        <SelectionBar
          count={selected.size}
          onClear={clear}
          onDownload={downloadSelected}
          onMove={() => handleMove([...selected])}
          onCopy={() => handleCopy([...selected])}
          onDelete={() => handleDelete([...selected])}
          lang={lang}
          floating
        />
      )}

      <main
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-20 md:pb-0"
        onContextMenu={
          isMobile
            ? undefined
            : (e) => {
                // Row handlers stop propagation; anything that bubbles up
                // here was a right-click on empty canvas.
                ctxMenu.openAt(e, { kind: 'empty' })
              }
        }
      >
        {visibleItems.length === 0 ? (
          query.trim() ? (
            <SearchEmptyState query={query.trim()} lang={lang} />
          ) : (
            <EmptyState trash={false} lang={lang} />
          )
        ) : view === 'list' ? (
          <ListView
            items={visibleItems}
            selected={selected}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onOpen={open}
            onAction={onAction}
            onNavigateToParent={goTo}
            onContextMenu={nodeCtxHandler}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
            lang={lang}
            showDotFiles={showDotFiles}
          />
        ) : (
          <GridView
            items={visibleItems}
            selected={selected}
            onToggle={toggle}
            onOpen={open}
            onAction={onAction}
            onContextMenu={nodeCtxHandler}
            lang={lang}
            showDotFiles={showDotFiles}
          />
        )}
      </main>

      {previewIdx != null && (
        <PreviewModal
          items={visibleItems}
          index={previewIdx}
          onClose={() => setPreviewIdx(null)}
          onDownload={downloadOne}
        />
      )}

      <ContextMenu menu={ctxMenu}>
        {ctxMenu.payload?.kind === 'node' &&
          (() => {
            const n = ctxMenu.payload.node
            return (
              <MenuList className="min-w-44">
                <MenuItem
                  icon={
                    n.type === 'folder' ? (
                      <FolderOpenIcon className="size-3.5" />
                    ) : (
                      <EyeIcon className="size-3.5" />
                    )
                  }
                  onClick={() => {
                    ctxMenu.close()
                    const idx = visibleItems.findIndex((x) => x.id === n.id)
                    if (idx >= 0) open(n, idx)
                  }}
                >
                  {n.type === 'folder' ? <T name="openFolder" /> : <T name="preview" />}
                </MenuItem>
                <MenuSeparator />
                <NodeMenuItems
                  node={n}
                  fire={(action) => {
                    ctxMenu.close()
                    onAction(action, n)
                  }}
                />
              </MenuList>
            )
          })()}
        {ctxMenu.payload?.kind === 'selection' && (
          <MenuList className="min-w-44">
            <MenuItem
              icon={<DownloadIcon className="size-3.5" />}
              onClick={() => {
                ctxMenu.close()
                downloadSelected()
              }}
            >
              <T name="download" />
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<StarIcon className="size-3.5" />}
              onClick={() => {
                ctxMenu.close()
                void handleStar([...selected], true)
              }}
            >
              <T name="star" />
            </MenuItem>
            <MenuItem
              icon={<CopyIcon className="size-3.5" />}
              onClick={() => {
                ctxMenu.close()
                handleCopy([...selected])
              }}
            >
              <T name="copyTo" />
            </MenuItem>
            <MenuItem
              icon={<FolderInputIcon className="size-3.5" />}
              onClick={() => {
                ctxMenu.close()
                handleMove([...selected])
              }}
            >
              <T name="move" />
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              icon={<Trash2Icon className="size-3.5" />}
              onClick={() => {
                ctxMenu.close()
                handleDelete([...selected])
              }}
            >
              <T name="delete" />
            </MenuItem>
            <MenuItem
              icon={<XIcon className="size-3.5" />}
              onClick={() => {
                ctxMenu.close()
                clear()
              }}
            >
              <T name="clearSelection" />
            </MenuItem>
          </MenuList>
        )}
        {ctxMenu.payload?.kind === 'empty' && (
          <MenuList className="min-w-44">
            <MenuItem
              icon={<FolderPlusIcon className="size-3.5" />}
              onClick={() => {
                ctxMenu.close()
                handleNewFolder()
              }}
            >
              <T name="newFolder" />
            </MenuItem>
            <MenuItem
              icon={<UploadIcon className="size-3.5" />}
              onClick={() => {
                ctxMenu.close()
                fileInputRef.current?.click()
              }}
            >
              <T name="upload" />
            </MenuItem>
            <MenuItem
              icon={<FolderUpIcon className="size-3.5" />}
              onClick={() => {
                ctxMenu.close()
                folderInputRef.current?.click()
              }}
            >
              <T name="uploadFolder" />
            </MenuItem>
          </MenuList>
        )}
      </ContextMenu>
    </div>
  )
}
