import { MessageCircleIcon, Share2Icon, Unlink2Icon } from 'lucide-react'
import { ComponentProps, memo } from 'react'

import { formatDate } from '@/utils/date.ts'

import { Button } from '@/components/button.tsx'
import { useConfirm } from '@/components/confirm.tsx'
import { ReadonlyImageGrid } from '@/components/image-grid.tsx'
import { StatusLight } from '@/components/status-light.tsx'
import { t, useLang } from '@/components/translation.tsx'

import { PostMutator, postActions as actions } from '@/views/actions.ts'

import { MAX_POST_HEIGHT } from '@/constants.ts'

import { CollapsibleContent } from './collapsible.tsx'
import { Post } from './post-list.tsx'
import { PostMenu } from './post-menu.tsx'
import { TruncateLink } from './truncate-link.tsx'

interface PostItemProps extends ComponentProps<'article'> {
  post: Post
  mutator: PostMutator
  collapsible?: boolean
  showParentLink?: boolean
  standalone?: boolean
  // 'time' renders HH:mm only — used by the day-grouped feed where the day
  // heading already carries the date; the full datetime stays in the tooltip.
  timeDisplay?: 'datetime' | 'time'
  index?: number
  scrollIntoView?: (index: number) => void
}

export const PostCard = memo(function PostItem({
  post,
  mutator,
  collapsible = false,
  showParentLink = true,
  standalone = false,
  timeDisplay = 'datetime',
  index,
  scrollIntoView,
  ...props
}: PostItemProps) {
  const confirm = useConfirm()
  const { lang } = useLang()

  const createdAtText = formatDate(post.created_at, true)
  const baseShareUrl = window.location.origin + import.meta.env.VITE_BLOG_URL
  const shareUrl = baseShareUrl.endsWith('/')
    ? baseShareUrl + post.id
    : baseShareUrl + '/' + post.id

  return (
    <article {...props}>
      <div className="group/memo border-border bg-card text-card-foreground relative rounded-[calc(var(--radius)+4px)] border p-4 px-5 shadow-xs transition-[box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-md">
        <header className="mb-2 flex items-center gap-3">
          <time
            className="text-muted-foreground/90 font-serif text-[13px] tracking-wider tabular-nums"
            title={createdAtText}
          >
            {/* createdAtText is 'YYYY-MM-DD HH:mm:ss'; the feed keeps HH:mm only */}
            {timeDisplay === 'time' ? createdAtText.slice(11, 16) : createdAtText}
          </time>
          {post.color && <StatusLight color={post.color} size="sm" />}
          {!standalone && post.children_count > 0 && (
            <span className="inline-flex items-center">
              <MessageCircleIcon
                className="fill-primary size-3 -rotate-90 text-transparent"
                aria-label="comment count"
              />
              <span className="text-foreground/80 ml-1 text-xs">{post.children_count}</span>
            </span>
          )}
          {post.shared && (
            <a href={shareUrl} target="_blank" rel="noopener noreferrer">
              <Share2Icon className="text-primary size-3" aria-label="shared" />
            </a>
          )}
          <PostMenu
            className="-mr-4 ml-auto h-8! opacity-100 transition-opacity duration-150 group-focus-within/memo:opacity-100 md:opacity-0 md:group-hover/memo:opacity-100"
            post={post}
            mutator={mutator}
            standalone={standalone}
          />
        </header>
        {collapsible ? (
          <CollapsibleContent
            className="prose"
            post={post}
            maxHeight={MAX_POST_HEIGHT}
            scrollIntoView={() => {
              if (scrollIntoView !== undefined && index !== undefined) {
                scrollIntoView(index)
              }
            }}
          />
        ) : (
          <div className="prose" dangerouslySetInnerHTML={{ __html: post.content }} />
        )}
        {post.files && post.files.length !== 0 && (
          <ReadonlyImageGrid
            className="scrollbar-none mt-3 max-h-[300px] overflow-y-auto"
            value={post.files}
          />
        )}
        {post.parent && showParentLink && (
          <footer className="mt-3 flex items-center gap-1">
            <TruncateLink
              className="flex-1"
              post={post.parent}
              maxLength={100}
              aria-label="see full post"
            />
            <Button
              className="text-muted-foreground hover:text-foreground size-8 flex-none px-0! opacity-100 transition-opacity duration-150 md:opacity-0 md:group-hover/memo:opacity-100"
              size="sm"
              variant="ghost"
              title="detach from parent post"
              onClick={() => {
                confirm.open({
                  heading: t('unlink', lang),
                  description: t('unlinkDescription', lang),
                  okText: t('unlink', lang),
                  cancelText: t('cancel', lang),
                  cancelButtonClassName: 'w-1/4',
                  onOk: async () => {
                    await actions.updatePost(mutator, { id: post.id, parent_id: null }, true)
                  },
                })
              }}
            >
              <Unlink2Icon className="size-4" aria-hidden="true" />
            </Button>
          </footer>
        )}
      </div>
    </article>
  )
})
