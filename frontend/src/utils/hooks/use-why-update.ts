import { useEffect, useRef } from 'react'

type IProps = Record<string, unknown>
type ChangedProps = Record<
  string,
  {
    from: unknown
    to: unknown
  }
>
// https://github.com/alibaba/hooks/blob/master/packages/hooks/src/useWhyDidYouUpdate/index.ts
export default function useWhyDidYouUpdate(componentName: string, props: IProps) {
  const prevProps = useRef<IProps>({})

  useEffect(() => {
    if (prevProps.current) {
      const allKeys = Object.keys({ ...prevProps.current, ...props })
      const changedProps: ChangedProps = {}

      allKeys.forEach((key) => {
        if (!Object.is(prevProps.current[key], props[key])) {
          changedProps[key] = {
            from: prevProps.current[key],
            to: props[key],
          }
        }
      })

      if (Object.keys(changedProps).length) {
        console.log('[why-did-you-update]', componentName, changedProps)
      }
    }

    prevProps.current = props
  })
}
