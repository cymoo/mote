// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import {
  Activators,
  DndContext,
  DragCancelEvent,
  DragEndEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  KeyboardCode,
  KeyboardCodes,
  KeyboardSensorOptions,
  KeyboardSensor as LibKeyboardSensor,
  MouseSensor as LibMouseSensor,
  MouseSensorOptions,
  TouchSensor,
  UniqueIdentifier,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import React, {
  CSSProperties,
  Dispatch,
  MouseEvent,
  ReactElement,
  ReactNode,
  SetStateAction,
  useState,
} from 'react'

interface SortableProps<T> {
  items: T[]
  setItems: Dispatch<SetStateAction<T[]>>
  renderItem: (item: T) => ReactElement
  renderOverlay?: (id: UniqueIdentifier) => ReactNode
}

export function Sortable<T extends { id: UniqueIdentifier }>({
  items,
  setItems,
  renderItem,
  renderOverlay,
}: SortableProps<T>) {
  const sensors = useSensors(
    useSensor(MouseSensor, {
      // Require the mouse to move by 10 pixels before activating
      activationConstraint: {
        distance: 10,
      },
    }),
    useSensor(TouchSensor, {
      // Press delay of 250ms, with tolerance of 5px of movement
      activationConstraint: {
        // NOTE: The delay should not be too long;
        // otherwise, on iOS Safari, it may trigger the `touch callout` for images or links,
        // interfering with the movement of the image.
        delay: 250,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null)

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id)
  }
  const handleDragCancel = () => {
    setActiveId(null)
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event

    if (over && active.id !== over.id) {
      setItems((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id)
        const newIndex = items.findIndex((item) => item.id === over.id)

        return arrayMove(items, oldIndex, newIndex)
      })
    }
    setActiveId(null)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{ announcements: genAnnouncements(items) }}
      onDragEnd={handleDragEnd}
      onDragStart={handleDragStart}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={items} strategy={rectSortingStrategy}>
        {items.map((item) => (
          <SortableItem key={item.id} id={item.id}>
            {renderItem(item)}
          </SortableItem>
        ))}
      </SortableContext>
      {renderOverlay && (
        <DragOverlay adjustScale>{activeId ? renderOverlay(activeId) : null}</DragOverlay>
      )}
    </DndContext>
  )
}

function genAnnouncements(items: { id: UniqueIdentifier }[]) {
  const getPosition = (id: UniqueIdentifier) => items.findIndex((item) => item.id === id) + 1
  const itemCount = items.length

  return {
    onDragStart({ active }: DragStartEvent) {
      return `Item at position ${String(getPosition(active.id))} of ${String(itemCount)} was picked up.`
    },
    onDragOver({ active, over }: DragOverEvent) {
      if (over) {
        return `Item at position ${String(getPosition(active.id))} of ${String(itemCount)} was moved to ${String(getPosition(over.id))}.`
      }
    },
    onDragEnd({ active, over }: DragEndEvent) {
      if (over) {
        return `Item at position ${String(getPosition(active.id))} of ${String(itemCount)} was dropped at ${String(getPosition(over.id))}.`
      }
    },
    onDragCancel({ active }: DragCancelEvent) {
      return `Dragging of item at position ${String(getPosition(active.id))} was cancelled.`
    },
  }
}

function SortableItem({ id, children }: { id: number | string; children: ReactElement }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // https://docs.dndkit.com/api-documentation/sensors/touch#touch-action
    // NOTE: It must be set to `manipulation`; otherwise, "it is possible to prevent the page from scrolling."
    touchAction: 'manipulation',
  }

  return React.cloneElement(children, {
    ref: setNodeRef,
    style: Object.assign(style, (children.props as { style?: CSSProperties }).style),
    ...attributes,
    ...listeners,
  })
}

// How to prevent draggable on input and buttons: https://github.com/clauderic/dnd-kit/issues/477
// Block DnD event propagation if element have `data-no-dnd` attribute
function shouldHandleEvent(element: HTMLElement | null) {
  let cur = element

  while (cur) {
    if (cur.dataset.noDnd) {
      return false
    }
    cur = cur.parentElement
  }

  return true
}

class MouseSensor extends LibMouseSensor {
  static activators = [
    {
      eventName: 'onMouseDown' as const,
      handler: ({ nativeEvent: event }: MouseEvent, { onActivation }: MouseSensorOptions) => {
        // 2: right-click
        if (event.button === 2) {
          return false
        }
        if (shouldHandleEvent(event.target as HTMLElement)) {
          onActivation?.({ event })
          return true
        } else {
          return false
        }
      },
    },
  ]
}

const defaultKeyboardCodes: KeyboardCodes = {
  start: [KeyboardCode.Space, KeyboardCode.Enter],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Enter],
}

class KeyboardSensor extends LibKeyboardSensor {
  static activators: Activators<KeyboardSensorOptions> = [
    {
      eventName: 'onKeyDown' as const,
      handler: (
        event: React.KeyboardEvent,
        { keyboardCodes = defaultKeyboardCodes, onActivation },
        { active },
      ) => {
        const { code } = event.nativeEvent

        if (keyboardCodes.start.includes(code)) {
          const activator = active.activatorNode.current

          if (activator && event.target !== activator) {
            return false
          }

          if (shouldHandleEvent(event.target as HTMLElement)) {
            event.preventDefault()
            onActivation?.({ event: event.nativeEvent })
            return true
          } else {
            return false
          }
        }
        return false
      },
    },
  ]

  // Sortable in modal - keydown event propagation issue
  // https://github.com/clauderic/dnd-kit/issues/1367
  private attach() {
    this.handleStart()

    this.windowListeners.add('resize', this.handleCancel)
    this.windowListeners.add('visibilitychange', this.handleCancel)

    this.props.event.target.addEventListener('keydown', this.handleKeyDown)
  }

  private detach() {
    this.props.event.target.removeEventListener('keydown', this.handleKeyDown)
    this.windowListeners.removeAll()
  }

  private handleCancel(event: Event) {
    const { onCancel } = this.props

    event.stopPropagation()
    event.preventDefault()
    this.detach()
    onCancel()
  }
}
