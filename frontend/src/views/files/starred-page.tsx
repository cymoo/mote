import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { useNavigate } from 'react-router'

import { useShortcuts } from '@/utils/hooks/use-shortcuts.ts'

import { useConfirm } from '@/components/confirm.tsx'
import { useModal } from '@/components/modal.tsx'
import { T, t, useLang } from '@/components/translation.tsx'

import {
  DriveNode,
  copyNodes,
  deleteNodes,
  downloadURL,
  downloadZipNodesURL,
  downloadZipURL,
  listStarred,
  moveNodes,
  renameNode,
  setStarred,
} from './api'
import { MoveDialog, NameDialog, ShareDialog } from './dialogs'
import { useSelection, useShowDotFiles, useSort } from './hooks'
import { TopBar } from './layout'
import { Breadcrumbs, RowAction, SelectionBar } from './parts'
import { PreviewModal } from './preview'
import { EmptyState, ListView } from './views'

// Starred items across the whole drive. The server returns paths (PathChip)
// like search results; sorting reuses the shared preference client-side.
export function StarredPage() {
  const [items, setItems] = useState<DriveNode[]>([])
  const [previewIdx, setPreviewIdx] = useState<number | null>(null)
  const confirm = useConfirm()
  const modal = useModal()
  const { lang } = useLang()
  const navigate = useNavigate()
  const { sortKey, sortDir, onSort } = useSort()
  const { showDotFiles, toggleShowDotFiles } = useShowDotFiles()

  const refresh = useCallback(async () => {
    setItems(await listStarred())
  }, [])

  useEffect(() => {
    void refresh().catch((err: Error) => toast.error(err.message))
  }, [refresh])

  const visibleItems = useMemo(() => {
    const filtered = showDotFiles ? items : items.filter((n) => !n.name.startsWith('.'))
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      let cmp = 0
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name)
      else if (sortKey === 'size') cmp = (a.size ?? 0) - (b.size ?? 0)
      else cmp = a.updated_at - b.updated_at
      return cmp * dir
    })
  }, [items, showDotFiles, sortKey, sortDir])

  const { selected, toggle, toggleAll, clear } = useSelection(visibleItems)

  const handleToggleDotFiles = useCallback(() => {
    toggleShowDotFiles()
    toast(t(showDotFiles ? 'dotFilesHidden' : 'dotFilesShown', lang))
  }, [toggleShowDotFiles, showDotFiles, lang])

  useShortcuts({
    'mod+.': { run: handleToggleDotFiles },
    'mod+a': { run: () => toggleAll(), when: () => visibleItems.length > 0 },
    escape: { run: () => clear(), when: () => selected.size > 0 },
  })

  // ---- navigation ---------------------------------------------------------

  const goToFolder = useCallback(
    (parentID: number | null) => {
      void navigate(parentID == null ? '/files' : `/files?p=${parentID}`)
    },
    [navigate],
  )

  const open = useCallback(
    (n: DriveNode, idx: number) => {
      if (n.type === 'folder') {
        void navigate(`/files?p=${n.id}`)
        return
      }
      setPreviewIdx(idx)
    },
    [navigate],
  )

  // ---- actions ------------------------------------------------------------

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
      const n = visibleItems.find((x) => x.id === sel[0])
      if (n) downloadOne(n)
      return
    }
    const a = document.createElement('a')
    a.href = downloadZipNodesURL(sel)
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
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
          currentParentID={null}
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

  const handleCopy = (ids: number[]) => {
    modal.open({
      heading: t('copyTo', lang),
      headingVisible: true,
      content: (
        <MoveDialog
          movingIDs={new Set(ids)}
          currentParentID={null}
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

  const handleStar = async (ids: number[], starred: boolean) => {
    try {
      await setStarred(ids, starred)
      await refresh()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const handleDuplicate = async (n: DriveNode) => {
    try {
      await copyNodes([n.id], n.parent_id ?? null)
      await refresh()
      toast.success(t('copiedItems', lang, true, '1'))
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

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
    [lang],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        lang={lang}
        middle={
          <Breadcrumbs
            crumbs={[]}
            onRoot={() => void navigate('/files')}
            onCrumb={() => {}}
            label={t('starred', lang)}
            lang={lang}
          />
        }
      />

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

      <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-20 md:pb-0">
        {visibleItems.length === 0 ? (
          <EmptyState trash={false} starred lang={lang} />
        ) : (
          <ListView
            items={visibleItems}
            selected={selected}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onOpen={open}
            onAction={onAction}
            onNavigateToParent={goToFolder}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
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
    </div>
  )
}
