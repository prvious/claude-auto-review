import { expect, test } from 'claude-code/testing'

test('startup registers history without a model ping or storage dependency', async ($, on) => {
  let completions = 0
  let stores = 0
  on('model.complete', () => { completions += 1; return { deny: 'unavailable' } })
  on('store.get', () => { stores += 1; return { value: undefined } })
  on('command.register', () => ({ value: {} }))
  on('ui.status', () => ({ value: null }))
  on('session.start', () => ({ cwd: '/work' }))
  await expect($.session.start({ cwd: '/work' })).resolves.toEqual({ cwd: '/work' })
  expect(completions).toBe(0)
  expect(stores).toBe(0)
})
