import { expect, mock, test } from 'claude-code/testing'

import { PANE, READ_WITH_QUESTIONS, REWRITE, typed, world } from './world'

const NOW = new Date(2026, 9, 26, 15, 0).getTime()
const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }
const PROMPT = 'Add a cache to the scanner so we stop paying for repeated scans of the same page'

test('answers given in the panel are kept for this project on this machine, and come back next time', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_QUESTIONS, READ_WITH_QUESTIONS], sonnet: [REWRITE], repoRoot: '/work/app' })
  mock.clock(on, { now: NOW })
  await $.prompt.submit(typed(PROMPT))
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'opt:q1:2' })
  await ui.press({ key: 'improve' })
  await ui.press({ key: 'launch' })
  await ui.unmount()
  // Only the answer the person chose is kept: the untouched default of q2 is not.
  expect(w.stored['answers:/work/app']).toEqual([{ topic: 'Scope', question: 'What should the cache cover?', answer: 'Images too', at: NOW }])

  await $.prompt.submit(typed(`${PROMPT}, and log the hit rate`))
  expect(JSON.stringify(w.completions[2]?.prompt)).toContain('Decisions the developer already made in this project')
  expect(JSON.stringify(w.completions[2]?.prompt)).toContain('Scope: What should the cache cover? → Images too')
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'opt:q1:2' }))?.text).toBe('● Images too')
  expect(await ui.find({ type: 'Text', text: '↺ Your earlier answer in this project' })).toBeDefined()
  await ui.unmount()
})

test('each project keeps its own answers, and /upgrader forget clears this one', async ($, on) => {
  const w = world(on, { haiku: [READ_WITH_QUESTIONS], sonnet: [REWRITE] })
  mock.clock(on, { now: NOW })
  w.stored['answers:/work/other'] = [{ topic: 'Scope', question: 'What should the cache cover?', answer: 'All API calls', at: NOW - 1000 }]
  await $.prompt.submit(typed(PROMPT))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Without a repository the session's folder (/work/app) names the project: the other project's answer stays out.
  expect((await ui.find({ key: 'opt:q1:0' }))?.text).toBe('● Scan results only')
  await ui.input({ key: 'own:q2', text: 'Second scan under 1 s', kind: 'change' })
  await ui.press({ key: 'improve' })
  await ui.unmount()
  expect(w.stored['answers:/work/app']).toEqual([{ topic: 'Done when', question: 'How will you check it works?', answer: 'Second scan under 1 s', at: NOW }])

  const said = await $.command.run({ command: 'upgrader', args: 'forget', ...COMMAND })
  expect(said).toMatchObject({ text: 'Prompt upgrader: forgot the answer kept for this project.' })
  expect(w.stored['answers:/work/app']).toEqual([])
  expect(w.stored['answers:/work/other']).toHaveLength(1)
})
