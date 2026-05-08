import { Circle as CircleIcon } from 'lucide-react'
import { ReactNode } from 'react'
import { useLocation, useSearchParams } from 'react-router'

import { formatDate } from '@/utils/date.ts'
import { useWindowSize } from '@/utils/hooks/use-window-size.ts'

import { T, t, useLang } from '@/components/translation.tsx'

import { CONTENT_WIDTH, SIDEBAR_WIDTH } from '@/constants.ts'

export function useIsSmallDevice() {
  const { width } = useWindowSize()

  return width < SIDEBAR_WIDTH + CONTENT_WIDTH
}

export function useMemoTitle(): ReactNode {
  const { lang } = useLang()
  const location = useLocation()
  const [params] = useSearchParams()

  let title: ReactNode
  const tag = params.get('tag')
  const color = params.get('color')
  const deleted = params.get('deleted')
  const startDate = params.get('start_date')
  const shared = params.get('shared')
  const untagged = params.get('untagged')

  if (location.pathname === '/stats') {
    title = t('statistics', lang)
  } else if (deleted === 'true') {
    title = t('recycler', lang)
  } else if (untagged === 'true') {
    title = t('untaggedMemos', lang)
  } else if (shared === 'true') {
    title = t('shared', lang)
  } else if (color && ['red', 'green', 'blue'].includes(color)) {
    title = (
      <>
        <CircleIcon className={`mr-3 size-5 fill-${color}-500`} />
        <T name={color as 'red' | 'green' | 'blue'} />
      </>
    )
  } else if (tag) {
    title = `#${tag}`
  } else if (startDate) {
    title = formatDate(Number(startDate))
  }

  return title || <T name="allMemos" />
}
