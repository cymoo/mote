import { TextareaHTMLAttributes, useCallback, useLayoutEffect, useMemo } from 'react'
import scrollIntoView from 'scroll-into-view-if-needed'
import { Editor, Range, Element as SlateElement, Transforms, createEditor } from 'slate'
import { withHistory } from 'slate-history'
import {
  Editable,
  ReactEditor,
  RenderElementProps,
  RenderLeafProps,
  Slate,
  withReact,
} from 'slate-react'

import { IS_IOS, isCtrlKey } from '@/utils/browser'

import { Element } from './element'
import { withBlockQuote } from './elements/block-quote'
import { withCheckList } from './elements/check-list'
import { withCodeBlock } from './elements/code-block'
import { withHashTag } from './elements/hash-tag'
import { withHeading } from './elements/heading'
import { handleMoveImage, withImage } from './elements/image'
import { withLink } from './elements/link'
import { withList, deIndentList, indentList } from './elements/list'
import {
  withAvoidEmptyChildren,
  withResetToParagraphWhenDeleteAtBlockStart,
} from './elements/plugins'
import { withTable, moveToNextTableCell, moveToPrevTableCell } from './elements/table'
import { HashTagSelect } from './extensions/hashtag-select'
import { withMarkdownShortcuts } from './extensions/markdown'
import { withMatchBrackets } from './extensions/match-brackets'
import { withPasteHtml } from './html'
import { Leaf } from './leaf'
import { BLOCK_QUOTE, CHECK_LIST, CODE_BLOCK, HEADINGS, IMAGE, LIST_ITEM, TABLE_CELL } from './types'
import {
  findElement,
  isEditorEmpty,
  isElementActive,
  isFirstElementParagraph,
  removeAllMarks,
  toggleBlock,
  toggleMark,
} from './utils'

export interface EditorProps extends Omit<TextareaHTMLAttributes<HTMLDivElement>, 'onChange'> {
  initialValue: SlateElement[]
  onChange: (value: SlateElement[]) => void
  autoFocus?: boolean
  autoFocusEnd?: boolean
  tags?: string[]
  beforeUploadImage?: (file: File) => boolean
  uploadImage?: (
    file: File,
  ) => Promise<{ url: string; width?: number; height?: number; alt?: string }>
}

declare module 'slate' {
  interface BaseElement {
    type: string
  }

  interface BaseText {
    bold?: boolean
    italic?: boolean
    underline?: boolean
    strikethrough?: boolean
    sup?: boolean
    sub?: boolean
    code?: boolean
  }
}

declare module 'slate-react' {
  interface ReactEditor {
    beforeUploadImage?: (file: File) => boolean
    uploadImage?: (
      file: File,
    ) => Promise<{ url: string; width?: number; height?: number; alt?: string }>
  }
}

// NOTE: Slate >= v0.106 has a critical bug on iOS, making it unable to handle Chinese input.
export function MbEditor({
  initialValue,
  onChange,
  autoFocus = true,
  autoFocusEnd = false,
  tags = [],
  beforeUploadImage,
  uploadImage,
  children,
  ...props
}: EditorProps) {
  const editor = useMemo(
    () =>
      compose(
        withAvoidEmptyChildren,
        withMarkdownShortcuts,
        withMatchBrackets,
        withResetToParagraphWhenDeleteAtBlockStart(
          ...HEADINGS,
          CHECK_LIST,
          CODE_BLOCK,
          BLOCK_QUOTE,
        ),
        withBlockQuote,
        withCodeBlock,
        withCheckList,
        withHeading,
        withHashTag,
        withImage,
        withLink,
        withList,
        withTable,
        // NOTE: `withReact` must be placed after `withPasteHtml`;
        // otherwise, the `insertData` method of `withPasteHTML` will not be invoked.
        withPasteHtml,
        withHistory,
        withReact,
      )(createEditor()) as ReactEditor,
    [],
  )

  editor.beforeUploadImage = beforeUploadImage
  editor.uploadImage = uploadImage

  // NOTE: `<Editable autoFocus={true} ...>` does not work...
  useLayoutEffect(() => {
    const el = ReactEditor.toDOMNode(editor, editor)
    if (autoFocusEnd) {
      if (!IS_IOS) {
        Transforms.select(editor, Editor.end(editor, []))
      } else {
        setTimeout(() => {
          focusInputOnIOS(el, () => {
            Transforms.select(editor, Editor.end(editor, []))
          })
        }, 0)
      }
    } else if (autoFocus) {
      if (!IS_IOS) {
        Transforms.select(editor, Editor.start(editor, []))
      } else {
        setTimeout(() => {
          focusInputOnIOS(el)
        }, 0)
      }
    }
  }, [editor, autoFocus, autoFocusEnd])

  const renderElement = useCallback((props: RenderElementProps) => <Element {...props} />, [])
  const renderLeaf = useCallback((props: RenderLeafProps) => <Leaf {...props} />, [])

  return (
    <Slate
      editor={editor}
      initialValue={initialValue}
      onChange={(value) => {
        // NOTE: `onValueChange` cannot be triggered when modifying the editor's content via API, such as `Transform.setNodes`.
        const isAstChange = editor.operations.some((op) => 'set_selection' !== op.type)
        if (isAstChange) {
          onChange(value as SlateElement[])
        }
      }}
    >
      <Editable
        autoFocus={autoFocus}
        renderPlaceholder={({ children, attributes }) => {
          const showPlaceholder = isEditorEmpty(editor) && isFirstElementParagraph(editor)
          return <span {...attributes}>{showPlaceholder ? children : ''}</span>
        }}
        renderElement={renderElement}
        renderLeaf={renderLeaf}
        // NOTE: The default `scrollSelectionIntoView` has the following issues:
        // 1. Scrolling occurs when an image is selected.
        // 2. Strange bugs on Android during editing:
        //   a) Pressing the Enter key fails to scroll into view.
        //   b) When the editor is inside a "floating" element, the background exhibits unusual scrolling behavior.
        // The default implementation is as follows:
        // https://github.com/ianstormtaylor/slate/blob/main/packages/slate-react/src/components/editable.tsx
        // The method to fix image scrolling in wang-editor:
        // https://github.com/wangeditor-team/wangEditor/blob/master/packages/core/src/text-area/syncSelection.ts
        scrollSelectionIntoView={(editor, domRange) => {
          if (!editor.selection || Range.isCollapsed(editor.selection)) {
            const img = findElement(editor, IMAGE)
            if (img) {
              return
            }

            // After inserting or deleting a \n inside a table cell, the cursor
            // sits right after a newline character. At that position the browser
            // returns a degenerate or edge-case rect from getBoundingClientRect,
            // which causes spurious scrolling (down on insert, ~viewport-height
            // up on delete). Skip scrolling for that specific cursor position.
            if (findElement(editor, TABLE_CELL) && editor.selection) {
              const { anchor } = editor.selection
              const [leaf] = Editor.leaf(editor, anchor)
              if (leaf.text[anchor.offset - 1] === '\n') return
            }

            const leafEl = domRange.startContainer.parentElement!
            leafEl.getBoundingClientRect = domRange.getBoundingClientRect.bind(domRange)
            scrollIntoView(leafEl, {
              scrollMode: 'if-needed',
              // See：https://www.wangeditor.com/v5/editor-config.html#scroll
              boundary: ReactEditor.toDOMNode(editor, editor).parentElement,
              // boundary: document.body,
              block: 'end',
              behavior: 'smooth',
            })

            // @ts-expect-error an unorthodox delete D:
            delete leafEl.getBoundingClientRect
          }
        }}
        onKeyDown={(event) => {
          const { selection } = editor

          // NOTE: Default left/right behavior is unit:'character'.
          // This fails to distinguish between two cursor positions, such as
          // <inline>foo<cursor/></inline> vs <inline>foo</inline><cursor/>.
          // Here we modify the behavior to unit:'offset'.
          // This lets the user step into and out of the inline without stepping over characters.
          // You may wish to customize this further to only use unit:'offset' in specific cases.
          if (selection && Range.isCollapsed(selection)) {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              Transforms.move(editor, { unit: 'offset', reverse: true })
              return
            }
            if (event.key === 'ArrowRight') {
              event.preventDefault()
              Transforms.move(editor, { unit: 'offset' })
              return
            }
          }

          if (event.key === 'Tab') {
            if (isElementActive(editor, TABLE_CELL)) {
              event.preventDefault()
              if (event.shiftKey) {
                moveToPrevTableCell(editor)
              } else {
                moveToNextTableCell(editor)
              }
              return
            }

            if (!isElementActive(editor, LIST_ITEM)) return

            // NOTE: The default behavior when pressing the Tab key is to focus on the next focusable element outside the editor.
            event.preventDefault()
            if (event.shiftKey) {
              deIndentList(editor)
            } else {
              indentList(editor)
            }
            return
          }

          if (isCtrlKey(event)) {
            switch (event.key) {
              case `Enter`: {
                event.preventDefault()
                editor.insertText('\n')
                break
              }
              case '.':
              case '`': {
                event.preventDefault()
                toggleMark(editor, 'code')
                break
              }
              case 'b': {
                event.preventDefault()
                toggleMark(editor, 'bold')
                break
              }
              case 'k': {
                event.preventDefault()
                removeAllMarks(editor)
                break
              }
              case '/': {
                event.preventDefault()
                toggleBlock(editor, 'block-quote')
                break
              }
              default:
              //
            }
          }
        }}
        onDrop={(event) => {
          handleMoveImage(event, editor)
        }}
        {...props}
      />
      {children}
      <HashTagSelect tags={tags} />
    </Slate>
  )
}

function compose<T>(...funcs: ((arg: T) => T)[]): (arg: T) => T {
  return funcs.reduce((acc, func) => (arg) => acc(func(arg)))
}

// focus on mobile safari is disgusting...
// https://stackoverflow.com/questions/12204571/mobile-safari-javascript-focus-method-on-inputfield-only-works-with-click
const focusInputOnIOS = (el: HTMLElement, cb?: () => void) => {
  const fakeInput = document.createElement('input')
  fakeInput.setAttribute('type', 'text')
  fakeInput.setAttribute('readonly', 'true')
  fakeInput.style.position = 'absolute'
  fakeInput.style.opacity = String(0)
  fakeInput.style.height = String(0)
  fakeInput.style.fontSize = '16px' // disable auto zoom

  // you may need to append to another element depending on the browser's auto
  // zoom/scroll behavior
  document.body.prepend(fakeInput)

  // focus so that subsequent async focus will work
  fakeInput.focus()

  setTimeout(() => {
    // now we can focus on the target input
    // https://stackoverflow.com/questions/52652469/prevent-safari-from-automatically-scrolling-to-focused-element-scrollback-techn
    el.focus()
    // cleanup
    fakeInput.remove()
    cb?.()
  }, 75)
}
