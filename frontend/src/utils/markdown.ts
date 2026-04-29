import TurndownService from 'turndown'

import { Post } from '@/views/post/post-list.tsx'

function createTurndownService(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  })

  // Hash tag span: <span class="hash-tag">#tag</span> → #tag
  td.addRule('hashTag', {
    filter: (node) =>
      node.nodeName === 'SPAN' && (node as HTMLElement).classList.contains('hash-tag'),
    replacement: (content) => content,
  })

  // Check list: <div class="check-list"><input checked/><label>text</label></div> → - [x] text
  td.addRule('checkList', {
    filter: (node) =>
      node.nodeName === 'DIV' && (node as HTMLElement).classList.contains('check-list'),
    replacement: (_content, node) => {
      const el = node as HTMLElement
      const input = el.querySelector('input')
      const checked = input ? input.hasAttribute('checked') || input.checked : false
      const text = el.querySelector('label')?.textContent?.trim() ?? ''
      return `\n- [${checked ? 'x' : ' '}] ${text}\n`
    },
  })

  // Search highlight: <mark>text</mark> → text (strip the mark)
  td.addRule('mark', {
    filter: 'mark',
    replacement: (content) => content,
  })

  // Underline: <u>text</u> → text (no standard Markdown equivalent)
  td.addRule('underline', {
    filter: 'u',
    replacement: (content) => content,
  })

  // Figure with image: convert to image with optional caption
  td.addRule('figure', {
    filter: 'figure',
    replacement: (_content, node) => {
      const el = node as HTMLElement
      const img = el.querySelector('img')
      if (!img) return _content
      const src = img.getAttribute('src') ?? ''
      const alt = img.getAttribute('alt') ?? ''
      const caption = el.querySelector('figcaption')?.textContent?.trim()
      const imgMd = `![${alt}](${src})`
      return caption ? `\n${imgMd}\n*${caption}*\n` : `\n${imgMd}\n`
    },
  })

  return td
}

const turndownService = createTurndownService()

export function toMarkdown(html: string): string {
  return turndownService.turndown(html)
}

export function exportPostAsMarkdown(post: Post): void {
  const markdown = toMarkdown(post.content)
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `memo-${String(post.id)}.md`
  anchor.click()
  URL.revokeObjectURL(url)
}
