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
    swatches: ['0 12% 99%', '352 82% 38%', '355 22% 8%'],
  },
  {
    id: 'sakura',
    labelKey: 'themeSakura',
    swatches: ['220 20% 99%', '185 100% 34%', '225 30% 6%'],
  },
  {
    id: 'moss',
    labelKey: 'themeMoss',
    swatches: ['160 50% 97%', '163 70% 28%', '165 38% 8%'],
  },
  {
    id: 'aurora',
    labelKey: 'themeAurora',
    swatches: ['272 65% 98%', '268 72% 42%', '268 46% 8%'],
  },
  {
    id: 'fjord',
    labelKey: 'themeFjord',
    swatches: ['22 80% 97%', '16 88% 48%', '258 40% 10%'],
  },
  {
    id: 'blueprint',
    labelKey: 'themeBlueprint',
    swatches: ['38 12% 99%', '22 96% 52%', '0 4% 6%'],
  },
  {
    id: 'candy',
    labelKey: 'themeCandy',
    swatches: ['42 42% 97%', '35 88% 38%', '26 28% 8%'],
  },
] as const satisfies readonly {
  id: string
  labelKey: TranslationKey
  swatches: readonly [string, string, string]
}[]

export type ColorTheme = (typeof COLOR_THEMES)[number]['id']

const LEGACY_COLOR_THEME_MAP: Record<string, ColorTheme> = {
  dune: 'aurora',
  rouge: 'blueprint',
  voltage: 'candy',
}

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
  const migratedColorTheme = storedColorTheme ? LEGACY_COLOR_THEME_MAP[storedColorTheme] : undefined
  if (migratedColorTheme) {
    localStorage.setItem(COLOR_THEME_STORE_KEY, migratedColorTheme)
    return migratedColorTheme
  }
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
