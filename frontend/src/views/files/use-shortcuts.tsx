import {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react'

// Pluggable keyboard shortcuts.
//
// Usage:
//   useShortcuts({
//     'mod+ArrowUp': { run: goUp, when: () => parentID != null, desc: 'Up' },
//     'enter':       { run: openOne, when: () => selected.size === 1, desc: 'Open' },
//   })
//
// Keyspec grammar (case-insensitive):
//   modifiers: mod | meta | ctrl | shift | alt   (mod = Cmd on Mac, Ctrl elsewhere)
//   key:       single letter/digit, '/', '?', or one of:
//              ArrowUp ArrowDown ArrowLeft ArrowRight
//              Enter Escape Esc Delete Del Backspace Space Tab
//
// Bindings auto-skip when the user is typing in an input/textarea/contenteditable,
// EXCEPT for 'esc' which must always be able to escape an input.

export interface Binding {
  run: (e: KeyboardEvent) => void
  when?: () => boolean
  desc: string
  keys: string // resolved display label, filled by the hook
}

type BindingMap = Record<string, Omit<Binding, 'keys'>>

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)

interface Parsed {
  key: string // lower-case canonical key
  mod: boolean // command on Mac, control elsewhere
  ctrl: boolean
  shift: boolean
  alt: boolean
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  space: ' ',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  arrowleft: 'arrowleft',
  arrowright: 'arrowright',
}

function parseSpec(spec: string): Parsed {
  const parts = spec.split('+').map((p) => p.trim().toLowerCase())
  const out: Parsed = { key: '', mod: false, ctrl: false, shift: false, alt: false }
  for (const p of parts) {
    if (p === 'mod' || p === 'meta' || p === 'cmd') out.mod = true
    else if (p === 'ctrl' || p === 'control') out.ctrl = true
    else if (p === 'shift') out.shift = true
    else if (p === 'alt' || p === 'option') out.alt = true
    else out.key = KEY_ALIASES[p] ?? p
  }
  return out
}

function eventMatches(e: KeyboardEvent, p: Parsed): boolean {
  const modPressed = isMac ? e.metaKey : e.ctrlKey
  if (p.mod && !modPressed) return false
  if (!p.mod && modPressed && !p.ctrl) {
    // Spec didn't ask for mod but mod is held — only match if spec also wants ctrl
    // (which is then handled below). Prevents "/" matching "cmd+/" by accident.
    return false
  }
  if (p.ctrl && !e.ctrlKey) return false
  if (p.shift !== e.shiftKey) return false
  if (p.alt !== e.altKey) return false
  const k = e.key.toLowerCase()
  // "?" is shift+/, but we let users write '?' directly. Match either.
  if (p.key === '?') return k === '?' || (e.shiftKey && k === '/')
  return k === p.key
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function displayLabel(spec: string): string {
  const p = parseSpec(spec)
  const parts: string[] = []
  if (p.mod) parts.push(isMac ? '⌘' : 'Ctrl')
  if (p.ctrl && !p.mod) parts.push('Ctrl')
  if (p.alt) parts.push(isMac ? '⌥' : 'Alt')
  if (p.shift) parts.push(isMac ? '⇧' : 'Shift')
  const keyMap: Record<string, string> = {
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
    escape: 'Esc',
    enter: '↵',
    backspace: '⌫',
    delete: 'Del',
    ' ': 'Space',
  }
  parts.push(keyMap[p.key] ?? p.key.toUpperCase())
  return parts.join(isMac ? '' : '+')
}

// ---------- context ----------

interface ShortcutsCtx {
  register: (id: number, bindings: Binding[]) => void
  unregister: (id: number) => void
  getActive: () => Binding[]
}

const Ctx = createContext<ShortcutsCtx | null>(null)

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  // Plain refs — no re-renders when bindings change. Cheatsheet reads
  // synchronously when opened.
  const groupsRef = useRef<Map<number, Binding[]>>(new Map())
  const value = useMemo<ShortcutsCtx>(
    () => ({
      register: (id, bs) => {
        groupsRef.current.set(id, bs)
      },
      unregister: (id) => {
        groupsRef.current.delete(id)
      },
      getActive: () => {
        const out: Binding[] = []
        for (const bs of groupsRef.current.values()) out.push(...bs)
        return out
      },
    }),
    [],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

let groupSeq = 0

export function useShortcuts(map: BindingMap) {
  const ctx = useContext(Ctx)
  // Capture latest map in a ref so the effect doesn't re-bind on every render.
  const latest = useRef(map)
  latest.current = map

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const typing = isTypingTarget(e.target)
      for (const [spec, b] of Object.entries(latest.current)) {
        const parsed = parseSpec(spec)
        if (typing && parsed.key !== 'escape') continue
        if (!eventMatches(e, parsed)) continue
        if (b.when && !b.when()) continue
        e.preventDefault()
        e.stopPropagation()
        b.run(e)
        return
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Push current bindings into context so the cheatsheet can list them.
  const id = useMemo(() => ++groupSeq, [])
  useEffect(() => {
    if (!ctx) return
    const list: Binding[] = Object.entries(map).map(([spec, b]) => ({
      ...b,
      keys: displayLabel(spec),
    }))
    ctx.register(id, list)
    return () => ctx.unregister(id)
  }, [ctx, id, map])
}

export function useActiveShortcuts(): Binding[] {
  const ctx = useContext(Ctx)
  return ctx?.getActive() ?? []
}
