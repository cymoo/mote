import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useNavigate } from 'react-router'

import { useConfirm } from '@/components/confirm.tsx'
import { t, useLang } from '@/components/translation.tsx'

import { SharedItem, listAllShares, revokeShare } from './api'
import { TopBar } from './layout'
import { EmptyState, SharedView } from './views'

export function SharedPage() {
  const [items, setItems] = useState<SharedItem[]>([])
  const confirm = useConfirm()
  const { lang } = useLang()
  const navigate = useNavigate()

  const refresh = useCallback(async () => {
    setItems(await listAllShares())
  }, [])

  useEffect(() => {
    void refresh().catch((err: Error) => toast.error(err.message))
  }, [refresh])

  return (
    <div className="flex flex-1 flex-col">
      <TopBar lang={lang} />
      <main className="flex-1 overflow-x-hidden overflow-y-auto">
        {items.length === 0 ? (
          <EmptyState trash={false} shared lang={lang} />
        ) : (
          <SharedView
            items={items}
            onOpenLocation={(pid) => {
              // Navigate to my-drive route. parentID is in-page state, so we
              // pass it via location state and the page picks it up on mount.
              void navigate('/files', { state: { parentID: pid } })
            }}
            onRevoke={(id) => {
              confirm.open({
                heading: t('revokeConfirm', lang),
                okText: t('revoke', lang),
                cancelText: t('cancel', lang),
                onOk: async () => {
                  try {
                    await revokeShare(id)
                    await refresh()
                  } catch (err) {
                    toast.error((err as Error).message)
                  }
                },
              })
            }}
            lang={lang}
          />
        )}
      </main>
    </div>
  )
}
