import { T, t } from '@/components/translation.tsx'

import { useActiveShortcuts } from './use-shortcuts'

type Lang = 'en' | 'zh'

export function ShortcutsCheatsheet({ lang }: { lang: Lang }) {
  // Read at render time so we always reflect the currently mounted page's
  // bindings (the modal mounts fresh each open).
  const bindings = useActiveShortcuts()
  return (
    <div className="min-w-[18rem] py-2 text-sm">
      <ul className="divide-border/60 divide-y">
        {bindings.length === 0 && (
          <li className="text-muted-foreground py-2">
            <T name="noShortcuts" />
          </li>
        )}
        {bindings.map((b, i) => (
          <li key={i} className="flex items-center justify-between gap-6 py-2">
            <span className="text-foreground/90">{b.desc}</span>
            <kbd className="bg-muted text-muted-foreground rounded border border-black/5 px-1.5 py-0.5 font-mono text-xs tracking-wide tabular-nums shadow-sm dark:border-white/10">
              {b.keys}
            </kbd>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground mt-3 text-xs">{t('shortcutsHint', lang)}</p>
    </div>
  )
}
