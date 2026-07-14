import {
  Download as DownloadIcon,
  Eye as EyeIcon,
  MoreHorizontal as MoreIcon,
  Pencil as PencilIcon,
  RotateCcw as RestoreIcon,
  Share2 as ShareIcon,
  TextQuote as QuoteIcon,
  Trash2 as TrashIcon,
  X as UnshareIcon,
} from 'lucide-react'
import { useState } from 'react'
import { Location, useLocation, useSearchParams } from 'react-router'

import { cx } from '@/utils/css.ts'
import { formatDate } from '@/utils/date.ts'
import { exportPostAsMarkdown } from '@/utils/markdown.ts'
import { countWords } from '@/utils/text.ts'

import { Button } from '@/components/button.tsx'
import { useConfirm } from '@/components/confirm.tsx'
import { MenuInfo, MenuItem, MenuList, MenuSeparator } from '@/components/menu.tsx'
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
      <MenuList>
        <MenuItem
          icon={<RestoreIcon className="size-3.5" />}
          onClick={() => {
            void handleRestorePost()
          }}
        >
          <T name="restore" />
        </MenuItem>
        <MenuItem
          danger
          icon={<TrashIcon className="size-3.5" />}
          onClick={() => {
            handleDeletePostPermanently()
          }}
        >
          <T name="delete" />
        </MenuItem>
      </MenuList>
    )
  } else {
    menu = (
      <MenuList>
        <li className="px-1 pt-0.5 pb-1">
          <RGBPicker
            initialValue={post.color}
            onChange={(color) => {
              handleMarkPost(color)
            }}
          />
        </li>
        <MenuItem
          icon={<PencilIcon className="size-3.5" />}
          onClick={() => {
            handleEditPost()
          }}
        >
          <T name="edit" />
        </MenuItem>
        {!standalone && (
          <MenuItem
            icon={<QuoteIcon className="size-3.5" />}
            onClick={() => {
              void handleQuotePost()
            }}
          >
            <T name="quote" />
          </MenuItem>
        )}
        {!standalone && (
          <MenuItem
            icon={<EyeIcon className="size-3.5" />}
            onClick={() => {
              goToPostPage()
            }}
          >
            <T name="viewDetail" />
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem
          icon={<DownloadIcon className="size-3.5" />}
          onClick={() => {
            handleExportMarkdown()
          }}
        >
          <T name="exportMarkdown" />
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={
            post.shared ? <UnshareIcon className="size-3.5" /> : <ShareIcon className="size-3.5" />
          }
          onClick={() => {
            handleSharePost(!post.shared)
          }}
        >
          {post.shared ? <T name="unshare" /> : <T name="share" />}
        </MenuItem>
        {!standalone && (
          <MenuItem
            danger
            icon={<TrashIcon className="size-3.5" />}
            onClick={() => {
              void handleDeletePost()
            }}
          >
            <T name="delete" />
          </MenuItem>
        )}
        <MenuInfo>
          <T name="words" />: {countWords(post.content)}
          {post.updated_at - post.created_at > 1 && (
            <>
              <br />
              <T name="updatedAt" />: {formatDate(post.updated_at, true)}
            </>
          )}
        </MenuInfo>
      </MenuList>
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
