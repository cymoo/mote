import { DragEvent, HTMLProps, useEffect, useState } from 'react'
import { Editor, Element, Path, Point, Range, Transforms } from 'slate'
import { HistoryEditor } from 'slate-history'
import {
  ReactEditor,
  RenderElementProps,
  useFocused,
  useSelected,
  useSlateStatic,
} from 'slate-react'

import { cx } from '@/utils/css.ts'
import { AppError } from '@/error.ts'
import { delay } from '@/utils/func.ts'
import { useLatest } from '@/utils/hooks/use-latest.ts'
import { useIsUnmounted } from '@/utils/hooks/use-unmount.ts'
import { URLWithStore } from '@/utils/url'

import { Spinner } from '@/components/spinner'

import { EditorProps } from '../editor'
import { IMAGE, ImageElement } from '../types'
import { findElement, getCurrentBlock, getLastChild, isEmptyLine, isImageUrl } from '../utils'
import { insertNewParagraph } from './paragraph'

export const withImage = (editor: Editor) => {
  const { insertData, insertBreak, deleteBackward, isVoid, normalizeNode } = editor as ReactEditor

  editor.isVoid = (element) => {
    return element.type === IMAGE ? true : isVoid(element)
  }

  // When pressing enter while an image is selected, insert a new paragraph
  editor.insertBreak = () => {
    const { selection } = editor

    if (selection && Range.isCollapsed(selection)) {
      const entry = findElement(editor, IMAGE)
      if (entry) {
        insertNewParagraph(editor)
        return
      }
    }

    insertBreak()
  }

  // If the last element in the editor is an Image, insert an empty line at the end;
  // this is to work around a slate bug:
  // If the last element of the editor is a void block element, the editor's content cannot be fully selected and cleared
  editor.normalizeNode = (entry) => {
    const [, path] = entry

    if (Path.equals(path, [])) {
      const [lastNode, lastPath] = getLastChild(editor, path)
      if (Element.isElement(lastNode) && lastNode.type === IMAGE) {
        insertNewParagraph(editor, Path.next(lastPath))
        return
      }
    }
    normalizeNode(entry)
  }

  // When pressing `delete` at the start of a line, if the line is empty, delete the line;
  // otherwise, select the image above.
  // NOTE: This behavior should have lower priority than `withResetToParagraphWhenDeleteAtBlockStart`
  editor.deleteBackward = (...args) => {
    const { selection } = editor
    if (selection && Range.isCollapsed(selection)) {
      const block = getCurrentBlock(editor)
      if (block) {
        const [, path] = block
        const start = Editor.start(editor, path)
        // Check if the cursor is at the start of a block
        if (Point.equals(selection.anchor, start)) {
          const prev = Editor.previous(editor, {
            at: path,
          })
          if (
            // Check if the previous node is an Image
            prev &&
            Element.isElement(prev[0]) &&
            Editor.isBlock(editor, prev[0]) &&
            Editor.isVoid(editor, prev[0])
          ) {
            // If the current line is empty, remove the line when pressing `delete`
            if (isEmptyLine(editor, path)) {
              Transforms.removeNodes(editor, {
                match: (node) => Element.isElement(node) && Editor.isBlock(editor, node),
                mode: 'lowest',
              })
            } else {
              // Otherwise, select the image
              Transforms.select(editor, prev[1])
            }
            return
          }
        }
      }
    }
    deleteBackward(...args)
  }

  // Support copying images or image URLs
  // NOTE: Both pasting and dragging images into the editor will trigger `insertData`
  ;(editor as ReactEditor).insertData = (data) => {
    const text = data.getData('text/plain')
    const { files } = data

    if (files.length > 0) {
      for (const file of files) {
        const [mime] = file.type.split('/')
        if (mime === 'image') {
          const beforeUpload = (editor as ReactEditor).beforeUploadImage

          if (!beforeUpload || beforeUpload(file)) {
            const objURL = URLWithStore.createObjectURL(file)
            insertImage(editor, { url: objURL })
          }
        }
      }
    } else if (isImageUrl(text)) {
      insertImage(editor, { url: text })
    } else {
      insertData(data)
    }
  }

  return editor
}

// https://gomakethings.com/how-to-write-good-alt-text/
// TODO: Support editing image alt text and figcaption
export const Image = ({ attributes, children, element }: RenderElementProps) => {
  const editor = useSlateStatic()
  const path = ReactEditor.findPath(editor as ReactEditor, element)
  const new_path = useLatest(path)
  const selected = useSelected()
  const focused = useFocused()

  const { url, alt, width, height, caption } = element as ImageElement

  const [loading, setLoading] = useState(false)
  const isUnmounted = useIsUnmounted()

  useEffect(() => {
    const isBlob = url.startsWith('blob:')
    const uploadImage = (editor as ReactEditor).uploadImage
    const file = URLWithStore.getFile(url)

    if (isBlob && uploadImage && file) {
      const upload: () => Promise<
        Awaited<ReturnType<Required<EditorProps>['uploadImage']>> | undefined
      > = async () => {
        try {
          const res = await uploadImage(file)
          if (!isUnmounted()) {
            return res
          }
        } catch (err) {
          console.error(err)
          // Don't retry client errors (e.g. 413 Too Large); propagate to .catch()
          if (err instanceof AppError && err.code >= 400 && err.code < 500) {
            throw err
          }
          if (!isUnmounted()) {
            await delay(2000)
            return upload()
          }
        }
      }

      setLoading(true)
      upload()
        .then((res) => {
          if (!res) return
          HistoryEditor.withoutSaving(editor as HistoryEditor, () => {
            Transforms.setNodes(
              editor,
              {
                url: res.url,
                alt: res.alt,
                width: res.width,
                height: res.height,
              } as Partial<ImageElement>,
              {
                at: new_path.current,
              },
            )
            URLWithStore.revokeObjectURL(url)
          })
        })
        .catch((err: unknown) => {
          console.error(err)
          // On a permanent client error, remove the placeholder image node
          if (err instanceof AppError && err.code >= 400 && err.code < 500) {
            HistoryEditor.withoutSaving(editor as HistoryEditor, () => {
              Transforms.removeNodes(editor, { at: new_path.current })
              URLWithStore.revokeObjectURL(url)
            })
          }
        })
        .finally(() => {
          setLoading(false)
        })
    }
  }, [editor, isUnmounted, new_path, url])

  return (
    <div {...attributes}>
      {children}
      <figure contentEditable={false} className="relative">
        <img
          width={width}
          height={height}
          alt={alt}
          src={url}
          className={cx('rounded align-top', { 'ring-ring ring-1': selected && focused })}
          loading="lazy"
          onDragStart={(event) => {
            event.dataTransfer.setData('img-url', url)
          }}
        />
        {loading && <LoadingMask />}
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
    </div>
  )
}

function LoadingMask({ className, ...props }: HTMLProps<HTMLDivElement>) {
  return (
    <div
      className={cx(
        'pointer-events-none absolute top-0 left-0 h-full w-full bg-black/60',
        className,
      )}
      {...props}
    >
      <Spinner className="abs-center text-primary" />
    </div>
  )
}

export function handleMoveImage(event: DragEvent<HTMLDivElement>, editor: ReactEditor) {
  const url = event.dataTransfer.getData('img-url')
  if (!url) {
    return
  }
  event.preventDefault()

  if (!editor.selection) {
    return
  }

  const [match] = Editor.nodes(editor, {
    match: (node) => (node as ImageElement).url === url,
    at: [],
  })

  if (typeof match !== 'undefined') {
    const range = ReactEditor.findEventRange(editor, event)
    // NOTE: It seems `moveNodes` cannot be used here, as `to` must be a path; need to delete and then insert.
    // Transforms.moveNodes(editor, { at: match[1], to: range.anchor })
    Transforms.select(editor, range.anchor)
    Transforms.removeNodes(editor, { at: match[1] })
    Transforms.insertNodes(editor, match[0], { at: editor.selection })

    // NOTE: Restore the cursor position
    setTimeout(() => {
      const [match] = Editor.nodes(editor, {
        match: (node) => (node as ImageElement).url === url,
        at: [],
      })
      if (typeof match !== 'undefined') {
        Transforms.select(editor, match[1])
        Transforms.move(editor, { reverse: true })
      }
    })
  }
}

export const insertImagesFromFileInput = (editor: ReactEditor) => {
  const input = document.createElement('input')
  input.setAttribute('type', 'file')
  input.setAttribute('multiple', 'true')
  input.setAttribute('accept', 'image/*')
  input.click()

  input.onchange = () => {
    if (!input.files) {
      return
    }

    for (const file of input.files) {
      const beforeUpload = editor.beforeUploadImage
      if (!beforeUpload || beforeUpload(file)) {
        const objURL = URLWithStore.createObjectURL(file)
        insertImage(editor, {
          url: objURL,
        })
      }
    }
    input.value = ''
  }
}

const insertImage = (editor: Editor, { url, alt, width, height }: Partial<ImageElement>) => {
  const image = {
    type: 'image',
    url,
    alt,
    width,
    height,
    children: [{ text: '' }],
  }

  const { selection } = editor
  Editor.withoutNormalizing(editor, () => {
    if (selection && Range.isCollapsed(selection)) {
      // If there is an empty block element, delete it first
      const block = getCurrentBlock(editor)

      if (block) {
        const [, path] = block
        if (isEmptyLine(editor, path)) {
          Transforms.removeNodes(editor, {
            at: path,
          })
        }
      }
    }

    Transforms.insertNodes(editor, image)
  })
}
