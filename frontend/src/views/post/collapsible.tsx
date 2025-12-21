import { ChevronDown as DownIcon, ChevronUp as UpIcon } from 'lucide-react'
import { ComponentProps, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { T } from '@/components/translation.tsx'

import { Post } from './post-list.tsx'

// NOTE: Items outside the viewport are unmounted when using virtual list.
// As a result, expanded items will collapse when they become visible again.
// This variable is used to persist the expanded state of items.
const expandedItems = new Set<number>()

interface CollapsibleProps extends ComponentProps<'div'> {
  post: Post
  maxHeight: number
  scrollIntoView: () => void
}

// A collapsible content component that can expand/collapse long content
export function CollapsibleContent({
  post,
  maxHeight,
  scrollIntoView,
  className,
  ...props
}: CollapsibleProps) {
  const [collapsable, setCollapsable] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  const ref = useRef<HTMLDivElement>(null!)

  useLayoutEffect(() => {
    const el = ref.current

    const collapsable = el.scrollHeight > maxHeight
    setCollapsable(collapsable)
    if (!expandedItems.has(post.id)) {
      setCollapsed(collapsable)
    }
    // NOTE: Re-run this effect when the content changes
  }, [maxHeight, post.content.length])

  useCodeBlockEnhancer(ref)

  const toggleCollapsed = () => {
    const nextCollapsed = !collapsed

    if (nextCollapsed) {
      scrollIntoView()
      expandedItems.delete(post.id)
    } else {
      expandedItems.add(post.id)
    }

    setCollapsed(nextCollapsed)
  }

  return (
    <>
      <div
        ref={ref}
        className={cx({ 'clamp-mask overflow-hidden': collapsed }, 'outline-none', className)}
        style={{ maxHeight: collapsed ? maxHeight : undefined }}
        dangerouslySetInnerHTML={{ __html: post.content }}
        onDoubleClick={() => {
          toggleCollapsed()
        }}
        {...props}
      />
      {collapsable && (
        <div className="mt-2">
          <Button
            className="hover:text-primary -ml-4 ring-inset hover:bg-transparent text-foreground/80"
            variant="ghost"
            aria-label={`${collapsed ? 'expand' : 'fold'} content`}
            onClick={() => {
              toggleCollapsed()
            }}
          >
            <ToggleIcon collapsed={collapsed} />
          </Button>
        </div>
      )}
    </>
  )
}

function ToggleIcon({ collapsed }: { collapsed: boolean }) {
  const text = collapsed ? 'expand' : 'collapse'
  const Icon = collapsed ? DownIcon : UpIcon

  return (
    <>
      <T name={text} />
      <Icon className="ml-1 size-4" aria-hidden="true" />
    </>
  )
}

// Enhance code blocks with line spans and copy buttons
function useCodeBlockEnhancer(ref: RefObject<HTMLElement>) {
  useLayoutEffect(() => {
    const container = ref.current
    if (!container) return

    container.querySelectorAll('pre > code').forEach((code) => {
      const pre = code.parentElement!

      if (pre.classList.contains('enhanced')) return

      const text = code.textContent || ''
      const lines = text.split('\n')

      code.innerHTML = lines.map((line) => `<span>${line || ''}</span>`).join('\n')

      const btn = document.createElement('button')
      btn.className = 'code-copy-btn'
      btn.title = 'Copy code'
      btn.textContent = '📄'

      pre.classList.add('enhanced')
      pre.insertBefore(btn, code)
    })
  })
}

// Global listener for code copy buttons
if (typeof document !== 'undefined') {
  let listenerAdded = false

  const ensureGlobalListener = () => {
    if (listenerAdded) return

    document.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.classList.contains('code-copy-btn')) return

      e.preventDefault()
      const code = target.parentElement?.querySelector('code')
      const text = code?.textContent || ''

      navigator.clipboard.writeText(text)
      target.textContent = '✅'
      setTimeout(() => (target.textContent = '📄'), 2000)
    })

    listenerAdded = true
  }

  ensureGlobalListener()
}
