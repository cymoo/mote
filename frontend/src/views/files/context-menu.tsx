import { MouseEvent as ReactMouseEvent, ReactNode, useCallback, useRef, useState } from 'react'

import { Popover, PopoverContent, usePopoverWithInteractions } from '@/components/popover.tsx'

// Desktop right-click context menu built on the shared Popover primitives.
// Positioning uses a point-shaped virtual reference (the click coordinates)
// instead of an anchor element. The Popover's default role="dialog" also
// pauses use-shortcuts while the menu is open, exactly like the kebab menus.

type PopoverRefs = ReturnType<typeof usePopoverWithInteractions>['refs']

export function useContextMenu<P>() {
  const refs = useRef<PopoverRefs | null>(null)
  const [open, setOpen] = useState(false)
  const [payload, setPayload] = useState<P | null>(null)

  const openAt = useCallback((e: ReactMouseEvent, p: P) => {
    // Suppress the native menu and keep the event from reaching the
    // page-level empty-area handler.
    e.preventDefault()
    e.stopPropagation()
    const { clientX: x, clientY: y } = e
    refs.current?.setReference({
      getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
    })
    setPayload(p)
    setOpen(true)
  }, [])

  const close = useCallback(() => setOpen(false), [])

  return { open, setOpen, payload, openAt, close, refs }
}

export function ContextMenu<P>({
  menu,
  children,
}: {
  menu: ReturnType<typeof useContextMenu<P>>
  children: ReactNode
}) {
  return (
    <Popover open={menu.open} onOpenChange={menu.setOpen} refs={menu.refs} placement="bottom-start">
      <PopoverContent>{children}</PopoverContent>
    </Popover>
  )
}
