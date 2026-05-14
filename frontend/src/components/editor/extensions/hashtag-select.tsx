import { ComponentProps, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import scrollIntoView from 'scroll-into-view-if-needed'
import { Editor, Point, Range, Transforms } from 'slate'
import { DOMEditor } from 'slate-dom'
import { ReactEditor, useSlateWithV } from 'slate-react'

import { cx } from '@/utils/css.ts'
import { useEvent } from '@/utils/hooks/use-event.ts'
import { useVisualViewportWhenPossible } from '@/utils/hooks/use-visual-view-port.ts'

import { Button } from '@/components/button'
import { Popover, PopoverContent, usePopoverWithInteractions } from '@/components/popover'

import { insertHashTag } from '../elements/hash-tag'
import { getPrevChar } from '../utils'

interface HashTagSelectProps extends ComponentProps<typeof PopoverContent> {
  tags: string[]
}

export function HashTagSelect({ tags, ...props }: HashTagSelectProps) {
  // NOTE: The identity of the editor remains unchanged.
  const { v, editor } = useSlateWithV()

  const [target, setTarget] = useState<Range | null>(null)

  const [index, setIndex] = useState(0)
  const [open, setOpen] = useState(false)
  const popoverRefs = useRef<ReturnType<typeof usePopoverWithInteractions>['refs']>(null)

  let search
  try {
    // NOTE: In some cases, `Editor.string` may throw an exception, for example:
    // In `HashTag`, when `deleteBackward` deletes the `#` at the beginning of a line,
    // it converts the `HashTag` into a text node, causing the `target` to no longer exist.
    search = target && Editor.string(editor, target).substring(1)
  } catch (_err) {
    setTarget(null)
    search = null
  }

  const filteredTags = useMemo(() => {
    if (search === null) return []
    if (search === '') return tags
    return tags.filter((tag) => tag.toLowerCase().includes(search.toLowerCase()))
  }, [tags, search])

  const enterTag = (tag: string) => {
    if (!target) return

    Editor.withoutNormalizing(editor, () => {
      Transforms.select(editor, target)
      tag = tag.trim()
      tag = tag.replace(/\/{2,}/g, '/')
      if (tag.startsWith('/')) tag = tag.substring(1)
      if (tag.endsWith('/')) tag = tag.substring(0, tag.length - 1)
      insertHashTag(editor, tag)
    })

    // NOTE: If `move` is called within `withoutNormalizing`, it will not work?
    Transforms.move(editor, { unit: 'offset' })
    setTarget(null)
  }

  const onKeyDown = useEvent((event: KeyboardEvent) => {
    if (target && filteredTags.length > 0) {
      const floatEl = popoverRefs.current!.floating.current
      switch (event.key) {
        case 'ArrowUp':
        case 'ArrowDown': {
          event.preventDefault()
          const key = event.key

          let nextIndex
          if (key === 'ArrowUp') {
            nextIndex = index <= 0 ? filteredTags.length - 1 : index - 1
          } else {
            nextIndex = index >= filteredTags.length - 1 ? 0 : index + 1
          }

          scrollIntoView(floatEl!.querySelectorAll('li')[nextIndex], {
            block: key === 'ArrowUp' ? 'start' : 'end',
            scrollMode: 'if-needed',
            behavior: 'smooth',
            boundary: floatEl,
          })

          setIndex(nextIndex)
          break
        }
        case 'Tab':
        case 'Enter': {
          event.preventDefault()
          enterTag(filteredTags[index])
          break
        }
        case 'Escape':
          event.preventDefault()
          setTarget(null)
          break
        default:
          break
      }
    }
  })

  useEffect(() => {
    // NOTE: When the menu pops up, the focus remains within the editor,
    // so `onKeyDown` needs to be added to the editor's DOM node.
    const domNode = ReactEditor.toDOMNode(editor as DOMEditor, editor)
    domNode.addEventListener('keydown', onKeyDown)
    return () => {
      domNode.removeEventListener('keydown', onKeyDown)
    }
  }, [editor, onKeyDown])

  useLayoutEffect(() => {
    const { selection } = editor

    if (selection && Range.isCollapsed(selection)) {
      const prevChar = getPrevChar(editor)
      if ((prevChar == ' ' || specialChars.has(prevChar)) && target && search) {
        enterTag(search)
        if (prevChar === ' ') {
          // Delete the space in front.
          Transforms.delete(editor, { unit: 'character' })
        } else {
          // Move to the position after the punctuation.
          Transforms.move(editor, { unit: 'character' })
        }
        setOpen(false)
        return
      }

      const [start] = Range.edges(selection)
      const hashPos = findHash(editor)
      const beforeRange = hashPos && Editor.range(editor, hashPos, start)
      const beforeMatch = beforeRange && Editor.string(editor, beforeRange)

      const after = Editor.after(editor, start)
      const afterRange = Editor.range(editor, start, after)
      const afterText = Editor.string(editor, afterRange)
      const afterMatch = /^(\s|$)/.exec(afterText)

      if (beforeMatch && afterMatch) {
        setTarget(beforeRange)
        setIndex(0)
        setOpen(true)
        return
      }
    }

    setTarget(null)
    setOpen(false)
    // NOTE: This effect is only executed when the editor's content changes.
    // Using a normal dependency list would cause an infinite loop!
  }, [v])

  useEffect(() => {
    if (!target || filteredTags.length === 0) {
      return
    }
    if (!open) {
      return
    }

    const rect = ReactEditor.toDOMRange(editor as DOMEditor, target).getBoundingClientRect()

    popoverRefs.current!.setReference({
      getBoundingClientRect() {
        // NOTE: This rect must be calculated in advance, do not `return domRange.getBoundingClientRect()`;
        // Otherwise, when deleting some characters, such as `/`, Slate will throw the following exception:
        // "cannot resolve a DOM point from Slate point".
        // The reason is unknown...
        return rect
      },
    })
    // NOTE: The rect only needs to be calculated once every time it is opened...
  }, [open])

  const { height } = useVisualViewportWhenPossible()

  return (
    <Popover
      open={open && filteredTags.length !== 0}
      onOpenChange={setOpen}
      placement="bottom-start"
      refs={popoverRefs}
    >
      <PopoverContent focusable={false} {...props}>
        <div
          className="scrollbar-none relative z-50 max-w-[13rem] overflow-y-auto"
          style={{
            maxHeight: height * 0.6,
          }}
        >
          <ul className="space-y-1">
            {filteredTags.map((char, idx) => (
              <li
                key={char}
                onMouseDown={(event) => {
                  event.preventDefault()
                  enterTag(char)
                }}
              >
                <Button
                  variant="ghost"
                  className={cx('scrollbar-none w-full justify-start! overflow-x-auto', {
                    'bg-accent': idx === index,
                  })}
                >
                  {char}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function findHash(editor: Editor): Point | null {
  const [start] = Range.edges(editor.selection!)
  const firstPoint = Editor.start(editor, [])
  let distance = 1

  while (true) {
    const beforePos = Editor.before(editor, start, { distance })
    const afterPos = beforePos && Editor.after(editor, beforePos)
    const range1 = afterPos && Editor.range(editor, beforePos, afterPos)
    const chr = range1 && Editor.string(editor, range1)

    // When at the beginning of the first line, `chr` is `undefined`.
    // For other lines, it is an empty string.
    if (!chr || chr === ' ' || specialChars.has(chr)) {
      return null
    }

    if (chr === '#') {
      const prevChar = getPrevChar(editor, beforePos)
      if (!prevChar || prevChar === ' ' || specialChars.has(prevChar)) {
        return beforePos
      } else {
        return null
      }
    }

    // NOTE: Why add this check:
    // There is a bug in `Editor.before(editor, location, { distance })`,
    // When the distance exceeds the first point, this function still returns the first point,
    // but it should return `undefined`!
    if (Point.equals(beforePos, firstPoint)) {
      return null
    }

    distance += 1
  }
}

export const specialChars = new Set([
  ',',
  '，',
  ';',
  '；',
  '.',
  '。',
  '!',
  '！',
  '?',
  '？',
  '"',
  '“',
  "'",
  '‘',
  '%',
])
