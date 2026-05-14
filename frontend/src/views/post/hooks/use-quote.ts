import { Location } from 'react-router'
import { create } from 'zustand/index'

interface Post {
  id: number
  content: string
}

interface QuoteState {
  quote: Post | null
  setQuote: (post: Post | null) => void | Promise<void>
}

export const useQuote = create<QuoteState>((set) => ({
  quote: null,
  setQuote: async (post: Post | null) => {
    set({ quote: post })

    if (!post) {
      return
    }

    const bg = history.state?.usr?.backgroundLocation as Location | undefined
    if (bg) {
      if (bg.pathname === '/') {
        await window.navigate(bg.pathname + bg.search)
      } else {
        await window.navigate('/')
      }
    } else {
      if (location.pathname !== '/') {
        await window.navigate('/')
      }
    }

    const editorOrTrigger =
      document.querySelector<HTMLDivElement>('#main-editor [contenteditable="true"]') ??
      document.querySelector<HTMLButtonElement>('#main-editor-trigger')

    if (editorOrTrigger instanceof HTMLButtonElement) {
      editorOrTrigger.click()
    } else {
      editorOrTrigger?.focus()
    }
  },
}))
