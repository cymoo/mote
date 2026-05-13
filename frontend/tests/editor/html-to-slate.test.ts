import { fromHtml } from '../../src/components/editor/html'

test('convert html string to slate nodes', () => {
  const inputs: Array<[string, object[]]> = [
    ['<p>foo</p>', [{ type: 'paragraph', children: [{ text: 'foo' }] }]],

    ['<p>foo</p>bar', [{ type: 'paragraph', children: [{ text: 'foo' }] }, { text: 'bar' }]],

    [
      '<p>foo</p><span>bar</span>',
      [{ type: 'paragraph', children: [{ text: 'foo' }] }, { text: 'bar' }],
    ],

    [
      '<div><p>foo</p><span>bar</span></div>',
      [{ type: 'paragraph', children: [{ text: 'foo' }] }, { text: 'bar' }],
    ],

    ['<div><p>foo</p></div>', [{ type: 'paragraph', children: [{ text: 'foo' }] }]],

    [
      '<p><i><u>foo</u></i></p>',
      [{ type: 'paragraph', children: [{ text: 'foo', italic: true, underline: true }] }],
    ],

    ['<ul><p>foo</p></ul>', [{ text: '' }]],

    [
      '<ul><p>foo</p><li>bar</li></ul>',
      [
        {
          type: 'bulleted-list',
          children: [
            { type: 'list-item', children: [{ type: 'paragraph', children: [{ text: 'bar' }] }] },
          ],
        },
      ],
    ],
  ]

  for (const [input, output] of inputs) {
    const node = new DOMParser().parseFromString(input, 'text/html').body
    const result = fromHtml(node)
    expect(result).toEqual(output)
  }
})

test('block-quote html round-trip: <br> preserves newlines', () => {
  // This is the format produced by toHtml() for a multi-line block-quote.
  // fromHtml() must decode <br> as '\n', not as empty string.
  const cases: Array<[string, object]> = [
    // Single-line (no <br>) — regression guard
    [
      '<blockquote><p>hello</p></blockquote>',
      { type: 'block-quote', children: [{ text: 'hello' }] },
    ],
    // Multi-line: <br> inside <p> that also has text siblings
    [
      '<blockquote><p>line1<br>line2</p></blockquote>',
      { type: 'block-quote', children: [{ text: 'line1' }, { text: '\n' }, { text: 'line2' }] },
    ],
    // Empty block-quote: <p><br></p> — <br> is the only childNode → empty text
    [
      '<blockquote><p><br></p></blockquote>',
      { type: 'block-quote', children: [{ text: '' }] },
    ],
    // Marks are preserved across the <br>
    [
      '<blockquote><p><strong>bold</strong><br><em>italic</em></p></blockquote>',
      {
        type: 'block-quote',
        children: [{ text: 'bold', bold: true }, { text: '\n' }, { text: 'italic', italic: true }],
      },
    ],
  ]

  for (const [input, expected] of cases) {
    const body = new DOMParser().parseFromString(input, 'text/html').body
    const result = fromHtml(body)
    expect(result).toEqual([expected])
  }
})

test('block-quote paste: nested block-level children are separated by newlines', () => {
  const cases: Array<[string, object]> = [
    // Multiple paragraphs
    [
      '<blockquote><p>Para 1</p><p>Para 2</p></blockquote>',
      {
        type: 'block-quote',
        children: [{ text: 'Para 1' }, { text: '\n' }, { text: 'Para 2' }],
      },
    ],
    // Paragraph followed by unordered list
    [
      '<blockquote><p>Text</p><ul><li>Item 1</li><li>Item 2</li></ul></blockquote>',
      {
        type: 'block-quote',
        children: [
          { text: 'Text' },
          { text: '\n' },
          { text: 'Item 1' },
          { text: '\n' },
          { text: 'Item 2' },
        ],
      },
    ],
    // Ordered list only
    [
      '<blockquote><ol><li>A</li><li>B</li></ol></blockquote>',
      {
        type: 'block-quote',
        children: [{ text: 'A' }, { text: '\n' }, { text: 'B' }],
      },
    ],
  ]

  for (const [input, expected] of cases) {
    const body = new DOMParser().parseFromString(input, 'text/html').body
    const result = fromHtml(body)
    expect(result).toEqual([expected])
  }
})

