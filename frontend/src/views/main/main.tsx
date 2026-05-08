import { CircleAlertIcon, Plus as PlusIcon, X as XIcon } from 'lucide-react'
import { ComponentProps, useEffect, useRef, useState } from 'react'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { useConfirm } from '@/components/confirm.tsx'
import { useModal } from '@/components/modal.tsx'
import { useBackgroundLocation } from '@/components/router.tsx'
import { T, t, useLang } from '@/components/translation.tsx'

import { ListMutator, postActions } from '@/views/actions.ts'
import { useLogoutWhenInactive } from '@/views/auth/hooks.tsx'
import { PostEditor } from '@/views/editor/editor.tsx'
import { useIsSmallDevice } from '@/views/layout/hooks.tsx'
import { useQuote } from '@/views/post/hooks/use-quote.ts'
import { PostColor, PostList } from '@/views/post/post-list.tsx'

export function Main() {
  const location = useBackgroundLocation()
  const params = new URLSearchParams(location.search)

  const deleted = params.get('deleted') === 'true'
  const shared = params.get('shared') === 'true'
  const color = params.get('color') as PostColor | null
  const tag = params.get('tag') ?? undefined
  const untagged = params.get('untagged') === 'true'
  const modal = useModal()

  const sm = useIsSmallDevice()
  useLogoutWhenInactive()

  const [keyForResetEditor, setKeyForResetEditor] = useState(0)

  const mutateRef = useRef<ListMutator>(null!)
  useEffect(() => {
    postActions.mainMutator = mutateRef.current
    return () => {
      postActions.mainMutator = undefined
    }
  })

  const editor = (
    <PostEditor
      id="main-editor"
      key={keyForResetEditor}
      className={
        sm
          ? 'min-h-[150px]'
          : 'relative mt-3 mb-5 max-h-[93vh]! flex-none rounded-xl border border-gray-300 p-4 dark:border-gray-700'
      }
      post={{ shared, color }}
      tag={tag}
      header={<ParentExcerpt />}
      autoFocusEnd
      afterSubmit={() => {
        if (sm) modal.close()
        else setKeyForResetEditor((x) => x + 1)
      }}
    />
  )

  return (
    <>
      {deleted ? (
        <RecycleAlert className="mt-3 mb-5" />
      ) : untagged ? null : sm ? (
        <Button
          id="main-editor-trigger"
          className="border-primary fixed left-0 right-0 mx-auto bottom-6 z-50 size-10 rounded-full! p-3! opacity-95"
          variant="primary"
          aria-label="open editor"
          onClick={() => {
            modal.open({
              content: editor,
            })
          }}
        >
          <PlusIcon className="size-6 shrink-0" />
        </Button>
      ) : (
        editor
      )}
      <PostList
        className={cx('relative flex-auto pt-4', { '[overflow-y:initial]': sm })}
        queryString={params.toString()}
        useWindowScroll={sm}
        mutateRef={mutateRef}
      />
    </>
  )
}

function RecycleAlert({ className }: ComponentProps<'div'>) {
  const confirm = useConfirm()
  const { lang } = useLang()

  return (
    <div className={cx('flex items-center rounded border px-4 py-2 text-sm', className)}>
      <CircleAlertIcon
        className="size-5 text-yellow-600/80 dark:text-yellow-300/80"
        aria-hidden="true"
      />
      <T name="recycleAlert" className="ml-3" />
      <Button
        className="-mr-4 ml-auto"
        size="sm"
        variant="ghost"
        onClick={() => {
          confirm.open({
            heading: t('emptyRecycler', lang),
            description: t('irreversible', lang),
            okText: t('delete', lang),
            cancelText: t('cancel', lang),
            cancelButtonClassName: 'w-1/4',
            onOk: async () => {
              await postActions.clearPosts()
            },
          })
        }}
      >
        <T name="clear" />
      </Button>
    </div>
  )
}

function ParentExcerpt({ className, ...props }: ComponentProps<'div'>) {
  const { quote, setQuote } = useQuote()
  if (!quote) return null

  return (
    <div className={cx('flex items-center justify-between', className)} {...props}>
      <p className="truncate text-muted-foreground text-sm border-l-2 border-foreground/30 pl-2">
        {quote.content}
      </p>
      <Button
        className="flex-none"
        variant="ghost"
        aria-label="detach from parent post"
        onClick={() => {
          void setQuote(null)
        }}
      >
        <XIcon className="size-4" />
      </Button>
    </div>
  )
}
