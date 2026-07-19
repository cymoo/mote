import { expect, test } from '@playwright/test'

import { createPost, deletePost } from './helper.js'

test('will jump to 404 page when post not found', async ({ page }) => {
  await page.goto('/p/0')
  await expect(page).toHaveURL('/404')
})

test('can create a post and delete it', async ({ page }) => {
  await createPost(page, 'wakeup neo')
  await deletePost(page, 'wakeup neo')
})

test('can submit a post with the Cmd/Ctrl+Enter shortcut', async ({ page }) => {
  await page.goto('/')
  await page.fill('[role="textbox"]', 'submit via shortcut')
  // `ControlOrMeta` resolves to Meta on macOS and Control elsewhere,
  // matching the editor's `isCtrlKey` handling.
  await page.locator('[role="textbox"]').press('ControlOrMeta+Enter')
  await expect(page.locator('div > p:has-text("submit via shortcut")').first()).toBeVisible()
  await deletePost(page, 'submit via shortcut')
})
