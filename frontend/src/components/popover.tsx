import {
  FloatingFocusManager,
  FloatingPortal,
  Placement,
  autoUpdate,
  flip,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useId,
  useInteractions,
  useMergeRefs,
  useRole,
  useTransitionStyles,
} from '@floating-ui/react'
import { X } from 'lucide-react'
import {
  ComponentProps,
  HTMLProps,
  ReactNode,
  Ref,
  RefObject,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { cx } from '@/utils/css.ts'

import { Button } from './button'

interface PopoverOptions {
  placement?: Placement
  initialOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function usePopoverWithInteractions({
  initialOpen = false,
  placement = 'bottom',
  open: controlledOpen,
  onOpenChange: setControlledOpen,
}: PopoverOptions = {}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(initialOpen)
  const [labelId, setLabelId] = useState<string | undefined>()
  const [descriptionId, setDescriptionId] = useState<string | undefined>()

  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = setControlledOpen ?? setUncontrolledOpen

  const data = useFloating({
    placement,
    open,
    onOpenChange: setOpen,
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(5),
      flip({
        crossAxis: placement.includes('-'),
        fallbackAxisSideDirection: 'end',
        padding: 5,
      }),
      shift({ padding: 5 }),
    ],
  })

  const context = data.context

  const click = useClick(context, {
    enabled: controlledOpen == null,
  })
  const dismiss = useDismiss(context)
  const role = useRole(context)

  const interactions = useInteractions([click, dismiss, role])

  return useMemo(
    () => ({
      open,
      setOpen,
      ...interactions,
      ...data,
      labelId,
      descriptionId,
      setLabelId,
      setDescriptionId,
    }),
    [open, setOpen, interactions, data, labelId, descriptionId],
  )
}

const PopoverContext = createContext<ReturnType<typeof usePopoverWithInteractions> | null>(null)

export const usePopoverContext = () => {
  const context = useContext(PopoverContext)

  if (context == null) {
    throw new Error('Popover components must be wrapped in <Popover />')
  }

  return context
}

export function Popover({
  children,
  refs,
  ...options
}: {
  children: ReactNode
  refs?: RefObject<ReturnType<typeof usePopoverWithInteractions>['refs'] | null>
} & PopoverOptions) {
  // This can accept any props as options, e.g. `placement`, or other positioning options.
  const popover = usePopoverWithInteractions(options)
  if (refs) {
    refs.current = popover.refs
  }
  return <PopoverContext.Provider value={popover}>{children}</PopoverContext.Provider>
}

interface PopoverTriggerProps extends HTMLProps<HTMLElement> {
  asChild?: boolean
  ref?: Ref<HTMLElement>
}

export function PopoverTrigger({
  children,
  asChild = false,
  ref: propRef,
  ...props
}: PopoverTriggerProps) {
  const context = usePopoverContext()
  const childrenRef = (children as { ref?: unknown }).ref
  const ref = useMergeRefs([context.refs.setReference, propRef, childrenRef as Ref<unknown>])

  // `asChild` allows the user to pass any element as the anchor
  if (asChild && isValidElement(children)) {
    return cloneElement(
      children,
      context.getReferenceProps({
        ref,
        ...props,
        ...(children.props as HTMLProps<Element>),
        // @ts-expect-error make ts happy
        'data-state': context.open ? 'open' : 'closed',
      }),
    )
  }

  return (
    <Button
      ref={ref}
      type="button"
      // The user can style the trigger based on the state
      data-state={context.open ? 'open' : 'closed'}
      {...context.getReferenceProps(props)}
    >
      {children}
    </Button>
  )
}

interface PopoverContentProps extends ComponentProps<'div'> {
  focusable?: boolean
  portal?: boolean
  modal?: boolean
  ref?: Ref<HTMLDivElement>
}

export function PopoverContent({
  className,
  focusable = true,
  portal = true,
  modal = false,
  children,
  ref: propRef,
  ...props
}: PopoverContentProps) {
  const { x, y, strategy, refs, context: floatingContext, ...context } = usePopoverContext()
  const ref = useMergeRefs([refs.setFloating, propRef])

  const { isMounted, styles: transitionStyles } = useTransitionStyles(floatingContext, {
    duration: {
      open: 300,
      // NOTE: The close animation interferes with the drawer's enter animation,
      // causing it to become laggy (especially on Android devices). Why?
      close: 0,
    },
    initial: ({ side }) => ({
      opacity: 0,
      transform: transforms[side],
    }),
  })

  if (!isMounted) return null

  let content = (
    <div
      ref={ref}
      {...context.getFloatingProps(props)}
      data-side={context.placement}
      className={cx(
        'bg-popover text-popover-foreground border-border relative z-50 min-w-[145px] rounded-[calc(var(--radius)+2px)] border p-1.5 shadow-xl outline-none',
        className,
      )}
      // style={{ ...context.floatingStyles, ...transitionStyles }}
      // NOTE: If `context.floatingStyles` is used, its positioning relies on `transform`,
      // which may conflict with transition animations.
      style={{
        position: strategy,
        left: x,
        top: y,
        ...transitionStyles,
      }}
      aria-labelledby={context.labelId}
      aria-describedby={context.descriptionId}
    >
      {children}
    </div>
  )

  if (focusable) {
    content = (
      <FloatingFocusManager context={floatingContext} modal={modal}>
        {content}
      </FloatingFocusManager>
    )
  }
  if (portal) {
    content = <FloatingPortal>{content}</FloatingPortal>
  }

  return content
}

const transforms = {
  left: 'translateX(10px)',
  right: 'translateX(-10px)',
  top: 'translateY(10px)',
  bottom: 'translateY(-10px)',
}

export function PopoverHeading({ children, className, ref, ...props }: ComponentProps<'h2'>) {
  const { setLabelId } = usePopoverContext()
  const id = useId()

  // Only sets `aria-labelledby` on the Popover root element
  // if this component is mounted inside it.
  useLayoutEffect(() => {
    setLabelId(id)
    return () => {
      setLabelId(undefined)
    }
  }, [id, setLabelId])

  return (
    <h2
      {...props}
      ref={ref}
      id={id}
      className={cx('text-lg leading-none font-semibold tracking-tight', className)}
    >
      {children}
    </h2>
  )
}

export function PopoverDescription({ children, className, ref, ...props }: ComponentProps<'p'>) {
  const { setDescriptionId } = usePopoverContext()
  const id = useId()

  // Only sets `aria-describedby` on the Popover root element
  // if this component is mounted inside it.
  useLayoutEffect(() => {
    setDescriptionId(id)
    return () => {
      setDescriptionId(undefined)
    }
  }, [id, setDescriptionId])

  return (
    <p {...props} ref={ref} id={id} className={cx('text-muted-foreground text-sm', className)}>
      {children}
    </p>
  )
}

export function PopoverClose({ className, onClick, ref, ...props }: ComponentProps<typeof Button>) {
  const { setOpen } = usePopoverContext()
  return (
    <Button
      type="button"
      variant="ghost"
      className={cx('absolute top-4 right-4', className)}
      ref={ref}
      onClick={(event) => {
        onClick?.(event)
        setOpen(false)
      }}
      {...props}
    >
      <X className="size-4" />
      <span className="sr-only">Close</span>
    </Button>
  )
}

interface VirtualPopoverHandle {
  toggle: (target: HTMLElement) => void
  close: () => void
}

interface VirtualPopoverProps extends Omit<ComponentProps<typeof PopoverContent>, 'ref'> {
  placement?: Placement
  ref?: Ref<VirtualPopoverHandle>
}

export function VirtualPopover({
  children,
  placement = 'left-start',
  ref: propRef,
  ...props
}: VirtualPopoverProps) {
  const [open, setOpen] = useState(false)
  const refs = useRef<ReturnType<typeof usePopoverWithInteractions>['refs']>(null)

  useImperativeHandle(propRef, () => ({
    toggle: (target) => {
      refs.current?.setReference(target)
      setOpen((open) => !open)
    },
    close: () => {
      refs.current?.setReference(null)
      setOpen(false)
    },
  }))

  return (
    <Popover open={open} onOpenChange={setOpen} refs={refs} placement={placement}>
      <PopoverContent {...props}>{children}</PopoverContent>
    </Popover>
  )
}
