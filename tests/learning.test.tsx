import { expect, mock, test } from 'claude-code/testing'

import { BAND, step, typed, world } from './world'

const NOW = new Date(2026, 9, 13, 10, 0).getTime()
const STEP = { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high' as const, messageCount: 3 }
const DONE = { turnId: 't0', answer: 'ok', durationMs: 1000, isAborted: false, reason: 'answer' as const }
const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }
const KEEP = 'Opus · High (recommended)'
const task = (n: number) => `!! Refactor the scanner module number ${n} so caching and retries live in one place, with its tests`

test('after five kept recommendations for a kind of task, the chooser stops asking for it and says so', async ($, on) => {
  const w = world(on, { picks: [KEEP, KEEP, KEEP, KEEP, KEEP] })
  mock.clock(on, { now: NOW })
  for (const n of [1, 2, 3, 4, 5]) await $.prompt.submit(typed(task(n)))
  expect(w.asked).toHaveLength(5)
  expect(w.stored.trust).toMatchObject({ 'engineering task': { streak: 5 } })
  expect(w.toasts.at(-1)).toBe('You kept my pick 5 times in a row for “engineering task”: I\'ll stop asking for that kind of task (/chooser reset to undo).')

  await $.prompt.submit(typed(task(6)))
  expect(w.asked).toHaveLength(5)
  await step($.turn.step(STEP))
  expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: ' · auto' })).toBeDefined()
    await ui.unmount()
  }
})

test('a different choice, in the dialog or by tag, brings the question back; /chooser reset forgets everything', async ($, on) => {
  const w = world(on, { picks: [KEEP, KEEP, 'Opus · Extra (stronger)', KEEP] })
  mock.clock(on, { now: NOW })
  for (const n of [1, 2, 3]) await $.prompt.submit(typed(task(n)))
  expect(w.stored.trust).toMatchObject({ 'engineering task': { streak: 0 } })

  w.stored.trust = { 'engineering task': { streak: 5, at: NOW } }
  await $.prompt.submit(typed(`${task(4)} !sonnet`))
  expect(w.stored.trust).toMatchObject({ 'engineering task': { streak: 0 } })
  await $.prompt.submit(typed(task(5)))
  expect(w.asked).toHaveLength(4)

  w.stored.trust = { 'engineering task': { streak: 7, at: NOW } }
  const reset = await $.command.run({ command: 'chooser', args: 'reset', ...COMMAND })
  expect(reset).toMatchObject({ text: 'Model chooser: it will ask again for every kind of task.' })
  expect(w.stored.trust).toEqual({})
})

test("a costly switch is always asked, even for a trusted kind of task", async ($, on) => {
  const w = world(on, { messages: [{ role: 'assistant', text: 'Done.', toolUses: [] }], tokens: 90_000, model: 'claude-sonnet-5-5', picks: [undefined] })
  mock.clock(on, { now: NOW })
  w.stored.trust = { 'hard, deep problem': { streak: 9, at: NOW } }
  await $.turn.complete(DONE)
  await $.prompt.submit(typed('!! The upload still fails intermittently after the retry change; find the root cause and fix it properly'))
  expect(w.asked[0]?.header).toBe('Switch model')
})

test('each turn adds its cost to its level, and the dialog shows what each choice usually costs', async ($, on) => {
  const w = world(on, { fiveHour: 10, picks: [undefined] })
  mock.clock(on, { now: NOW })
  const turn = async (from: number, to: number) => {
    w.window.fiveHour = from
    await $.turn.start({ text: 'go', turnId: 't' })
    w.window.fiveHour = to
    await $.turn.complete(DONE)
  }
  await turn(10, 13)
  expect(w.stored.turnCost).toEqual({ 'opus:high': { avg: 3, n: 1 } })
  await turn(13, 15.5)
  await turn(15.5, 2)
  expect(w.stored.turnCost).toEqual({ 'opus:high': { avg: 2.9, n: 2 } })

  await $.prompt.submit(typed(task(1)))
  expect(w.asked[0]?.options).toEqual(['Opus · High (recommended) · ≈3%', 'Opus · Extra (stronger) · ≈4%', 'Sonnet · Extra (lighter) · ≈2%'])
})
