import { ChevronDown as ChevronDownIcon, Maximize2, Minimize2, X as XIcon } from 'lucide-react'
import {
  ComponentProps,
  ReactNode,
  Ref,
  RefObject,
  createContext,
  useContext,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'

import { IS_TOUCH_DEVICE } from '@/utils/browser.ts'
import { cx } from '@/utils/css.ts'

import { Dialog, DialogClose, DialogContent, DialogHeading } from './dialog'
import { DrawerContent } from './drawer'

interface ModalOption {
  heading?: ReactNode
  headingVisible?: boolean
  content: ReactNode
  // Opt-in: show a grip + expand/collapse control so the panel (a bottom sheet on
  // touch) can grow to a full-screen editor and shrink back. Used by the composer.
  expandable?: boolean
  // Title shown in the expandable panel's header row (e.g. "new memo").
  title?: ReactNode
}

interface ModalHandle {
  open: (option: ModalOption) => void
  close: () => void
}

interface ModalProps extends Omit<ComponentProps<typeof DialogContent>, 'ref'> {
  ref?: Ref<ModalHandle>
}

export function Modal({ ref, ...props }: ModalProps) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const [options, setOptions] = useState({} as ModalOption)
  const { heading, content, headingVisible = false, expandable = false, title } = options

  useImperativeHandle(ref, () => ({
    open: (options) => {
      setOptions(options)
      setExpanded(false)
      setOpen(true)
    },
    close: () => {
      setOpen(false)
    },
  }))

  const { className, overlayClassName, ...rest } = props
  const fullscreen = expandable && expanded

  const controls = expandable ? (
    fullscreen ? (
      <div className="border-border -mx-1 flex flex-none items-center border-b pb-2">
        <button
          type="button"
          className="text-muted-foreground hover:bg-muted flex size-9 items-center justify-center rounded-lg transition-colors"
          aria-label="collapse editor"
          onClick={() => {
            setExpanded(false)
          }}
        >
          <Minimize2 className="size-[18px]" />
        </button>
        <span className="text-foreground flex-1 text-center text-[15px] font-medium">{title}</span>
        <button
          type="button"
          className="text-muted-foreground hover:bg-muted flex size-9 items-center justify-center rounded-lg transition-colors"
          aria-label="close editor"
          onClick={() => {
            setOpen(false)
          }}
        >
          <XIcon className="size-5" />
        </button>
      </div>
    ) : (
      <div className="-mt-1 flex flex-none flex-col">
        <span
          className="bg-muted-foreground/25 mx-auto mb-2 h-1 w-9 rounded-full"
          aria-hidden="true"
        ></span>
        <div className="-mr-1 flex items-center">
          <span className="text-muted-foreground text-[13px] font-medium tracking-wide">
            {title}
          </span>
          <span className="ml-auto flex items-center gap-0.5">
            <button
              type="button"
              className="text-muted-foreground hover:bg-muted flex size-8 items-center justify-center rounded-lg transition-colors"
              aria-label="expand editor"
              onClick={() => {
                setExpanded(true)
              }}
            >
              <Maximize2 className="size-[18px]" />
            </button>
            <button
              type="button"
              className="text-muted-foreground hover:bg-muted flex size-8 items-center justify-center rounded-lg transition-colors"
              aria-label="close editor"
              onClick={() => {
                setOpen(false)
              }}
            >
              <ChevronDownIcon className="size-5" />
            </button>
          </span>
        </div>
      </div>
    )
  ) : null

  const inner = (
    <>
      {heading && (
        <DialogHeading className={cx({ 'sr-only': !headingVisible })}>{heading}</DialogHeading>
      )}
      <DialogClose className="sr-only" />
      {controls}
      {content}
    </>
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {expandable ? (
        <DrawerContent
          side="bottom"
          overlayClassName="bg-black/45! backdrop-blur-sm"
          className={cx(
            'flex flex-col',
            fullscreen
              ? 'h-[100dvh]! max-h-none! rounded-none! border-0! p-3!'
              : 'max-h-[92%] rounded-t-[1.25rem]! rounded-b-none! border-t p-4! pb-[calc(env(safe-area-inset-bottom)+0.75rem)]',
          )}
        >
          {inner}
        </DrawerContent>
      ) : (
        <DialogContent className={className} overlayClassName={overlayClassName} {...rest}>
          {inner}
        </DialogContent>
      )}
    </Dialog>
  )
}

const ModalContext = createContext<RefObject<ModalHandle> | null>(null)

export function ModalProvider({ children }: { children: ReactNode }) {
  const ref = useRef<ModalHandle>(null!)

  return (
    <ModalContext value={ref}>
      <>
        <Modal
          ref={ref}
          // animation={false}
          overlayClassName={cx('bg-black/90', { 'items-end!': IS_TOUCH_DEVICE })}
          className={cx('max-w-[640px]! p-4!', IS_TOUCH_DEVICE ? 'max-h-[80vh]' : 'max-h-[640px]')}
        />
        {children}
      </>
    </ModalContext>
  )
}

export function useModal() {
  const modalRef = useContext(ModalContext)

  return useMemo(
    () => ({
      open: (option: ModalOption) => {
        modalRef?.current.open(option)
      },
      close: () => {
        modalRef?.current.close()
      },
    }),
    [modalRef],
  )
}
