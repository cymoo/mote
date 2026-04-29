import { RotateCcwIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { memo } from 'react'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { T, t } from '@/components/translation.tsx'

import { DriveNode, humanSize } from './api'
import { Checkbox, NodeIcon, PathChip, RowAction, RowMenu } from './parts'

type Lang = 'en' | 'zh'

// ---------- list view ----------

interface ListViewProps {
  items: DriveNode[]
  selected: Set<number>
  onToggle: (id: number, additive: boolean) => void
  onToggleAll: () => void
  onOpen: (n: DriveNode, idx: number) => void
  onAction: (action: RowAction, n: DriveNode) => void
  onNavigateToParent: (parentID: number | null) => void
  lang: Lang
}

export const ListView = memo(function ListView({
  items,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
  onAction,
  onNavigateToParent,
  lang,
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
            <T name="name" />
          </th>
          <th className="hidden w-24 px-2 font-medium md:table-cell">
            <T name="size" />
          </th>
          <th className="hidden w-44 px-2 font-medium md:table-cell">
            <T name="modified" />
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
}: ListRowProps) {
  return (
    <tr
      className={cx(
        'group hover:bg-accent/50 cursor-default border-b transition-colors',
        'border-border/40',
        selected ? 'bg-accent' : undefined,
      )}
      onClick={(e) => onToggle(node.id, e.shiftKey || e.metaKey || e.ctrlKey)}
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
      <td className="min-w-0 py-2.5 pr-2 pl-1">
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
      <td className="px-1" onClick={(e) => e.stopPropagation()}>
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
        'group relative flex h-36 flex-col items-center justify-start gap-2 rounded-xl border p-3 text-center transition-all',
        'hover:bg-accent/60 border-transparent hover:-translate-y-0.5 hover:shadow-sm',
        selected ? 'border-primary/40 bg-accent ring-primary/20 ring-2' : undefined,
      )}
      onClick={(e) => onToggle(node.id, e.shiftKey || e.metaKey || e.ctrlKey)}
      onDoubleClick={() => onOpen(node, index)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(node, index)
      }}
      title={node.name}
    >
      {/* hover-revealed kebab in top-right */}
      <div className="absolute top-1.5 right-1.5" onClick={(e) => e.stopPropagation()}>
        <RowMenu node={node} onAction={onAction} lang={lang} />
      </div>
      <div className="flex size-14 shrink-0 items-center justify-center">
        <NodeIcon node={node} large />
      </div>
      <div className="line-clamp-2 h-8 text-xs leading-4 break-all">{node.name}</div>
      <div className="text-muted-foreground mt-auto text-[10px] tabular-nums">
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
          >
            <RotateCcwIcon className="mr-1 size-4" />
            <T name="restore" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => onPurge(n.id)}
            title={t('delete', lang)}
          >
            <Trash2Icon className="mr-1 size-4" />
            <T name="delete" />
          </Button>
        </li>
      ))}
    </ul>
  )
})

// ---------- empty state ----------

export const EmptyState = memo(function EmptyState({
  trash,
  lang,
}: {
  trash: boolean
  lang: Lang
}) {
  return (
    <div className="text-muted-foreground flex h-full animate-[fadeIn_200ms_ease-out] flex-col items-center justify-center gap-3 text-sm">
      {trash ? (
        <>
          <Trash2Icon className="size-12 opacity-30" strokeWidth={1.25} />
          <span>{t('trashEmpty', lang)}</span>
        </>
      ) : (
        <>
          <UploadIcon className="size-12 opacity-30" strokeWidth={1.25} />
          <span>{t('dropFiles', lang)}</span>
        </>
      )}
    </div>
  )
})
