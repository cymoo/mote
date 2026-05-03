import { createContext, useContext } from 'react'
import { Editor, Element, Node, Path, Point, Range, Transforms } from 'slate'
import { RenderElementProps } from 'slate-react'

import { PARAGRAPH, ParagraphElement, TABLE, TABLE_CELL, TABLE_ROW, TableCellElement, TableRowElement } from '../types'
import { findElement } from '../utils'

// ---------------------------------------------------------------------------
// React context — lets TableCell know if it lives inside a header row
// ---------------------------------------------------------------------------

const TableHeaderContext = createContext(false)

// ---------------------------------------------------------------------------
// React components
// ---------------------------------------------------------------------------

export function Table({ attributes, children }: RenderElementProps) {
  return (
    <div className="my-3 overflow-x-auto">
      <table className="border-collapse w-full">
        {/* attributes (including Slate's ref) go on tbody, matching the official Slate tables pattern.
            This prevents the browser from inserting an implicit tbody and keeps Slate's DOM mapping correct. */}
        <tbody {...attributes}>{children}</tbody>
      </table>
    </div>
  )
}

export function TableRow({ attributes, children, element }: RenderElementProps) {
  const isHeader = (element as TableRowElement).isHeader ?? false
  return (
    <TableHeaderContext.Provider value={isHeader}>
      <tr {...attributes}>{children}</tr>
    </TableHeaderContext.Provider>
  )
}

export function TableCell({ attributes, children, element }: RenderElementProps) {
  const isHeader = useContext(TableHeaderContext)
  const cell = element as TableCellElement
  const Tag = isHeader ? 'th' : 'td'
  return (
    <Tag
      {...attributes}
      style={cell.align ? { textAlign: cell.align } : undefined}
      className={`border border-gray-200 dark:border-gray-700 px-3 py-1.5 align-top ${isHeader ? 'bg-gray-100 dark:bg-gray-800 font-semibold' : ''}`}
    >
      {children}
    </Tag>
  )
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function withTable(editor: Editor): Editor {
  const { insertBreak, deleteBackward, normalizeNode } = editor

  // Enter in a table cell inserts a soft line break instead of splitting
  editor.insertBreak = () => {
    if (findElement(editor, TABLE_CELL)) {
      Editor.insertText(editor, '\n')
      return
    }
    insertBreak()
  }

  // Backspace at the very start of a cell does nothing —
  // prevents Slate from merging the cell with content outside the table
  editor.deleteBackward = (...args) => {
    const { selection } = editor
    if (selection && Range.isCollapsed(selection)) {
      const cellEntry = findElement(editor, TABLE_CELL)
      if (cellEntry) {
        const [, cellPath] = cellEntry
        if (Point.equals(Editor.start(editor, cellPath), selection.anchor)) {
          return
        }
      }
    }
    deleteBackward(...args)
  }

  editor.normalizeNode = (entry) => {
    const [node, path] = entry

    // Ensure there is always a trailing paragraph after a table at the editor root
    if (path.length === 0) {
      const children = editor.children
      if (
        children.length > 0 &&
        Element.isElement(children[children.length - 1]) &&
        (children[children.length - 1] as Element).type === TABLE
      ) {
        Transforms.insertNodes(
          editor,
          { type: PARAGRAPH, children: [{ text: '' }] } as ParagraphElement,
          { at: [children.length] },
        )
        return
      }
    }

    if (!Element.isElement(node)) {
      normalizeNode(entry)
      return
    }

    // table must have at least one table-row
    if (node.type === TABLE && node.children.length === 0) {
      Transforms.insertNodes(
        editor,
        {
          type: TABLE_ROW,
          isHeader: true,
          children: [{ type: TABLE_CELL, children: [{ text: '' }] }],
        } as TableRowElement,
        { at: [...path, 0] },
      )
      return
    }

    // table-row must have at least one table-cell
    if (node.type === TABLE_ROW && node.children.length === 0) {
      Transforms.insertNodes(
        editor,
        { type: TABLE_CELL, children: [{ text: '' }] } as TableCellElement,
        { at: [...path, 0] },
      )
      return
    }

    // table-cell must have at least one text child
    if (node.type === TABLE_CELL && node.children.length === 0) {
      Transforms.insertNodes(editor, { text: '' }, { at: [...path, 0] })
      return
    }

    normalizeNode(entry)
  }

  return editor
}

// ---------------------------------------------------------------------------
// Cell navigation helpers
// ---------------------------------------------------------------------------

export function moveToNextTableCell(editor: Editor) {
  const cellEntry = findElement(editor, TABLE_CELL)
  if (!cellEntry) return

  const [, cellPath] = cellEntry
  const nextCellPath = Path.next(cellPath)

  // Try the next sibling cell in the same row
  if (Node.has(editor, nextCellPath)) {
    Transforms.select(editor, Editor.start(editor, nextCellPath))
    return
  }

  // Try the first cell of the next row
  const rowPath = Path.parent(cellPath)
  const nextRowPath = Path.next(rowPath)

  if (Node.has(editor, nextRowPath)) {
    const firstCellPath = [...nextRowPath, 0]
    Transforms.select(editor, Editor.start(editor, firstCellPath))
    return
  }

  // We're at the last cell of the last row — insert a new empty row
  const tablePath = Path.parent(rowPath)
  const tableNode = Node.get(editor, tablePath)
  const colCount = (tableNode as Element).children[0]
    ? ((tableNode as Element).children[0] as TableRowElement).children.length
    : 1

  const newRow: TableRowElement = {
    type: TABLE_ROW,
    isHeader: false,
    children: Array.from({ length: colCount }, () => ({
      type: TABLE_CELL,
      children: [{ text: '' }],
    })) as TableCellElement[],
  }

  const insertAt = Path.next(rowPath)
  Editor.withoutNormalizing(editor, () => {
    Transforms.insertNodes(editor, newRow, { at: insertAt })
  })
  Transforms.select(editor, Editor.start(editor, [...insertAt, 0]))
}

export function moveToPrevTableCell(editor: Editor) {
  const cellEntry = findElement(editor, TABLE_CELL)
  if (!cellEntry) return

  const [, cellPath] = cellEntry

  // Try the previous sibling cell in the same row
  if (cellPath[cellPath.length - 1] > 0) {
    const prevCellPath = Path.previous(cellPath)
    Transforms.select(editor, Editor.end(editor, prevCellPath))
    return
  }

  // Try the last cell of the previous row
  const rowPath = Path.parent(cellPath)
  if (rowPath[rowPath.length - 1] === 0) {
    // Already at the first row — do nothing
    return
  }

  const prevRowPath = Path.previous(rowPath)
  const prevRowNode = Node.get(editor, prevRowPath) as TableRowElement
  const lastCellIndex = prevRowNode.children.length - 1
  const lastCellPath = [...prevRowPath, lastCellIndex]
  Transforms.select(editor, Editor.end(editor, lastCellPath))
}
