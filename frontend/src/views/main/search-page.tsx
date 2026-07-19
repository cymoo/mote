import {
  ArrowDownIcon,
  ArrowUpIcon,
  ClockIcon,
  HashIcon,
  SearchIcon,
  SparklesIcon,
  XIcon,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useLocation, useOutletContext, useSearchParams } from 'react-router'
import useSWR from 'swr'

import { cx } from '@/utils/css.ts'
import { debounce } from '@/utils/func.ts'
import { useLatest } from '@/utils/hooks/use-latest.ts'

import { useStableNavigate } from '@/components/router.tsx'
import { T, t, useLang } from '@/components/translation.tsx'

import { useIsSmallDevice } from '@/views/layout/hooks.tsx'
import { OrderBy, PostList } from '@/views/post/post-list.tsx'
import { Tag } from '@/views/tag/tag-list.tsx'
import { getLastSegment } from '@/views/tag/utils.ts'

import { GET_TAGS } from '@/api.ts'

import { SearchOutletContext } from './search-outlet.tsx'

const RECENT_KEY = 'mote:recent-search'
const RECENT_MAX = 6

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (raw) return JSON.parse(raw) as string[]
  } catch {
    /* ignore malformed storage */
  }
  return []
}

function saveRecent(list: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    /* ignore quota / disabled storage */
  }
}

const chipStyles =
  'inline-flex h-8 items-center gap-1.5 rounded-full bg-muted px-3.5 text-sm ' +
  'text-foreground transition-colors hover:bg-primary/10 hover:text-primary'

const sectionHeadStyles =
  'mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider ' +
  'text-muted-foreground/70'

const ORDERS = [
  { id: 'relevance', order: 'score', asc: false, icon: SparklesIcon },
  { id: 'newest', order: 'created_at', asc: false, icon: ArrowDownIcon },
  { id: 'oldest', order: 'created_at', asc: true, icon: ArrowUpIcon },
] as const

export function SearchPage() {
  const [params, setParams] = useSearchParams()

  const searchTerm = params.get('query') || ''
  const orderBy = (params.get('order_by') as OrderBy | null) ?? undefined
  const asc = params.get('asc') == 'true'

  const location = useLocation()
  const prevState = location.state as unknown
  const navigate = useStableNavigate()
  const outlet = useOutletContext<SearchOutletContext | null>()
  const sm = useIsSmallDevice()
  const { lang } = useLang()

  const close = outlet?.close ?? (() => void navigate('/'))

  const latestParams = useLatest(params)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(searchTerm)
  const [recent, setRecent] = useState<string[]>(loadRecent)

  const { data: tags } = useSWR<Tag[]>(GET_TAGS, { fallbackData: [] })
  const suggestedTags = useMemo(
    () =>
      [...(tags ?? [])]
        .filter((tag) => tag.name !== 'hidden' && tag.post_count > 0)
        .sort((a, b) => Number(b.sticky) - Number(a.sticky) || b.post_count - a.post_count)
        .slice(0, 8),
    [tags],
  )

  const pushParam = useRef(
    debounce((value: string) => {
      const next = latestParams.current
      if (value) next.set('query', value)
      else next.delete('query')
      setParams(next, { replace: true, state: prevState })
    }, 500),
  ).current

  const setParamNow = (value: string) => {
    // Drop any pending debounced update so a stale keystroke can't overwrite this.
    pushParam.cancel()
    const next = latestParams.current
    if (value) next.set('query', value)
    else next.delete('query')
    setParams(next, { replace: true, state: prevState })
  }

  const commitRecent = (value: string) => {
    const q = value.trim()
    if (!q) return
    setRecent((prev) => {
      const next = [q, ...prev.filter((item) => item !== q)].slice(0, RECENT_MAX)
      saveRecent(next)
      return next
    })
  }

  const onType = (value: string) => {
    setQuery(value)
    pushParam(value.trim())
  }

  const runSearch = (value: string) => {
    setQuery(value)
    setParamNow(value.trim())
    commitRecent(value)
    inputRef.current?.focus()
  }

  const handleOrderChange = (order: string, ascending: boolean) => {
    params.set('order_by', order)
    params.set('asc', String(ascending))
    setParams(params, { replace: true, state: prevState })
  }

  const goToTag = (name: string) => {
    void navigate(
      { pathname: '/', search: `?${new URLSearchParams({ tag: name }).toString()}` },
      { state: { fromInternal: true } },
    )
  }

  const hasQuery = query.trim().length > 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Search header */}
      <div className="border-border flex flex-none items-center gap-2.5 border-b px-4 py-3.5">
        <SearchIcon className="text-muted-foreground size-5 flex-none" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          autoFocus={true}
          className="text-foreground placeholder:text-muted-foreground/70 min-w-0 flex-1 bg-transparent text-[17px] outline-none"
          placeholder={t('searchPlaceholder', lang)}
          value={query}
          onChange={(event) => {
            onType(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitRecent(event.currentTarget.value)
          }}
        />
        {hasQuery && (
          <button
            type="button"
            aria-label="clear"
            className="text-muted-foreground hover:text-foreground flex size-7 flex-none items-center justify-center rounded-full"
            onClick={() => {
              setQuery('')
              setParamNow('')
              inputRef.current?.focus()
            }}
          >
            <XIcon className="size-4" />
          </button>
        )}
        {sm ? (
          <button
            type="button"
            className="text-primary flex-none px-1 text-sm font-medium"
            onClick={close}
          >
            <T name="cancel" />
          </button>
        ) : (
          <kbd className="border-border bg-muted text-muted-foreground flex-none rounded-md border px-1.5 py-1 font-mono text-[10px] leading-none">
            ESC
          </kbd>
        )}
      </div>

      {/* Order-by control */}
      {hasQuery && (
        <div className="border-border flex flex-none items-center justify-end border-b px-4 py-2">
          <div className="bg-muted inline-flex items-center gap-0.5 rounded-lg p-0.5">
            {ORDERS.map((o) => {
              const active =
                o.order === 'score'
                  ? orderBy === 'score' || orderBy === undefined
                  : orderBy === 'created_at' && asc === o.asc
              return (
                <button
                  key={o.id}
                  type="button"
                  className={cx(
                    'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                    active
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => {
                    handleOrderChange(o.order, o.asc)
                  }}
                >
                  <o.icon className="size-3.5" aria-hidden="true" />
                  <T name={o.id} />
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Body: results or empty-state */}
      {hasQuery ? (
        searchTerm ? (
          // Padding lives on this wrapper, not on the virtuoso scroller: horizontal
          // padding on the scroller makes its content overflow (spurious x-scrollbar),
          // and the scroller doesn't honor top padding for its first item.
          <div className="min-h-0 flex-1 overflow-hidden px-4 py-3">
            <PostList
              className="h-full overflow-x-hidden"
              queryString={new URLSearchParams({ query: searchTerm }).toString()}
              orderBy={orderBy}
              ascending={asc}
            />
          </div>
        ) : (
          <div className="flex-1" />
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-6">
          {recent.length > 0 && (
            <section className="mb-6">
              <div className={sectionHeadStyles}>
                <ClockIcon className="size-3.5" aria-hidden="true" />
                <T name="recentSearches" />
                <button
                  type="button"
                  className="text-muted-foreground/70 hover:text-primary ml-auto text-[11px] font-medium tracking-normal normal-case"
                  onClick={() => {
                    setRecent([])
                    saveRecent([])
                  }}
                >
                  <T name="clear" />
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {recent.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className={chipStyles}
                    onClick={() => {
                      runSearch(q)
                    }}
                  >
                    <SearchIcon className="size-3.5 opacity-60" aria-hidden="true" />
                    {q}
                  </button>
                ))}
              </div>
            </section>
          )}

          {suggestedTags.length > 0 && (
            <section>
              <div className={sectionHeadStyles}>
                <HashIcon className="size-3.5" aria-hidden="true" />
                <T name="topTags" />
              </div>
              <div className="flex flex-wrap gap-2">
                {suggestedTags.map((tag) => (
                  <button
                    key={tag.name}
                    type="button"
                    className={chipStyles}
                    onClick={() => {
                      goToTag(tag.name)
                    }}
                  >
                    <span className="text-muted-foreground/60 font-serif" aria-hidden="true">
                      #
                    </span>
                    {getLastSegment(tag.name)}
                    <span className="text-muted-foreground/60 text-[11px] tabular-nums">
                      {tag.post_count}
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-muted-foreground/60 mt-4 px-1 text-xs">
                <T name="searchHint" />
              </p>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
