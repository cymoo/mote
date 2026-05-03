import { Descendant, Element, Text } from 'slate'

// block elements
export const HEADING_ONE = 'heading-one'
export const HEADING_TWO = 'heading-two'
export const HEADING_THREE = 'heading-three'
export const HEADING_FOUR = 'heading-four'
export const HEADING_FIVE = 'heading-five'
export const PARAGRAPH = 'paragraph'
export const BLOCK_QUOTE = 'block-quote'
export const CODE_BLOCK = 'code-block'
export const CHECK_LIST = 'check-list'

export const NUMBERED_LIST = 'numbered-list'
export const BULLETED_LIST = 'bulleted-list'
export const LIST_ITEM = 'list-item'

// inline elements
export const LINK = 'link'
export const HASH_TAG = 'hash-tag'

// void elements
export const IMAGE = 'image'

// table elements
export const TABLE = 'table'
export const TABLE_ROW = 'table-row'
export const TABLE_CELL = 'table-cell'

// marks
export const BOLD = 'bold'
export const ITALIC = 'italic'
export const UNDERLINE = 'underline'
export const STRIKETHROUGH = 'strikethrough'
export const SUP = 'sup'
export const SUB = 'sub'
export const CODE = 'code'

export const HEADINGS = [
  HEADING_ONE,
  HEADING_TWO,
  HEADING_THREE,
  HEADING_FOUR,
  HEADING_FIVE,
] as const
export type HeadingType = (typeof HEADINGS)[number]

// Non-nested blocks, which can only contain inline or text elements.
export const FLAT_BLOCKS = [...HEADINGS, PARAGRAPH, BLOCK_QUOTE, CODE_BLOCK, CHECK_LIST] as const
export type FlatBlockType = (typeof FLAT_BLOCKS)[number]

export const LISTS = [BULLETED_LIST, NUMBERED_LIST] as const
export type ListType = (typeof LISTS)[number]

export const MARKS = [BOLD, ITALIC, UNDERLINE, STRIKETHROUGH, SUP, SUB, CODE] as const
export type MarkType = (typeof MARKS)[number]

export function isHeading(type: string): type is HeadingType {
  return !!HEADINGS.find((item) => item === type)
}

export function isFlatBlock(type: string): type is FlatBlockType {
  return !!FLAT_BLOCKS.find((item) => item === type)
}

export function isList(type: string): type is ListType {
  return !!LISTS.find((item) => item === type)
}

export function isMark(type: string): type is MarkType {
  return !!MARKS.find((item) => item === type)
}

export function isInlineElementOrText(node: Element | Text): boolean {
  if (Text.isText(node)) {
    return true
  }
  return node.type === LINK || node.type === HASH_TAG
}

export function isBlockElement(node: Element | Text): boolean {
  return !isInlineElementOrText(node)
}

export interface HeadingElement {
  type: HeadingType
  children: Descendant[]
}

export interface ParagraphElement {
  type: typeof PARAGRAPH
  children: Descendant[]
}

export interface BlockQuoteElement {
  type: typeof BLOCK_QUOTE
  children: Descendant[]
}

export interface CodeBlockElement {
  type: typeof CODE_BLOCK
  children: Text[]
}

export interface NumberedListElement {
  type: typeof NUMBERED_LIST
  start?: number
  children: ListItemElement[]
}

export interface BulletedListElement {
  type: typeof BULLETED_LIST
  children: ListItemElement[]
}

export interface ListItemElement {
  type: typeof LIST_ITEM
  children: Descendant[]
}

export interface CheckListElement {
  type: typeof CHECK_LIST
  checked: boolean
  children: Descendant[]
}

export interface LinkElement {
  type: typeof LINK
  url: string
  title?: string
  children: Text[]
}

export interface ImageElement {
  type: typeof IMAGE
  url: string
  alt?: string
  caption?: string
  width?: number
  height?: number
  children: [{ text: '' }]
}

export interface HashTagElement {
  type: typeof HASH_TAG
  children: [Text]
}

export interface TableCellElement {
  type: typeof TABLE_CELL
  align?: 'left' | 'center' | 'right'
  children: Descendant[]
}

export interface TableRowElement {
  type: typeof TABLE_ROW
  isHeader?: boolean
  children: TableCellElement[]
}

export interface TableElement {
  type: typeof TABLE
  children: TableRowElement[]
}
