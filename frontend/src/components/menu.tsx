import { ComponentProps, ReactNode } from 'react'

import { cx } from '@/utils/css.ts'

// Compact popover-menu primitives shared by the post, tag and drive row
// menus: 13px text, 14px muted icons, theme-radius items.

export function MenuList({ className, ...props }: ComponentProps<'ul'>) {
  return <ul className={cx('min-w-36 text-[13px]', className)} {...props} />
}

interface MenuItemProps extends Omit<ComponentProps<'button'>, 'onClick'> {
  icon?: ReactNode
  danger?: boolean
  onClick: () => void
}

export function MenuItem({ icon, danger, className, children, onClick, ...props }: MenuItemProps) {
  return (
    <li>
      <button
        type="button"
        className={cx(
          'flex w-full items-center gap-2.5 rounded-[max(calc(var(--radius)-4px),4px)] px-2.5 py-[7px] text-left transition-colors',
          danger ? 'text-destructive hover:bg-destructive/10 hover:text-destructive' : 'hover:bg-accent',
          className,
        )}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        {...props}
      >
        {icon && (
          <span
            className={cx(
              'inline-flex size-3.5 flex-none items-center justify-center',
              danger ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {icon}
          </span>
        )}
        {children}
      </button>
    </li>
  )
}

export function MenuSeparator({ className, ...props }: ComponentProps<'li'>) {
  return <li aria-hidden="true" className={cx('border-border/70 mx-1.5 my-1 border-t', className)} {...props} />
}

// Non-interactive footer block (word counts, timestamps…).
export function MenuInfo({ className, ...props }: ComponentProps<'li'>) {
  return (
    <li
      className={cx(
        'text-muted-foreground/80 border-border/70 mt-1 border-t px-2.5 pt-1.5 pb-1 text-[11px] leading-relaxed',
        className,
      )}
      {...props}
    />
  )
}
