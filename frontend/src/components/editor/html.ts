import {
  Descendant,
  Editor,
  Element as SlateElement,
  Node as SlateNode,
  Text as SlateText,
  Transforms,
} from 'slate'
import { ReactEditor } from 'slate-react'
import { marked } from 'marked'
import toast from 'react-hot-toast'

import { t } from '@/components/translation.tsx'

import {
  BLOCK_QUOTE,
  BULLETED_LIST,
  CHECK_LIST,
  CODE_BLOCK,
  CheckListElement,
  HASH_TAG,
  HEADING_FIVE,
  HEADING_FOUR,
  HEADING_ONE,
  HEADING_THREE,
  HEADING_TWO,
  HashTagElement,
  IMAGE,
  ImageElement,
  LINK,
  LIST_ITEM,
  LinkElement,
  ListItemElement,
  NUMBERED_LIST,
  NumberedListElement,
  PARAGRAPH,
  TABLE,
  TABLE_CELL,
  TABLE_ROW,
  TableCellElement,
  TableElement,
  TableRowElement,
  isBlockElement,
  isInlineElementOrText,
} from './types'

// NOTE: This function will not be called during cross-device pasting,
// e.g., copying on an iPhone and pasting on a Mac.
export function withPasteHtml(editor: Editor): Editor {
  const { insertData } = editor as ReactEditor

  ;(editor as ReactEditor).insertData = (data) => {
    const html = data.getData('text/html')

    if (!html) {
      const text = data.getData('text/plain')
      if (text && looksLikeMarkdown(text)) {
        const parsedHtml = marked.parse(text) as string
        const doc = new DOMParser().parseFromString(parsedHtml, 'text/html')
        let nodes = fromHtml(doc.body) as Descendant[]

        // Same cleanup as HTML paste path
        const newLines = [`\n`, `\n\n`, `\r\n`]
        const firstNode = nodes[0]
        if (SlateText.isText(firstNode) && newLines.includes(firstNode.text)) {
          nodes = nodes.slice(1)
        }
        const lastNode = nodes[nodes.length - 1]
        if (SlateText.isText(lastNode) && newLines.includes(lastNode.text)) {
          nodes = nodes.slice(0, nodes.length - 1)
        }

        const containBlockElement = nodes.some(
          (node) => SlateElement.isElement(node) && Editor.isBlock(editor, node),
        )
        if (containBlockElement) {
          nodes = nodes
            .filter(
              (node) =>
                SlateElement.isElement(node) ||
                (SlateText.isText(node) && node.text !== '\u200B\u200B'),
            )
            .filter(
              (node) =>
                SlateElement.isElement(node) ||
                (SlateText.isText(node) && node.text.trim() !== ''),
            )
            .map((node) =>
              SlateText.isText(node) || Editor.isInline(editor, node)
                ? { type: 'paragraph', children: [{ ...node }] }
                : node,
            )
        }

        Transforms.insertFragment(editor, nodes)

        const lang = (localStorage.getItem('lang') ?? 'en') as 'en' | 'zh'
        toast.success(t('markdownPasted', lang), { duration: 2000 })
        return
      }
      insertData(data)
      return
    }

    const doc = new DOMParser().parseFromString(html, 'text/html')
    let nodes = fromHtml(doc.body) as Descendant[]

    // In some cases, the first and last nodes during pasting may be line breaks, which need to be removed.
    const newLines = [`\n`, `\n\n`, `\r\n`]

    const firstNode = nodes[0]
    if (SlateText.isText(firstNode) && newLines.includes(firstNode.text)) {
      nodes = nodes.slice(1)
    }
    const lastNode = nodes[nodes.length - 1]
    if (SlateText.isText(lastNode) && newLines.includes(lastNode.text)) {
      nodes = nodes.slice(0, nodes.length - 1)
    }

    // In rare cases, Slate may throw an exception if the pasted HTML contains certain characters at the beginning of a line:
    // See: https://github.com/ianstormtaylor/slate/issues/4857
    // Slate will also throw an exception if the fragment contains both block elements and Text:
    // "Uncaught TypeError: Cannot read properties of null (reading 'length')"
    const containBlockElement = nodes.some(
      (node) => SlateElement.isElement(node) && Editor.isBlock(editor, node),
    )
    if (containBlockElement) {
      nodes = nodes
        // Remove strange zero-width characters
        .filter(
          (node) =>
            SlateElement.isElement(node) ||
            (SlateText.isText(node) && node.text !== '\u200B\u200B'),
        )
        .filter(
          (node) =>
            SlateElement.isElement(node) || (SlateText.isText(node) && node.text.trim() !== ''),
        )
        .map((node) =>
          SlateText.isText(node) || Editor.isInline(editor, node)
            ? { type: 'paragraph', children: [{ ...node }] }
            : node,
        )
    }

    Transforms.insertFragment(editor, nodes)
  }

  return editor
}

// Convert Slate node to HTML
export function toHtml(node: Descendant, parent?: SlateElement): string {
  if (SlateText.isText(node)) {
    // https://github.com/wangeditor-team/wangEditor/blob/master/packages/core/src/to-html/text2html.ts
    let string = replaceHtmlSpecialSymbols(node.text)
    if (parent?.type === CODE_BLOCK) {
      // Replace `&nbsp;` with spaces in code-blocks
      string = string.replace(/&nbsp;/g, ' ')
    } else {
      string = string.replace(/\r\n|\r|\n/g, '<br>')
    }

    // Handle empty strings
    if (string === '') {
      const childNum = parent?.children.length
      if (childNum === 0 || childNum === 1) {
        // Slate has a mechanism called "Empty Children Early Constraint Execution":
        // Before any of the other normalizations can execute,
        // Slate iterates through all element nodes and makes sure they have at least one child.
        // If it does not, an empty text descendant is created.
        // https://docs.slatejs.org/concepts/11-normalizing#empty-children-early-constraint-execution
        // If the textNode is the only child, replace it with <br>.
        string = '<br>'
      }
    }

    if (node.bold) {
      string = `<strong>${string}</strong>`
    }
    if (node.underline) {
      string = `<u>${string}</u>`
    }
    if (node.strikethrough) {
      string = `<del>${string}</del>`
    }
    if (node.italic) {
      string = `<em>${string}</em>`
    }
    if (node.code) {
      string = `<code>${string}</code>`
    }

    return string
  }

  const children = node.children.map((child) => toHtml(child, node)).join('')

  switch (node.type) {
    case BLOCK_QUOTE:
      return `<blockquote><p>${children}</p></blockquote>`
    case CODE_BLOCK:
      return `<pre><code>${children}</code></pre>`
    case BULLETED_LIST:
      return `<ul>${children}</ul>`
    case NUMBERED_LIST: {
      const ol = node as NumberedListElement
      if (typeof ol.start !== 'undefined') {
        return `<ol start="${ol.start.toString()}">${children}</ol>`
      } else {
        return `<ol>${children}</ol>`
      }
    }
    case LIST_ITEM:
      return `<li>${children}</li>`
    case CHECK_LIST: {
      const checked = (node as CheckListElement).checked ? 'checked' : ''
      return `<div class="check-list">
                <input type="checkbox" ${checked} disabled/>
                <label>${children}</label>
              </div>`
        .trim()
        .replace(/\n +/g, '')
    }
    case HASH_TAG:
      return `<span class="hash-tag">${SlateNode.string(node).trim()}</span>`
    case LINK:
      // https://stackoverflow.com/questions/75980/when-are-you-supposed-to-use-escape-instead-of-encodeuri-encodeuricomponent
      return `<a href="${(node as LinkElement).url}" target="_blank" rel="noreferrer nofollow">${children}</a>`
    case IMAGE: {
      const { url, alt, width, height, caption } = node as ImageElement
      let attrs = ''
      if (alt) attrs += `alt="${alt}"`
      if (width) attrs += ` width="${String(width)}"`
      if (height) attrs += ` height="${String(height)}"`
      return `
         <figure>
           <img src="${url}" ${attrs} loading="lazy"/>
           ${caption ? `<figcaption>${caption}</figcaption>` : ''}
         </figure>
         `.trim()
    }
    case HEADING_ONE:
      return `<h1>${children}</h1>`
    case HEADING_TWO:
      return `<h2>${children}</h2>`
    case HEADING_THREE:
      return `<h3>${children}</h3>`
    case HEADING_FOUR:
      return `<h4>${children}</h4>`
    case HEADING_FIVE:
      return `<h5>${children}</h5>`
    case PARAGRAPH:
      return `<p>${children}</p>`
    case TABLE: {
      const tableNode = node as TableElement
      const headerRows = tableNode.children.filter((r) => r.isHeader)
      const bodyRows = tableNode.children.filter((r) => !r.isHeader)
      const theadHtml =
        headerRows.length > 0
          ? `<thead>${headerRows.map((r) => toHtml(r, tableNode)).join('')}</thead>`
          : ''
      const tbodyHtml =
        bodyRows.length > 0
          ? `<tbody>${bodyRows.map((r) => toHtml(r, tableNode)).join('')}</tbody>`
          : ''
      return `<table>${theadHtml}${tbodyHtml}</table>`
    }
    case TABLE_ROW:
      return `<tr>${children}</tr>`
    case TABLE_CELL: {
      const cellNode = node as TableCellElement
      const isHeader = (parent as TableRowElement)?.isHeader
      const tag = isHeader ? 'th' : 'td'
      const alignAttr = cellNode.align ? ` style="text-align:${cellNode.align}"` : ''
      return `<${tag}${alignAttr}>${children}</${tag}>`
    }
    default:
      return children
  }
}

// Convert HTML to Slate node
// https://github.com/ianstormtaylor/slate/blob/main/site/examples/paste-html.tsx
export function fromHtml(
  el: Node,
  marks: Record<string, boolean> = {},
  isValidBlockNode = true,
): Descendant[] | Descendant | null {
  const nodeName = el.nodeName

  // Handle text nodes
  if (el instanceof Text) {
    let text = el.textContent!
    // If not inside `<pre>`, then:
    // 1. Replace useless spaces and line breaks.
    // 2. Replace `<br>` with `\n`.
    // See: https://github.com/wangeditor-team/wangEditor/blob/master/packages/core/src/parse-html/parse-common-elem-html.ts
    if (!hasPreAncestor(el)) {
      text = text.replace(/\s+/gm, ' ').replace(/<br>/g, '\n')
    }
    // Replace HTML special characters, e.g., `&lt;` with `<`.
    text = deReplaceHtmlSpecialSymbols(text)
    // Replace spaces with charCode 160 (`&nbsp;` converted) with spaces with charCode 32 (default in JS).
    text = replaceSpace160(text)
    return {
      text,
      ...marks,
    }
  }

  // Ignore non-element nodes
  if (!(el instanceof HTMLElement)) {
    return null
  }

  // Handle `<br />` nodes
  if (el instanceof HTMLBRElement) {
    const parent = el.parentElement
    if (parent && parent.childElementCount === 1) {
      return { text: '' }
    } else {
      return { text: '\n' }
    }
  }

  // Handle void nodes
  if ((nodeName === 'FIGURE' && el.querySelector('img')) || nodeName === 'IMG') {
    // NOTE: Only block-level images are allowed.
    if (!isValidBlockNode) {
      return null
    }
    const img = el.querySelector('img') || el
    const caption = el.querySelector('figcaption')?.textContent || ''
    return {
      type: IMAGE,
      url: img.getAttribute('src'),
      alt: img.getAttribute('alt') || '',
      width: parseInt(img.getAttribute('width') || '') || undefined,
      height: parseInt(img.getAttribute('height') || '') || undefined,
      caption,
      children: [{ text: '' }],
    } as ImageElement
  }

  if (nodeName === 'SPAN' && el.classList.contains('hash-tag')) {
    return {
      type: HASH_TAG,
      children: [{ text: el.innerText.trim() }],
    } as HashTagElement
  }

  const newMarks = { ...marks }

  for (const [tagName, mark] of Object.entries(MARK_TAGS)) {
    if (nodeName === tagName) {
      newMarks[mark] = true
    }
  }

  let isValidChildBlockNode = isValidBlockNode

  // All children of `p`, `heading`, `code-block`, and `block-quote` must be inlines.
  if (Object.keys(BLOCK_TAGS).includes(nodeName)) {
    isValidChildBlockNode = false
  }

  // Children of `ul`, `ol`, and `li` can be other blocks.
  if (isValidBlockNode && Object.keys(LIST_TAGS).includes(nodeName)) {
    isValidChildBlockNode = true
  }

  // Table cells contain inline content only.
  if (nodeName === 'TH' || nodeName === 'TD') {
    isValidChildBlockNode = false
  }

  const dirtyChildren = Array.from(el.childNodes)
    .map((node) => fromHtml(node, newMarks, isValidChildBlockNode))
    .flat()

  // Filter out nulls caused by invalid tags.
  const nonNullableChildren = dirtyChildren.filter((child) => child !== null)

  // NOTE: There is no need to handle cases where inline and block elements are at the same level here,
  // as the function's implementation ensures this only happens at the top level.

  // Children cannot be empty
  if (nonNullableChildren.length === 0) {
    nonNullableChildren.push({ text: '', ...newMarks })
  }

  // Filter out consecutive empty texts, i.e., `{text: ''}`.
  let children = ignoreConsecutiveEmptyText(nonNullableChildren)

  if (nodeName === 'A') {
    return {
      type: LINK,
      url: el.getAttribute('href'),
      children,
    } as LinkElement
  }

  if (nodeName === 'DIV' && el.classList.contains('check-list')) {
    const checked = el.querySelector('input')!.hasAttribute('checked')
    return {
      type: CHECK_LIST,
      checked,
      children: children.filter((node) => isInlineElementOrText(node)),
    } as CheckListElement
  }

  // NOTE: Remove the header (language identifier, etc.) from ChatGPT-generated code blocks.
  if (nodeName === 'DIV' && el.classList.contains('bg-token-main-surface-secondary')) {
    return null
  }

  if (isValidBlockNode && Object.keys(BLOCK_TAGS).includes(nodeName)) {
    return {
      type: BLOCK_TAGS[nodeName as keyof typeof BLOCK_TAGS],
      children:
        nodeName === 'PRE'
          ? [{ text: SlateNode.string({ children } as SlateNode).trim() }]
          : children,
    }
  }

  if (isValidBlockNode && nodeName === 'LI') {
    // Handle GitHub-style task list items (from marked output or pasted from GitHub)
    const checkboxInput = el.querySelector(':scope > input[type="checkbox"]')
    if (checkboxInput) {
      const checked =
        checkboxInput.hasAttribute('checked') || (checkboxInput as HTMLInputElement).checked
      const taskChildren = Array.from(el.childNodes)
        .filter((n) => n !== checkboxInput)
        .map((n) => fromHtml(n, newMarks, false))
        .flat()
        .filter((n): n is Descendant => n !== null)
      let filtered = ignoreConsecutiveEmptyText(
        taskChildren.length ? taskChildren : [{ text: '' }],
      )
      // Trim leading whitespace from the first text node (marked inserts a space after the input)
      const first = filtered[0]
      if (first && SlateText.isText(first)) {
        filtered = [{ ...first, text: first.text.trimStart() }, ...filtered.slice(1)]
      }
      return {
        type: CHECK_LIST,
        checked,
        children: filtered.filter((n) => isInlineElementOrText(n)),
      } as CheckListElement
    }

    children = normalizeListItemChildren(children)
    return {
      type: LIST_ITEM,
      children,
    } as ListItemElement
  }

  if (isValidBlockNode && (nodeName === 'UL' || nodeName === 'OL')) {
    children = children.filter((child) => (child as SlateElement).type === LIST_ITEM)
    if (children.length === 0) {
      return null
    }

    if (nodeName === 'OL') {
      return {
        type: NUMBERED_LIST,
        start: Number(el.getAttribute('start')) || undefined,
        children,
      } as NumberedListElement
    } else {
      return { type: BULLETED_LIST, children }
    }
  }

  // THEAD / TBODY / TFOOT are transparent wrappers — just return their children (rows)
  if (nodeName === 'THEAD' || nodeName === 'TBODY' || nodeName === 'TFOOT') {
    return children
  }

  if (isValidBlockNode && nodeName === 'TR') {
    const trEl = el as HTMLTableRowElement
    const isHeader =
      !!trEl.closest('thead') ||
      (trEl.cells.length > 0 && Array.from(trEl.cells).every((c) => c.nodeName === 'TH'))
    const cells = children.filter(
      (c) => SlateElement.isElement(c) && c.type === TABLE_CELL,
    ) as TableCellElement[]
    if (cells.length === 0) return null
    return { type: TABLE_ROW, isHeader, children: cells } as TableRowElement
  }

  if (nodeName === 'TH' || nodeName === 'TD') {
    // Parse alignment from `align` attribute (marked output) or `style` attribute
    const alignAttr = (el as HTMLElement).getAttribute('align')?.toLowerCase()
    const styleAttr = (el as HTMLElement).getAttribute('style') ?? ''
    const alignFromStyle = styleAttr.match(/text-align:\s*(left|center|right)/i)?.[1]?.toLowerCase()
    const rawAlign = alignAttr || alignFromStyle
    const VALID_ALIGNS = ['left', 'center', 'right'] as const
    const align = VALID_ALIGNS.includes(rawAlign as (typeof VALID_ALIGNS)[number])
      ? (rawAlign as 'left' | 'center' | 'right')
      : undefined
    const inlineChildren = children.filter(isInlineElementOrText)
    return {
      type: TABLE_CELL,
      align,
      children: inlineChildren.length > 0 ? inlineChildren : [{ text: '' }],
    } as TableCellElement
  }

  if (isValidBlockNode && nodeName === 'TABLE') {
    const rows = children.filter(
      (c) => SlateElement.isElement(c) && c.type === TABLE_ROW,
    ) as TableRowElement[]
    if (rows.length === 0) return null
    return { type: TABLE, children: rows } as TableElement
  }

  return children
}

function looksLikeMarkdown(text: string): boolean {
  let score = 0
  // Strong signals (count as 2 each)
  if (/^```|^~~~/m.test(text)) score += 2 // fenced code blocks
  if (/^#{1,6} /m.test(text)) score += 2 // ATX headings
  if (/^[-*] \[[ xX]\]/m.test(text)) score += 2 // task list items
  if (/^\|.+\|$/m.test(text) && /^\|[\s|:-]+\|$/m.test(text)) score += 2 // GFM pipe table
  // Regular signals (count as 1 each)
  if (/\*\*[^*\n]+\*\*/.test(text)) score++ // bold
  if (/(?<!\*)\*(?!\*)[^*\n]+\*(?!\*)/.test(text)) score++ // italic
  if (/^> /m.test(text)) score++ // blockquote
  if (/\[[^\]\n]+\]\([^)\n]+\)/.test(text)) score++ // link
  if (/^[-*] /m.test(text)) score++ // unordered list
  if (/^\d+\. /m.test(text)) score++ // ordered list
  if (/`[^`\n]+`/.test(text)) score++ // inline code
  return score >= 2
}

function replaceHtmlSpecialSymbols(str: string) {
  return str.replace(/ {2}/g, ' &nbsp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function deReplaceHtmlSpecialSymbols(str: string) {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

// https://github.com/wangeditor-team/wangEditor/blob/dad4fc7a950c0215ab79bda1e161ebdc64551d13/packages/core/src/parse-html/helper.ts
const REPLACE_SPACE_160_REG = new RegExp(String.fromCharCode(160), 'g')

function replaceSpace160(str: string): string {
  return str.replace(REPLACE_SPACE_160_REG, ' ')
}

// Check if a node has a `pre` node as an ancestor
function hasPreAncestor(el: Node): boolean {
  let parent = el.parentElement

  while (parent) {
    if (parent.nodeName === 'PRE') {
      return true
    }
    parent = parent.parentElement
  }

  return false
}

function ignoreConsecutiveEmptyText(nodes: Descendant[]): Descendant[] {
  return nodes.reduce<Descendant[]>((newNodes, curr) => {
    const prev = newNodes[newNodes.length - 1]
    if (
      SlateText.isText(curr) &&
      SlateText.isText(prev) &&
      curr.text.trim() === '' &&
      prev.text.trim() === ''
    ) {
      return newNodes
    } else {
      newNodes.push(curr)
      return newNodes
    }
  }, [])
}

// Check the children of `li`:
// 1. Wrap all consecutive inline nodes with `paragraph`.
// 2. Do not process block nodes other than child `li`.
// 3. Convert child `li` nodes to text nodes (since `li` cannot be direct children of `li`).
function normalizeListItemChildren(children: Descendant[]): Descendant[] {
  const newNodes: Descendant[] = []
  let inlineNodes: Descendant[] = []

  for (const node of children) {
    if (isBlockElement(node) && (node as SlateElement).type !== LIST_ITEM) {
      if (inlineNodes.length !== 0) {
        newNodes.push({ type: PARAGRAPH, children: [...inlineNodes] })
        inlineNodes = []
      }
      newNodes.push(node)
    } else {
      // Convert `li` nodes to `text` nodes
      const inlineNode = isInlineElementOrText(node) ? node : { text: SlateNode.string(node) }
      inlineNodes.push(inlineNode)
    }
  }

  if (inlineNodes.length !== 0) {
    newNodes.push({ type: PARAGRAPH, children: [...inlineNodes] })
  }

  return newNodes
}

// The following HTML tags can only contain inline elements
const BLOCK_TAGS = {
  H1: HEADING_ONE,
  H2: HEADING_TWO,
  H3: HEADING_THREE,
  H4: HEADING_FOUR,
  H5: HEADING_FIVE,
  P: PARAGRAPH,
  BLOCKQUOTE: BLOCK_QUOTE,
  PRE: CODE_BLOCK,
}

// `ul`, `ol`, and `li` can nest other block-level elements.
const LIST_TAGS = {
  UL: BULLETED_LIST,
  OL: NUMBERED_LIST,
  LI: LIST_ITEM,
}

// COMPAT: `B` is omitted here because Google Docs uses `<b>` in weird ways.
const MARK_TAGS = {
  CODE: 'code',
  EM: 'italic',
  I: 'italic',
  DEL: 'strikethrough',
  S: 'strikethrough',
  STRONG: 'bold',
  U: 'underline',
}
