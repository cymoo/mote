import { useLayoutEffect, useRef, useState } from 'react'
import { Outlet } from 'react-router'

import { cx } from '@/utils/css.ts'

import { Dialog, DialogContent } from '@/components/dialog'
import { useStableNavigate } from '@/components/router.tsx'

import { useIsSmallDevice } from '@/views/layout/hooks.tsx'

export interface SearchOutletContext {
  close: () => void
}

/**
 * Presents the `/search` route as a command-palette-style panel: a top-anchored,
 * centered floating card on desktop and a full-screen sheet on touch — not a side
 * drawer. Kept separate from `DrawerOutlet` (which still owns `/p/:id`).
 */
export const SearchOutlet = () => {
  const navigate = useStableNavigate()
  const sm = useIsSmallDevice()
  const [open, setOpen] = useState(false)
  const closing = useRef(false)

  useLayoutEffect(() => {
    setOpen(true)
  }, [])

  const close = () => {
    if (closing.current) return
    closing.current = true
    setOpen(false)
    // Let the exit transition play, then drop /search from the URL.
    setTimeout(() => {
      void navigate(-1)
    }, 240)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true)
        else close()
      }}
    >
      <DialogContent
        overlayClassName={cx('bg-black/40 backdrop-blur-md', sm ? 'items-stretch' : 'items-start')}
        className={cx(
          'flex flex-col gap-0! overflow-hidden p-0! shadow-2xl',
          sm
            ? 'h-[100dvh]! w-full! max-w-none! rounded-none! border-0!'
            : 'mt-[7.5vh] h-[72vh] w-[min(672px,100%)]! max-w-none! rounded-2xl!',
        )}
      >
        <Outlet context={{ close } satisfies SearchOutletContext} />
      </DialogContent>
    </Dialog>
  )
}
