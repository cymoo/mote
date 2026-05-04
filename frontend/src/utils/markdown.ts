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

  // GFM tables: thead/tbody/tfoot are transparent wrappers
  td.addRule('tableSection', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: (content) => content,
  })

  // Each cell becomes a pipe-delimited segment: | content
  td.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: (content) =>
      `| ${content
        .trim()
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ')} `,
  })

  // Each row closes the pipe sequence; header rows get a separator underneath
  td.addRule('tableRow', {
    filter: 'tr',
    replacement: (content, node) => {
      const row = node as HTMLTableRowElement
      const cells = Array.from(row.cells)
      const isHeader =
        !!row.closest('thead') ||
        (cells.length > 0 && cells.every((c) => c.nodeName === 'TH'))

      let result = `\n${content}|`

      if (isHeader) {
        const separators = cells.map((cell) => {
          const style = cell.getAttribute('style') ?? ''
          const align = style.match(/text-align:\s*(left|center|right)/i)?.[1]?.toLowerCase()
          if (align === 'center') return ':---:'
          if (align === 'right') return '---:'
          if (align === 'left') return ':---'
          return '---'
        })
        result += `\n| ${separators.join(' | ')} |`
      }

      return result
    },
  })

  // Wrap the whole table in blank lines
  td.addRule('table', {
    filter: 'table',
    replacement: (content) => `\n\n${content}\n\n`,
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
