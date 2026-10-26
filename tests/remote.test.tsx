import { expect, mock, test } from 'claude-code/testing'

import { HISTORY, PANE, READ_WITH_QUESTIONS, READ_WITH_SIX_QUESTIONS, REWRITE, typed, world } from './world'

const NOW = new Date(2026, 9, 26, 15, 0).getTime()
const DONE = { turnId: 't0', answer: 'ok', durationMs: 1000, isAborted: false, reason: 'answer' as const }
const PROMPT = 'Add a cache to the scanner so we stop paying for repeated scans of the same page'
const IMPROVED_START = 'Cache scan results so a second scan of the same page skips the API call.'
const fromPhone = (text: string) => ({ text, wait: false, origin: { kind: 'bridge' as const } })

test('a prompt from a phone or the web is never held in a panel: the dialog asks three at a time, then it runs', async ($, on) => {
  const w = world(on, {
    haiku: [READ_WITH_SIX_QUESTIONS],
    sonnet: [REWRITE],
    surfaces: ['desktop', 'mobile'],
    picks: ['Option 1b', 'Option 2a', 'My own words', 'Next questions', 'Option 4a', 'Option 5b', 'Option 6a', 'Run the improved prompt', undefined],
  })
  mock.clock(on, { now: NOW })
  const entered = await $.prompt.submit(fromPhone('Redesign the onboarding so new parents reach their first scan faster and drop off less often'))
  expect(w.opened).toHaveLength(0)
  expect(w.asked.map(one => one.header)).toEqual(['Audience', 'Steps', 'Skip', 'Upgrader', 'Tone', 'Platforms', 'Done when', 'Upgrader'])
  expect(w.asked[0]).toEqual({ question: 'Question 1 about audience?', header: 'Audience', options: ['Option 1a', 'Option 1b'] })
  expect(w.asked[3]?.question).toBe('3 more questions could sharpen it. Go on?')
  expect(w.asked[7]?.question).toStartWith('Run the improved prompt?')
  const sent = JSON.stringify(w.completions[1]?.prompt)
  expect(sent).toContain('Question 1 about audience? → Option 1b')
  expect(sent).toContain('Question 3 about skip? → My own words')
  expect(sent).toContain('Question 5 about platforms? → Option 5b')
  expect(entered).toMatchObject({ text: expect.stringContaining(IMPROVED_START) })
  expect(w.submitted[0]?.text).toStartWith(IMPROVED_START)
})

test('"Improve now" between groups writes the prompt from the first three answers', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_SIX_QUESTIONS], sonnet: [REWRITE], surfaces: ['mobile'], picks: ['Option 1a', 'Option 2a', 'Option 3a', 'Improve now', 'Run the improved prompt'] })
  mock.clock(on, { now: NOW })
  await $.prompt.submit(fromPhone('Redesign the onboarding so new parents reach their first scan faster and drop off less often'))
  const sent = JSON.stringify(w.completions[1]?.prompt)
  expect(sent).toContain('Question 3 about skip? → Option 3a')
  expect(sent).not.toContain('Question 4')
  expect(w.submitted[0]?.text).toStartWith(IMPROVED_START)
})

test('only a phone attached: the dialog, even for a prompt typed in the app; "Send mine as typed" runs it unchanged', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_QUESTIONS], sonnet: [REWRITE], surfaces: ['mobile'], picks: ['All API calls', undefined, 'Send mine as typed', undefined] })
  mock.clock(on, { now: NOW })
  const entered = await $.prompt.submit(typed(PROMPT))
  expect(w.opened).toHaveLength(0)
  expect(entered).toMatchObject({ text: PROMPT })
  expect(w.stored['answers:/work/app']).toEqual([{ topic: 'Scope', question: 'What should the cache cover?', answer: 'All API calls', at: NOW }])
})

test('a dismissed question dialog lets the prompt run as typed', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_QUESTIONS], surfaces: ['mobile'], picks: [undefined, undefined] })
  mock.clock(on, { now: NOW })
  const entered = await $.prompt.submit(fromPhone(PROMPT))
  expect(entered).toMatchObject({ text: PROMPT })
  expect(w.completions.filter(one => one.model === 'sonnet')).toHaveLength(0)
})

test('a headless run with nothing attached is never held, read or asked', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_QUESTIONS], surfaces: [] })
  mock.clock(on, { now: NOW })
  const entered = await $.prompt.submit(typed(PROMPT))
  expect(entered).toMatchObject({ text: PROMPT })
  expect(w.opened).toHaveLength(0)
  // The chooser may still classify it; the upgrader never reads it.
  expect(w.completions.filter(one => one.system.startsWith('You triage'))).toHaveLength(0)
  expect(w.asked).toHaveLength(0)
})

test('when nothing can be copied, "New conversation" runs the prompt here instead of dropping it', async ($, on) => {
  const w = world(on, { messages: HISTORY, tokens: 90_000, model: 'claude-sonnet-5-5', copies: false, picks: ['New conversation (with recap)'] })
  mock.clock(on, { now: NOW })
  await $.turn.complete(DONE)
  const prompt = '!! The upload still fails intermittently after the retry change; find the root cause and fix it properly'
  const entered = await $.prompt.submit(typed(prompt))
  expect(w.asked[0]?.options.at(-1)).toBe('New conversation (with recap)')
  expect(entered).toMatchObject({ text: prompt.slice(3) })
  expect(w.submitted).toHaveLength(1)
  expect(w.toasts.at(-1)).toBe("Couldn't reach the clipboard: nothing was copied. Running your prompt here instead.")
})

test('cancelling where neither the box nor the clipboard takes it leaves the prompt in the conversation', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_QUESTIONS], hasBox: false, copies: false })
  mock.clock(on, { now: NOW })
  await $.prompt.submit(typed(PROMPT))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'cancel' })
  await ui.unmount()
  expect(w.logs.at(-1)).toBe(`Prompt upgrader: your prompt, not sent:\n${PROMPT}`)
  expect(w.toasts.at(-1)).toBe('Upgrade cancelled: your prompt is in the conversation, to copy.')
})

test('"Edit in box" with no box and no clipboard keeps the panel open with the prompt to select', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_QUESTIONS], sonnet: [REWRITE], hasBox: false, copies: false })
  mock.clock(on, { now: NOW })
  await $.prompt.submit(typed(PROMPT))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'improve' })
  await ui.press({ key: 'edit' })
  expect(w.closed).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: "Couldn't reach the box or the clipboard: select the prompt above to copy it." })).toBeDefined()
  await ui.unmount()
})
