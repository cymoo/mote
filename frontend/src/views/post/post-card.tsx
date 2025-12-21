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
  index?: number
  scrollIntoView?: (index: number) => void
}

export const PostCard = memo(function PostItem({
  post,
  mutator,
  collapsible = false,
  showParentLink = true,
  standalone = false,
  index,
  scrollIntoView,
  ...props
}: PostItemProps) {
  const confirm = useConfirm()
  const { lang } = useLang()

  return (
    <article {...props}>
      <div className="border-border/50 bg-card text-card-foreground relative rounded-lg border p-4 shadow-xs">
        <header className="mb-2 flex items-center gap-3">
          <time className="text-foreground/80 text-sm">{formatDate(post.created_at, true)}</time>
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
            <Share2Icon
              className="text-primary size-3 cursor-pointer"
              aria-label="shared"
              onClick={() => {
                const baseUrl = window.location.origin + import.meta.env.VITE_BLOG_URL
                const url = baseUrl.endsWith('/') ? baseUrl + post.id : baseUrl + '/' + post.id
                navigator.clipboard.writeText(url)
              }}
            />
          )}
          <PostMenu
            className="-mr-4 ml-auto h-8!"
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
          <footer className="mt-2 -ml-4 flex items-center">
            <TruncateLink
              className="max-w-full overflow-hidden"
              post={post.parent}
              maxLength={100}
              aria-label="see full post"
            />
            <Button
              className="text-foreground/75! relative top-[1px] -mr-2 px-1!"
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
              <Unlink2Icon className="size-5 pr-1" aria-hidden="true" />
            </Button>
          </footer>
        )}
      </div>
    </article>
  )
})
