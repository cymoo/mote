import {
  BoldIcon,
  List as BulletedListIcon,
  CheckSquare as CheckListIcon,
  CodeIcon,
  HashIcon,
  ListOrdered as NumberedListIcon,
} from 'lucide-react'
import { ComponentProps } from 'react'
import { useFocused, useSlate } from 'slate-react'

import { cx } from '@/utils/css.ts'
import { noop } from '@/utils/func.ts'

import { Button } from '@/components/button.tsx'
import { isListActive } from '@/components/editor/elements/list.tsx'
import {
  BOLD,
  BULLETED_LIST,
  CHECK_LIST,
  CODE_BLOCK,
  NUMBERED_LIST,
  isList,
  isMark,
} from '@/components/editor/types.ts'
import {
  getPrevChar,
  isBlockStart,
  isElementActive,
  isMarkActive,
  toggleBlock,
  toggleMark,
} from '@/components/editor/utils.ts'

import { useIsSmallDevice } from '@/views/layout/hooks.tsx'

export function ToolBar({ className, children, ...props }: ComponentProps<'div'>) {
  const editor = useSlate()
  const sm = useIsSmallDevice()

  return (
    <div className={cx('flex items-center', className)} {...props}>
      <ToolButton
        title="insert hashtag"
        onMouseDown={(event) => {
          if (!editor.selection) {
            return
          }
          event.preventDefault()
          const prevChr = getPrevChar(editor)
          let text = '#'
          if (!isBlockStart(editor) && prevChr !== ' ') {
            text = ' ' + text
          }
          editor.insertText(text)
        }}
      >
        <HashIcon />
      </ToolButton>
      <FormatButton format={CHECK_LIST}>
        <CheckListIcon />
      </FormatButton>
      {!sm && (
        <>
          <FormatButton format={BULLETED_LIST}>
            <BulletedListIcon />
          </FormatButton>
          <FormatButton format={NUMBERED_LIST}>
            <NumberedListIcon />
          </FormatButton>
          <FormatButton format={CODE_BLOCK}>
            <CodeIcon />
          </FormatButton>
        </>
      )}
      <FormatButton format={BOLD}>
        <BoldIcon />
      </FormatButton>
      {children}
    </div>
  )
}

export function ToolButton({ className, children, ...props }: ComponentProps<typeof Button>) {
  const focused = useFocused()
  const sm = useIsSmallDevice()

  return (
    <Button
      className={cx(
        sm
          ? 'hover:bg-muted size-11! rounded-lg px-0! *:size-5'
          : '*:size-[1.2em] hover:scale-130 hover:bg-transparent transition-all',
        { 'opacity-50': !focused && !sm },
        className,
      )}
      size="sm"
      variant="ghost"
      {...props}
    >
      {children}
    </Button>
  )
}

function FormatButton({
  format,
  className,
  children,
  ...props
}: { format: string } & ComponentProps<typeof ToolButton>) {
  const editor = useSlate()
  let active: boolean
  let toggleFormat = noop

  if (isMark(format)) {
    active = isMarkActive(editor, format)
    toggleFormat = () => {
      toggleMark(editor, format)
    }
  } else {
    active = isList(format) ? isListActive(editor, format) : isElementActive(editor, format)
    toggleFormat = () => {
      toggleBlock(editor, format)
    }
  }

  return (
    <ToolButton
      className={cx({ 'text-primary': active }, className)}
      title={format}
      onMouseDown={(event) => {
        event.preventDefault()
        toggleFormat()
      }}
      {...props}
    >
      {children}
    </ToolButton>
  )
}
