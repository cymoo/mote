import { BasePoint, Editor, Element, Range, Transforms } from 'slate'

import { wrapList } from '../elements/list.js'
import {
  BLOCK_QUOTE,
  BULLETED_LIST,
  CHECK_LIST,
  CODE_BLOCK,
  HEADING_FIVE,
  HEADING_FOUR,
  HEADING_ONE,
  HEADING_THREE,
  HEADING_TWO,
  LIST_ITEM,
  NUMBERED_LIST,
  PARAGRAPH,
} from '../types'
import { isElementActive } from '../utils'

const BLOCK_PATTERN = {
  '#': HEADING_ONE,
  '##': HEADING_TWO,
  '###': HEADING_THREE,
  '####': HEADING_FOUR,
  '#####': HEADING_FIVE,

  '>': BLOCK_QUOTE,
  '```': CODE_BLOCK,
  '*': LIST_ITEM,
  '-': LIST_ITEM,
  '+': LIST_ITEM,
  '1.': LIST_ITEM,
  '[]-': CHECK_LIST,
  '[x]-': CHECK_LIST,
}

export function withMarkdownShortcuts(editor: Editor): Editor {
  const { insertText } = editor

  editor.insertText = (text) => {
    const { selection } = editor
    if (
      !selection ||
      !Range.isCollapsed(selection) ||
      // NOTE: The current type must be `paragraph` to use mark-down syntax
      !isElementActive(editor, PARAGRAPH)
    ) {
      insertText(text)
      return
    }

    // heading, blockquote, code-block, list, check-list
    if (text === ' ') {
      const beforeRange = getRangeBeforeCursor(editor)
      const beforeText = Editor.string(editor, beforeRange)
      const type = (BLOCK_PATTERN as Record<string, string>)[beforeText]
      const props = { type } as { type: string; checked?: boolean }
      if (beforeText === '[]-') props.checked = false
      if (beforeText === '[x]-') props.checked = true

      if (type) {
        Transforms.select(editor, beforeRange)
        Transforms.delete(editor)

        if (type === LIST_ITEM) {
          const listType = beforeText === '1.' ? NUMBERED_LIST : BULLETED_LIST
          wrapList(editor, listType)
        } else if (type === BLOCK_QUOTE) {
          Transforms.wrapNodes(
            editor,
            { type: BLOCK_QUOTE, children: [] },
            {
              match: (node) => Element.isElement(node) && node.type === PARAGRAPH,
              mode: 'lowest',
              split: true,
            },
          )
        } else {
          Transforms.setNodes(editor, props, {
            match: (node) => Element.isElement(node) && Editor.isBlock(editor, node),
          })
        }
        return
      }
    }

    insertText(text)
  }

  return editor
}

const getRangeBeforeCursor = (editor: Editor): { anchor: BasePoint; focus: BasePoint } => {
  const { selection } = editor
  if (!selection) {
    throw Error('cannot get the range before cursor without a selection')
  }
  const { anchor } = selection
  const block = Editor.above(editor, {
    match: (node) => Element.isElement(node) && Editor.isBlock(editor, node),
  })
  const path = block ? block[1] : []
  const start = Editor.start(editor, path)
  return { anchor, focus: start }
}
