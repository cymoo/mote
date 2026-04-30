import { ArrowDownIcon, ArrowUpIcon, FileIcon, FolderOpenIcon, KeyIcon, RotateCcwIcon, Share2Icon, Trash2Icon, UploadIcon } from 'lucide-react'
import React, { memo } from 'react'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { T, t } from '@/components/translation.tsx'

import { DriveNode, SharedItem, humanSize } from './api'
import { Checkbox, NodeIcon, PathChip, RowAction, RowMenu, ShareBadge } from './parts'

type Lang = 'en' | 'zh'

export type SortKey = 'name' | 'size' | 'updated_at'
export type SortDir = 'asc' | 'desc'

// ---------- list view ----------

interface ListViewProps {
  items: DriveNode[]
  selected: Set<number>
  onToggle: (id: number, additive: boolean) => void
  onToggleAll: () => void
  onOpen: (n: DriveNode, idx: number) => void
  onAction: (action: RowAction, n: DriveNode) => void
  onNavigateToParent: (parentID: number | null) => void
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
  lang: Lang
  isMobile?: boolean
}

export const ListView = memo(function ListView({
  items,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
  onAction,
  onNavigateToParent,
  sortKey,
  sortDir,
  onSort,
  lang,
  isMobile,
}: ListViewProps) {
  const allSelected = items.length > 0 && selected.size === items.length
  const someSelected = selected.size > 0 && !allSelected
  return (
    <table className="w-full table-fixed text-sm">
      <thead className="text-muted-foreground bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-10 text-left text-xs backdrop-blur">
        <tr className="border-border/60 border-b">
          <th className="w-10 px-3 py-2">
            <Checkbox
              checked={allSelected}
              indeterminate={someSelected}
              onChange={onToggleAll}
              title={t('selectAll', lang)}
            />
          </th>
          <th className="w-9"></th>
          <th className="px-2 py-2 font-medium">
            <SortHeader k="name" sortKey={sortKey} sortDir={sortDir} onSort={onSort}>
              <T name="name" />
            </SortHeader>
          </th>
          <th className="hidden w-24 px-2 font-medium md:table-cell">
            <SortHeader k="size" sortKey={sortKey} sortDir={sortDir} onSort={onSort}>
              <T name="size" />
            </SortHeader>
          </th>
          <th className="hidden w-44 px-2 font-medium md:table-cell">
            <SortHeader k="updated_at" sortKey={sortKey} sortDir={sortDir} onSort={onSort}>
              <T name="modified" />
            </SortHeader>
          </th>
          <th className="w-10"></th>
        </tr>
      </thead>
      <tbody>
        {items.map((n, idx) => (
          <ListRow
            key={n.id}
            node={n}
            index={idx}
            selected={selected.has(n.id)}
            onToggle={onToggle}
            onOpen={onOpen}
            onAction={onAction}
            onNavigateToParent={onNavigateToParent}
            lang={lang}
            isMobile={isMobile}
          />
        ))}
      </tbody>
    </table>
  )
})

interface ListRowProps {
  node: DriveNode
  index: number
  selected: boolean
  onToggle: (id: number, additive: boolean) => void
  onOpen: (n: DriveNode, idx: number) => void
  onAction: (action: RowAction, n: DriveNode) => void
  onNavigateToParent: (parentID: number | null) => void
  lang: Lang
  isMobile?: boolean
}

const ListRow = memo(function ListRow({
  node,
  index,
  selected,
  onToggle,
  onOpen,
  onAction,
  onNavigateToParent,
  lang,
  isMobile,
}: ListRowProps) {
  return (
    <tr
      className={cx(
        'group hover:bg-accent/50 cursor-default border-b transition-colors',
        'border-border/40',
        selected ? 'bg-accent' : undefined,
      )}
      onClick={(e) => {
        if (isMobile) {
          // On mobile, plain row click opens. Modifier-click still toggles
          // selection (covers BT keyboards), and the checkbox handles the
          // common "select" gesture. No double-click on touch.
          if (e.shiftKey || e.metaKey || e.ctrlKey) {
            onToggle(node.id, true)
          } else {
            onOpen(node, index)
          }
        } else {
          onToggle(node.id, e.shiftKey || e.metaKey || e.ctrlKey)
        }
      }}
      onDoubleClick={() => onOpen(node, index)}
    >
      <td className="px-3" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          onChange={() => onToggle(node.id, true)}
          title={node.name}
        />
      </td>
      <td className="px-1">
        <NodeIcon node={node} />
      </td>
      <td className="min-w-0 py-3 pr-2 pl-1 md:py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            className="hover:text-primary min-w-0 truncate text-left font-medium transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              onOpen(node, index)
            }}
            title={node.type === 'folder' ? t('openFolder', lang) : t('preview', lang)}
          >
            {node.name}
          </button>
          {!!node.share_count && (
            <ShareBadge count={node.share_count} lang={lang} />
          )}
          {node.path !== undefined && (
            <PathChip
              path={node.path}
              onNavigate={() =>
                onNavigateToParent(node.parent_id ?? null)
              }
              lang={lang}
            />
          )}
        </div>
      </td>
      <td className="text-muted-foreground hidden px-2 text-xs md:table-cell">
        {humanSize(node.size)}
      </td>
      <td className="text-muted-foreground hidden px-2 text-xs md:table-cell">
        {new Date(node.updated_at).toLocaleString()}
      </td>
      <td
        className="px-1"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <RowMenu node={node} onAction={onAction} lang={lang} />
      </td>
    </tr>
  )
})

// ---------- grid view ----------

interface GridViewProps {
  items: DriveNode[]
  selected: Set<number>
  onToggle: (id: number, additive: boolean) => void
  onOpen: (n: DriveNode, idx: number) => void
  onAction: (action: RowAction, n: DriveNode) => void
  lang: Lang
}

export const GridView = memo(function GridView({
  items,
  selected,
  onToggle,
  onOpen,
  onAction,
  lang,
}: GridViewProps) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-4">
      {items.map((n, idx) => (
        <GridCard
          key={n.id}
          node={n}
          index={idx}
          selected={selected.has(n.id)}
          onToggle={onToggle}
          onOpen={onOpen}
          onAction={onAction}
          lang={lang}
        />
      ))}
    </div>
  )
})

interface GridCardProps {
  node: DriveNode
  index: number
  selected: boolean
  onToggle: (id: number, additive: boolean) => void
  onOpen: (n: DriveNode, idx: number) => void
  onAction: (action: RowAction, n: DriveNode) => void
  lang: Lang
}

const GridCard = memo(function GridCard({
  node,
  index,
  selected,
  onToggle,
  onOpen,
  onAction,
  lang,
}: GridCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cx(
        'group relative flex h-32 flex-col items-center justify-start gap-1.5 rounded-xl border p-3 text-center transition-all md:h-36',
        'hover:bg-accent/60 border-transparent hover:-translate-y-0.5 hover:shadow-sm',
        selected ? 'border-primary/40 bg-accent ring-primary/20 ring-2' : undefined,
      )}
      onClick={(e) => {
        // Modifier-click toggles selection; plain click opens.
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          onToggle(node.id, true)
        } else {
          onOpen(node, index)
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(node, index)
      }}
      title={node.name}
    >
      {/* hover-revealed checkbox in top-left (always visible on mobile) */}
      <div
        className={cx(
          'absolute top-1.5 left-1.5 transition-opacity',
          selected
            ? 'opacity-100'
            : 'opacity-100 md:opacity-0 md:group-hover:opacity-100',
        )}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Checkbox
          checked={selected}
          onChange={() => onToggle(node.id, true)}
          title={node.name}
        />
      </div>
      {/* hover-revealed kebab in top-right */}
      <div
        className="absolute top-1.5 right-1.5"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <RowMenu node={node} onAction={onAction} lang={lang} />
      </div>
      <div className="flex size-14 shrink-0 items-center justify-center">
        <NodeIcon node={node} large />
      </div>
      <div className="flex w-full min-w-0 items-center justify-center gap-1">
        <span className="truncate text-xs leading-4">{node.name}</span>
        {!!node.share_count && (
          <ShareBadge count={node.share_count} lang={lang} />
        )}
      </div>
      <div className="text-muted-foreground text-[10px] tabular-nums">
        {humanSize(node.size)}
      </div>
    </div>
  )
})

// ---------- trash view ----------

interface TrashViewProps {
  items: DriveNode[]
  onRestore: (id: number) => void | Promise<void>
  onPurge: (id: number) => void
  lang: Lang
}

export const TrashView = memo(function TrashView({
  items,
  onRestore,
  onPurge,
  lang,
}: TrashViewProps) {
  return (
    <ul className="divide-border/60 divide-y">
      {items.map((n) => (
        <li
          key={n.id}
          className="hover:bg-accent/40 flex items-center gap-3 px-4 py-2.5 transition-colors"
        >
          <NodeIcon node={n} />
          <span className="flex-1 truncate text-sm">{n.name}</span>
          <span className="text-muted-foreground text-xs">
            {n.deleted_at ? new Date(n.deleted_at).toLocaleString() : ''}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onRestore(n.id)}
            title={t('restore', lang)}
            aria-label={t('restore', lang)}
          >
            <RotateCcwIcon className="size-4 md:mr-1" />
            <span className="hidden md:inline">
              <T name="restore" />
            </span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => onPurge(n.id)}
            title={t('delete', lang)}
            aria-label={t('delete', lang)}
          >
            <Trash2Icon className="size-4 md:mr-1" />
            <span className="hidden md:inline">
              <T name="delete" />
            </span>
          </Button>
        </li>
      ))}
    </ul>
  )
})

// ---------- sort header ----------

function SortHeader({
  k,
  sortKey,
  sortDir,
  onSort,
  children,
}: {
  k: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
  children: React.ReactNode
}) {
  const active = sortKey === k
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      className={cx(
        'hover:text-foreground inline-flex items-center gap-1 transition-colors',
        active ? 'text-foreground' : undefined,
      )}
    >
      {children}
      {active && (
        sortDir === 'asc' ? (
          <ArrowUpIcon className="size-3" />
        ) : (
          <ArrowDownIcon className="size-3" />
        )
      )}
    </button>
  )
}

// ---------- empty state ----------

export const EmptyState = memo(function EmptyState({
  trash,
  shared,
  lang,
}: {
  trash: boolean
  shared?: boolean
  lang: Lang
}) {
  return (
    <div className="text-muted-foreground flex h-full animate-[fadeIn_200ms_ease-out] flex-col items-center justify-center gap-3 text-sm">
      {shared ? (
        <>
          <Share2Icon className="size-12 opacity-30" strokeWidth={1.25} />
          <span>{t('noActiveShares', lang)}</span>
        </>
      ) : trash ? (
        <>
          <Trash2Icon className="size-12 opacity-30" strokeWidth={1.25} />
          <span>{t('trashEmpty', lang)}</span>
        </>
      ) : (
        <>
          <UploadIcon className="size-12 opacity-30" strokeWidth={1.25} />
          <span className="hidden md:inline">{t('dropFiles', lang)}</span>
          <span className="md:hidden">{t('tapUpload', lang)}</span>
        </>
      )}
    </div>
  )
})

// ---------- shared view ----------

function formatExpiry(expires_at: number | null, lang: Lang): string {
  if (expires_at == null) return t('neverExpires', lang)
  const now = Date.now()
  const diffMs = expires_at - now
  if (diffMs <= 0) return t('expires_short', lang, true, new Date(expires_at).toLocaleString())
  const days = Math.floor(diffMs / 86_400_000)
  const hours = Math.floor(diffMs / 3_600_000)
  if (days >= 1) return t('expiresIn', lang, true, `${days}d`)
  if (hours >= 1) return t('expiresIn', lang, true, `${hours}h`)
  const mins = Math.max(1, Math.floor(diffMs / 60_000))
  return t('expiresIn', lang, true, `${mins}m`)
}

interface SharedViewProps {
  items: SharedItem[]
  onOpenLocation: (parentID: number | null) => void
  onRevoke: (shareID: number) => void | Promise<void>
  lang: Lang
}

export const SharedView = memo(function SharedView({
  items,
  onOpenLocation,
  onRevoke,
  lang,
}: SharedViewProps) {
  return (
    <ul className="divide-border/60 divide-y">
      {items.map((s) => {
        const expired = s.expires_at != null && s.expires_at <= Date.now()
        return (
          <li
            key={s.id}
            className={cx(
              'hover:bg-accent/40 flex items-center gap-3 px-4 py-2.5 transition-colors',
              expired ? 'opacity-60' : undefined,
            )}
          >
            <FileIcon className="text-muted-foreground size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{s.name}</span>
                {s.has_password && (
                  <span
                    className="text-muted-foreground inline-flex items-center gap-1 text-[11px]"
                    title={t('passwordProtected', lang)}
                  >
                    <KeyIcon className="size-3" />
                  </span>
                )}
              </div>
              <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                <button
                  type="button"
                  className="hover:text-foreground inline-flex items-center gap-1 truncate transition-colors"
                  onClick={() => onOpenLocation(s.parent_id)}
                  title={t('openFolder', lang)}
                >
                  <FolderOpenIcon className="size-3 shrink-0" />
                  <span className="truncate">{s.path || '/'}</span>
                </button>
                <span>·</span>
                <span>{humanSize(s.size)}</span>
                <span>·</span>
                <span>{formatExpiry(s.expires_at, lang)}</span>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => void onRevoke(s.id)}
              title={t('revoke', lang)}
              aria-label={t('revoke', lang)}
            >
              <Trash2Icon className="size-4 md:mr-1" />
              <span className="hidden md:inline">
                <T name="revoke" />
              </span>
            </Button>
          </li>
        )
      })}
    </ul>
  )
})
