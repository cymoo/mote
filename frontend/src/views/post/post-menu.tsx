import { MoreHorizontal as MoreIcon } from 'lucide-react'
import { useState } from 'react'
import { Location, useLocation, useSearchParams } from 'react-router'

import { cx } from '@/utils/css.ts'
import { formatDate } from '@/utils/date.ts'
import { exportPostAsMarkdown } from '@/utils/markdown.ts'
import { countWords } from '@/utils/text.ts'

import { Button } from '@/components/button.tsx'
import { useConfirm } from '@/components/confirm.tsx'
import { useModal } from '@/components/modal.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/popover.tsx'
import { RGBPicker } from '@/components/rgb-picker.tsx'
import { useStableNavigate } from '@/components/router.tsx'
import { T, t, useLang } from '@/components/translation.tsx'

import { ListMutator, PostMutator, postActions as actions } from '@/views/actions.ts'
import { PostEditor } from '@/views/editor/editor.tsx'
import { useQuote } from '@/views/post/hooks/use-quote.ts'

import { Post } from './post-list.tsx'

interface PostMenuProps {
  post: Post
  mutator: PostMutator
  standalone?: boolean
  className?: string
}

export function PostMenu({ post, mutator, standalone = false, className }: PostMenuProps) {
  const [params] = useSearchParams()
  const location = useLocation()
  const isRecyclerPage = params.get('deleted') === 'true'

  const navigate = useStableNavigate()
  const confirm = useConfirm()
  const modal = useModal()
  const quotePost = useQuote((state) => state.setQuote)
  const { lang } = useLang()

  const [open, setOpen] = useState(false)

  const handleQuotePost = async () => {
    setOpen(false)
    const excerpt = post.content.replace(/(<([^>]+)>)/gi, ' ').substring(0, 100)
    await quotePost({ id: post.id, content: excerpt })
  }

  const handleDeletePost = async () => {
    setOpen(false)
    await actions.deletePost(mutator as ListMutator, post.id, false)

    if (useQuote.getState().quote?.id === post.id) {
      await quotePost(null)
    }
  }

  const handleRestorePost = async () => {
    setOpen(false)
    await actions.restorePost(mutator as ListMutator, post.id)
  }

  const handleDeletePostPermanently = () => {
    setOpen(false)

    confirm.open({
      heading: t('deleteMemo', lang),
      description: t('irreversible', lang),
      okText: t('delete', lang),
      cancelText: t('cancel', lang),
      cancelButtonClassName: 'w-1/4',
      onOk: async () => {
        await actions.deletePost(mutator as ListMutator, post.id, true)
      },
    })
  }

  const handleMarkPost = (color: 'red' | 'blue' | 'green' | null) => {
    setOpen(false)
    void actions.updatePost(mutator, { id: post.id, color })
  }

  const handleSharePost = (shared: boolean) => {
    setOpen(false)
    void actions.updatePost(mutator, { id: post.id, shared })
  }

  const handleEditPost = () => {
    setOpen(false)

    modal.open({
      content: (
        <PostEditor
          className="min-h-[150px]"
          post={post}
          mutator={mutator}
          afterSubmit={() => {
            modal.close()
          }}
          afterCancel={() => {
            modal.close()
          }}
        />
      ),
    })
  }

  const handleExportMarkdown = () => {
    setOpen(false)
    exportPostAsMarkdown(post)
  }

  const goToPostPage = () => {
    setOpen(false)
    const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation

    void navigate(`/p/${String(post.id)}`, {
      state: {
        post,
        isFirstLayer: !bg,
        backgroundLocation: bg || location,
      },
    })
  }

  let menu
  if (isRecyclerPage) {
    menu = (
      <ul className="*:mt-2">
        <li>
          <Button
            className="w-full justify-start!"
            variant="ghost"
            onClick={() => {
              void handleRestorePost()
            }}
          >
            <T name="restore" />
          </Button>
        </li>
        <li>
          <Button
            className="text-destructive w-full justify-start!"
            variant="ghost"
            onClick={() => {
              handleDeletePostPermanently()
            }}
          >
            <T name="delete" />
          </Button>
        </li>
      </ul>
    )
  } else {
    menu = (
      <ul className="*:mt-2">
        <li>
          <RGBPicker
            className="-mx-2 space-x-0! px-3"
            initialValue={post.color}
            onChange={(color) => {
              handleMarkPost(color)
            }}
          />
        </li>
        <li>
          <Button
            className="w-full justify-start!"
            variant="ghost"
            onClick={() => {
              handleEditPost()
            }}
          >
            <T name="edit" />
          </Button>
        </li>
        {!standalone && (
          <li>
            <Button
              className="w-full justify-start!"
              variant="ghost"
              onClick={() => {
                void handleQuotePost()
              }}
            >
              <T name="quote" />
            </Button>
          </li>
        )}
        {!standalone && (
          <li>
            <Button
              className="w-full justify-start!"
              variant="ghost"
              onClick={() => {
                goToPostPage()
              }}
            >
              <T name="viewDetail" />
            </Button>
          </li>
        )}
        <li>
          <Divider />
        </li>
        <li>
          <Button
            className="w-full justify-start!"
            variant="ghost"
            onClick={() => {
              handleExportMarkdown()
            }}
          >
            <T name="exportMarkdown" />
          </Button>
        </li>
        <li>
          <Divider />
        </li>
        <li>
          <Button
            className="w-full justify-start!"
            variant="ghost"
            onClick={() => {
              handleSharePost(!post.shared)
            }}
          >
            {post.shared ? <T name="unshare" /> : <T name="share" />}
          </Button>
        </li>
        {!standalone && (
          <li>
            <Button
              className="text-destructive w-full justify-start!"
              variant="ghost"
              onClick={() => {
                void handleDeletePost()
              }}
            >
              <T name="delete" />
            </Button>
          </li>
        )}
        <li className="text-muted-foreground/80 px-4 pt-2 pb-1 text-xs">
          <T name="words" />: {countWords(post.content)}
        </li>
        {post.updated_at - post.created_at > 1 && (
          <li className="text-muted-foreground/80 flex flex-col gap-0.5 px-4 pt-1 pb-2 text-xs">
            <span>
              <T name="updatedAt" />:
            </span>
            <span>{formatDate(post.updated_at, true)}</span>
          </li>
        )}
      </ul>
    )
  }

  return (
    <Popover placement="left-start" open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        asChild
        onClick={() => {
          setOpen((opened) => !opened)
        }}
      >
        <Button
          className={cx('text-foreground/80 ring-inset hover:bg-transparent', className)}
          variant="ghost"
          aria-label="show/hide post menu"
        >
          <MoreIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent>{menu}</PopoverContent>
    </Popover>
  )
}

function Divider() {
  return <div className="border-t border-slate-700/10 dark:border-slate-200/10" />
}
