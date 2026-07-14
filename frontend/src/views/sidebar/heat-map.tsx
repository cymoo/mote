import React, { ComponentProps, useRef } from 'react'
import useSWR from 'swr'

import { cx } from '@/utils/css.ts'
import { formatDate, getDatesBetween, getNextSunday, getPreviousMonday } from '@/utils/date.ts'

import { VirtualTooltip, VirtualTooltipHandle } from '@/components/tooltip.tsx'

import { GET_DAILY_POST_COUNTS } from '@/api.ts'

interface HeatMapProps extends ComponentProps<'div'> {
  startDate: Date
  endDate?: Date
}

export const HeatMap = React.memo(function HeatMap({
  startDate,
  endDate = new Date(),
  className,
  ...props
}: HeatMapProps) {
  const firstMonday = getPreviousMonday(startDate)
  const lastSunday = getNextSunday(endDate)
  const dates = getDatesBetween(firstMonday, lastSunday).map((date) => formatDate(date))

  const startDateStr = formatDate(firstMonday)
  const endDateStr = formatDate(lastSunday)
  const offset = (-new Date().getTimezoneOffset()).toString()
  const { data: counts } = useSWR<number[]>(
    `${GET_DAILY_POST_COUNTS}?start_date=${startDateStr}&end_date=${endDateStr}&offset=${offset}`,
  )

  const today = formatDate()

  return (
    <div
      className={cx(
        'grid auto-cols-fr grid-flow-col grid-rows-7 gap-[3px] *:aspect-square',
        className,
      )}
      role="grid"
      aria-label="heatmap of activities"
      {...props}
    >
      {dates.map((date, idx) => {
        const count = counts?.[idx] ?? 0
        return (
          <a
            key={date}
            className={cx(
              'cursor-pointer rounded-[4px] transition-transform duration-100 hover:z-10 hover:scale-125',
              getColor(count),
              { 'ring-foreground/60 ring-1 ring-inset': date === today },
            )}
            data-date={date}
            data-count={count}
            role="gridcell"
            aria-label={`date: ${date}, activities: ${String(count)}`}
          />
        )
      })}
    </div>
  )
})

export function HeatMapWithTooltip({ className, ...props }: ComponentProps<typeof HeatMap>) {
  const ref = useRef<VirtualTooltipHandle>(null)

  return (
    <>
      <VirtualTooltip ref={ref} />
      <HeatMap
        className={cx('cursor-pointer', className)}
        onMouseOver={(event) => {
          if (event.target instanceof HTMLElement && event.target.tagName === 'A') {
            const { date, count } = event.target.dataset
            if (!date || !count) return
            const content = `${date}: ${count} memos`
            ref.current?.open(event.target, content)
          }
        }}
        onMouseOut={(event) => {
          if (event.target instanceof HTMLElement && event.target.tagName === 'A') {
            ref.current?.close()
          }
        }}
        {...props}
      />
    </>
  )
}

// 强度色随主题主色联动（.heat-* 定义于 index.css），明暗模式通用。
const getColor = (count: number): string => {
  if (count >= 9) return 'heat-4'
  if (count >= 6) return 'heat-3'
  if (count >= 3) return 'heat-2'
  if (count >= 1) return 'heat-1'
  return 'heat-0'
}
