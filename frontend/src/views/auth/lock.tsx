import { useEffect, useRef } from 'react'

import { LockIcon } from 'lucide-react'

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
      className="fixed inset-0 z-[9999] flex cursor-default items-center justify-center focus:outline-none"
      style={{
        backgroundColor: 'var(--lock-overlay-bg)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      }}
      onKeyDown={(event) => {
        if (event.key === 'Tab') event.preventDefault()
      }}
    >
      <LockIcon className="size-8 text-foreground/30" aria-hidden="true" />
      <T name="appLocked" className="sr-only" />
    </div>
  )
}
