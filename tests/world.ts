import type { On, RenderSurface, SessionMessage } from 'claude-code'

export const PANE = {
  plugin: 'prompt-pilot',
  component: 'Pane',
  requestId: 'prompt-upgrader',
  props: {
    title: '✨ Prompt upgrader',
    isFocused: true,
    bodyColumns: 64,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

export const BAND = {
  plugin: 'prompt-pilot',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 90,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

export const USAGE = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

export type Asked = { question: string; header: string; options: string[] }

/** One question as a dialog showed it, with each option's line. */
export type DialogQuestion = { question: string; header: string; options: string[]; descriptions: string[] }

export type Setup = {
  /** The conversation so far. */
  messages?: SessionMessage[]
  /** Tokens the last response was answered over. */
  tokens?: number
  /** The session's own model. */
  model?: string
  /** Haiku's replies, in order (reads and classifications). */
  haiku?: string[]
  /** Sonnet's replies, in order (rewrites). */
  sonnet?: string[]
  /** What the person picks in each dialog, in order; a list answers a dialog of several questions; undefined = dismissed. */
  picks?: (string | readonly string[] | undefined)[]
  /** The surfaces attached (default: the desktop app); [] is a headless run. */
  surfaces?: RenderSurface[]
  /** False: no clipboard takes text (a phone, a cloud session). */
  copies?: boolean
  /** The repository's root (default: none, so the session's folder names the project). */
  repoRoot?: string
  /** False: the panel cannot be placed (a bare -p run). */
  placesPanes?: boolean
  /** False: the prompt box takes nothing (a headless host). */
  hasBox?: boolean
  /** The 5-hour window's reading, in percent (none when absent). */
  fiveHour?: number
}

export const HISTORY: SessionMessage[] = [
  { role: 'user', text: 'Set up the scanner module', toolUses: [] },
  { role: 'assistant', text: 'Done: the scanner module is in src/scanner.', toolUses: [] },
]

/** The engine beneath the mod: the session, the models, the dialog, the panel, the box and the clipboard. */
export const world = (on: On, setup: Setup = {}) => {
  // The engine's own band beneath the mod's, which keeps it drawn.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: { key: 'engine-band' }, children: [] }))
  const haiku = [...(setup.haiku ?? [])]
  const sonnet = [...(setup.sonnet ?? [])]
  const picks = [...(setup.picks ?? [])]
  const asked: Asked[] = []
  /** Every dialog, each with all of its questions. */
  const dialogs: DialogQuestion[][] = []
  const submitted: { text: string; origin: string; asUser: boolean }[] = []
  const completions: { model: string; system: string; prompt: string }[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const copied: string[] = []
  const filled: string[] = []
  const opened: string[] = []
  const closed: string[] = []
  const steps: { model: string; effort: unknown }[] = []
  const stored: Record<string, unknown> = {}
  const logs: string[] = []

  on('store.get', ($, e) => ({ value: stored[e.key] }))
  on('store.set', ($, e) => {
    stored[e.key] = e.value

    return { value: undefined }
  })
  on('session.messages', () => ({ value: setup.messages ?? [] }))
  const window = { fiveHour: setup.fiveHour }
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: setup.tokens ?? 0, window: 200_000 },
      rateLimits: window.fiveHour === undefined ? [] : [{ kind: 'five_hour', percentUsed: window.fiveHour }],
    },
  }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.model', () => ({ value: setup.model ?? 'claude-opus-5-5' }))
  on('session.root', () => ({ value: '/work/app' }))
  on('fs.read', ($, e) => ({ value: e.path === '/work/app/CLAUDE.md' ? '# App\nTests live in tests/. Never touch vendor/.' : '' }))
  on('model.complete', ($, e) => {
    completions.push({ model: e.model, system: e.system ?? '', prompt: e.prompt })
    const text = (e.model === 'sonnet' ? sonnet : haiku).shift()

    return { value: text === undefined ? { isAnswered: false, reason: 'empty-reply', usage: USAGE } : { isAnswered: true, text, usage: USAGE } }
  })
  on('model.fork', () => ({ value: { isAnswered: true, text: 'Goal: scanner caching. Done: src/scanner/cache.ts.', usage: USAGE } }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const [question] = e.questions
    if (question) asked.push({ question: question.question, header: question.header, options: question.options.map(one => one.label) })
    dialogs.push(
      e.questions.map(one => ({ question: one.question, header: one.header, options: one.options.map(option => option.label), descriptions: one.options.map(option => option.description ?? '') })),
    )
    const reply = picks.shift()
    const replies = typeof reply === 'string' ? [reply] : (reply ?? [])
    const answers = Object.fromEntries(e.questions.flatMap((one, index) => (replies[index] === undefined ? [] : [[one.question, replies[index]]])))

    return { result: { questions: e.questions, answers } }
  })
  on('session.surfaces', () => ({ value: setup.surfaces ?? ['desktop'] }))
  on('session.repo', () => ({ value: setup.repoRoot ? { root: setup.repoRoot, remote: null, internal: false, name: null } : null }))
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, origin: e.origin.kind, asUser: e.origin.kind === 'plugin' && e.origin.asUser === true })

    return { text: e.text }
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: setup.placesPanes === false ? { isPlaced: false, reason: 'no surface places panes' } : { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    closed.push(e.id)

    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    if (setup.hasBox === false) return { isFilled: false, refusal: 'no_composer' as const }
    filled.push(e.text)

    return { isFilled: true }
  })
  on('ui.copy', ($, e) => {
    if (setup.copies === false) return { value: { isCopied: false, reason: 'no-clipboard' as const } }
    copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)

    return { value: undefined }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.step', async function* ($, e) {
    steps.push({ model: e.model, effort: e.effort })

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })

  return { window, logs, asked, dialogs, submitted, completions, toasts, statuses, copied, filled, opened, closed, steps, stored }
}

/** A typed prompt, as the person's Enter raises it. */
export const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

/** One main-thread model request, read to its end. */
export const step = async (stream: AsyncGenerator<unknown, unknown> & { result: Promise<unknown> }) => {
  for await (const chunk of stream) void chunk

  return stream.result
}

export const READ_WITH_QUESTIONS = JSON.stringify({
  clear: false,
  intent: 'cache scan results',
  model: 'opus',
  effort: 'high',
  reason: 'multi-file feature',
  questions: [
    { topic: 'Scope', question: 'What should the cache cover?', options: ['Scan results only', 'All API calls', 'Images too'], recommended: 0 },
    { topic: 'Done when', question: 'How will you check it works?', options: ['Unit tests pass', 'Faster second scan'], recommended: 1 },
  ],
})

export const READ_CLEAR = JSON.stringify({ clear: true, intent: 'rename a helper', model: 'sonnet', effort: 'high', reason: 'routine edit', questions: [] })

export const REWRITE = `<prompt>
Cache scan results so a second scan of the same page skips the API call.
- Scope: scan results only; leave image uploads alone.
- Done when: a second scan of the same page is faster and makes no API call.
</prompt>
PICK: opus xhigh | multi-file feature`

/** A read with more questions than the old cap of three. */
export const READ_WITH_SIX_QUESTIONS = JSON.stringify({
  clear: false,
  intent: 'redesign onboarding',
  model: 'opus',
  effort: 'high',
  reason: 'multi-file feature',
  questions: ['Audience', 'Steps', 'Skip', 'Tone', 'Platforms', 'Done when'].map((topic, n) => ({
    topic,
    question: `Question ${n + 1} about ${topic.toLowerCase()}?`,
    options: [`Option ${n + 1}a`, `Option ${n + 1}b`],
    recommended: 0,
  })),
})
