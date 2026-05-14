import { PRIVACY_COVER_SESSION_KEY, usePrivacyCover } from '../../src/views/auth/lock-store'

beforeEach(() => {
  window.sessionStorage.clear()
  usePrivacyCover.getState().unlock()
})

test('privacy cover lock state is mirrored to sessionStorage', () => {
  usePrivacyCover.getState().lock()

  expect(usePrivacyCover.getState().locked).toBe(true)
  expect(window.sessionStorage.getItem(PRIVACY_COVER_SESSION_KEY)).toBe('true')

  usePrivacyCover.getState().unlock()

  expect(usePrivacyCover.getState().locked).toBe(false)
  expect(window.sessionStorage.getItem(PRIVACY_COVER_SESSION_KEY)).toBeNull()
})

test('privacy cover toggle flips persisted state', () => {
  usePrivacyCover.getState().toggle()

  expect(usePrivacyCover.getState().locked).toBe(true)
  expect(window.sessionStorage.getItem(PRIVACY_COVER_SESSION_KEY)).toBe('true')

  usePrivacyCover.getState().toggle()

  expect(usePrivacyCover.getState().locked).toBe(false)
  expect(window.sessionStorage.getItem(PRIVACY_COVER_SESSION_KEY)).toBeNull()
})
