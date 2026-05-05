import { useCallback, useEffect, useReducer, useState, useSyncExternalStore } from 'react'

import { uploadManager } from './upload-manager'

export type SortKey = 'name' | 'size' | 'updated_at'
export type SortDir = 'asc' | 'desc'

const SORT_KEY_STORE = 'drive_sort_key'
const SORT_DIR_STORE = 'drive_sort_dir'

// Selection ----------------------------------------------------------------

export function useSelection<T extends { id: number }>(items: readonly T[]) {
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const toggle = useCallback((id: number, additive: boolean) => {
    setSelected((s) => {
      if (additive) {
        const next = new Set(s)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }
      // Plain click: if already the only one, clear; else single-select.
      if (s.size === 1 && s.has(id)) return new Set()
      return new Set([id])
    })
  }, [])

  const toggleAll = useCallback(() => {
    setSelected((s) => (s.size === items.length ? new Set() : new Set(items.map((n) => n.id))))
  }, [items])

  const clear = useCallback(() => setSelected(new Set()), [])

  return { selected, setSelected, toggle, toggleAll, clear }
}

// Sort ---------------------------------------------------------------------

type SortState = { sortKey: SortKey; sortDir: SortDir }

function sortReducer(state: SortState, key: SortKey): SortState {
  if (key === state.sortKey) {
    return { sortKey: key, sortDir: state.sortDir === 'asc' ? 'desc' : 'asc' }
  }
  return { sortKey: key, sortDir: 'asc' }
}

export function useSort() {
  const [{ sortKey, sortDir }, dispatch] = useReducer(sortReducer, {
    sortKey: (localStorage.getItem(SORT_KEY_STORE) as SortKey) || 'name',
    sortDir: (localStorage.getItem(SORT_DIR_STORE) as SortDir) || 'asc',
  })

  useEffect(() => {
    localStorage.setItem(SORT_KEY_STORE, sortKey)
    localStorage.setItem(SORT_DIR_STORE, sortDir)
  }, [sortKey, sortDir])

  const onSort = useCallback((k: SortKey) => dispatch(k), [])

  return { sortKey, sortDir, onSort }
}

// Cookie sync (downloads / PhotoSwipe rely on cookie auth) -----------------

export function useCookieAuthSync() {
  useEffect(() => {
    const tok = localStorage.getItem('token')
    if (!tok) return
    if (!document.cookie.split(';').some((c) => c.trim().startsWith('token='))) {
      const expires = new Date()
      expires.setDate(expires.getDate() + 365 * 10)
      document.cookie = `token=${tok}; expires=${expires.toUTCString()}; path=/`
    }
  }, [])
}

// Refresh on upload completion --------------------------------------------

export function useRefreshOnUploadComplete(refresh: () => void) {
  useEffect(() => uploadManager.onCompleted(() => refresh()), [refresh])
}

// Show dot files toggle ---------------------------------------------------

const SHOW_DOT_FILES_STORE = 'drive_show_dotfiles'

export function useShowDotFiles() {
  const [showDotFiles, setShowDotFiles] = useState(
    () => localStorage.getItem(SHOW_DOT_FILES_STORE) === 'true',
  )

  const toggleShowDotFiles = useCallback(() => {
    setShowDotFiles((v) => {
      const next = !v
      localStorage.setItem(SHOW_DOT_FILES_STORE, String(next))
      return next
    })
  }, [])

  return { showDotFiles, toggleShowDotFiles }
}

// Mobile breakpoint detection ---------------------------------------------

// Aligned with Tailwind's `md` (768px). Pages branch a small number of
// behaviors on this (e.g. ListRow click = open vs toggle). Visual styling
// should still prefer responsive Tailwind classes over reading this hook.
const MOBILE_QUERY = '(max-width: 767.98px)'

function subscribeMobile(cb: () => void) {
  if (typeof window === 'undefined') return () => {}
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener('change', cb)
  return () => mql.removeEventListener('change', cb)
}

function getMobileSnapshot() {
  if (typeof window === 'undefined') return false
  return window.matchMedia(MOBILE_QUERY).matches
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribeMobile,
    getMobileSnapshot,
    () => false,
  )
}
