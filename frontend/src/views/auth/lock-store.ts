import { create } from 'zustand'

export const PRIVACY_COVER_SESSION_KEY = 'privacyCoverLocked'

interface PrivacyCoverState {
  locked: boolean
  lock: () => void
  unlock: () => void
  toggle: () => void
}

function readLocked() {
  if (typeof window === 'undefined') return false
  return window.sessionStorage.getItem(PRIVACY_COVER_SESSION_KEY) === 'true'
}

function writeLocked(locked: boolean) {
  if (typeof window === 'undefined') return
  if (locked) {
    window.sessionStorage.setItem(PRIVACY_COVER_SESSION_KEY, 'true')
  } else {
    window.sessionStorage.removeItem(PRIVACY_COVER_SESSION_KEY)
  }
}

export const usePrivacyCover = create<PrivacyCoverState>((set) => ({
  locked: readLocked(),
  lock: () => {
    writeLocked(true)
    set({ locked: true })
  },
  unlock: () => {
    writeLocked(false)
    set({ locked: false })
  },
  toggle: () => {
    set((state) => {
      const locked = !state.locked
      writeLocked(locked)
      return { locked }
    })
  },
}))
