import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useNavigate } from 'react-router'
import { CheckIcon, CopyIcon, ExternalLinkIcon } from 'lucide-react'

import { Button } from '@/components/button.tsx'
import { useConfirm } from '@/components/confirm.tsx'
import { useModal } from '@/components/modal.tsx'
import { T, t, useLang } from '@/components/translation.tsx'

import { SharedItem, listAllShares, revokeShare } from './api'
import { TopBar } from './layout'
import { EmptyState, SharedView } from './views'

export function SharedPage() {
  const [items, setItems] = useState<SharedItem[]>([])
  const confirm = useConfirm()
  const modal = useModal()
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
              void navigate(pid == null ? '/files' : `/files?p=${pid}`)
            }}
            onViewLink={(item) => {
              modal.open({
                heading: `${t('shareLink', lang)} — ${item.name}`,
                headingVisible: true,
                content: <ShareLinkDialog item={item} lang={lang} />,
              })
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

function ShareLinkDialog({ item, lang }: { item: SharedItem; lang: 'en' | 'zh' }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    if (!item.url) return
    try {
      await navigator.clipboard.writeText(item.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  if (!item.url) {
    return (
      <div className="text-muted-foreground max-w-md text-sm">
        {t('shareLinkUnavailable', lang)}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <input
        readOnly
        value={item.url}
        className="border-input bg-background focus-visible:ring-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2"
        onClick={(e) => (e.target as HTMLInputElement).select()}
      />
      <div className="flex justify-end gap-2">
        <Button variant={copied ? 'secondary' : 'outline'} size="sm" onClick={() => void copy()}>
          {copied ? <CheckIcon className="size-4 md:mr-1" /> : <CopyIcon className="size-4 md:mr-1" />}
          <span className="hidden md:inline">
            <T name="copy" />
          </span>
        </Button>
        <Button tag="a" href={item.url} target="_blank" rel="noreferrer" size="sm">
          <ExternalLinkIcon className="size-4 md:mr-1" />
          <span className="hidden md:inline">
            <T name="openLink" />
          </span>
        </Button>
      </div>
    </div>
  )
}
