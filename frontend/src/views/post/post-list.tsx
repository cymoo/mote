import { ComponentProps, ReactNode, RefObject, memo, useCallback, useMemo, useRef } from 'react'
import { Virtuoso as VirtualList, VirtuosoHandle } from 'react-virtuoso'

import { toSorted } from '@/utils/array.ts'
import { cx } from '@/utils/css.ts'
import { formatDate, formatDayHeading } from '@/utils/date.ts'
import { useUpdateEffect } from '@/utils/hooks/use-update-effect.ts'

import { Image } from '@/components/image-grid.tsx'
import { T, t, useLang } from '@/components/translation.tsx'

import { ListMutator } from '@/views/actions.ts'

import { useInfinitePosts } from './hooks/use-infinite.ts'
import { PostCard } from './post-card.tsx'

export interface Post {
  id: number
  content: string
  files?: Image[]
  color: PostColor | null
  created_at: number
  updated_at: number
  deleted_at?: number
  shared: boolean
  parent?: Post
  parent_id?: number | null
  children_count: number
  score?: number
  tags?: string[]
}

export interface PostPagination {
  posts: Post[]
  cursor: number
  size: number
}

export type PostColor = 'red' | 'green' | 'blue'

export type OrderBy = 'created_at' | 'updated_at' | 'deleted_at' | 'score'

interface PostListProps extends ComponentProps<typeof VirtualList> {
  queryString?: string
  useWindowScroll?: boolean
  scrollParent?: HTMLElement
  showPlaceholder?: boolean
  orderBy?: OrderBy
  ascending?: boolean
  // Renders a day heading above the first post of each day. Only meaningful
  // for lists in reverse-chronological order (the main feed).
  groupByDay?: boolean
  mutateRef?: RefObject<ListMutator>
}

export const PostList = memo(function PostList({
  queryString,
  scrollParent,
  useWindowScroll = false,
  showPlaceholder = true,
  orderBy,
  ascending = false,
  groupByDay = false,
  mutateRef,
  className,
  ...props
}: PostListProps) {
  const { posts, isEmpty, isLoadingMore, isReachingEnd, mutate, setSize } =
    useInfinitePosts(queryString)

  if (mutateRef) mutateRef.current = mutate

  const filteredAndSortedPosts = useMemo(() => {
    const isHiddenPage = queryString?.includes('tag=hidden')
    const filteredPosts = isHiddenPage
      ? posts
      : posts.filter((post) => !(post.tags ?? []).some((tag) => tag.startsWith('hidden')))

    if (!orderBy) return filteredPosts
    const key = orderBy
    return toSorted(filteredPosts, (x, y) => (ascending ? x[key]! - y[key]! : y[key]! - x[key]!))
  }, [queryString, posts, orderBy, ascending])

  const listHandle = useRef<VirtuosoHandle>(null!)

  useUpdateEffect(() => {
    listHandle.current.scrollToIndex(0)
  }, [queryString, orderBy, ascending])

  const scrollItemIntoView = useCallback((index: number) => {
    listHandle.current.scrollIntoView({ index })
  }, [])

  const isMainList = !queryString?.includes('parent_id')
  const isRecyclerPage = !!queryString?.includes('deleted=true')

  let footer: ReactNode = null
  if (isLoadingMore)
    footer = (
      <Footer>
        <T name="loading" />
      </Footer>
    )
  else if (isEmpty)
    footer = showPlaceholder ? (
      <Footer>
        <T name="noContent" />
      </Footer>
    ) : null
  else if (isReachingEnd) footer = <Footer>✨</Footer>

  return (
    <VirtualList
      ref={listHandle}
      className={className}
      useWindowScroll={useWindowScroll}
      customScrollParent={scrollParent}
      data={filteredAndSortedPosts}
      endReached={() => {
        if (isLoadingMore || isReachingEnd) return
        void setSize((size) => size + 1)
      }}
      itemContent={(index, post) => {
        // The divider renders INSIDE the virtuoso item so the item-list child
        // count still equals the post count (e2e tests rely on it).
        const prev = filteredAndSortedPosts[index - 1] as Post | undefined
        const showDayHeading =
          groupByDay &&
          (index === 0 ||
            (prev !== undefined &&
              formatDate((post as Post).created_at) !== formatDate(prev.created_at)))
        return (
          <>
            {showDayHeading && (
              <DayHeading timestamp={(post as Post).created_at} first={index === 0} />
            )}
            <PostCard
              className={cx({ 'pt-3': index !== 0 && !showDayHeading })}
              key={(post as Post).id}
              index={index}
              scrollIntoView={scrollItemIntoView}
              collapsible
              showParentLink={isMainList && !isRecyclerPage}
              timeDisplay={groupByDay ? 'time' : 'datetime'}
              post={post as Post} // NOTE: something wrong with TS definition of Virtuoso
              mutator={mutate}
            />
          </>
        )
      }}
      increaseViewportBy={200}
      components={{ Footer: () => footer }}
      {...props}
    />
  )
})

function Footer({ children }: ComponentProps<'div'>) {
  return <div className="text-muted-foreground/80 mt-2 mb-1 text-center text-sm">{children}</div>
}

function DayHeading({ timestamp, first }: { timestamp: number; first: boolean }) {
  const { lang } = useLang()
  return (
    <div className={cx('flex items-center gap-3 px-0.5 pb-3', first ? 'pt-1' : 'pt-7')}>
      <span className="font-serif text-[13px] tracking-wide whitespace-nowrap tabular-nums text-muted-foreground">
        {formatDayHeading(timestamp, lang, t('today', lang), t('yesterday', lang))}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  )
}
