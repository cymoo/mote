import { MoonIcon, SunIcon } from 'lucide-react'
import { ComponentProps, useEffect } from 'react'
import { create } from 'zustand'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import type { TranslationKey } from '@/components/translation.tsx'

export type ThemeMode = 'light' | 'dark'

export const COLOR_THEMES = [
  {
    id: 'celadon',
    labelKey: 'themeCeladon',
    swatches: ['158 26% 88%', '170 58% 30%', '172 26% 9%'],
  },
  {
    id: 'dawn',
    labelKey: 'themeDawn',
    swatches: ['40 26% 90%', '216 78% 49%', '226 22% 11.5%'],
  },
  {
    id: 'ink',
    labelKey: 'themeInk',
    swatches: ['28 10% 90%', '9 68% 46%', '24 6% 8%'],
  },
  {
    id: 'wisteria',
    labelKey: 'themeWisteria',
    swatches: ['278 24% 90%', '278 56% 52%', '276 28% 11%'],
  },
] as const satisfies readonly {
  id: string
  labelKey: TranslationKey
  swatches: readonly [string, string, string]
}[]

export type ColorTheme = (typeof COLOR_THEMES)[number]['id']

const LEGACY_COLOR_THEME_MAP: Record<string, ColorTheme> = {
  classic: 'celadon',
  moss: 'celadon',
  candy: 'celadon',
  voltage: 'celadon',
  nocturne: 'wisteria',
  sakura: 'wisteria',
  aurora: 'wisteria',
  fjord: 'wisteria',
  dune: 'wisteria',
  blueprint: 'ink',
  rouge: 'ink',
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
  return 'celadon'
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
