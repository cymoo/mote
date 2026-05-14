import { ComponentProps, useState } from 'react'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeading,
  DialogTrigger,
} from '@/components/dialog.tsx'
import { RadioButton } from '@/components/radio-button.tsx'
import { T, t, useLang } from '@/components/translation.tsx'

import { useIdleTimeout } from '@/views/auth/hooks.tsx'

import { COLOR_THEMES, useTheme } from '@/views/sidebar/theme-toggle.tsx'
import type { ColorTheme, ThemeMode } from '@/views/sidebar/theme-toggle.tsx'

export function SettingDialog({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Dialog>
      <DialogTrigger asChild={true}>
        <Button
          className={cx('text-foreground/85 justify-start! ring-inset text-base!', className)}
          variant="ghost"
          {...props}
        >
          <T name="settings" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[min(90vh,760px)] max-w-2xl! overflow-y-auto">
        <DialogHeading>
          <T name="settings" />
        </DialogHeading>
        <DialogDescription className="sr-only">
          <T name="settingsDescription" />
        </DialogDescription>
        <Setting />
        <DialogClose />
      </DialogContent>
    </Dialog>
  )
}

export function Setting(props: ComponentProps<'div'>) {
  const [fs, setFs] = useState(window.localStorage.getItem('baseFontSize') || '16px')
  const { timeout, setTimeout } = useIdleTimeout()
  const { theme, colorTheme, setTheme, setColorTheme } = useTheme()

  const { lang, setLang } = useLang()
  const min = t('minute', lang, false)
  const hour = t('hour', lang, false)

  return (
    <div {...props}>
      <h3 className="text-foreground/80 mb-3">
        <T name="theme" />
      </h3>
      <RadioButton<ColorTheme>
        value={colorTheme}
        onChange={(value) => {
          if (!value) return
          setColorTheme(value)
        }}
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
        options={COLOR_THEMES.map(({ id, labelKey }) => ({
          label: <T name={labelKey} />,
          value: id,
        }))}
        renderLabel={(option) => {
          const item = COLOR_THEMES.find((theme) => theme.id === option.value)
          return (
            <label
              className={cx(
                'bg-card text-card-foreground block min-h-24 rounded-xl border border-input p-3 text-left text-sm transition-all hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                option.value === colorTheme
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/60'
                  : undefined,
              )}
            >
              <span className="font-medium">{option.label}</span>
              <span className="mt-3 flex gap-1" aria-hidden="true">
                {item?.swatches.map((swatch) => (
                  <span
                    key={swatch}
                    className="h-8 flex-1 rounded-md border border-black/10 shadow-inner dark:border-white/10"
                    style={{ backgroundColor: `hsl(${swatch})` }}
                  />
                ))}
              </span>
            </label>
          )
        }}
      />
      <h3 className="text-foreground/80 mt-4 mb-3">
        <T name="appearance" />
      </h3>
      <RadioButton<ThemeMode>
        value={theme}
        onChange={(value) => {
          if (!value) return
          setTheme(value)
        }}
        options={[
          { label: <T name="lightMode" />, value: 'light' },
          { label: <T name="darkMode" />, value: 'dark' },
        ]}
      />
      <h3 className="text-foreground/80 mt-4 mb-3">
        <T name="fontSize" />
      </h3>
      <RadioButton
        value={fs}
        onChange={(value) => {
          if (!value) return
          setFs(value)
          document.documentElement.style.fontSize = value
          window.localStorage.setItem('baseFontSize', value)
        }}
        options={[
          { label: <T name="large" />, value: '18px' },
          { label: <T name="medium" />, value: '16px' },
          { label: <T name="small" />, value: '14px' },
        ]}
      />
      <h3 className="text-foreground/80 mt-4 mb-3">
        <T name="language" />
      </h3>
      <RadioButton
        value={lang}
        onChange={(value) => {
          if (!value) return
          setLang(value)
        }}
        options={[
          { label: '中文', value: 'zh' },
          { label: 'English', value: 'en' },
        ]}
      />
      <h3 className="text-foreground/80 mt-4 mb-3">
        <T name="logoutWhenInactivity" />
      </h3>
      <RadioButton
        selfToggleable={true}
        value={timeout}
        onChange={(value) => {
          setTimeout(value)
        }}
        options={[
          { label: `5 ${min}`, value: 5 * 60 },
          { label: `30 ${min}`, value: 30 * 60 },
          { label: `6 ${hour}`, value: 6 * 60 * 60 },
        ]}
      />
    </div>
  )
}
