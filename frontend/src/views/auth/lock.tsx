import { useEffect, useRef } from 'react'

import { useShortcuts } from '@/utils/hooks/use-shortcuts.ts'

import { T, t, useLang } from '@/components/translation.tsx'

import { usePrivacyCover } from './lock-store.ts'

export function PrivacyCoverShortcut() {
  const toggle = usePrivacyCover((state) => state.toggle)

  useShortcuts({
    'mod+shift+l': { run: toggle },
  })

  return null
}

export function PrivacyCoverOverlay() {
  const locked = usePrivacyCover((state) => state.locked)
  const ref = useRef<HTMLDivElement>(null)
  const { lang } = useLang()

  useEffect(() => {
    if (!locked) return

    const overlay = ref.current
    overlay?.focus()

    const keepFocusOnOverlay = (event: FocusEvent) => {
      if (!overlay || event.target === overlay) return
      overlay.focus()
    }

    document.addEventListener('focusin', keepFocusOnOverlay)
    return () => {
      document.removeEventListener('focusin', keepFocusOnOverlay)
    }
  }, [locked])

  if (!locked) return null

  return (
    <div
      ref={ref}
      tabIndex={-1}
      aria-label={t('appLocked', lang)}
      className="bg-background/40 dark:bg-background/55 fixed inset-0 z-[9999] cursor-default backdrop-blur-2xl backdrop-saturate-50 focus:outline-none"
      onKeyDown={(event) => {
        if (event.key === 'Tab') event.preventDefault()
      }}
    >
      <T name="appLocked" className="sr-only" />
    </div>
  )
}
