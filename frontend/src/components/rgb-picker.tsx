import { Check as CheckIcon, Circle as CircleIcon } from 'lucide-react'
import { useState } from 'react'

import { cx } from '@/utils/css.ts'

import { Button } from './button.tsx'
import { RadioButton } from './radio-button.tsx'

type RGB = 'red' | 'green' | 'blue'

interface RGBPickerProps {
  initialValue: RGB | null
  onChange: (value: RGB | null) => void
  className?: string
}

export function RGBPicker({ initialValue, onChange, className }: RGBPickerProps) {
  const [value, setValue] = useState(initialValue)
  return (
    <RadioButton
      className={cx('inline-flex gap-1 hover:*:bg-transparent', className)}
      value={value}
      onChange={(value) => {
        setValue(value)
        onChange(value)
      }}
      options={[
        { label: 'fill-red-500', value: 'red' },
        { label: 'fill-blue-500', value: 'blue' },
        { label: 'fill-green-500', value: 'green' },
      ]}
      selfToggleable={true}
      renderLabel={(option) => (
        <Button
          tag="label"
          variant="ghost"
          size="sm"
          className="relative size-8! p-0!"
          title={`mark as ${option.value}`}
        >
          <CircleIcon
            className={cx(
              'pointer-events-none inline-block size-[22px] stroke-1',
              option.label as string,
            )}
          />
          <span
            className="abs-center pointer-events-none text-white transition-opacity"
            style={{ opacity: value === option.value ? 1 : 0 }}
          >
            <CheckIcon className="size-4" />
          </span>
        </Button>
      )}
    />
  )
}
