import { ChevronDown as DownIcon, ChevronRight as RightIcon } from 'lucide-react'
import { ComponentProps, memo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { useStableNavigate } from '@/components/router.tsx'

import { HIGHLIGHT_STYLE } from '@/views/sidebar/sidebar.tsx'

import { TagNode } from './tag-list.tsx'
import { TagMenu } from './tag-menu.tsx'
import { getLastSegment } from './utils.ts'

interface TagItemProps extends ComponentProps<'li'> {
  tag: TagNode
  showPath?: boolean
}

export const TagItem = memo(function TreeItem({
  tag,
  showPath = false,
  className,
  children,
  ...props
}: TagItemProps) {
  const [isOpen, setOpen] = useState(false)
  const ref = useRef<HTMLLIElement>(null)
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const navigate = useStableNavigate()

  const selectTag = () => {
    const options = {
      state: { fromInternal: true },
      replace: params.get('tag')?.includes('hidden'),
    }

    if (location.pathname === '/') {
      setParams({ tag: tag.name }, options)
    } else {
      void navigate(
        {
          pathname: '/',
          search: `?${new URLSearchParams({ tag: tag.name }).toString()}`,
        },
        options,
      )
    }
    window.toggleSidebar()
  }

  return (
    <li
      ref={ref}
      // How to transition auto height
      // https://stackoverflow.com/a/76944290/6617322
      className={cx(
        'grid grid-rows-[min-content_0fr] transition-[grid-template-rows] duration-500 ease-out',
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-between min-w-0">
        <Button
          className={cx('w-full flex-1 justify-start gap-0 rounded-lg font-normal ring-inset', {
            [HIGHLIGHT_STYLE]: params.get('tag') === tag.name,
          })}
          variant="ghost"
          onClick={selectTag}
        >
          <span className="text-muted-foreground/60 mr-1.5 flex-none font-serif" aria-hidden="true">
            #
          </span>
          <span className="truncate">{showPath ? tag.name : getLastSegment(tag.name)}</span>
          <span className="text-muted-foreground/60 ml-auto flex-none pl-2 text-[11px] tabular-nums">
            {tag.post_count}
          </span>
        </Button>
        {tag.children.length > 0 && (
          <Button
            className="font-normal"
            size="sm"
            variant="ghost"
            aria-label="expand/fold sub-tags"
            onClick={() => {
              setOpen(!isOpen)
              ref.current?.classList.toggle('grid-rows-[min-content_1fr]')
            }}
          >
            {isOpen ? (
              <DownIcon className="size-4 align-middle" />
            ) : (
              <RightIcon className="size-4 align-middle" />
            )}
          </Button>
        )}
        <TagMenu tag={tag} className="flex-none" />
      </div>
      {tag.children.length > 0 && (
        <div
          className="overflow-hidden"
          inert={!isOpen}
          aria-expanded={isOpen}
          aria-label={`sub tags of #${tag.name}`}
        >
          {children}
        </div>
      )}
    </li>
  )
})
