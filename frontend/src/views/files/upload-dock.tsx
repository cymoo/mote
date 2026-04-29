import { ChevronRightIcon, XIcon } from 'lucide-react'
import { memo, useState, useSyncExternalStore } from 'react'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { T, t } from '@/components/translation.tsx'

import { CollisionPolicy, humanSize } from './api'
import { UploadItem, uploadManager } from './upload-manager'

type Lang = 'en' | 'zh'

let uploadsSnapshot: UploadItem[] = []
uploadManager.subscribe((items) => {
  uploadsSnapshot = items
})

function useUploads(): UploadItem[] {
  return useSyncExternalStore(
    (cb) => uploadManager.subscribe(cb),
    () => uploadsSnapshot,
    () => [],
  )
}

export function UploadDock({
  onRefresh,
  lang,
}: {
  onRefresh: () => Promise<void> | void
  lang: Lang
}) {
  const items = useUploads()
  const [collapsed, setCollapsed] = useState(false)
  if (items.length === 0) return null

  const active = items.filter(
    (i) => i.status === 'uploading' || i.status === 'pending',
  ).length

  return (
    <div className="border-border bg-popover text-popover-foreground fixed right-4 bottom-4 z-30 w-80 animate-[fadeIn_160ms_ease-out] rounded-xl border shadow-xl">
      <div className="border-border/60 flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">
          {active > 0 ? t('uploading', lang, true, String(active)) : t('uploads', lang)}
        </span>
        <div className="flex gap-0.5">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1 transition-colors"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? t('expand', lang) : t('collapse', lang)}
            aria-label={collapsed ? t('expand', lang) : t('collapse', lang)}
          >
            <ChevronRightIcon
              className={cx(
                'size-4 transition-transform',
                collapsed ? '-rotate-90' : 'rotate-90',
              )}
            />
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1 transition-colors"
            onClick={() => uploadManager.clearFinished()}
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

const UploadRow = memo(function UploadRow({
  item,
  onRefresh,
  lang,
}: {
  item: UploadItem
  onRefresh: () => Promise<void> | void
  lang: Lang
}) {
  const pct = item.size > 0 ? Math.round((item.loaded / item.size) * 100) : 0
  const finished =
    item.status === 'done' ||
    item.status === 'failed' ||
    item.status === 'cancelled'

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
        <span className="truncate font-medium" title={item.name}>
          {item.name}
        </span>
        <span className="text-muted-foreground shrink-0 tabular-nums">
          {humanSize(item.size)}
        </span>
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
        <span
          className={cx(
            item.status === 'failed' ? 'text-destructive' : undefined,
            item.status === 'done' ? 'text-emerald-600 dark:text-emerald-400' : undefined,
          )}
        >
          {statusLabel(item, lang)}
        </span>
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
        {finished && (
          <button
            type="button"
            onClick={() => uploadManager.remove(item.id)}
            className="hover:text-foreground transition-colors"
            title={t('clear', lang)}
            aria-label={t('clear', lang)}
          >
            <XIcon className="size-3.5" />
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
})

function statusLabel(i: UploadItem, lang: Lang): string {
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
