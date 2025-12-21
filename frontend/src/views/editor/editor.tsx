import { ImageIcon } from 'lucide-react'
import { ComponentProps, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Element as SlateElement, Text as SlateText } from 'slate'
import useSWR from 'swr'

import { cx } from '@/utils/css.ts'
import { useEvent } from '@/utils/hooks/use-event.ts'
import { textToHtml } from '@/utils/text.ts'

import { Button } from '@/components/button.tsx'
import { MbEditor } from '@/components/editor/editor.tsx'
import { fromHtml, toHtml } from '@/components/editor/html.ts'
import { HASH_TAG, PARAGRAPH } from '@/components/editor/types.ts'
import { Image, ImageGrid, ImageGridHandle } from '@/components/image-grid.tsx'
import { T } from '@/components/translation.tsx'

import { useQuote } from '@/views/post/hooks/use-quote.ts'

import { GET_TAGS, UPLOAD_FILE, fetcher } from '@/api.ts'

import { ListMutator, PostMutator, postActions as actions } from '../actions.ts'
import { Post } from '../post/post-list.tsx'
import { Tag } from '../tag/tag-list.tsx'
import { ToolBar, ToolButton } from './toolbar.tsx'

interface PostEditorProps extends ComponentProps<'div'> {
  post: Partial<Post>
  tag?: string
  mutator?: PostMutator
  afterSubmit?: () => void
  afterCancel?: () => void
  autoFocus?: boolean
  autoFocusEnd?: boolean
  header?: ReactNode
}

export function PostEditor({
  post,
  tag,
  mutator,
  afterCancel,
  afterSubmit,
  className,
  autoFocus = true,
  autoFocusEnd = false,
  header,
  ...props
}: PostEditorProps) {
  const draftKey = genDraftKey(post.id, post.parent_id)

  const { value: initialValue, images: initialImages } = useMemo(
    () => getInitialState(draftKey, post, tag),
    [draftKey, post, tag],
  )

  const [value, setValue] = useState(initialValue)
  const [images, setImages] = useState(initialImages)

  const empty = isEditorEmpty(value) && images.length === 0

  const { data: tags } = useSWR<Tag[]>(GET_TAGS, { fallbackData: [] })
  const tagNames = useMemo(
    () => tags!.filter((tag) => tag.post_count > 0).map((tag) => tag.name),
    [tags],
  )

  const imageGridRef = useRef<ImageGridHandle>(null)
  const uploadImage = useCallback((file: File): Promise<Image> => fetcher(UPLOAD_FILE, file), [])

  const saveDraft = useSaveDraft(draftKey, value, images)

  const [submitting, handleSubmit] = useSubmitPost(
    post,
    mutator,
    useEvent(() => {
      afterSubmit?.()
      localStorage.removeItem(draftKey)
    }),
  )

  const handleCancel = () => {
    afterCancel?.()
    localStorage.removeItem(draftKey)
  }

  return (
    <div className={cx('flex max-h-full flex-col', className)} {...props}>
      {header}
      <MbEditor
        key={tag}
        className="scrollbar-none prose flex-auto overflow-y-auto focus:outline-none"
        autoFocus={autoFocus}
        autoFocusEnd={autoFocusEnd}
        placeholder="Capture a mote of light..."
        initialValue={initialValue}
        tags={tagNames}
        uploadImage={uploadImage}
        onChange={setValue}
        onBlur={saveDraft}
      >
        <ImageGrid
          ref={imageGridRef}
          className="scrollbar-none mt-3 max-h-[300px] flex-none overflow-y-auto"
          initialValue={initialImages}
          onChange={setImages}
          uploadImage={uploadImage}
        />
        <ToolBar className="flex-none mt-2 -ml-3">
          <ToolButton
            title="insert image"
            onClick={() => {
              imageGridRef.current?.open()
            }}
          >
            <ImageIcon />
          </ToolButton>
          <span className="ml-auto size-0"></span>
          {post.id && (
            <Button
              className="mr-2"
              size="sm"
              variant="ghost"
              aria-label="cancel"
              onClick={() => {
                handleCancel()
              }}
            >
              <T name="cancel" />
            </Button>
          )}
          <Button
            className="px-5! py-1!"
            size="sm"
            variant="outline"
            type="submit"
            aria-label="submit"
            disabled={submitting || empty}
            style={{ opacity: submitting || empty ? 0.65 : 1 }}
            onClick={() => {
              void handleSubmit(
                toHtml({ children: trimTrailingEmptyParagraphs(value), type: '' }),
                images,
              )
            }}
          >
            <T name="submit" />
          </Button>
        </ToolBar>
      </MbEditor>
    </div>
  )
}

// Hook to handle post submission
function useSubmitPost(
  post: Partial<Post>,
  mutator?: PostMutator | ListMutator,
  onSuccess?: () => void,
) {
  const [submitting, setSubmitting] = useState(false)
  const { quote, setQuote } = useQuote()

  const handleSubmit = async (content: string, files: Image[]) => {
    const data = {
      id: post.id,
      content,
      files,
      ...(quote && !post.id ? { parent_id: quote.id } : {}),
      ...(post.id ? {} : post),
    }

    try {
      setSubmitting(true)
      if (post.id) {
        await actions.updatePost(mutator || actions.mainMutator!, data)
      } else {
        await actions.createPost((mutator as ListMutator | undefined) || actions.mainMutator!, data)
        await setQuote(null)
      }
      onSuccess?.()
    } finally {
      setSubmitting(false)
    }
  }

  return [submitting, handleSubmit] as const
}

// Hook to save draft to localStorage before unload
function useSaveDraft(draftKey: string, value: SlateElement[], images: Image[]) {
  const saveDraft = useEvent(() => {
    if (images.length === 0 && (isEditorEmpty(value) || isParagraphWithSingleTag(value))) {
      localStorage.removeItem(draftKey)
    } else {
      localStorage.setItem(draftKey, JSON.stringify({ value, images }))
    }
  })

  useEffect(() => {
    window.addEventListener('beforeunload', saveDraft)
    return () => {
      window.removeEventListener('beforeunload', saveDraft)
    }
  }, [saveDraft])

  return saveDraft
}

interface DraftState {
  value: SlateElement[]
  images: Image[]
}

// Generate a unique key for storing drafts in localStorage
function genDraftKey(id: number | undefined, parentId: number | undefined | null): string {
  let key = 'draft:' + (id ?? 0).toString()
  if (parentId) key += `:${parentId.toString()}`
  return key
}

// Get the initial state for the editor from draft or post content
function getInitialState(key: string, post: Partial<Post>, tag?: string) {
  const draft = localStorage.getItem(key)
  if (draft) return JSON.parse(draft) as DraftState

  if (post.content) {
    return {
      value: fromHtml(textToHtml(post.content)) as SlateElement[],
      images: post.files ?? [],
    }
  }

  if (tag) {
    return {
      value: [
        {
          type: PARAGRAPH,
          children: [
            { text: '' },
            { type: HASH_TAG, children: [{ text: '#' + tag }] },
            { text: '' },
          ],
        },
      ],
      images: post.files ?? [],
    }
  } else {
    return {
      value: [{ type: PARAGRAPH, children: [{ text: '' }] }],
      images: post.files ?? [],
    }
  }
}

// Check if the editor contains only a single paragraph with a single hash tag
function isParagraphWithSingleTag(elements: SlateElement[]): boolean {
  if (elements.length !== 1) return false
  const [paragraph] = elements
  if (paragraph.type !== PARAGRAPH) return false

  const meaningfulChildren = paragraph.children.filter(
    (child) => !SlateText.isText(child) || child.text.trim() !== '',
  )

  return (
    meaningfulChildren.length === 1 &&
    SlateElement.isElement(meaningfulChildren[0]) &&
    meaningfulChildren[0].type === HASH_TAG
  )
}

// Check if the editor content is empty (only one empty paragraph)
function isEditorEmpty(elements: SlateElement[]): boolean {
  if (elements.length !== 1) return false
  const [paragraph] = elements
  return isEmptyParagraph(paragraph)
}

// Check if the element is an empty paragraph
function isEmptyParagraph(element: SlateElement): boolean {
  if (element.type !== PARAGRAPH) return false

  return element.children.every((child) => SlateText.isText(child) && child.text.trim() === '')
}

// Trim trailing empty paragraphs from the editor content, ensuring at least one paragraph remains
export function trimTrailingEmptyParagraphs(elements: SlateElement[]): SlateElement[] {
  if (elements.length <= 1) return elements

  let end = elements.length

  while (end > 0 && isEmptyParagraph(elements[end - 1])) {
    end--
  }

  if (end === 0) end = 1

  return elements.slice(0, end)
}
