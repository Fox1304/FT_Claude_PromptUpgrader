import { expect, mock, test } from 'claude-code/testing'

import { PANE, READ_CLEAR, READ_WITH_QUESTIONS, READ_WITH_SIX_QUESTIONS, REWRITE, step, typed, world } from './world'

const NOW = new Date(2026, 9, 12, 15, 0).getTime()
const STEP = { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high' as const, messageCount: 3 }
const PROMPT = 'Add a cache to the scanner so we stop paying for repeated scans of the same page'
const IMPROVED = `Cache scan results so a second scan of the same page skips the API call.
- Scope: scan results only; leave image uploads alone.
- Done when: a second scan of the same page is faster and makes no API call.`

test('a substantial prompt waits while its panel asks the questions that matter', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_QUESTIONS] })
  mock.clock(on, { now: NOW })
  const answer = await $.prompt.submit(typed(PROMPT))
  expect(answer).toEqual({ drop: '✨ Prompt upgrader: answer in its panel, then Launch (or Send as is).' })
  expect(w.submitted).toHaveLength(0)
  expect(w.opened).toEqual(['prompt-upgrader'])
  expect(w.completions[0]?.model).toBe('haiku')
  expect(JSON.stringify(w.completions[0]?.prompt)).toContain('Never touch vendor/.')

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Step 1 of 2 · 2 questions' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Your prompt · cache scan results' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'What should the cache cover?' })).toBeDefined()
    expect((await ui.find({ key: 'opt:q1:0' }))?.text).toBe('● Scan results only')
    expect((await ui.find({ key: 'opt:q1:1' }))?.text).toBe('○ All API calls')
    expect((await ui.find({ key: 'opt:q2:1' }))?.text).toBe('● Faster second scan')
    expect((await ui.find({ key: 'own:q1' }))?.props.placeholder).toBe('Or type your own answer…')
    expect((await ui.find({ key: 'improve' }))?.props.label).toBe('✨ Improve prompt')
    expect(await ui.find({ type: 'Text', text: '◆ Opus · High' })).toBeDefined()
    await ui.unmount()
  }
  // The phone has no text fields: choices only.
  const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await phone.find({ key: 'own:q1' })).toBeUndefined()
  expect(await phone.find({ key: 'opt:q1:2' })).toBeDefined()
  await phone.unmount()
})

test('answers, own words and a model change go into the improved prompt, which launches on that model', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_QUESTIONS], sonnet: [REWRITE] })
  mock.clock(on, { now: NOW })
  await $.prompt.submit(typed(PROMPT))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'opt:q1:1' })
  expect((await ui.find({ key: 'opt:q1:1' }))?.text).toBe('● All API calls')
  await ui.input({ key: 'own:q2', text: 'Second scan under 1 s', kind: 'change' })
  await ui.input({ key: 'extra-input', text: 'Keep the cache in memory only', kind: 'change' })
  await ui.press({ key: 'improve' })

  const rewrite = w.completions[1]
  expect(rewrite?.model).toBe('sonnet')
  expect(rewrite?.system).toContain('Opus plans well on its own')
  expect(JSON.stringify(rewrite?.prompt)).toContain('What should the cache cover? → All API calls')
  expect(JSON.stringify(rewrite?.prompt)).toContain('How will you check it works? → Second scan under 1 s')
  expect(JSON.stringify(rewrite?.prompt)).toContain('Also: Keep the cache in memory only')

  expect(await ui.find({ type: 'Text', text: 'Step 2 of 2 · Ready' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✓ Improved prompt' })).toBeDefined()
  expect((await ui.find({ key: 'improved-text' }))?.props.text).toBe(IMPROVED)
  expect((await ui.find({ key: 'launch' }))?.props.label).toBe('▶ Launch on Opus · Extra')
  await ui.press({ key: 'model:sonnet' })
  expect((await ui.find({ key: 'launch' }))?.props.label).toBe('▶ Launch on Sonnet · Extra')
  expect((await ui.find({ key: 'model:sonnet' }))?.text).toBe('● Sonnet')

  await ui.press({ key: 'launch' })
  expect(w.submitted).toEqual([{ text: IMPROVED, origin: 'plugin', asUser: true }])
  expect(w.closed).toContain('prompt-upgrader')
  expect(w.asked).toHaveLength(0)
  await step($.turn.step(STEP))
  expect(w.steps.at(-1)).toEqual({ model: 'claude-sonnet-5-5', effort: 'xhigh' })
  await ui.unmount()
})

test('copy keeps the panel open; edit hands the prompt to the box and its next send runs unasked', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_QUESTIONS], sonnet: [REWRITE] })
  mock.clock(on, { now: NOW })
  await $.prompt.submit(typed(PROMPT))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'improve' })
  await ui.press({ key: 'copy' })
  expect(w.copied).toEqual([IMPROVED])
  expect(await ui.find({ type: 'Text', text: '✓ Copied: paste it into any session.' })).toBeDefined()

  await ui.press({ key: 'edit' })
  expect(w.filled).toEqual([IMPROVED])
  expect(w.toasts.at(-1)).toBe('The improved prompt is in the box: edit it, then press Enter.')
  await ui.unmount()

  await $.prompt.submit(typed(`${IMPROVED}\n- Also log cache hits.`))
  expect(w.completions).toHaveLength(2)
  expect(w.asked).toHaveLength(0)
  expect(w.submitted.at(-1)?.text).toContain('Also log cache hits.')
  await step($.turn.step(STEP))
  expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' })
})

test('a requested change rewrites it, and can be taken back', async ($, on) => {
  const shorter = '<prompt>\nCache scan results; second scan of a page makes no API call.\n</prompt>\nPICK: opus high | small feature'
  const w = world(on, { haiku: [READ_WITH_QUESTIONS], sonnet: [REWRITE, shorter] })
  mock.clock(on, { now: NOW })
  await $.prompt.submit(typed(PROMPT))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'improve' })
  await ui.input({ key: 'tweak-input', text: 'shorter' })
  expect(JSON.stringify(w.completions[2]?.prompt)).toContain('Apply this change to it: shorter')
  expect((await ui.find({ key: 'improved-text' }))?.props.text).toBe('Cache scan results; second scan of a page makes no API call.')
  await ui.press({ key: 'undo' })
  expect((await ui.find({ key: 'improved-text' }))?.props.text).toBe(IMPROVED)
  expect(await ui.find({ key: 'undo' })).toBeUndefined()
  await ui.unmount()
})

test('a failed rewrite says why and offers to try again or send the prompt as is', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_QUESTIONS], sonnet: ['Sorry, here it is: Cache the scans.'] })
  mock.clock(on, { now: NOW })
  await $.prompt.submit(typed(PROMPT))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'improve' })
  expect(await ui.find({ type: 'Text', text: "⚠ Couldn't write the improved prompt: the answer came back in an unexpected shape." })).toBeDefined()
  await ui.press({ key: 'retry' })
  expect(await ui.find({ type: 'Text', text: "⚠ Couldn't write the improved prompt: the model sent back nothing." })).toBeDefined()
  await ui.press({ key: 'as-is' })
  expect(w.submitted).toEqual([{ text: PROMPT, origin: 'plugin', asUser: true }])
  await ui.unmount()
})

test('cancelling puts the prompt back in the box, or on the clipboard where there is no box', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_QUESTIONS, READ_WITH_QUESTIONS], hasBox: false })
  mock.clock(on, { now: NOW })
  await $.prompt.submit(typed(PROMPT))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'cancel' })
  await ui.unmount()
  expect(w.closed).toContain('prompt-upgrader')
  expect(w.copied).toEqual([PROMPT])
  expect(w.toasts.at(-1)).toBe('Upgrade cancelled: your prompt is on the clipboard.')
  expect(w.submitted).toHaveLength(0)
})

test('a clear prompt skips the panel and the confirm says so; short prompts are never read', async ($, on) => {
  const w = world(on, { haiku: [READ_CLEAR], picks: [undefined] })
  mock.clock(on, { now: NOW })
  const entered = await $.prompt.submit(typed('Rename the helper getUser to fetchUser everywhere in src and update the imports'))
  expect(entered).toMatchObject({ text: 'Rename the helper getUser to fetchUser everywhere in src and update the imports' })
  expect(w.opened).toHaveLength(0)
  expect(w.asked[0]).toEqual({ question: '✓ Your prompt is clear. Routine edit: run it on Sonnet · High?', header: 'Model', options: ['Sonnet · High (recommended)', 'Sonnet · Extra (stronger)', 'Sonnet · Medium (lighter)'] })

  await $.prompt.submit(typed('now run the tests'))
  expect(w.completions).toHaveLength(1)
})

test('?? asks for the panel on a short prompt; a session that places no panes just goes on', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_QUESTIONS, READ_WITH_QUESTIONS], placesPanes: false, picks: [undefined] })
  mock.clock(on, { now: NOW })
  const entered = await $.prompt.submit(typed('?? add caching'))
  expect(w.opened).toEqual(['prompt-upgrader'])
  expect(entered).toMatchObject({ text: 'add caching' })
  // No panel: the questions go to the dialog (dismissed here), then the model confirm.
  expect(w.asked[0]?.question).toBe('What should the cache cover?')
  expect(w.asked).toHaveLength(2)
})

test('the panel asks more than three questions, three at a time, and every answer asked reaches the rewrite', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_SIX_QUESTIONS], sonnet: [REWRITE] })
  mock.clock(on, { now: NOW })
  await $.prompt.submit(typed('Redesign the onboarding so new parents reach their first scan faster and drop off less often'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Step 1 of 2 · Questions 1–3 of 6' })).toBeDefined()
  for (const n of [1, 2, 3]) expect(await ui.find({ key: `opt:q${n}:0` })).toBeDefined()
  expect(await ui.find({ key: 'opt:q4:0' })).toBeUndefined()
  expect(await ui.find({ key: 'back' })).toBeUndefined()
  expect((await ui.find({ key: 'more' }))?.props.label).toBe('Next 3 questions →')

  await ui.press({ key: 'more' })
  expect(await ui.find({ type: 'Text', text: 'Step 1 of 2 · Questions 4–6 of 6' })).toBeDefined()
  expect(await ui.find({ key: 'opt:q1:0' })).toBeUndefined()
  for (const n of [4, 5, 6]) expect(await ui.find({ key: `opt:q${n}:0` })).toBeDefined()
  expect(await ui.find({ key: 'more' })).toBeUndefined()
  expect((await ui.find({ key: 'improve' }))?.props.label).toBe('✨ Improve prompt')
  await ui.press({ key: 'back' })
  await ui.press({ key: 'opt:q2:1' })
  await ui.press({ key: 'more' })
  await ui.press({ key: 'opt:q6:1' })
  await ui.press({ key: 'improve' })
  const sent = JSON.stringify(w.completions[1]?.prompt)
  expect(sent).toContain('Question 2 about steps? → Option 2b')
  expect(sent).toContain('Question 4 about tone? → Option 4a')
  expect(sent).toContain('Question 6 about done when? → Option 6b')
  await ui.unmount()
})

test('improving after the first three sends only the questions asked so far', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_SIX_QUESTIONS], sonnet: [REWRITE] })
  mock.clock(on, { now: NOW })
  await $.prompt.submit(typed('Redesign the onboarding so new parents reach their first scan faster and drop off less often'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'improve' }))?.props.label).toBe('✨ Improve now')
  await ui.press({ key: 'improve' })
  const sent = JSON.stringify(w.completions[1]?.prompt)
  expect(sent).toContain('Question 3 about skip?')
  expect(sent).not.toContain('Question 4 about tone?')
  await ui.unmount()
})
