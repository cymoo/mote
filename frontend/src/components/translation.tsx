import { ReactNode, createContext, useContext, useMemo, useState } from 'react'

import { IS_ZH } from '@/utils/browser'
import { cx } from '@/utils/css.ts'
import { noop } from '@/utils/func.ts'

import en from '@/lang/en.json'
import zh from '@/lang/zh.json'

const dictionaries = { en, zh }

type LangType = 'en' | 'zh'

interface LangContextType {
  lang: LangType
  setLang: (lang: LangType) => void
}

const LangContext = createContext<LangContextType>({
  lang: 'en',
  setLang: noop,
})
const defaultLang = window.localStorage.getItem('lang') ?? (IS_ZH ? 'zh' : 'en')

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, _setLang] = useState<LangType>(defaultLang as LangType)
  const value = useMemo(
    () => ({
      lang: lang,
      setLang: (value: LangType) => {
        _setLang(value)
        window.localStorage.setItem('lang', value)
        document.documentElement.lang = value === 'zh' ? 'zh-CN' : 'en'
      },
    }),
    [lang],
  )

  return <LangContext value={value}>{children}</LangContext>
}

export function useLang() {
  return useContext(LangContext)
}

export type TranslationKey = keyof typeof en

export function T({
  name,
  className,
  capitalized = true,
}: {
  name: TranslationKey
  capitalized?: boolean
  className?: string
}) {
  const { lang } = useLang()
  const value = t(name, lang)
  if (capitalized) {
    // NOTE: why inline-block: https://stackoverflow.com/questions/7631722/css-first-letter-not-working
    return <span className={cx('inline-block first-letter:capitalize', className)}>{value}</span>
  } else {
    if (className) {
      return <span className={className}>{value}</span>
    } else {
      return value
    }
  }
}

export function t(
  name: TranslationKey,
  lang: LangType = 'en',
  capitalized = true,
  ...replacements: string[]
): string {
  let rv = dictionaries[lang][name]
  if (rv) {
    replacements.forEach((repl, idx) => {
      rv = rv.replace(`{${idx.toString()}}`, repl)
    })

    if (capitalized) rv = capitalizeFirstLetter(rv)
  }
  return rv
}

function capitalizeFirstLetter(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
