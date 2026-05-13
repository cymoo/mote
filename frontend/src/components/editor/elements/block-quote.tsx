import { Editor, Element, Node, Path, Range, Text as SlateText, Transforms } from 'slate'
import { RenderElementProps } from 'slate-react'

import {
  BLOCK_QUOTE,
  LIST_ITEM,
  PARAGRAPH,
  ParagraphElement,
  isInlineElementOrText,
} from '../types'
import { findElement, isElementActive } from '../utils'

export function withBlockQuote(editor: Editor) {
  const { insertBreak, normalizeNode } = editor

  editor.insertBreak = () => {
    const { selection } = editor

    if (selection && Range.isCollapsed(selection)) {
      const quoteEntry = findElement(editor, BLOCK_QUOTE)

      if (quoteEntry) {
        const [, quotePath] = quoteEntry
        const blockEntry = Editor.above(editor, {
          match: (node) =>
            Element.isElement(node) && Editor.isBlock(editor, node) && node.type !== BLOCK_QUOTE,
          mode: 'lowest',
        })

        if (blockEntry) {
          const [blockNode, blockPath] = blockEntry
          const quoteNode = Node.get(editor, quotePath)
          const blockIsDirectQuoteChild = Path.equals(Path.parent(blockPath), quotePath)
          const blockIsLastQuoteChild =
            Element.isElement(quoteNode) &&
            blockPath[blockPath.length - 1] === quoteNode.children.length - 1

          if (
            Element.isElement(blockNode) &&
            blockNode.type === PARAGRAPH &&
            Node.string(blockNode) === '' &&
            blockIsDirectQuoteChild &&
            blockIsLastQuoteChild
          ) {
            exitBlockQuote(editor, quotePath, blockPath)
            return
          }
        }
      }
    }

    insertBreak()
  }

  editor.normalizeNode = (entry) => {
    const [node, path] = entry

    if (Element.isElement(node) && node.type === BLOCK_QUOTE) {
      if (node.children.length === 0) {
        Transforms.insertNodes(editor, createParagraph(), { at: path.concat(0) })
        return
      }

      for (const [child, childPath] of Node.children(editor, path)) {
        if (!Element.isElement(child) || isInlineElementOrText(child)) {
          wrapQuoteInlineRun(editor, path, childPath)
          return
        }
      }
    }

    normalizeNode(entry)
  }

  return editor
}

export function toggleBlockQuote(editor: Editor) {
  if (editor.selection === null) {
    return
  }

  const active = isElementActive(editor, BLOCK_QUOTE)

  if (active) {
    Transforms.unwrapNodes(editor, {
      match: (node) => Element.isElement(node) && node.type === BLOCK_QUOTE,
      split: true,
    })
    return
  }

  Transforms.wrapNodes(
    editor,
    { type: BLOCK_QUOTE, children: [] },
    {
      match: (node) =>
        Element.isElement(node) &&
        Editor.isBlock(editor, node) &&
        node.type !== BLOCK_QUOTE &&
        node.type !== LIST_ITEM,
      mode: 'highest',
      split: true,
    },
  )
}

export function BlockQuote({ attributes, children }: RenderElementProps) {
  return <blockquote {...attributes}>{children}</blockquote>
}

function createParagraph(): ParagraphElement {
  return {
    type: PARAGRAPH,
    children: [{ text: '' }],
  }
}

function exitBlockQuote(editor: Editor, quotePath: Path, emptyBlockPath: Path) {
  const quoteNode = Node.get(editor, quotePath)
  if (!Element.isElement(quoteNode)) {
    return
  }

  const at = quoteNode.children.length === 1 ? quotePath : Path.next(quotePath)

  Editor.withoutNormalizing(editor, () => {
    if (quoteNode.children.length === 1) {
      Transforms.removeNodes(editor, { at: quotePath })
    } else {
      Transforms.removeNodes(editor, { at: emptyBlockPath })
    }

    Transforms.insertNodes(editor, createParagraph(), { at, select: true })
  })
}

function wrapQuoteInlineRun(editor: Editor, quotePath: Path, startPath: Path) {
  let endPath = startPath

  for (const [, childPath] of Node.children(editor, quotePath)) {
    if (childPath[childPath.length - 1] <= startPath[startPath.length - 1]) {
      continue
    }

    const child = Node.get(editor, childPath)
    if (Element.isElement(child) && !isInlineElementOrText(child)) {
      break
    }
    endPath = childPath
  }

  Transforms.wrapNodes(editor, createParagraph(), {
    at: Editor.range(editor, startPath, endPath),
    match: (node, path) =>
      path.length === quotePath.length + 1 &&
      Path.equals(Path.parent(path), quotePath) &&
      (SlateText.isText(node) || (Element.isElement(node) && isInlineElementOrText(node))),
    split: true,
  })
}
