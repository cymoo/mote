import { ComponentProps } from 'react'
import useSWR from 'swr'

import { cx } from '@/utils/css.ts'

import { GET_OVERALL_COUNTS } from '@/api.ts'

export function Stats({ className, ...props }: ComponentProps<'section'>) {
  const { data } = useSWR<{ post_count: number; tag_count: number; day_count: number }>(
    GET_OVERALL_COUNTS,
  )

  return (
    <section
      className={cx('flex items-baseline justify-between', className)}
      aria-label="statistics"
      {...props}
    >
      <StatItem label="MEMO" count={data?.post_count || '-'} align="items-start" />
      <StatItem label="TAG" count={data?.tag_count || '-'} align="items-center" />
      <StatItem label="DAY" count={data?.day_count || '-'} align="items-end" />
    </section>
  )
}

function StatItem({
  label,
  count,
  align,
}: {
  label: string
  count: number | '-'
  align: string
}) {
  return (
    <div className={cx('flex flex-1 flex-col gap-px', align)}>
      <span
        className="font-serif text-[21px] font-semibold tracking-wide tabular-nums"
        aria-label={`${label} count: ${String(count)}`}
      >
        {count}
      </span>
      <span
        className="text-muted-foreground/70 text-[10.5px] tracking-[0.14em]"
        aria-hidden="true"
      >
        {label}
      </span>
    </div>
  )
}
