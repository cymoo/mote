export function omit<T extends object, K extends keyof T>(obj: T, ...keysToOmit: K[]): Omit<T, K> {
  const result = { ...obj }
  keysToOmit.forEach((key) => {
    delete result[key]
  })
  return result
}

export function pick<T extends object, K extends keyof T>(obj: T, ...keysToPick: K[]): Pick<T, K> {
  const result: Partial<Pick<T, K>> = {}

  keysToPick.forEach((key) => {
    result[key] = obj[key]
  })

  return result as Pick<T, K>
}

export function isAsyncFunction(value: unknown): value is (...args: unknown[]) => Promise<unknown> {
  return typeof value === 'function' && value.constructor.name === 'AsyncFunction'
}
