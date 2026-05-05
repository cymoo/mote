import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { EraserIcon, InfoIcon } from 'lucide-react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/button.tsx'
import { useConfirm } from '@/components/confirm.tsx'
import { t, T, useLang } from '@/components/translation.tsx'

import { DriveNode, purgeNodes, restoreNode, trash } from './api'
import { useShowDotFiles } from './hooks'
import { TopBar } from './layout'
import { Breadcrumbs } from './parts'
import { useShortcuts } from './use-shortcuts'
import { EmptyState, TrashView } from './views'

export function TrashPage() {
  const [items, setItems] = useState<DriveNode[]>([])
  const confirm = useConfirm()
  const { lang } = useLang()
  const { showDotFiles, toggleShowDotFiles } = useShowDotFiles()

  const navigate = useNavigate()
  const refresh = useCallback(async () => {
    setItems(await trash())
  }, [])

  useEffect(() => {
    void refresh().catch((err: Error) => toast.error(err.message))
  }, [refresh])

  const visibleItems = useMemo(
    () => (showDotFiles ? items : items.filter((n) => !n.name.startsWith('.'))),
    [items, showDotFiles],
  )

  const handleToggleDotFiles = useCallback(() => {
    toggleShowDotFiles()
    toast(t(showDotFiles ? 'dotFilesHidden' : 'dotFilesShown', lang))
  }, [toggleShowDotFiles, showDotFiles, lang])

  useShortcuts({
    'mod+.': { run: handleToggleDotFiles },
  })

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

  const handleClearTrash = () => {
    if (items.length === 0) return
    confirm.open({
      heading: t('emptyTrash', lang),
      description: t('clearTrashConfirm', lang),
      okText: t('delete', lang),
      cancelText: t('cancel', lang),
      onOk: async () => {
        try {
          await purgeNodes(items.map((item) => item.id))
          await refresh()
        } catch (err) {
          toast.error((err as Error).message)
        }
      },
    })
  }

  return (
    <div className="flex flex-1 flex-col">
      <TopBar
        lang={lang}
        middle={
          <Breadcrumbs
            crumbs={[]}
            onRoot={() => void navigate('/files')}
            onCrumb={() => {}}
            isTrash
            lang={lang}
          />
        }
      />
      <div className="border-border/40 flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        <InfoIcon className="size-3.5 shrink-0 opacity-60" />
        <span className="flex-1">
          <T name="driveTrashRetention" capitalized={false} />
        </span>
        {items.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="-my-1 -mr-2 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={handleClearTrash}
            title={t('emptyTrash', lang)}
          >
            <EraserIcon className="size-3.5" />
            <T name="clear" />
          </Button>
        )}
      </div>
      <main className="flex-1 overflow-x-hidden overflow-y-auto pb-20 md:pb-0">
        {visibleItems.length === 0 ? (
          <EmptyState trash lang={lang} />
        ) : (
          <TrashView
            items={visibleItems}
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
            showDotFiles={showDotFiles}
          />
        )}
      </main>
    </div>
  )
}
