import { Editor, Element, Node, Point, Range, Transforms } from 'slate'
import { RenderElementProps } from 'slate-react'

import { HASH_TAG } from '../types'
import { findElement, getPrevChar } from '../utils'

export function withHashTag(editor: Editor) {
  const { isInline, insertText, insertBreak, deleteBackward, normalizeNode } = editor

  editor.isInline = (element) => {
    return element.type === HASH_TAG ? true : isInline(element)
  }

  editor.normalizeNode = (entry) => {
    const [node, path] = entry

    if (Element.isElement(node) && node.type === HASH_TAG) {
      const text = Node.string(node)
      if (text === '#' || text === '' || !text.startsWith('#')) {
        Transforms.unwrapNodes(editor, { at: path })
        return
      }
    }

    normalizeNode(entry)
  }

  editor.deleteBackward = (...args) => {
    const entry = findElement(editor, HASH_TAG)
    if (entry) {
      if (Node.string(entry[0]) === '' || Node.string(entry[0]) === '#') {
        Transforms.removeNodes(editor, { at: entry[1] })
        return
      }
      if (getPrevChar(editor) === '#') {
        Transforms.unwrapNodes(editor, { at: entry[1] })
        deleteBackward(...args)
        return
      }
    }

    deleteBackward(...args)
  }

  // NOTE: Bug of slate：
  // If insertText does nothing, text is inserted into the DOM anyway, causing DOM/Slate de-sync
  // https://github.com/ianstormtaylor/slate/issues/5152
  editor.insertText = (text) => {
    if (text.trim() === '') {
      const entry = findElement(editor, HASH_TAG)

      if (entry) {
        const [, path] = entry
        const endPoint = Editor.end(editor, path)

        if (Point.equals(endPoint, editor.selection!.focus)) {
          Transforms.move(editor, { unit: 'offset' })
        } else {
          // NOTE: `insertText` must insert some character
          insertText('-')
          // Or perhaps inserting an invisible character would be better?
          // insertText(String.fromCodePoint(160))
          return
        }
      }
    }

    insertText(text)
  }

  editor.insertBreak = () => {
    const { selection } = editor

    if (findElement(editor, HASH_TAG, false, selection?.anchor)) {
      return
    }

    if (!Range.isCollapsed(selection!) && findElement(editor, HASH_TAG, false, selection?.focus)) {
      return
    }

    insertBreak()
  }

  return editor
}

export function HashTag({ attributes, children }: RenderElementProps) {
  return (
    /*
      Note that this is not a true button, but a span with button-like CSS.
      True buttons are display:inline-block, but Chrome and Safari
      have a bad bug with display:inline-block inside contenteditable:
      - https://bugs.webkit.org/show_bug.cgi?id=105898
      - https://bugs.chromium.org/p/chromium/issues/detail?id=1088403
      Worse, one cannot override the display property: https://github.com/w3c/csswg-drafts/issues/3226
      The only current workaround is to emulate the appearance of a display:inline button using CSS.
    */
    <span {...attributes} className="hash-tag">
      <InlineChromiumBugfix />
      {children}
      <InlineChromiumBugfix />
    </span>
  )
}

export function insertHashTag(editor: Editor, name: string) {
  const element = {
    type: HASH_TAG,
    children: [{ text: '#' + name }],
  }
  const entry = findElement(editor, HASH_TAG)
  if (entry) {
    Transforms.insertText(editor, '#' + name)
  } else {
    Transforms.insertNodes(editor, element)
  }
}

// Put this at the start and end of an inline component to work around this Chromium bug:
// https://github.com/ianstormtaylor/slate/blob/main/site/examples/inlines.tsx
// https://bugs.chromium.org/p/chromium/issues/detail?id=1249405
const InlineChromiumBugfix = () => (
  <span contentEditable={false} style={{ fontSize: 0 }}>
    {String.fromCodePoint(160) /* Non-breaking space */}
  </span>
)
