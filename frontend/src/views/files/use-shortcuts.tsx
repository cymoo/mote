import { useEffect, useRef } from 'react'

// Pluggable keyboard shortcuts.
//
// Usage:
//   useShortcuts({
//     'mod+ArrowUp': { run: goUp, when: () => parentID != null },
//     'enter':       { run: openOne, when: () => selected.size === 1 },
//   })
//
// Keyspec grammar (case-insensitive):
//   modifiers: mod | meta | ctrl | shift | alt   (mod = Cmd on Mac, Ctrl elsewhere)
//   key:       single letter/digit, '/', '?', or one of:
//              ArrowUp ArrowDown ArrowLeft ArrowRight
//              Enter Escape Esc Delete Del Backspace Space Tab
//
// Shortcuts auto-skip when the user is typing in an input/textarea/contenteditable,
// EXCEPT for 'esc' which must always be able to escape an input.
// Shortcuts also skip whenever a modal/dialog is open, so dialog buttons own
// the keyboard and don't double-trigger page actions.

interface Binding {
  run: (e: KeyboardEvent) => void
  when?: () => boolean
}

type BindingMap = Record<string, Binding>

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)

interface Parsed {
  key: string
  mod: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  space: ' ',
}

function parseSpec(spec: string): Parsed {
  const out: Parsed = { key: '', mod: false, ctrl: false, shift: false, alt: false }
  for (const p of spec.split('+').map((x) => x.trim().toLowerCase())) {
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
  // Spec didn't ask for mod but mod is held — bail unless spec also wants ctrl
  // (handled below). Prevents '/' matching cmd+/ by accident.
  if (!p.mod && modPressed && !p.ctrl) return false
  if (p.ctrl && !e.ctrlKey) return false
  if (p.alt !== e.altKey) return false
  const k = e.key.toLowerCase()
  // '?' is shift+/ on most layouts. Match either form, ignoring shift state
  // since typing '?' inherently requires shift.
  if (p.key === '?') return k === '?' || (e.shiftKey && k === '/')
  if (p.shift !== e.shiftKey) return false
  return k === p.key
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function useShortcuts(map: BindingMap) {
  // Capture latest map in a ref so the effect doesn't re-bind every render.
  const latest = useRef(map)
  latest.current = map

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't fire while a modal/dialog is open: their own buttons should own
      // the keyboard.
      if (document.querySelector('[role="dialog"]')) return
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
}
