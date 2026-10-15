import { expect, mock, test } from 'claude-code/testing'

import { BAND, HISTORY, step, typed, world } from './world'

const NOW = new Date(2026, 9, 12, 15, 0).getTime()
const STEP = { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high' as const, messageCount: 3 }
const DONE = { turnId: 't0', answer: 'ok', durationMs: 1000, isAborted: false, reason: 'answer' as const }
const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }

test('a new task is confirmed in the dialog, and every request of the turn goes to the confirmed model', async ($, on) => {
  const w = world(on, { picks: ['Opus · Extra (stronger)'] })
  mock.clock(on, { now: NOW })
  const entered = await $.prompt.submit(typed('!! Refactor the scanner so caching and retries live in one module, then update its tests'))
  expect(entered).toMatchObject({ text: 'Refactor the scanner so caching and retries live in one module, then update its tests' })
  expect(w.completions).toHaveLength(0)
  expect(w.asked).toEqual([
    { question: 'Engineering task: run it on Opus · High?', header: 'Model', options: ['Opus · High (recommended)', 'Opus · Extra (stronger)', 'Sonnet · Extra (lighter)'] },
  ])
  await step($.turn.step(STEP))
  await step($.turn.step({ ...STEP, index: 1 }))
  expect(w.steps).toEqual([
    { model: 'claude-opus-5-5', effort: 'xhigh' },
    { model: 'claude-opus-5-5', effort: 'xhigh' },
  ])
  expect(w.statuses.at(-1)).toBe('◆ Opus · Extra · engineering task')

  // A reply keeps what runs: no dialog.
  await $.prompt.submit(typed('yes'))
  expect(w.asked).toHaveLength(1)

  // A subagent's requests are left alone.
  await step($.turn.step({ ...STEP, agentId: 'a1' }))
  expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
})

test('a tag forces the pick with no dialog, and an unclear prompt is settled by a quick Haiku read', async ($, on) => {
  const w = world(on, { haiku: ['{"model":"sonnet","effort":"high","reason":"small UI tweak"}'], picks: [undefined] })
  mock.clock(on, { now: NOW })
  await $.prompt.submit(typed('fix the flaky login test !sonnet'))
  expect(w.asked).toHaveLength(0)
  await step($.turn.step(STEP))
  expect(w.steps.at(-1)).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' })

  await $.prompt.submit(typed('!! make the onboarding screen feel a little nicer and warmer for new parents'))
  expect(w.completions.map(one => one.model)).toEqual(['haiku'])
  expect(w.asked[0]?.question).toBe('Small UI tweak: run it on Sonnet · High?')
  // Dismissed: the recommended pick runs.
  await step($.turn.step(STEP))
  expect(w.steps.at(-1)).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' })
})

test('a costly switch mid-conversation offers switch, stay, or a new conversation with a recap', async ($, on) => {
  const w = world(on, { messages: HISTORY, tokens: 90_000, model: 'claude-sonnet-5-5', picks: ['New conversation (with recap)', 'Stay on Sonnet · Max (cheapest)'] })
  mock.clock(on, { now: NOW })
  await $.turn.complete(DONE)
  const prompt = '!! The upload still fails intermittently after the retry change; find the root cause and fix it properly'
  const dropped = await $.prompt.submit(typed(prompt))
  expect(w.asked[0]).toEqual({
    question: 'Opus · Max fits this better (hard, deep problem), but switching from Sonnet re-reads 90k tokens without the cache. Switch?',
    header: 'Switch model',
    options: ['Switch to Opus · Max', 'Stay on Sonnet · Max (cheapest)', 'New conversation (with recap)'],
  })
  expect(dropped).toEqual({ drop: 'Copied your prompt with a short recap: open a new conversation and paste it.' })
  expect(w.copied[0]).toContain('Context from an earlier session:\nGoal: scanner caching.')
  expect(w.copied[0]).toEndWith('find the root cause and fix it properly')
  expect(w.submitted).toHaveLength(0)

  await $.prompt.submit(typed(prompt))
  await step($.turn.step({ ...STEP, model: 'claude-sonnet-5-5' }))
  expect(w.steps.at(-1)).toEqual({ model: 'claude-sonnet-5-5', effort: 'max' })
})

test('mid-conversation, a lighter task stays on the warm stronger model instead of re-reading everything', async ($, on) => {
  const w = world(on, { messages: HISTORY, tokens: 80_000, picks: [undefined] })
  mock.clock(on, { now: NOW })
  await $.turn.complete(DONE)
  await $.prompt.submit(typed('!! what does the scan function return when the page is empty?'))
  expect(w.asked[0]?.options[0]).toBe('Opus · Medium (recommended)')
  expect(w.asked[0]?.question).toBe('Routine request, kept on Opus (cache warm): run it on Opus · Medium?')
})

test('the choice typed under Other is understood, else the recommended pick runs', async ($, on) => {
  const w = world(on, { picks: ['sonnet max', 'whatever'] })
  mock.clock(on, { now: NOW })
  await $.prompt.submit(typed('!! Refactor the scanner so caching and retries live in one module, then update its tests'))
  await step($.turn.step(STEP))
  expect(w.steps.at(-1)).toEqual({ model: 'claude-sonnet-5-5', effort: 'max' })
  await $.prompt.submit(typed('!! Refactor the uploader the same way, so retries and backoff live in one module as well'))
  expect(w.toasts.at(-1)).toBe('Didn\'t catch “whatever”: running on Opus · High.')
})

test('the switches turn each part off for every session', async ($, on) => {
  const w = world(on)
  mock.clock(on, { now: NOW })
  const off = await $.command.run({ command: 'chooser', args: 'off', ...COMMAND })
  expect(off).toMatchObject({ text: 'Model chooser: off in every session.' })
  expect(w.stored.chooserOn).toBe(false)
  await $.prompt.submit(typed('!! Refactor the scanner so caching and retries live in one module, then update its tests'))
  expect(w.asked).toHaveLength(0)
  await step($.turn.step(STEP))
  expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  const on_ = await $.command.run({ command: 'chooser', args: '', ...COMMAND })
  expect(on_).toMatchObject({ text: 'Model chooser: on in every session.' })
})

test('plan usage warns once per window and level, and the band shows it', async ($, on) => {
  const w = world(on, { picks: ['Opus · High (recommended)'] })
  mock.clock(on, { now: NOW })
  const resetsAt = new Date(NOW + 2 * 3_600_000 + 10 * 60_000).toISOString()
  const measure = (percentUsed: number) =>
    $.session.measure({ context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt }, { kind: 'seven_day', percentUsed: 31 }], changed: ['rateLimits'] })
  await measure(82)
  await measure(84)
  expect(w.toasts).toEqual(['⚠ 5-hour usage at 82% · resets in 2 h 10 min'])
  await measure(96)
  expect(w.toasts).toHaveLength(2)

  await $.prompt.submit(typed('!! Refactor the scanner so caching and retries live in one module, then update its tests'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '◆ Opus · High' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' ▰▰▱▱' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h 96% · week 31%/ })).toBeDefined()
    await ui.unmount()
  }
})
