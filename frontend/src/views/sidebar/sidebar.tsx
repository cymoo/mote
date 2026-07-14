import { memo } from 'react'
import { useSearchParams } from 'react-router'

import { IS_TOUCH_DEVICE } from '@/utils/browser.ts'
import { cx } from '@/utils/css.ts'
import { getTimestampOfDayEnd, getTimestampOfDayStart } from '@/utils/date.ts'

import { Button } from '@/components/button.tsx'
import { T } from '@/components/translation.tsx'

import { TagList } from '@/views/tag/tag-list.tsx'

import { Header } from './header.tsx'
import { HeatMap as HeatMapWithNoTooltip, HeatMapWithTooltip } from './heat-map.tsx'
import { NavLinks } from './nav-links.tsx'
import { SettingDialog } from './setting.tsx'
import { Stats } from './stats.tsx'

export const HIGHLIGHT_STYLE = 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'

export const Sidebar = memo(function SideBar() {
  const [params, setParams] = useSearchParams()
  const HeatMap = IS_TOUCH_DEVICE ? HeatMapWithNoTooltip : HeatMapWithTooltip

  return (
    <>
      <Header className="-mx-4" />
      <Stats className="mt-3" />
      <HeatMap
        className="mt-4"
        startDate={new Date(Date.now() - 16 * 7 * 24 * 60 * 60 * 1000)} // 16 weeks ago
        onClick={(event) => {
          if (event.target instanceof HTMLElement && event.target.tagName === 'A') {
            const { date, count } = event.target.dataset
            if (!date || !count) return
            if (Number(count) > 0) {
              setParams(
                {
                  start_date: getTimestampOfDayStart(date).toString(),
                  end_date: getTimestampOfDayEnd(date).toString(),
                },
                {
                  replace: params.get('tag')?.includes('hidden'),
                },
              )
              window.toggleSidebar()
            }
          }
        }}
      />
      <NavLinks className="-mx-4 mt-5" />
      <TagList className="mt-5" />
      <div className="-mx-4 flex flex-col space-y-2">
        <SettingDialog />
        <Button
          className={cx('text-foreground/75 justify-start! ring-inset text-base!', {
            [HIGHLIGHT_STYLE]: params.get('deleted') === 'true',
          })}
          variant="ghost"
          onClick={() => {
            setParams({ deleted: 'true' }, { replace: params.get('tag')?.includes('hidden') })
            window.toggleSidebar()
          }}
        >
          <T name="recycler" />
        </Button>
      </div>
    </>
  )
})
