import {
  MoreHorizontal as MoreIcon,
  Pencil as PencilIcon,
  Pin as PinIcon,
  PinOff as PinOffIcon,
  Trash2 as TrashIcon,
} from 'lucide-react'
import { ComponentRef, useRef } from 'react'
import toast from 'react-hot-toast'
import { useSearchParams } from 'react-router'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { useConfirm } from '@/components/confirm.tsx'
import { specialChars } from '@/components/editor/extensions/hashtag-select.tsx'
import { Input } from '@/components/input.tsx'
import { MenuInfo, MenuItem, MenuList } from '@/components/menu.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/popover.tsx'
import { T, t, useLang } from '@/components/translation.tsx'

import { tagActions as actions } from '@/views/actions.ts'

import { TagNode } from './tag-list.tsx'

interface TagMenuProps {
  tag: TagNode
  className?: string
}

export function TagMenu({ tag, className }: TagMenuProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const triggerRef = useRef<ComponentRef<typeof Button>>(null!)
  const confirm = useConfirm()
  const [params, setParams] = useSearchParams()
  const { lang } = useLang()

  const closeMenu = () => {
    triggerRef.current.click()
  }

  return (
    <Popover placement="left-start">
      <PopoverTrigger asChild ref={triggerRef}>
        <Button
          className={cx('text-foreground/80 ring-inset', className)}
          variant="ghost"
          aria-label="show/hide tag menu"
        >
          <MoreIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <MenuList>
          <MenuItem
            icon={
              tag.sticky ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />
            }
            onClick={() => {
              closeMenu()
              void actions.stickTag(tag.name, !tag.sticky)
            }}
          >
            <T name={tag.sticky ? 'unpin' : 'pin'} />
          </MenuItem>
          <MenuItem
            icon={<PencilIcon className="size-3.5" />}
            onClick={() => {
                closeMenu()
                confirm.open({
                  heading: t('rename', lang),

                  okText: t('ok', lang),
                  oKButtonVariant: 'outline',
                  oKButtonClassName: 'w-1/4',

                  cancelText: t('cancel', lang),
                  cancelButtonClassName: 'hidden!',

                  description: (
                    <Input
                      ref={inputRef}
                      className="border-b-border rounded-none border-b border-transparent pr-0 pl-0 focus-visible:ring-transparent"
                      defaultValue={tag.name}
                      autoFocus={true}
                    />
                  ),

                  onOk: async () => {
                    let input = inputRef.current!.value
                    input = input.trim()
                    input = input.replace(/\/{2,}/g, '/')
                    if (input.startsWith('/')) input = input.substring(1)
                    if (input.endsWith('/')) input = input.substring(0, input.length - 1)

                    if (input.includes('#')) {
                      toast('invalid character: #')
                      return
                    }

                    if (/\s/.test(input)) {
                      toast('spaces are not allowed')
                      return
                    }

                    for (const char of input) {
                      if (specialChars.has(char)) {
                        toast(`invalid character: ${char}`)
                        return
                      }
                    }

                    if (input !== '' && input !== tag.name) {
                      await actions.renameTag(tag.name, input)
                      if (params.get('tag') === tag.name) {
                        setParams({ tag: input })
                      }
                    }
                  },
                })
            }}
          >
            <T name="rename" />
          </MenuItem>
          <MenuItem
            danger
            icon={<TrashIcon className="size-3.5" />}
            onClick={() => {
              closeMenu()
              confirm.open({
                heading: <T name="deleteTag" />,
                description: t('deleteTagDescription', lang, true, tag.name),
                okText: t('delete', lang),
                cancelText: t('cancel', lang),
                cancelButtonClassName: 'w-1/4',
                onOk: async () => {
                  await actions.deleteTag(tag.name)
                },
              })
            }}
          >
            <T name="delete" />
          </MenuItem>
          <MenuInfo>
            <T name="totalMemos" />: {tag.post_count}
          </MenuInfo>
        </MenuList>
      </PopoverContent>
    </Popover>
  )
}
