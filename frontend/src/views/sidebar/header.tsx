import { LogOutIcon } from 'lucide-react'
import { ComponentProps } from 'react'

import { cx } from '@/utils/css.ts'

import { Button } from '@/components/button.tsx'
import { useStableNavigate } from '@/components/router.tsx'

import { useLogout } from '@/views/auth/hooks.tsx'

import { ThemeToggle } from './theme-toggle.tsx'

export function Header({ className, ...props }: ComponentProps<'header'>) {
  const logout = useLogout()
  const navigate = useStableNavigate()

  return (
    <header className={cx('flex h-10 items-center', className)} {...props}>
      <Button
        className="pr-2 text-xl font-medium ring-inset hover:bg-transparent [&:hover]:text-foreground"
        variant="ghost"
        aria-label="go to homepage"
        onClick={() => {
          void navigate('/')
          window.toggleSidebar()
        }}
      >
        mote
      </Button>
      <Button
        className="relative top-[1px] px-2! ring-inset"
        variant="ghost"
        title="logout"
        onClick={() => {
          logout()
        }}
      >
        <LogOutIcon className="size-4 opacity-75" />
      </Button>
      <ThemeToggle className="ml-auto" />
    </header>
  )
}
