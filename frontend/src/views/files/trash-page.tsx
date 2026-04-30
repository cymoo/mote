import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'

import { useConfirm } from '@/components/confirm.tsx'
import { t, useLang } from '@/components/translation.tsx'

import { DriveNode, purgeNodes, restoreNode, trash } from './api'
import { TopBar } from './layout'
import { EmptyState, TrashView } from './views'

export function TrashPage() {
  const [items, setItems] = useState<DriveNode[]>([])
  const confirm = useConfirm()
  const { lang } = useLang()

  const refresh = useCallback(async () => {
    setItems(await trash())
  }, [])

  useEffect(() => {
    void refresh().catch((err: Error) => toast.error(err.message))
  }, [refresh])

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

  return (
    <div className="flex flex-1 flex-col">
      <TopBar lang={lang} />
      <main className="flex-1 overflow-x-hidden overflow-y-auto">
        {items.length === 0 ? (
          <EmptyState trash lang={lang} />
        ) : (
          <TrashView
            items={items}
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
        )}
      </main>
    </div>
  )
}
