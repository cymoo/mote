import { MoonIcon, SunIcon } from 'lucide-react'
import { ComponentProps, useEffect } from 'react'
import { create } from 'zustand'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import type { TranslationKey } from '@/components/translation.tsx'

export type ThemeMode = 'light' | 'dark'

export const COLOR_THEMES = [
  {
    id: 'classic',
    labelKey: 'themeClassic',
    swatches: ['220 98% 36%', '174 42% 65%', '229 20% 20%'],
  },
  {
    id: 'ink',
    labelKey: 'themeInk',
    swatches: ['45 38% 96%', '24 78% 40%', '36 12% 9%'],
  },
  {
    id: 'sakura',
    labelKey: 'themeSakura',
    swatches: ['330 70% 98%', '340 82% 57%', '318 24% 12%'],
  },
  {
    id: 'moss',
    labelKey: 'themeMoss',
    swatches: ['82 28% 95%', '142 42% 34%', '128 20% 10%'],
  },
  {
    id: 'dune',
    labelKey: 'themeDune',
    swatches: ['39 87% 96%', '28 88% 47%', '27 28% 11%'],
  },
  {
    id: 'fjord',
    labelKey: 'themeFjord',
    swatches: ['207 48% 97%', '199 86% 39%', '216 32% 10%'],
  },
  {
    id: 'rouge',
    labelKey: 'themeRouge',
    swatches: ['355 42% 97%', '350 74% 38%', '344 32% 9%'],
  },
  {
    id: 'voltage',
    labelKey: 'themeVoltage',
    swatches: ['74 100% 96%', '82 96% 55%', '230 38% 7%'],
  },
] as const satisfies readonly {
  id: string
  labelKey: TranslationKey
  swatches: readonly [string, string, string]
}[]

export type ColorTheme = (typeof COLOR_THEMES)[number]['id']

export function ThemeToggle({ className, ...props }: ComponentProps<typeof Button>) {
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    const handler = (event: MediaQueryListEvent) => {
      if (localStorage.getItem(THEME_MODE_STORE_KEY)) return
      setTheme(event.matches ? 'dark' : 'light', { persist: false })
    }
    mql.addEventListener('change', handler)
    return () => {
      mql.removeEventListener('change', handler)
    }
  }, [setTheme])

  return (
    <Button
      className={cx('ring-inset hover:bg-transparent', className)}
      variant="ghost"
      aria-label="toggle dark mode"
      onClick={() => {
        const nextTheme = theme === 'light' ? 'dark' : 'light'
        setTheme(nextTheme)
      }}
      {...props}
    >
      {theme === 'dark' ? (
        <MoonIcon className="size-6 align-middle text-yellow-400" />
      ) : (
        <SunIcon className="size-6 align-middle text-yellow-500" />
      )}
    </Button>
  )
}

const mql = window.matchMedia('(prefers-color-scheme: dark)')
const THEME_MODE_STORE_KEY = 'theme'
const COLOR_THEME_STORE_KEY = 'colorTheme'

const isThemeMode = (value: string | null): value is ThemeMode =>
  value === 'light' || value === 'dark'

const isColorTheme = (value: string | null): value is ColorTheme =>
  COLOR_THEMES.some((theme) => theme.id === value)

const getInitialThemeMode = (): ThemeMode => {
  const storedTheme = localStorage.getItem(THEME_MODE_STORE_KEY)
  if (isThemeMode(storedTheme)) return storedTheme
  return mql.matches ? 'dark' : 'light'
}

const getInitialColorTheme = (): ColorTheme => {
  const storedColorTheme = localStorage.getItem(COLOR_THEME_STORE_KEY)
  if (isColorTheme(storedColorTheme)) return storedColorTheme
  return 'classic'
}

const applyTheme = (theme: ThemeMode, colorTheme: ColorTheme) => {
  document.documentElement.dataset.theme = theme
  document.documentElement.dataset.colorTheme = colorTheme
  document.documentElement.style.colorScheme = theme
}

const initTheme = () => {
  const theme = getInitialThemeMode()
  const colorTheme = getInitialColorTheme()
  applyTheme(theme, colorTheme)
  return { theme, colorTheme }
}

export const useTheme = create<{
  theme: ThemeMode
  colorTheme: ColorTheme
  setTheme: (theme: ThemeMode, options?: { persist?: boolean }) => void
  setColorTheme: (colorTheme: ColorTheme) => void
}>((set) => {
  const initialTheme = initTheme()

  return {
    ...initialTheme,
    setTheme: (theme, options = { persist: true }) => {
      set((state) => {
        applyTheme(theme, state.colorTheme)
        if (options.persist) {
          localStorage.setItem(THEME_MODE_STORE_KEY, theme)
        }
        return { theme }
      })
    },
    setColorTheme: (colorTheme) => {
      set((state) => {
        applyTheme(state.theme, colorTheme)
        localStorage.setItem(COLOR_THEME_STORE_KEY, colorTheme)
        return { colorTheme }
      })
    },
  }
})
