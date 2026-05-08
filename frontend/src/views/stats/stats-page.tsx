import {
  CalendarDaysIcon,
  HashIcon,
  ImageIcon,
  ListFilterIcon,
  Share2Icon,
  SparklesIcon,
  TagIcon,
} from 'lucide-react'
import { ReactNode, useMemo, useState } from 'react'
import useSWR from 'swr'

import { cx } from '@/utils/css.ts'
import { formatDate, getTimestampOfDayEnd, getTimestampOfDayStart } from '@/utils/date.ts'

import { useStableNavigate } from '@/components/router.tsx'
import { t, useLang } from '@/components/translation.tsx'

import { GET_STATS_SUMMARY } from '@/api.ts'
import { HeatMapWithTooltip } from '@/views/sidebar/heat-map.tsx'

interface StatCount {
  name: string
  count: number
}

interface StatsSummary {
  total_posts: number
  active_days: number
  shared_posts: number
  posts_with_images: number
  untagged_posts: number
  first_post_at: number | null
  last_post_at: number | null
  color_counts: StatCount[]
  top_tags: StatCount[]
}

const colorStyles = {
  red: 'bg-red-500',
  green: 'bg-green-500',
  blue: 'bg-blue-500',
} as const

export function StatsPage() {
  const { lang } = useLang()
  const navigate = useStableNavigate()
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState<number | null>(null)
  const [heatmapYear, setHeatmapYear] = useState(currentYear)

  const offset = (-new Date().getTimezoneOffset()).toString()
  const allSummaryUrl = `${GET_STATS_SUMMARY}?${new URLSearchParams({ offset }).toString()}`
  const { data: allSummary } = useSWR<StatsSummary>(allSummaryUrl)
  const summaryUrl = useMemo(() => {
    const params = new URLSearchParams({ offset })
    if (year !== null) {
      params.set('start_date', `${year.toString()}-01-01`)
      params.set('end_date', `${year.toString()}-12-31`)
    }
    return `${GET_STATS_SUMMARY}?${params.toString()}`
  }, [offset, year])
  const { data: summary } = useSWR<StatsSummary>(summaryUrl)

  const years = useMemo(() => {
    const firstYear = allSummary?.first_post_at ? new Date(allSummary.first_post_at).getFullYear() : currentYear
    return Array.from({ length: currentYear - firstYear + 1 }, (_, idx) => currentYear - idx)
  }, [allSummary?.first_post_at, currentYear])

  const maxTagCount = Math.max(...(summary?.top_tags.map((tag) => tag.count) ?? [0]), 1)
  const totalColorCount = (summary?.color_counts ?? []).reduce((sum, item) => sum + item.count, 0)
  const yearLabel = year === null ? t('allTime', lang) : year.toString()
  const selectedHeatmapYear = year ?? Math.min(heatmapYear, years[0] ?? currentYear)

  const openDate = (date: string, count: string | undefined) => {
    if (Number(count ?? 0) <= 0) return
    void navigate(
      `/?start_date=${getTimestampOfDayStart(date).toString()}&end_date=${getTimestampOfDayEnd(date).toString()}`,
    )
  }

  return (
    <div className="scrollbar-none flex-auto overflow-y-auto pb-12">
      <title>{t('statistics', lang)}</title>
      <section className="relative mt-4 overflow-hidden rounded-2xl border bg-card p-5 shadow-sm">
        <div className="pointer-events-none absolute -right-14 -top-20 size-44 rounded-full bg-primary/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-16 left-8 size-32 rounded-full bg-emerald-400/10 blur-3xl" />
        <div className="relative">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-muted-foreground text-xs font-semibold uppercase tracking-[0.24em]">
                {t('activityReview', lang)}
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight">{yearLabel}</h1>
              <p className="text-muted-foreground mt-2 text-sm">{t('activityReviewDescription', lang)}</p>
            </div>
          </div>

          <label className="mt-5 flex items-center gap-3 rounded-xl border bg-background/70 p-2">
            <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
              <ListFilterIcon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-muted-foreground block text-xs">{t('reviewRange', lang)}</span>
              <select
                className="w-full bg-transparent text-sm font-semibold focus:outline-none"
                value={year ?? 'all'}
                onChange={(event) => {
                  const value = event.target.value
                  const nextYear = value === 'all' ? null : Number(value)
                  setYear(nextYear)
                  if (nextYear !== null) setHeatmapYear(nextYear)
                }}
              >
                <option value="all">{t('allTime', lang)}</option>
                {years.map((item) => (
                  <option key={item} value={item}>
                    {item.toString()}
                  </option>
                ))}
              </select>
            </span>
          </label>

          <div className="mt-6 grid grid-cols-2 gap-3">
            <MetricCard icon={<SparklesIcon />} label={t('totalMemos', lang)} value={summary?.total_posts} />
            <MetricCard icon={<CalendarDaysIcon />} label={t('activeDays', lang)} value={summary?.active_days} />
          </div>
        </div>
      </section>

      <section className="mt-4 rounded-2xl border bg-card p-4 shadow-sm">
        <div className="mb-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">{t('heatmap', lang)}</h2>
              <p className="text-muted-foreground text-xs">{t('yearlyActivityHint', lang)}</p>
            </div>
            <span className="text-muted-foreground text-xs">{selectedHeatmapYear}</span>
          </div>
        </div>
        {year === null && years.length > 1 && (
          <div className="scrollbar-none mb-3 flex gap-1 overflow-x-auto rounded-full bg-muted/50 p-1">
            {years.map((item) => (
              <button
                key={item}
                className={cx('rounded-full px-3 py-1 text-xs transition-colors', {
                  'bg-primary text-primary-foreground shadow-sm': selectedHeatmapYear === item,
                  'text-muted-foreground hover:bg-background': selectedHeatmapYear !== item,
                })}
                onClick={() => setHeatmapYear(item)}
              >
                {item}
              </button>
            ))}
          </div>
        )}
        <div className="rounded-xl bg-muted/30 p-3">
          <HeatMapWithTooltip
            className="w-full [grid-auto-columns:minmax(0,1fr)] gap-px opacity-90 sm:gap-0.5"
            startDate={new Date(selectedHeatmapYear, 0, 1)}
            endDate={selectedHeatmapYear === currentYear ? new Date() : new Date(selectedHeatmapYear, 11, 31)}
            onClick={(event) => {
              if (event.target instanceof HTMLElement && event.target.tagName === 'A') {
                const { date, count } = event.target.dataset
                if (!date) return
                openDate(date, count)
              }
            }}
          />
        </div>
      </section>

      <div className="mt-4 grid gap-4">
        <section className="rounded-2xl border bg-card p-4 shadow-sm">
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <HashIcon className="size-4 text-primary" />
            {t('topTags', lang)}
          </h2>
          {summary && (summary.top_tags.length > 0 || summary.untagged_posts > 0) ? (
            <div className="space-y-3">
              {summary.top_tags.map((tag) => (
                <button
                  key={tag.name}
                  className="group block w-full text-left"
                  onClick={() => {
                    void navigate(`/?tag=${encodeURIComponent(tag.name)}`)
                  }}
                >
                  <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                    <span className="truncate group-hover:text-primary">#{tag.name}</span>
                    <span className="text-muted-foreground">{tag.count}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/80"
                      style={{ width: `${Math.max((tag.count / maxTagCount) * 100, 6).toString()}%` }}
                    />
                  </div>
                </button>
              ))}
              {summary.untagged_posts > 0 && (
                <button
                  className="group block w-full rounded-xl border border-dashed bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-accent"
                  onClick={() => {
                    void navigate('/?untagged=true')
                  }}
                >
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground group-hover:text-primary inline-flex items-center gap-2">
                      <TagIcon className="size-3.5" />
                      {t('untaggedMemos', lang)}
                    </span>
                    <span>{summary.untagged_posts}</span>
                  </div>
                </button>
              )}
            </div>
          ) : (
            <EmptyLine>{t('noStatsYet', lang)}</EmptyLine>
          )}
        </section>

        <section className="rounded-2xl border bg-card p-4 shadow-sm">
          <h2 className="mb-3 font-semibold">{t('colorDistribution', lang)}</h2>
          <div className="space-y-3">
            {(['red', 'green', 'blue'] as const).map((color) => {
              const count = summary?.color_counts.find((item) => item.name === color)?.count ?? 0
              const pct = totalColorCount > 0 ? (count / totalColorCount) * 100 : 0
              return (
                <button
                  key={color}
                  className="block w-full text-left disabled:cursor-default disabled:opacity-60"
                  disabled={count === 0}
                  onClick={() => {
                    void navigate(`/?color=${color}`)
                  }}
                >
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="inline-flex items-center gap-2">
                      <span className={cx('size-2 rounded-full', colorStyles[color])} />
                      {t(color, lang)}
                    </span>
                    <span className="text-muted-foreground">{count}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cx('h-full rounded-full', colorStyles[color])}
                      style={{ width: `${Math.max(pct, count > 0 ? 6 : 0).toString()}%` }}
                    />
                  </div>
                </button>
              )
            })}
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3">
          <MiniCard
            icon={<Share2Icon />}
            label={t('sharedMemos', lang)}
            value={summary?.shared_posts}
            onClick={() => {
              void navigate('/?shared=true')
            }}
          />
          <MiniCard
            icon={<ImageIcon />}
            label={t('memosWithImages', lang)}
            value={summary?.posts_with_images}
            onClick={() => {
              void navigate('/?has_files=true')
            }}
          />
        </section>
      </div>
    </div>
  )
}

function MetricCard({ icon, label, value }: { icon: ReactNode; label: string; value?: number }) {
  return (
    <div className="rounded-xl border bg-background/70 p-3">
      <div className="text-muted-foreground mb-3 flex items-center gap-2 text-xs">
        <span className="text-primary [&_svg]:size-4">{icon}</span>
        {label}
      </div>
      <div className="text-2xl font-semibold">{value ?? '-'}</div>
    </div>
  )
}

function MiniCard({
  icon,
  label,
  value,
  onClick,
}: {
  icon: ReactNode
  label: string
  value?: number
  onClick: () => void
}) {
  return (
    <button
      className="rounded-2xl border bg-card p-4 text-left shadow-sm transition-colors hover:bg-accent"
      onClick={onClick}
    >
      <span className="text-primary [&_svg]:size-4">{icon}</span>
      <span className="text-muted-foreground mt-3 block text-xs">{label}</span>
      <span className="mt-1 block text-2xl font-semibold">{value ?? '-'}</span>
    </button>
  )
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground rounded-xl bg-muted/50 px-3 py-6 text-center text-sm">{children}</p>
}
