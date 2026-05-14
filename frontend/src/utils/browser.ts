import { KeyboardEvent } from 'react'

export const IS_ZH = (navigator.languages?.length ? navigator.languages[0] : navigator.language).startsWith(
  'zh',
)

export const IS_TOUCH_DEVICE =
  !!navigator.maxTouchPoints || 'ontouchstart' in document.documentElement

// https://github.com/ianstormtaylor/slate/blob/main/packages/slate-react/src/utils/environment.ts
export const IS_APPLE = navigator.userAgent.includes('Mac OS X')

// https://stackoverflow.com/questions/9038625/detect-if-device-is-ios
export const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  // iPad on iOS 13 detection
  (navigator.userAgent.includes('Mac') && 'ontouchend' in document)

export function isCtrlKey(event: KeyboardEvent) {
  return IS_APPLE ? event.metaKey : event.ctrlKey
}
