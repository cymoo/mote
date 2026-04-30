import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  FolderOpenIcon,
} from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import toast from 'react-hot-toast'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { T, t } from '@/components/translation.tsx'

import { DriveNode, createShare, list } from './api'
import { Checkbox } from './parts'

type Lang = 'en' | 'zh'

// ---------- name dialog ----------

export function NameDialog({
  initial = '',
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: string
  placeholder?: string
  submitLabel: string
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial)
  const valid = name.trim().length > 0 && name !== initial
  return (
    <div className="space-y-4">
      <input
        autoFocus
        placeholder={placeholder}
        className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring h-10 w-full rounded-md border px-3 text-sm transition-colors outline-none focus-visible:ring-2"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && valid) onSubmit(name.trim())
          if (e.key === 'Escape') onCancel()
        }}
      />
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          <T name="cancel" />
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => onSubmit(name.trim())}
          disabled={!valid}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}

// ---------- share dialog ----------

export function ShareDialog({
  node,
  onClose,
  lang,
}: {
  node: DriveNode
  onClose: () => void
  lang: Lang
}) {
  const [withPassword, setWithPassword] = useState(false)
  const [pw, setPw] = useState('')
  const [show, setShow] = useState(false)
  const [exp, setExp] = useState<'1' | '7' | '30' | 'never'>('never')
  const [created, setCreated] = useState<{ url: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (withPassword && pw.length < 4) {
      setErr(t('passwordTooShort', lang))
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const expiresAt =
        exp === 'never' ? null : Date.now() + Number(exp) * 24 * 60 * 60 * 1000
      const sh = await createShare(node.id, withPassword ? pw : null, expiresAt)
      setCreated({ url: sh.url ?? '' })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!created) return
    await navigator.clipboard.writeText(created.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (created) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">{t('linkReady', lang)}</p>
        <div className="flex items-stretch gap-2">
          <input
            readOnly
            value={created.url}
            className="border-input bg-background focus-visible:ring-ring h-10 flex-1 rounded-md border px-3 text-sm focus-visible:ring-2"
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <Button
            variant={copied ? 'secondary' : 'primary'}
            size="sm"
            onClick={() => void copy()}
            title={t('copy', lang)}
          >
            {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
          </Button>
        </div>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            <T name="done" />
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <Checkbox
          checked={withPassword}
          onChange={() => setWithPassword((v) => !v)}
          title={t('requirePassword', lang)}
        />
        <T name="requirePassword" />
      </label>

      {withPassword && (
        <div className="relative animate-[fadeIn_120ms_ease-out]">
          <input
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder={t('password', lang)}
            className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring h-10 w-full rounded-md border px-3 pr-10 text-sm focus-visible:ring-2"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 p-1 transition-colors"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? t('hidePassword', lang) : t('showPassword', lang)}
            title={show ? t('hidePassword', lang) : t('showPassword', lang)}
          >
            {show ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
          </button>
        </div>
      )}

      <div>
        <label className="text-muted-foreground mb-1 block text-xs">
          <T name="expires" />
        </label>
        <select
          className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2"
          value={exp}
          onChange={(e) => setExp(e.target.value as typeof exp)}
        >
          <option value="1">{t('day1', lang)}</option>
          <option value="7">{t('day7', lang)}</option>
          <option value="30">{t('day30', lang)}</option>
          <option value="never">{t('never', lang)}</option>
        </select>
      </div>

      {err && <p className="text-destructive text-xs">{err}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>
          <T name="cancel" />
        </Button>
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={busy}>
          <T name="createLink" />
        </Button>
      </div>
    </div>
  )
}

// ---------- move dialog ----------

interface MoveNode {
  id: number
  name: string
  expanded: boolean
  loaded: boolean
  children: MoveNode[]
}

export function MoveDialog({
  movingIDs,
  currentParentID,
  onSelect,
  onCancel,
}: {
  movingIDs: Set<number>
  currentParentID: number | null
  onSelect: (target: number | null) => void
  onCancel: () => void
}) {
  const [tree, setTree] = useState<MoveNode[]>([])
  const [target, setTarget] = useState<number | null>(currentParentID)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const rows = await list(null)
        setTree(
          rows
            .filter((n) => n.type === 'folder' && !movingIDs.has(n.id))
            .map((n) => toMoveNode(n.id, n.name)),
        )
        setLoaded(true)
      } catch (err) {
        toast.error((err as Error).message)
      }
    })()
  }, [movingIDs])

  const expand = async (n: MoveNode) => {
    if (n.loaded) {
      n.expanded = !n.expanded
      setTree([...tree])
      return
    }
    try {
      const rows = await list(n.id)
      n.children = rows
        .filter((r) => r.type === 'folder' && !movingIDs.has(r.id))
        .map((r) => toMoveNode(r.id, r.name))
      n.loaded = true
      n.expanded = true
      setTree([...tree])
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setTarget(null)}
        className={cx(
          'hover:bg-accent flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
          target === null ? 'bg-accent text-accent-foreground' : undefined,
        )}
      >
        <FolderOpenIcon className="text-primary size-4" />
        <T name="myDrive" />
      </button>
      <div className="border-border/60 max-h-72 overflow-auto rounded-md border p-1">
        {!loaded ? (
          <div className="text-muted-foreground p-3 text-sm">…</div>
        ) : tree.length === 0 ? (
          <div className="text-muted-foreground p-3 text-xs">—</div>
        ) : (
          tree.map((n) => (
            <TreeNode
              key={n.id}
              node={n}
              depth={0}
              target={target}
              onSelect={setTarget}
              onExpand={expand}
            />
          ))
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          <T name="cancel" />
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || target === currentParentID}
          onClick={async () => {
            setBusy(true)
            try {
              await onSelect(target)
            } finally {
              setBusy(false)
            }
          }}
        >
          <T name="moveHere" />
        </Button>
      </div>
    </div>
  )
}

function toMoveNode(id: number, name: string): MoveNode {
  return { id, name, expanded: false, loaded: false, children: [] }
}

const TreeNode = memo(function TreeNode({
  node,
  depth,
  target,
  onSelect,
  onExpand,
}: {
  node: MoveNode
  depth: number
  target: number | null
  onSelect: (id: number) => void
  onExpand: (n: MoveNode) => void
}) {
  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        className={cx(
          'hover:bg-accent flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
          target === node.id ? 'bg-accent text-accent-foreground' : undefined,
        )}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        <span
          role="button"
          aria-label="expand"
          tabIndex={-1}
          className="hover:bg-background/60 -m-1 inline-flex size-5 items-center justify-center rounded p-1"
          onClick={(e) => {
            e.stopPropagation()
            void onExpand(node)
          }}
        >
          <ChevronRightIcon
            className={cx(
              'size-3 transition-transform',
              node.expanded ? 'rotate-90' : undefined,
            )}
          />
        </span>
        <FolderIcon className="text-primary fill-primary/15 size-4" />
        <span className="flex-1 truncate">{node.name}</span>
      </button>
      {node.expanded &&
        node.children.map((c) => (
          <TreeNode
            key={c.id}
            node={c}
            depth={depth + 1}
            target={target}
            onSelect={onSelect}
            onExpand={onExpand}
          />
        ))}
    </div>
  )
})
