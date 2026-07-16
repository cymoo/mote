import { useDraggable, useDroppable } from '@dnd-kit/core'
import { ArrowDownIcon, ArrowUpIcon, FolderOpenIcon, KeyIcon, LinkIcon, RotateCcwIcon, SearchIcon, Share2Icon, StarIcon, Trash2Icon, UploadIcon, XIcon } from 'lucide-react'
import React, { memo } from 'react'

import { cx } from '@/utils/css.ts'

import { T, t } from '@/components/translation.tsx'

import { DriveNode, SharedItem, humanSize } from './api'
import { Checkbox, NodeIcon, PathChip, RowAction, RowActionButton, RowMenu, ShareBadge, StarBadge } from './parts'

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
  onContextMenu?: (e: React.MouseEvent, n: DriveNode) => void
  // Enables drag-to-move (rows draggable, folder rows droppable). Only the
  // main browser turns this on; requires an enclosing <DndContext>.
  draggable?: boolean
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
  lang: Lang
  showDotFiles?: boolean
}

export const ListView = memo(function ListView({
  items,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
  onAction,
  onNavigateToParent,
  onContextMenu,
  draggable,
  sortKey,
  sortDir,
  onSort,
  lang,
  showDotFiles,
}: ListViewProps) {
  const allSelected = items.length > 0 && selected.size === items.length
  const someSelected = selected.size > 0 && !allSelected
  return (
    <table className="w-full table-fixed text-sm">
      <thead className="text-muted-foreground bg-card/95 supports-[backdrop-filter]:bg-card/80 sticky top-0 z-10 text-left text-[11.5px] tracking-wide backdrop-blur">
        <tr className="border-border/60 border-b">
          <th className="w-10 px-3 py-2">
            <Checkbox
              checked={allSelected}
              indeterminate={someSelected}
              onChange={onToggleAll}
              title={t('selectAll', lang)}
            />
          </th>
          <th className="w-11"></th>
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
            onContextMenu={onContextMenu}
            draggable={draggable}
            lang={lang}
            dimmed={showDotFiles && n.name.startsWith('.')}
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
  onContextMenu?: (e: React.MouseEvent, n: DriveNode) => void
  draggable?: boolean
  lang: Lang
  dimmed?: boolean
}

const ListRow = memo(function ListRow({
  node,
  index,
  selected,
  onToggle,
  onOpen,
  onAction,
  onNavigateToParent,
  onContextMenu,
  draggable,
  lang,
  dimmed,
}: ListRowProps) {
  const {
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: node.id, disabled: !draggable })
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `folder-${node.id}`,
    disabled: !draggable || node.type !== 'folder',
  })
  return (
    <tr
      ref={(el) => {
        setDragRef(el)
        setDropRef(el)
      }}
      className={cx(
        'group hover:bg-accent/60 cursor-pointer border-b transition-colors',
        'border-border/40',
        selected ? 'bg-primary/10 hover:bg-primary/15' : undefined,
        dimmed ? 'opacity-50' : undefined,
        isDragging ? 'opacity-40' : undefined,
        // Drop-target highlight (background only — box-shadow rings are
        // unreliable on <tr>).
        isOver ? 'bg-primary/20 hover:bg-primary/20' : undefined,
      )}
      onClick={(e) => {
        // 打开是高频操作：单击即打开；⌘/Ctrl/Shift+单击、或点复选框才是多选。
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          onToggle(node.id, true)
        } else {
          onOpen(node, index)
        }
      }}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, node) : undefined}
      {...(draggable ? listeners : {})}
    >
      <td
        className="px-3"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span
          className={cx(
            'inline-flex transition-opacity',
            selected
              ? 'opacity-100'
              : 'opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100',
          )}
        >
          <Checkbox
            checked={selected}
            onChange={() => onToggle(node.id, true)}
            title={node.name}
          />
        </span>
      </td>
      <td className="px-1 py-1.5">
        <NodeIcon node={node} />
      </td>
      <td className="min-w-0 py-2 pr-2 pl-1 md:py-2.5">
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
          {!!node.starred_at && <StarBadge lang={lang} />}
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
        {/* 小屏隐藏了大小/时间列，改在名称下方以副行呈现 */}
        <span className="text-muted-foreground/80 mt-0.5 block text-[11px] tabular-nums md:hidden">
          {node.type !== 'folder' && humanSize(node.size) ? `${humanSize(node.size)} · ` : ''}
          {new Date(node.updated_at).toLocaleDateString()}
        </span>
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
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className="inline-flex opacity-100 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
          <RowMenu node={node} onAction={onAction} lang={lang} />
        </span>
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
  onContextMenu?: (e: React.MouseEvent, n: DriveNode) => void
  draggable?: boolean
  lang: Lang
  showDotFiles?: boolean
}

export const GridView = memo(function GridView({
  items,
  selected,
  onToggle,
  onOpen,
  onAction,
  onContextMenu,
  draggable,
  lang,
  showDotFiles,
}: GridViewProps) {
  return (
    <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {items.map((n, idx) => (
        <GridCard
          key={n.id}
          node={n}
          index={idx}
          selected={selected.has(n.id)}
          onToggle={onToggle}
          onOpen={onOpen}
          onAction={onAction}
          onContextMenu={onContextMenu}
          draggable={draggable}
          lang={lang}
          dimmed={showDotFiles && n.name.startsWith('.')}
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
  onContextMenu?: (e: React.MouseEvent, n: DriveNode) => void
  draggable?: boolean
  lang: Lang
  dimmed?: boolean
}

const GridCard = memo(function GridCard({
  node,
  index,
  selected,
  onToggle,
  onOpen,
  onAction,
  onContextMenu,
  draggable,
  lang,
  dimmed,
}: GridCardProps) {
  const {
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: node.id, disabled: !draggable })
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `folder-${node.id}`,
    disabled: !draggable || node.type !== 'folder',
  })
  return (
    <div
      ref={(el) => {
        setDragRef(el)
        setDropRef(el)
      }}
      role="button"
      tabIndex={0}
      className={cx(
        'group relative flex h-32 flex-col items-center justify-start gap-1.5 rounded-[calc(var(--radius)+4px)] border p-3 text-center transition-all md:h-36',
        'hover:bg-accent/60 border-transparent hover:-translate-y-0.5 hover:shadow-md',
        selected ? 'border-primary/40 bg-primary/10 ring-primary/20 ring-2' : undefined,
        dimmed ? 'opacity-50' : undefined,
        isDragging ? 'opacity-40' : undefined,
        isOver ? 'ring-primary bg-primary/15 ring-2' : undefined,
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
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, node) : undefined}
      title={node.name}
      {...(draggable ? listeners : {})}
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
        onPointerDown={(e) => e.stopPropagation()}
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
        onPointerDown={(e) => e.stopPropagation()}
      >
        <RowMenu node={node} onAction={onAction} lang={lang} />
      </div>
      <div className="flex size-14 shrink-0 items-center justify-center">
        <NodeIcon node={node} large />
      </div>
      <div className="flex w-full min-w-0 items-center justify-center gap-1">
        <span className="truncate text-xs leading-4">{node.name}</span>
        {!!node.starred_at && <StarBadge lang={lang} />}
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
  showDotFiles?: boolean
}

export const TrashView = memo(function TrashView({
  items,
  onRestore,
  onPurge,
  lang,
  showDotFiles,
}: TrashViewProps) {
  return (
    <ul className="divide-border/60 divide-y">
      {items.map((n) => (
        <li
          key={n.id}
          className={cx(
            'hover:bg-accent/40 flex items-center gap-3 px-4 py-2.5 transition-colors',
            showDotFiles && n.name.startsWith('.') ? 'opacity-50' : undefined,
          )}
        >
          <NodeIcon node={n} />
          <span className="flex-1 truncate text-sm">{n.name}</span>
          <span className="text-muted-foreground shrink-0 text-xs">
            {n.deleted_at ? (
              <>
                <span className="hidden md:inline">{new Date(n.deleted_at).toLocaleString()}</span>
                <span className="md:hidden">{new Date(n.deleted_at).toLocaleDateString()}</span>
              </>
            ) : null}
          </span>
          <RowActionButton
            icon={<RotateCcwIcon className="size-3.5" />}
            label={t('restore', lang)}
            title={t('restore', lang)}
            onClick={() => void onRestore(n.id)}
          />
          <RowActionButton
            icon={<Trash2Icon className="size-3.5" />}
            label={t('delete', lang)}
            title={t('delete', lang)}
            danger
            onClick={() => onPurge(n.id)}
          />
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
  starred,
  lang,
}: {
  trash: boolean
  shared?: boolean
  starred?: boolean
  lang: Lang
}) {
  return (
    <div className="text-muted-foreground flex h-full animate-[fadeIn_200ms_ease-out] flex-col items-center justify-center gap-3 text-sm">
      {starred ? (
        <>
          <StarIcon className="size-12 opacity-30" strokeWidth={1.25} />
          <span>{t('noStarred', lang)}</span>
        </>
      ) : shared ? (
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

// ---------- search empty state ----------

export const SearchEmptyState = memo(function SearchEmptyState({
  query,
  lang,
}: {
  query: string
  lang: Lang
}) {
  return (
    <div className="text-muted-foreground flex h-full animate-[fadeIn_200ms_ease-out] flex-col items-center justify-center gap-3 text-sm">
      <SearchIcon className="size-12 opacity-30" strokeWidth={1.25} />
      <span>{t('searchNoResults', lang, true, query)}</span>
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
  onViewLink: (item: SharedItem) => void
  onRevoke: (shareID: number) => void | Promise<void>
  lang: Lang
  showDotFiles?: boolean
}

export const SharedView = memo(function SharedView({
  items,
  onOpenLocation,
  onViewLink,
  onRevoke,
  lang,
  showDotFiles,
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
              showDotFiles && s.name.startsWith('.') ? 'opacity-50' : undefined,
            )}
          >
            <span className="shrink-0">
              <NodeIcon
                node={{
                  id: s.node_id,
                  parent_id: s.parent_id,
                  type: s.node_type,
                  name: s.name,
                  size: s.size,
                  mime_type: s.mime_type ?? null,
                  created_at: s.created_at,
                  updated_at: s.created_at,
                }}
              />
            </span>
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
              <div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
                <button
                  type="button"
                  className="hover:text-foreground inline-flex min-w-0 shrink items-center gap-1 transition-colors"
                  onClick={() => onOpenLocation(s.parent_id)}
                  title={t('openFolder', lang)}
                >
                  <FolderOpenIcon className="size-3 shrink-0" />
                  <span className="min-w-0 truncate">
                    {s.path
                      ? `${t('myDrive', lang)} > ${s.path.replace(/\//g, ' > ')}`
                      : t('myDrive', lang)}
                  </span>
                </button>
                <span className="shrink-0 opacity-40">·</span>
                <span className="shrink-0 whitespace-nowrap">{formatExpiry(s.expires_at, lang)}</span>
              </div>
            </div>
            <RowActionButton
              icon={<LinkIcon className="size-3.5" />}
              label={t('openLink', lang)}
              title={t('viewShareLink', lang)}
              onClick={() => onViewLink(s)}
            />
            <RowActionButton
              icon={<XIcon className="size-3.5" />}
              label={t('revoke', lang)}
              title={t('revoke', lang)}
              danger
              onClick={() => void onRevoke(s.id)}
            />
          </li>
        )
      })}
    </ul>
  )
})
