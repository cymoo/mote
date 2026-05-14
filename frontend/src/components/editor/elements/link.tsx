import { Editor, Element, Node, Point, Range, Transforms } from 'slate'
import { ReactEditor, RenderElementProps } from 'slate-react'

import { LINK, LinkElement } from '../types'
import { findElement, isElementActive, isUrl } from '../utils'

// https://github.com/ianstormtaylor/slate/blob/main/site/examples/inlines.tsx
export const withLink = (editor: Editor) => {
  const reactEditor = editor as ReactEditor
  const { insertData, insertText, isInline, deleteBackward, normalizeNode } = reactEditor

  editor.isInline = (element) => {
    return element.type === LINK ? true : isInline(element)
  }

  editor.normalizeNode = (entry) => {
    const [node, path] = entry

    if (Element.isElement(node) && node.type === LINK) {
      const text = Node.string(node)
      if (text.trim() === '') {
        Transforms.removeNodes(editor, { at: path })
        return
      }
    }

    normalizeNode(entry)
  }

  editor.deleteBackward = (...args) => {
    const entry = findElement(editor, LINK)
    if (entry) {
      if (Node.string(entry[0]) === '') {
        Transforms.removeNodes(editor, { at: entry[1] })
        return
      }
    }
    deleteBackward(...args)
  }

  editor.insertText = (text) => {
    // Press `space` after a link to restore to normal text
    if (text === ' ') {
      const entry = findElement(editor, LINK)

      if (entry) {
        const [, path] = entry
        const endPoint = Editor.end(editor, path)

        if (Point.equals(endPoint, editor.selection!.focus)) {
          // Move one offset to exit the link
          Transforms.move(editor, { unit: 'offset' })
          insertText(text)
          return
        }
      }
    }

    if (isUrl(text)) {
      wrapOrInsertLink(editor, text)
    } else {
      insertText(text)
    }
  }

  // if the pasted text is a URL, convert it to a link
  reactEditor.insertData = (data) => {
    const text = data.getData('text/plain')

    if (isUrl(text)) {
      const preview = data.getData('text/link-preview')
      if (preview) {
        wrapOrInsertLink(editor, text, (JSON.parse(preview) as { title: string }).title)
      } else {
        wrapOrInsertLink(editor, text)
      }
    } else {
      insertData(data)
    }
  }

  return editor
}

export const Link = ({ attributes, children, element }: RenderElementProps) => {
  const linkElement = element as LinkElement
  return (
    <a {...attributes} href={linkElement.url} title={linkElement.title}>
      <InlineChromiumBugfix />
      {children}
      <InlineChromiumBugfix />
    </a>
  )
}

export const wrapOrInsertLink = (editor: Editor, url: string, title?: string) => {
  const { selection } = editor
  if (selection === null) {
    return
  }

  if (isElementActive(editor, LINK)) {
    unwrapLink(editor)
  }

  const isCollapsed = Range.isCollapsed(selection)
  const link = {
    type: LINK,
    url,
    title,
    children: isCollapsed ? [{ text: title ?? url }] : [],
  }

  if (isCollapsed) {
    Transforms.insertNodes(editor, link)
  } else {
    Transforms.wrapNodes(editor, link, { split: true })
    Transforms.collapse(editor, { edge: 'end' })
  }
}

export const unwrapLink = (editor: Editor) => {
  if (editor.selection === null) {
    return
  }

  Transforms.unwrapNodes(editor, { match: (node) => Element.isElement(node) && node.type === LINK })
}

// Put this at the start and end of an inline component to work around this Chromium bug:
// https://github.com/ianstormtaylor/slate/blob/main/site/examples/inlines.tsx
// https://bugs.chromium.org/p/chromium/issues/detail?id=1249405
const InlineChromiumBugfix = () => (
  <span contentEditable={false} style={{ fontSize: 0 }}>
    ${String.fromCodePoint(160) /* Non-breaking space */}
  </span>
)
