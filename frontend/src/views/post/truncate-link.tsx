import { TextQuoteIcon } from 'lucide-react'
import { ComponentProps } from 'react'
import { Location, useLocation } from 'react-router'

import { cx } from '@/utils/css.ts'

import { useStableNavigate } from '@/components/router.tsx'

import { Post } from './post-list.tsx'

interface TruncateLinkProps extends ComponentProps<'button'> {
  post: Post
  maxLength?: number
}

// A compact "quoted note" pill: the parent post's text with a leading quote
// icon, muted by default and tinted with the primary color on hover. Clicking
// it opens the parent post.
export function TruncateLink({ post, maxLength, className, ...props }: TruncateLinkProps) {
  // NOTE: `useNavigate` hook causes waste rendering
  // https://github.com/remix-run/react-router/issues/7634
  const navigate = useStableNavigate()
  const location = useLocation()

  return (
    <button
      {...props}
      type="button"
      className={cx(
        'bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary focus-visible:ring-ring flex min-w-0 items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-[12.5px] transition-colors focus-visible:ring-1 focus-visible:ring-offset-0 focus-visible:outline-none',
        className,
      )}
      onClick={() => {
        const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation
        void navigate(`/p/${String(post.id)}`, {
          state: {
            post,
            isFirstLayer: !bg,
            backgroundLocation: bg || location,
          },
        })
      }}
    >
      <TextQuoteIcon className="size-3.5 flex-none opacity-70" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-left">
        {post.content.replace(/(<([^>]+)>)/gi, ' ').substring(0, maxLength)}
      </span>
    </button>
  )
}
