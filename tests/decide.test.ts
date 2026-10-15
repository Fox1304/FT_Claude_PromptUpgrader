import { expect, test } from 'claude-code/testing'

import {
  costText,
  estimateTurn,
  isContinuation,
  isTrusted,
  keepIfTooLong,
  keepStronger,
  kindOf,
  label,
  neighbours,
  parsePickWords,
  parseRead,
  parseRewrite,
  parseTags,
  recordAnswer,
  recordTurnCost,
  rulePick,
  switchCost,
} from '../hooks/decide'
import type { Pick } from '../types'
import { READ_WITH_QUESTIONS, REWRITE } from './world'

const OPUS_HIGH: Pick = { model: 'opus', effort: 'high', reason: 'general task', by: 'rules' }
const HOUR = 60 * 60_000

test('tags at either end are read and stripped; words inside the prompt are left alone', async () => {
  expect(parseTags('!! fix the login !opus')).toMatchObject({ text: 'fix the login', skipUpgrade: true, model: 'opus' })
  expect(parseTags('?? add caching')).toMatchObject({ text: 'add caching', forceUpgrade: true })
  expect(parseTags('!sonnet !max refactor the parser')).toMatchObject({ text: 'refactor the parser', model: 'sonnet', effort: 'max' })
  expect(parseTags('why does !! print twice?')).toMatchObject({ text: 'why does !! print twice?', skipUpgrade: false })
  expect(parseTags('!!').text).toBe('!!')
  expect(parseTags('!! line one\nline two').text).toBe('line one\nline two')
})

test('replies keep what runs, short prompts are only confirmed on change, long ones are tasks', async () => {
  expect(kindOf('yes', '')).toBe('ack')
  expect(kindOf('vas-y', '')).toBe('ack')
  expect(kindOf('2', 'Which one do you prefer?')).toBe('ack')
  expect(kindOf('fix the typo in the README', '')).toBe('short')
  expect(kindOf('Use the second option but keep the old flag working for one more release please', 'Option 1 or 2?')).toBe('short')
  expect(kindOf('Add a cache to the scanner so we stop paying for repeated scans of the same page', '')).toBe('substantial')
})

test('the rules: trivial on Haiku, routine on Sonnet, real work on Opus, hard problems at Max', async () => {
  expect(rulePick('thanks!', false).pick).toMatchObject({ model: 'haiku', effort: 'medium' })
  expect(rulePick('rename getUser to fetchUser in api.ts', false)).toMatchObject({ pick: { model: 'sonnet', effort: 'medium' }, isConfident: true })
  expect(rulePick('refactor the scanner into smaller modules and keep behaviour identical', false)).toMatchObject({ pick: { model: 'opus', effort: 'high' }, isConfident: true })
  expect(rulePick('debug why the upload fails with a 500 error on large files', false).pick).toMatchObject({ model: 'opus', effort: 'xhigh' })
  expect(rulePick('the upload still fails after the retry change, find the root cause', false).pick).toMatchObject({ model: 'opus', effort: 'max' })
  expect(rulePick('la page plante toujours au deuxième scan, trouve la cause racine et corrige', false).pick).toMatchObject({ model: 'opus', effort: 'max' })
  expect(rulePick('make the onboarding nicer', false)).toMatchObject({ pick: { model: 'opus', effort: 'high' }, isConfident: false })
})

test('the confirm dialog offers the rungs next to the pick', async () => {
  expect(neighbours({ model: 'opus', effort: 'high' })).toEqual({ up: { model: 'opus', effort: 'xhigh' }, down: { model: 'sonnet', effort: 'xhigh' } })
  expect(neighbours({ model: 'opus', effort: 'max' }).up).toBeUndefined()
  expect(neighbours({ model: 'haiku', effort: 'medium' }).down).toBeUndefined()
  expect(label({ model: 'opus', effort: 'xhigh' })).toBe('Opus · Extra')
  expect(parsePickWords('sonnet max', OPUS_HIGH)).toEqual({ model: 'sonnet', effort: 'max' })
  expect(parsePickWords('Extra', OPUS_HIGH)).toEqual({ model: 'opus', effort: 'xhigh' })
  expect(parsePickWords('whatever you think', OPUS_HIGH)).toBeUndefined()
})

test('switching cost: short conversations and cold caches are cheap; a warm cache makes it costly', async () => {
  const now = 10 * HOUR
  expect(switchCost({ model: 'opus' }, { model: 'opus' }, 90_000, {}, now, HOUR).kind).toBe('none')
  expect(switchCost({ model: 'opus' }, null, 90_000, {}, now, HOUR).kind).toBe('none')
  expect(switchCost({ model: 'opus' }, { model: 'sonnet' }, 8_000, {}, now, HOUR).kind).toBe('cheap')
  expect(switchCost({ model: 'opus' }, { model: 'sonnet' }, 90_000, { sonnet: now - 2 * HOUR }, now, HOUR).short).toBe("Sonnet's cache is cold: switching costs nothing extra")
  expect(switchCost({ model: 'opus' }, { model: 'sonnet' }, 90_000, { opus: now - 5 * 60_000, sonnet: now }, now, HOUR).short).toBe("Opus's cache is still warm: switching costs little")
  const costly = switchCost({ model: 'opus' }, { model: 'sonnet' }, 90_000, { sonnet: now - 60_000 }, now, HOUR)
  expect(costly).toMatchObject({ kind: 'costly', short: 'Re-reads 90k tokens on Opus, without the cache' })
})

test('mid-conversation, a costly step down keeps the stronger model at Medium; a step up is left to the person', async () => {
  const routine: Pick = { model: 'sonnet', effort: 'high', reason: 'routine request', by: 'rules' }
  const costly = { kind: 'costly' as const, note: '', short: '', tokens: '' }
  expect(keepStronger(routine, { model: 'opus', effort: 'high' }, costly)).toMatchObject({ model: 'opus', effort: 'medium', by: 'kept' })
  expect(keepStronger(routine, { model: 'opus', effort: 'high' }, { kind: 'cheap', note: '', short: '', tokens: '' })).toBe(routine)
  expect(keepStronger(OPUS_HIGH, { model: 'sonnet', effort: 'high' }, costly)).toBe(OPUS_HIGH)
})

test("the models' answers are read defensively", async () => {
  const read = parseRead(READ_WITH_QUESTIONS, OPUS_HIGH, 3)
  expect(read).toMatchObject({ isClear: false, intent: 'cache scan results', pick: { model: 'opus', effort: 'high', by: 'haiku' } })
  expect(read?.questions.map(one => one.id)).toEqual(['q1', 'q2'])
  expect(parseRead('{"clear":false,"questions":[{"question":"Which?","options":["one"]}],"model":"gpt","effort":"low"}', OPUS_HIGH, 3)).toMatchObject({
    isClear: true,
    questions: [],
    pick: { model: 'opus', effort: 'medium' },
  })
  expect(parseRead('no json here', OPUS_HIGH, 3)).toBeUndefined()
  expect(parseRewrite(REWRITE, OPUS_HIGH)).toMatchObject({ pick: { model: 'opus', effort: 'xhigh', reason: 'multi-file feature', by: 'upgrader' } })
  expect(parseRewrite(REWRITE, OPUS_HIGH)?.prompt).toStartWith('Cache scan results')
  expect(parseRewrite('<prompt></prompt>', OPUS_HIGH)).toBeUndefined()
})

test('a conversation too long for another window keeps its model', async () => {
  expect(keepIfTooLong(OPUS_HIGH, { model: 'sonnet' }, 170_000)).toMatchObject({ model: 'sonnet', effort: 'high', by: 'kept' })
  expect(keepIfTooLong(OPUS_HIGH, { model: 'sonnet' }, 90_000)).toBe(OPUS_HIGH)
  expect(keepIfTooLong(OPUS_HIGH, null, 170_000)).toBe(OPUS_HIGH)
})

test('trust is counted per kind of task and resets on any other choice', async () => {
  let trust = {}
  for (let n = 0; n < 4; n++) trust = recordAnswer(trust, 'routine request', true, n)
  expect(isTrusted(trust, 'routine request')).toBe(false)
  trust = recordAnswer(trust, 'routine request', true, 5)
  expect(isTrusted(trust, 'routine request')).toBe(true)
  expect(isTrusted(recordAnswer(trust, 'routine request', false, 6), 'routine request')).toBe(false)
  expect(isTrusted(trust, 'engineering task')).toBe(false)
})

test('turn costs: a moving average per level, scaled to levels not yet seen', async () => {
  let costs = recordTurnCost({}, 'sonnet:high', 1)
  expect(estimateTurn(costs, { model: 'sonnet', effort: 'high' })).toBeUndefined()
  costs = recordTurnCost(costs, 'sonnet:high', 1)
  expect(estimateTurn(costs, { model: 'sonnet', effort: 'high' })).toBe(1)
  expect(Math.round((estimateTurn(costs, { model: 'opus', effort: 'max' }) ?? 0) * 100)).toBe(333)
  expect(recordTurnCost(costs, 'sonnet:high', -40)).toBe(costs)
  expect(costText(undefined)).toBe('')
  expect(costText(0.4)).toBe('<1%')
  expect(costText(3.4)).toBe('≈3%')
})

test('calibrated on real prompts: go-aheads and status replies keep what runs', async () => {
  for (const reply of [
    'Please continue',
    'Work on 1, 2, 3, 4',
    'Ok with A through E.',
    'Both.',
    'Keep Brevo',
    'App has been published',
    'Chrome is reconnected',
    "vas y, mets à jour, et commit/push/merge ensuite",
    'can we resume on this ?',
  ])
    expect(isContinuation(reply, '')).toBe(true)
  expect(isContinuation('Files are in ~/Documents/Sample Manga', 'Where are the files?')).toBe(true)
  for (const task of ['Commit push merge, then produce a new testflight build.', 'How can we improve these two mods ?', 'Should we use resend instead of Brevo ?'])
    expect(isContinuation(task, '')).toBe(false)
})

test('calibrated on real prompts: shipping, planning, checks and long engineering prompts', async () => {
  expect(rulePick('Commit push merge, then produce a new testflight build.', false)).toMatchObject({ pick: { model: 'opus', effort: 'high' }, isConfident: true })
  expect(rulePick('How can we improve these two mods ?', false)).toMatchObject({ pick: { model: 'opus', effort: 'high' }, isConfident: true })
  expect(rulePick('Can you apply the migration & deploy yourself ?', false).pick).toMatchObject({ model: 'sonnet', effort: 'high' })
  expect(rulePick('is everything commited ?', false)).toMatchObject({ pick: { model: 'sonnet', effort: 'medium' }, isConfident: true })
  expect(rulePick('is the task still running ?', false).pick).toMatchObject({ model: 'haiku', effort: 'medium' })
  expect(rulePick('Should we use resend instead of Brevo ?', false).isConfident).toBe(false)
  const long = `The redeem of codes fails on Android ${'when a parent enters a code from the email and taps confirm on the settings screen '.repeat(3)}`
  expect(rulePick(long, false).pick).toMatchObject({ model: 'opus', effort: 'xhigh', reason: 'detailed engineering task' })
})
