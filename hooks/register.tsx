import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, RenderSurface } from 'claude-code'

import type { Effort, ModelName, Pick, SwitchCost, TrustEntry, TurnCost, Upgrade, UpgradeQuestion, UsageWindow } from '../types'
import {
  EFFORTS,
  EFFORT_LABEL,
  TRUST_AFTER,
  MODELS,
  MODEL_LABEL,
  answersText,
  costKey,
  costText,
  estimateTurn,
  isContinuation,
  isTrusted,
  keepIfTooLong,
  keepStronger,
  kindKey,
  kindOf,
  label,
  meter,
  neighbours,
  parseClassify,
  parsePickWords,
  parseRead,
  parseRewrite,
  parseTags,
  recordAnswer,
  recordTurnCost,
  rulePick,
  samePick,
  switchCost,
  tierOf,
  wordCount,
} from './decide'
import type { Read } from './decide'
import { CLASSIFY_SYSTEM, READ_SYSTEM, RECAP_PROMPT, REWRITE_SYSTEM } from './prompts'

const PLUGIN = 'prompt-pilot'
const PANE = 'prompt-upgrader'
const PANE_TITLE = '✨ Prompt upgrader'
const MAX_QUESTIONS = 3
const READ_TIMEOUT_MS = 10_000
const CLASSIFY_TIMEOUT_MS = 6_000
const WRITE_TIMEOUT_MS = 60_000
const HANDOFF_MS = 15 * 60_000
const RULES_CHARS = 2_500

const active = atom({ plugin: 'prompt-pilot', key: 'active' } as const, null)
const upgrade = atom({ plugin: 'prompt-pilot', key: 'upgrade' } as const, null)
const busy = atom({ plugin: 'prompt-pilot', key: 'busy' } as const, '')
const usage = atom({ plugin: 'prompt-pilot', key: 'usage' } as const, [])
const cache = atom({ plugin: 'prompt-pilot', key: 'cache' } as const, {})
const handoff = atom({ plugin: 'prompt-pilot', key: 'handoff' } as const, null)
const turnStart = atom({ plugin: 'prompt-pilot', key: 'turnStart' } as const, null)
const chooserOn = atom({ plugin: 'prompt-pilot', key: 'chooserOn' } as const, true)
const upgraderOn = atom({ plugin: 'prompt-pilot', key: 'upgraderOn' } as const, true)

/** Model ids, cache lifetime and warning level, from the mod's settings. */
const config = {
  ids: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-4-5-20251001' } as Record<ModelName, string>,
  cacheMs: 60 * 60_000,
  warnAt: 80,
}

const MODEL_COLOR: Record<ModelName, string> = { opus: 'claude', sonnet: 'suggestion', haiku: 'success' }

/** Prompts that come from elsewhere than the person (notifications, peers, other plugins) run on what runs now. */
const NOT_THE_PERSON = new Set<PromptOrigin['kind']>([
  'task-notification',
  'scheduled-trigger',
  'peer',
  'peer-send-message',
  'projects-relay',
  'channel',
  'coordinator',
  'observer',
  'observer-activity',
  'auto-continuation',
  'plugin',
  'slack-ping',
])

const cap = (text: string) => (text ? text[0]?.toUpperCase() + text.slice(1) : text)
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

// ── Reading the session ────────────────────────────────────────────────────

type Conversation = { lastUser: string; lastAssistant: string; hasHistory: boolean; contextTokens: number }

const conversation = async ($: EngineInterface): Promise<Conversation> => {
  const listed = await $.session.messages()
  const messages = Array.isArray(listed) ? listed : []
  const said = messages.filter(one => one.text.trim())
  const lastAssistant = [...said].reverse().find(one => one.role === 'assistant')?.text ?? ''
  const lastUser = [...said].reverse().find(one => one.role === 'user')?.text ?? ''
  const used = await $.session.usage()

  return { lastUser, lastAssistant, hasHistory: messages.some(one => one.role === 'assistant'), contextTokens: used.context.tokens ?? 0 }
}

/** What runs now: the last pick, else the session's own model (at High). */
const currentPick = async ($: EngineInterface): Promise<Pick> => {
  const pick = await read($, active)
  if (pick) return pick

  return { model: tierOf(await $.session.model()) ?? 'opus', effort: 'high', reason: 'session model', by: 'kept' }
}

const projectRules = async ($: EngineInterface) => {
  const root = await $.session.root()
  for (const name of ['CLAUDE.md', '.claude/CLAUDE.md']) {
    try {
      const text = await $.fs.read(`${root}/${name}`)
      if (text.trim()) return clip(text.trim(), RULES_CHARS)
    } catch {
      // no rules file there
    }
  }

  return ''
}

const setActive = async ($: EngineInterface, pick: Pick) => {
  await update($, active, () => pick)
  $.ui.status(`◆ ${label(pick)} · ${pick.reason}`)
}

const setBusy = async ($: EngineInterface, text: string) => {
  await update($, busy, () => text)
}

// ── The models' reads ──────────────────────────────────────────────────────

const contextBlock = (conv: Conversation) =>
  [conv.lastUser ? `Previous request: ${clip(conv.lastUser, 500)}` : '', conv.lastAssistant ? `Claude's last answer: ${clip(conv.lastAssistant, 900)}` : '']
    .filter(Boolean)
    .join('\n')

/** Haiku reads a substantial prompt: clear or not, the questions worth asking, and the pick. */
const readPrompt = async ($: EngineInterface, text: string, conv: Conversation, fallback: Pick): Promise<Read | undefined> => {
  const rules = await projectRules($)
  const reply = await $.model.complete({
    model: 'haiku',
    system: READ_SYSTEM(MAX_QUESTIONS),
    prompt: [
      { text: rules ? `Project rules (start of CLAUDE.md):\n${rules}` : 'This project has no rules file.', cache: true },
      { text: `${contextBlock(conv)}\n\nPrompt to triage:\n<<<\n${clip(text, 6000)}\n>>>` },
    ],
    maxTokens: 900,
    effort: 'low',
    timeoutMs: READ_TIMEOUT_MS,
  })
  if (!reply.isAnswered) {
    $.ui.log(`prompt-pilot: the read failed (${reply.reason})`, { to: 'debug' })

    return undefined
  }

  return parseRead(reply.text, fallback, MAX_QUESTIONS)
}

/** The chooser's pick: the rules when they are sure, else a quick Haiku read. */
const choosePick = async ($: EngineInterface, text: string, hasImages: boolean, conv: Conversation): Promise<Pick> => {
  const ruled = rulePick(text, hasImages)
  if (ruled.isConfident || wordCount(text) < 5) return ruled.pick
  await setBusy($, 'Choosing a model…')
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system: CLASSIFY_SYSTEM,
      prompt: `${contextBlock(conv)}\n\nPrompt:\n<<<\n${clip(text, 4000)}\n>>>`,
      maxTokens: 120,
      effort: 'low',
      timeoutMs: CLASSIFY_TIMEOUT_MS,
    })

    return (reply.isAnswered ? parseClassify(reply.text, ruled.pick) : undefined) ?? ruled.pick
  } finally {
    await setBusy($, '')
  }
}

// ── Asking the person ──────────────────────────────────────────────────────

/** One question in the engine's own dialog; the label chosen, the words typed under Other, or undefined when dismissed. */
const askOne = async ($: EngineInterface, question: string, header: string, options: string[]) => {
  try {
    const answer = await $.ui.ask(question, { options, header })

    return answer.trim() || undefined
  } catch (error) {
    $.ui.log(`prompt-pilot: the confirm dialog closed without an answer (${String(error)})`, { to: 'debug' })

    return undefined
  }
}

/** `agreed`: the plain confirm's answer kept the recommendation (true), chose otherwise (false), or said nothing (undefined). */
type Decision = { kind: 'run'; pick: Pick; agreed?: boolean } | { kind: 'new' }

/** A choice's label with what one turn on it usually costs: "Opus · High (recommended) · ≈3%". */
const priced = (text: string, pick: { model: ModelName; effort: Effort }, costs: Record<string, TurnCost>) => {
  const cost = costText(estimateTurn(costs, pick))

  return cost ? `${text} · ${cost}` : text
}

/** The confirm step: a plain confirm, or, when a model switch would re-read the conversation, three choices. */
const confirmPick = async (
  $: EngineInterface,
  pick: Pick,
  current: Pick | null,
  cost: SwitchCost,
  isClear: boolean,
  costs: Record<string, TurnCost>,
): Promise<Decision> => {
  const typed = (answer: string): Pick => {
    const words = parsePickWords(answer, pick)
    if (!words) $.ui.toast(`Didn't catch “${clip(answer, 30)}”: running on ${label(pick)}.`)

    return words ? { ...words, reason: pick.reason, by: 'you' } : pick
  }
  if (cost.kind === 'costly' && current) {
    const stay: Pick = { model: current.model, effort: pick.effort, reason: pick.reason, by: 'you' }
    const from = MODEL_LABEL[current.model]
    const question = `${label(pick)} fits this better (${pick.reason}), but switching from ${from} re-reads ${cost.tokens} tokens without the cache. Switch?`
    const options = [priced(`Switch to ${label(pick)}`, pick, costs), priced(`Stay on ${label(stay)} (cheapest)`, stay, costs), 'New conversation (with recap)']
    const answer = await askOne($, question, 'Switch model', options)
    if (answer === undefined || answer === options[0]) return { kind: 'run', pick: answer ? { ...pick, by: 'you' } : pick }
    if (answer === options[1]) return { kind: 'run', pick: stay }
    if (answer === options[2]) return { kind: 'new' }

    return { kind: 'run', pick: typed(answer) }
  }
  const { up, down } = neighbours(pick)
  const choices: { pick: { model: ModelName; effort: Effort }; text: string }[] = [{ pick, text: priced(`${label(pick)} (recommended)`, pick, costs) }]
  if (up) choices.push({ pick: up, text: priced(`${label(up)} (stronger)`, up, costs) })
  if (down) choices.push({ pick: down, text: priced(`${label(down)} (lighter)`, down, costs) })
  const notes = [isClear ? '✓ Your prompt is clear.' : '', cost.kind === 'cheap' ? `${cost.short}.` : ''].filter(Boolean).join(' ')
  const answer = await askOne($, `${notes ? `${notes} ` : ''}${cap(pick.reason)}: run it on ${label(pick)}?`, 'Model', choices.map(one => one.text))
  if (answer === undefined) return { kind: 'run', pick }
  const chosen = choices.find(one => one.text === answer || label(one.pick) === answer)
  if (chosen) {
    const isKept = chosen.pick === pick

    return {
      kind: 'run',
      pick: { model: chosen.pick.model, effort: chosen.pick.effort, reason: pick.reason, by: isKept ? pick.by : 'you', ...(pick.kind ? { kind: pick.kind } : {}) },
      agreed: isKept,
    }
  }
  const words = typed(answer)

  return { kind: 'run', pick: words, agreed: samePick(words, pick) }
}

// ── Learning from the person ───────────────────────────────────────────────

const loadTrust = async ($: EngineInterface) => ((await $.store.get('trust')) ?? {}) as Record<string, TrustEntry>
const loadCosts = async ($: EngineInterface) => ((await $.store.get('turnCost')) ?? {}) as Record<string, TurnCost>

/** Records whether the person kept the recommendation for this kind; says so the moment the chooser stops asking. */
const learnAnswer = async ($: EngineInterface, pick: Pick, kept: boolean) => {
  const kind = kindKey(pick)
  const now = await $.clock.now()
  const trust = recordAnswer(await loadTrust($), kind, kept, now)
  await $.store.set('trust', trust)
  if (kept && trust[kind]?.streak === TRUST_AFTER)
    $.ui.toast(`You kept my pick ${TRUST_AFTER} times in a row for “${pick.reason}”: I'll stop asking for that kind of task (/chooser reset to undo).`)
}

/** A pick forced with a tag on a kind of task the chooser no longer asks about: the question comes back. */
const forgetTrust = async ($: EngineInterface, kind: string) => {
  const trust = await loadTrust($)
  if (!trust[kind]) return
  await $.store.set('trust', recordAnswer(trust, kind, false, await $.clock.now()))
}

// ── Clipboard, box, new conversation ──────────────────────────────────────

const copyText = async ($: EngineInterface, text: string, surface?: RenderSurface) => {
  try {
    const copied = await $.ui.copy({ text, surface })
    if (copied.isCopied) return true
  } catch {
    // no surface clipboard: the machine's below
  }
  try {
    return (await $.process.run(['pbcopy'], { stdin: text, timeoutMs: 5000 })).exitCode === 0
  } catch {
    return false
  }
}

/** Puts text in the prompt box, else on the clipboard: where it went. */
const fillBox = async ($: EngineInterface, text: string, surface?: RenderSurface): Promise<'box' | 'clipboard' | 'nowhere'> => {
  try {
    if ((await $.prompt.fill({ text })).isFilled) return 'box'
  } catch {
    // no box: the clipboard below
  }

  return (await copyText($, text, surface)) ? 'clipboard' : 'nowhere'
}

/** A short recap of this conversation plus the prompt, on the clipboard for a fresh session. */
const handOffToNewConversation = async ($: EngineInterface, text: string, surface?: RenderSurface) => {
  await setBusy($, 'Writing a recap for the new conversation…')
  try {
    const fork = await $.model.fork({ prompt: RECAP_PROMPT })
    const recap = fork.isAnswered ? fork.text.trim() : ''
    const whole = recap ? `Context from an earlier session:\n${recap}\n\n---\n\n${text}` : text
    const copied = await copyText($, whole, surface)

    return copied
      ? `Copied your prompt${recap ? ' with a short recap' : ''}: open a new conversation and paste it.`
      : "Couldn't reach the clipboard: your prompt was not sent."
  } finally {
    await setBusy($, '')
  }
}

// ── The upgrader's panel ───────────────────────────────────────────────────

const openUpgrade = async ($: EngineInterface, original: string, triage: Read, pick0: Pick, isForced: boolean, chooser: boolean, conv: Conversation) => {
  const now = await $.clock.now()
  const from = conv.hasHistory ? await currentPick($) : null
  const clock = await read($, cache)
  const first = switchCost(pick0, from, conv.contextTokens, clock, now, config.cacheMs)
  const pick = keepIfTooLong(isForced ? pick0 : keepStronger(pick0, from, first), from, conv.contextTokens)
  const state: Upgrade = {
    id: `u${now}`,
    stage: 'questions',
    original,
    intent: triage.intent,
    questions: triage.questions,
    answers: Object.fromEntries(triage.questions.map(question => [question.id, { choice: question.recommended }])),
    extra: '',
    improved: '',
    previous: [],
    pick,
    pickTouched: isForced,
    chipsOpen: false,
    chooser,
    from: from && { model: from.model, effort: from.effort },
    contextTokens: conv.contextTokens,
    switch: switchCost(pick, from, conv.contextTokens, clock, now, config.cacheMs),
    error: '',
    notice: '',
  }
  await update($, upgrade, () => state)
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true })
  if (opened.isPlaced) return true
  await update($, upgrade, () => null)
  await $.ui.close({ id: PANE })

  return false
}

const changeUpgrade = async ($: EngineInterface, change: (up: Upgrade) => Upgrade) => {
  await update($, upgrade, up => (up ? change(up) : up))
}

const choose = async ($: EngineInterface, id: string, choice: number) => {
  await changeUpgrade($, up => ({ ...up, answers: { ...up.answers, [id]: { choice } } }))
}

const typeOwn = async ($: EngineInterface, id: string, text: string) => {
  await changeUpgrade($, up => ({ ...up, answers: { ...up.answers, [id]: { ...up.answers[id], text } } }))
}

const typeExtra = async ($: EngineInterface, text: string) => {
  await changeUpgrade($, up => ({ ...up, extra: text }))
}

const repick = async ($: EngineInterface, change: { model?: ModelName; effort?: Effort }) => {
  const now = await $.clock.now()
  const clock = await read($, cache)
  await changeUpgrade($, up => {
    const pick: Pick = { ...up.pick, ...change, by: 'you' }

    return { ...up, pick, pickTouched: true, switch: switchCost(pick, up.from, up.contextTokens, clock, now, config.cacheMs) }
  })
}

const toggleChips = async ($: EngineInterface) => {
  await changeUpgrade($, up => ({ ...up, chipsOpen: !up.chipsOpen }))
}

/** Sonnet writes the improved prompt from the answers (or applies a requested change to it). */
const writeUpgrade = async ($: EngineInterface, tweak?: string) => {
  const start = await read($, upgrade)
  if (!start || start.stage === 'writing') return
  await update($, upgrade, () => ({ ...start, stage: 'writing' as const, error: '', notice: '' }))
  const rules = await projectRules($)
  const change = tweak?.trim()
  const reply = await $.model.complete({
    model: 'sonnet',
    system: REWRITE_SYSTEM(start.pick.model),
    prompt: [
      { text: rules ? `Project rules (start of CLAUDE.md):\n${rules}` : 'This project has no rules file.', cache: true },
      {
        text: [
          `Original prompt:\n<<<\n${start.original}\n>>>`,
          `The developer's answers:\n${answersText(start.questions, start.answers, start.extra)}`,
          change ? `Your current rewrite:\n<<<\n${start.improved}\n>>>\nApply this change to it: ${change}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    maxTokens: 3000,
    effort: 'low',
    timeoutMs: WRITE_TIMEOUT_MS,
  })
  const parsed = reply.isAnswered ? parseRewrite(reply.text, start.pick) : undefined
  const now = await $.clock.now()
  const clock = await read($, cache)
  await update($, upgrade, up => {
    if (!up || up.id !== start.id) return up
    if (!parsed) {
      const why = reply.isAnswered
        ? 'the answer came back in an unexpected shape'
        : reply.reason === 'api-error'
          ? `the API answered ${reply.status ?? 'with an error'}`
          : reply.reason === 'aborted'
            ? 'it took too long'
            : 'the model sent back nothing'
      return { ...up, stage: 'failed' as const, error: `Couldn't write the improved prompt: ${why}.` }
    }
    const fresh = up.pickTouched
      ? up.pick
      : keepIfTooLong(keepStronger(parsed.pick, up.from, switchCost(parsed.pick, up.from, up.contextTokens, clock, now, config.cacheMs)), up.from, up.contextTokens)

    return {
      ...up,
      stage: 'ready' as const,
      improved: parsed.prompt,
      previous: change && up.improved ? [...up.previous, up.improved].slice(-5) : up.previous,
      pick: fresh,
      switch: switchCost(fresh, up.from, up.contextTokens, clock, now, config.cacheMs),
    }
  })
}

const undoTweak = async ($: EngineInterface) => {
  await changeUpgrade($, up => {
    const last = up.previous[up.previous.length - 1]

    return last === undefined ? up : { ...up, improved: last, previous: up.previous.slice(0, -1), notice: '' }
  })
}

const closePane = async ($: EngineInterface) => {
  await update($, upgrade, () => null)
  await $.ui.close({ id: PANE })
}

/** Runs the improved prompt (or the original) here, on the panel's pick. */
const launch = async ($: EngineInterface, which: 'improved' | 'original') => {
  const up = await read($, upgrade)
  if (!up) return
  const text = which === 'improved' && up.improved ? up.improved : up.original
  if (up.chooser) await setActive($, up.pick)
  await closePane($)
  await $.prompt.submit({ text, asUser: true })
}

const copyImproved = async ($: EngineInterface, surface: RenderSurface) => {
  const up = await read($, upgrade)
  if (!up?.improved) return
  const copied = await copyText($, up.improved, surface)
  await changeUpgrade($, one => ({ ...one, notice: copied ? '✓ Copied: paste it into any session.' : "Couldn't reach the clipboard." }))
}

const editImproved = async ($: EngineInterface, surface: RenderSurface) => {
  const up = await read($, upgrade)
  if (!up?.improved) return
  const now = await $.clock.now()
  if (up.chooser) await update($, handoff, () => ({ pick: up.pick, until: now + HANDOFF_MS }))
  await closePane($)
  const where = await fillBox($, up.improved, surface)
  $.ui.toast(
    where === 'box'
      ? 'The improved prompt is in the box: edit it, then press Enter.'
      : where === 'clipboard'
        ? 'Copied the improved prompt: paste it in the box, edit it, then press Enter.'
        : "Couldn't reach the box or the clipboard.",
  )
}

const newConversation = async ($: EngineInterface, surface: RenderSurface) => {
  const up = await read($, upgrade)
  if (!up) return
  const said = await handOffToNewConversation($, up.improved || up.original, surface)
  await changeUpgrade($, one => ({ ...one, notice: said }))
}

/** The person closed the panel without running anything: their prompt goes back where they can use it. */
const cancelUpgrade = async ($: EngineInterface) => {
  const up = await read($, upgrade)
  if (!up) return
  await update($, upgrade, () => null)
  const where = await fillBox($, up.original)
  $.ui.toast(
    where === 'box'
      ? 'Upgrade cancelled: your prompt is back in the box.'
      : where === 'clipboard'
        ? 'Upgrade cancelled: your prompt is on the clipboard.'
        : 'Upgrade cancelled.',
  )
}

const cancelFromPane = async ($: EngineInterface) => {
  await cancelUpgrade($)
  await $.ui.close({ id: PANE })
}

// ── Plan usage ─────────────────────────────────────────────────────────────

const WINDOW_NAME: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly' }

const resetsIn = (resetsAt: string | undefined, now: number) => {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.round((ms % 3_600_000) / 60_000)
  if (hours >= 24) return ` · resets in ${Math.round(hours / 24)} d`

  return ` · resets in ${hours ? `${hours} h ` : ''}${minutes} min`
}

const noteUsage = async ($: EngineInterface, limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]) => {
  const windows: UsageWindow[] = limits
    .filter(one => WINDOW_NAME[one.kind])
    .map(one => ({ kind: one.kind, percent: one.percentUsed, ...(one.resetsAt ? { resetsAt: one.resetsAt } : {}) }))
  await update($, usage, () => windows)
  const now = await $.clock.now()
  for (const window of windows) {
    const level = window.percent >= 95 ? 95 : window.percent >= config.warnAt ? config.warnAt : 0
    if (!level) continue
    const key = `${window.kind}:${window.resetsAt ?? ''}:${level}`
    const warned = ((await $.store.get('warned')) ?? {}) as Record<string, number>
    if (warned[key]) continue
    const kept = Object.fromEntries(Object.entries(warned).filter(([, at]) => now - at < 8 * 24 * 3_600_000))
    await $.store.set('warned', { ...kept, [key]: now })
    $.ui.toast(`⚠ ${WINDOW_NAME[window.kind]} usage at ${Math.round(window.percent)}%${resetsIn(window.resetsAt, now)}`)
  }
}

// ── Switches ───────────────────────────────────────────────────────────────

const setToggle = async ($: EngineInterface, which: 'chooser' | 'upgrader', value: boolean) => {
  await $.store.set(which === 'chooser' ? 'chooserOn' : 'upgraderOn', value)
  if (which === 'chooser') {
    await update($, chooserOn, () => value)
    if (!value) {
      await update($, active, () => null)
      $.ui.status(undefined)
    }
  } else await update($, upgraderOn, () => value)
}

const toggleCommand = async ($: EngineInterface, which: 'chooser' | 'upgrader', args: string) => {
  const word = args.trim().toLowerCase()
  if (which === 'chooser' && word === 'reset') {
    await $.store.set('trust', {})

    return 'Model chooser: it will ask again for every kind of task.'
  }
  const now = which === 'chooser' ? await read($, chooserOn) : await read($, upgraderOn)
  const next = word === 'on' ? true : word === 'off' ? false : word === '' ? !now : now
  if (next !== now) await setToggle($, which, next)
  const name = which === 'chooser' ? 'Model chooser' : 'Prompt upgrader'
  const pick = await read($, active)
  const extra = which === 'chooser' && next && pick ? ` Now running on ${label(pick)} (${pick.reason}).` : ''

  return `${name}: ${next ? 'on' : 'off'} in every session.${extra}`
}

// ── The hooks ──────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  for (const model of MODELS) {
    const id = options[`${model}Model`]
    if (typeof id === 'string' && id.trim()) config.ids[model] = id.trim()
  }
  if (typeof options.cacheMinutes === 'number' && options.cacheMinutes > 0) config.cacheMs = options.cacheMinutes * 60_000
  if (typeof options.usageWarnPercent === 'number' && options.usageWarnPercent > 0) config.warnAt = options.usageWarnPercent

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'chooser', description: 'Model chooser: picks the model and effort for each prompt (on, off; reset makes it ask again)', argumentHint: '[on|off|reset]', immediate: true })
    await $.command.register({ name: 'upgrader', description: 'Prompt upgrader: improves substantial prompts with a short question panel (on, off)', argumentHint: '[on|off]', immediate: true })
    const [chooser, upgrader] = [await $.store.get('chooserOn'), await $.store.get('upgraderOn')]
    await update($, chooserOn, () => chooser !== false)
    await update($, upgraderOn, () => upgrader !== false)

    return next(e)
  })

  on('command.run', { command: 'chooser' }, async ($, e) => ({ text: await toggleCommand($, 'chooser', e.args) }))
  on('command.run', { command: 'upgrader' }, async ($, e) => ({ text: await toggleCommand($, 'upgrader', e.args) }))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' && e.origin.name === PLUGIN) return next(e)
    if (NOT_THE_PERSON.has(e.origin.kind) || e.turnId !== undefined) return next(e)
    if (e.text.trimStart().startsWith('/') || /^\s*<[a-z-]+>/.test(e.text)) return next(e)
    const tags = parseTags(e.text)
    const pass = () => next(tags.text === e.text ? e : { ...e, text: tags.text })
    const chooser = await read($, chooserOn)
    const upgrader = await read($, upgraderOn)
    if (!chooser && !upgrader) return pass()
    const text = tags.text
    const conv = await conversation($)
    const kind = kindOf(text, conv.lastAssistant)
    const hasAttachments = (e.attachments?.length ?? 0) > 0
    const now = await $.clock.now()
    const current = conv.hasHistory || (await read($, active)) ? await currentPick($) : null

    // An improved prompt the person edited in the box runs on the panel's pick, unasked.
    const handed = await read($, handoff)
    if (handed) await update($, handoff, () => null)
    if (handed && handed.until > now) {
      if (chooser) await setActive($, handed.pick)

      return pass()
    }

    const forced: Pick | undefined =
      tags.model || tags.effort
        ? { model: tags.model ?? current?.model ?? 'opus', effort: tags.effort ?? (tags.model === 'haiku' ? 'medium' : 'high'), reason: 'your choice', by: 'you' }
        : undefined

    let triage: Read | undefined
    if (upgrader && !tags.skipUpgrade && !hasAttachments && (tags.forceUpgrade || kind === 'substantial')) {
      await setBusy($, 'Reading your prompt…')
      try {
        triage = await readPrompt($, text, conv, forced ?? rulePick(text, hasAttachments).pick)
      } finally {
        await setBusy($, '')
      }
      if (triage && (!triage.isClear || tags.forceUpgrade) && triage.questions.length > 0) {
        const opened = await openUpgrade($, text, triage, forced ?? triage.pick, !!forced, chooser, conv)
        if (opened) return { drop: '✨ Prompt upgrader: answer in its panel, then Launch (or Send as is).' }
      }
    }
    if (!chooser) return pass()

    // Go-aheads and status replies keep what runs (the upgrader keeps its own reading of `kind`).
    const asked = kind === 'ack' || isContinuation(text, conv.lastAssistant) ? 'ack' : kind
    let pick: Pick
    if (forced) pick = forced
    else if (asked === 'ack' && current) pick = { ...current, by: 'kept' }
    else pick = triage?.pick ?? (await choosePick($, text, hasAttachments, conv))
    if (forced) {
      const usual = rulePick(text, hasAttachments).pick
      if (!samePick(forced, usual)) await forgetTrust($, kindKey(usual))
    }
    const clock = await read($, cache)
    const kept = keepIfTooLong(
      forced ? pick : keepStronger(pick, current, switchCost(pick, current, conv.contextTokens, clock, now, config.cacheMs)),
      current,
      conv.contextTokens,
    )
    const cost = switchCost(kept, current, conv.contextTokens, clock, now, config.cacheMs)
    const mustAsk = !forced && asked !== 'ack' && (asked === 'substantial' || !samePick(kept, current))
    let final = kept
    if (mustAsk && cost.kind !== 'costly' && isTrusted(await loadTrust($), kindKey(kept))) final = { ...kept, by: 'trusted' }
    else if (mustAsk) {
      const decision = await confirmPick($, kept, current, cost, triage?.isClear === true, await loadCosts($))
      if (decision.kind === 'new') return { drop: await handOffToNewConversation($, text) }
      final = decision.pick
      if (decision.agreed !== undefined) await learnAnswer($, kept, decision.agreed)
    }
    await setActive($, final)

    return pass()
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const pick = await read($, active)
    if (!pick || !(await read($, chooserOn))) return yield* next(e)
    const model = tierOf(e.model) === pick.model ? e.model : config.ids[pick.model]

    return yield* next({ ...e, model, effort: pick.effort })
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    const percent = (await $.session.usage()).rateLimits.find(one => one.kind === 'five_hour')?.percentUsed
    const pick = (await read($, active)) ?? (await currentPick($))
    await update($, turnStart, () => (percent === undefined ? null : { key: costKey(pick), percent }))

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') {
      const pick = await read($, active)
      const tier = pick?.model ?? tierOf(await $.session.model())
      const now = await $.clock.now()
      if (tier) await update($, cache, clock => ({ ...clock, [tier]: now }))
    }
    if (e.agentId === undefined) {
      const mark = await read($, turnStart)
      await update($, turnStart, () => null)
      const percent = (await $.session.usage()).rateLimits.find(one => one.kind === 'five_hour')?.percentUsed
      if (mark && percent !== undefined && e.reason === 'answer') await $.store.set('turnCost', recordTurnCost(await loadCosts($), mark.key, percent - mark.percent))
    }

    return ended
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await noteUsage($, e.rateLimits)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, active, () => null)
      await update($, cache, () => ({}))
      $.ui.status(undefined)
    }

    return next(e)
  })

  on('ui.close', { id: 'prompt-upgrader' }, async ($, e, next) => {
    const closed = await next(e)
    if (e.origin.kind === 'person') await cancelUpgrade($)

    return closed
  })

  // ── The band above the prompt ────────────────────────────────────────────

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [chooser, upgrader] = [await read($, chooserOn), await read($, upgraderOn)]
    if (!chooser && !upgrader) return next(e)
    const [pick, doing, windows, up] = [await read($, active), await read($, busy), await read($, usage), await read($, upgrade)]
    const { Box, Text } = $.ui.resolve(e)
    const shown = windows.filter(one => one.percent >= 1)
    const usageText = shown.map(one => `${one.kind === 'five_hour' ? '5h' : 'week'} ${Math.round(one.percent)}%`).join(' · ')
    const usageColor = shown.some(one => one.percent >= 95) ? 'error' : shown.some(one => one.percent >= config.warnAt) ? 'warning' : undefined

    return (
      <Box key="pilot-band" flexDirection="row" justifyContent="space-between" width={e.props.bodyColumns}>
        <Box flexShrink={1}>
          {doing ? (
            <Text color="claude" wrap="truncate-end">
              ✨ {doing}
            </Text>
          ) : up ? (
            <Text color="claude" wrap="truncate-end">
              ✨ Upgrading your prompt: answer in the panel
            </Text>
          ) : chooser && pick ? (
            <Text wrap="truncate-end">
              <Text color={MODEL_COLOR[pick.model]} bold>
                ◆ {label(pick)}
              </Text>
              <Text color={MODEL_COLOR[pick.model]}> {meter(pick.effort)}</Text>
              <Text dimColor> {pick.reason}</Text>
              {pick.by === 'trusted' ? <Text dimColor> · auto</Text> : null}
            </Text>
          ) : (
            <Text dimColor wrap="truncate-end">
              {[chooser ? '◆ Auto model' : '', upgrader ? '✨ Prompt upgrader' : ''].filter(Boolean).join(' · ')}
            </Text>
          )}
        </Box>
        {usageText ? (
          <Text color={usageColor} dimColor={!usageColor}>
            {' '}
            {usageText}
          </Text>
        ) : null}
      </Box>
    )
  })

  // ── The upgrader's panel ─────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: 'prompt-upgrader' }, async ($, e) => {
    const up = await read($, upgrade)
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const Input = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Input
    const width = Math.max(30, e.props.bodyColumns)

    if (!up)
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor wrap="wrap">
            No prompt is being upgraded. Long new prompts open this panel; start one with ?? to ask for it, or with !! to skip it.
          </Text>
        </Box>
      )

    const step = up.stage === 'questions' ? 'Step 1 of 2 · A few questions' : up.stage === 'writing' ? 'Step 2 of 2 · Writing' : up.stage === 'ready' ? 'Step 2 of 2 · Ready' : 'Step 2 of 2'
    const header = (
      <Box key="head" flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">
          ✨ PROMPT UPGRADER
        </Text>
        <Text dimColor>{step}</Text>
      </Box>
    )
    const original = (
      <Box key="original" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} marginTop={1}>
        <Text dimColor bold>
          Your prompt{up.intent ? ` · ${up.intent}` : ''}
        </Text>
        <Text dimColor wrap="wrap">
          {clip(up.original.replace(/\s+/g, ' '), up.stage === 'questions' ? 360 : 160)}
        </Text>
      </Box>
    )

    const chip = (key: string, isOn: boolean, text: string, onPress: () => void) => (
      <Button key={key} plain onPress={onPress}>
        <Text color={isOn ? 'claude' : 'subtle'}>{isOn ? '●' : '○'}</Text> <Text bold={isOn}>{text}</Text>
      </Button>
    )

    const modelRows = up.chooser ? (
      <Box key="model" flexDirection="column" marginTop={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text bold>Model </Text>
          {MODELS.map(model => chip(`model:${model}`, up.pick.model === model, MODEL_LABEL[model], () => void repick($, { model })))}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text bold>Effort</Text>
          {EFFORTS.map(effort => chip(`effort:${effort}`, up.pick.effort === effort, EFFORT_LABEL[effort], () => void repick($, { effort })))}
        </Box>
        <Text dimColor wrap="wrap">
          {meter(up.pick.effort)} {up.pick.reason}
          {up.pick.by === 'you' ? ' · your choice' : ''}
        </Text>
        {up.switch.kind !== 'none' ? (
          <Text color={up.switch.kind === 'costly' ? 'warning' : undefined} dimColor={up.switch.kind !== 'costly'} wrap="wrap">
            {up.switch.kind === 'costly' ? '⚠ ' : 'ⓘ '}
            {up.switch.note}
          </Text>
        ) : null}
      </Box>
    ) : null

    const pickLine = up.chooser ? (
      <Box key="pick-line" flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
        <Text dimColor>Runs on</Text>
        <Text color={MODEL_COLOR[up.pick.model]} bold>
          ◆ {label(up.pick)}
        </Text>
        <Text dimColor>{up.pick.reason}</Text>
        <Button key="chips" plain onPress={() => void toggleChips($)}>
          <Text color="suggestion">{up.chipsOpen ? '▾ hide' : '▸ change'}</Text>
        </Button>
      </Box>
    ) : null

    if (up.stage === 'questions')
      return (
        <Box flexDirection="column" paddingX={1} width={width}>
          {header}
          {original}
          {up.questions.map((question: UpgradeQuestion, index: number) => {
            const answer = up.answers[question.id] ?? {}
            const ownWords = answer.text?.trim() ?? ''

            return (
              <Box key={`q:${question.id}`} flexDirection="column" marginTop={1}>
                <Text>
                  <Text color="claude" bold>
                    {index + 1}
                  </Text>
                  <Text bold> {question.topic.toUpperCase()}</Text>
                </Text>
                <Text wrap="wrap">{question.question}</Text>
                <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                  {question.options.map((option, choice) =>
                    chip(`opt:${question.id}:${choice}`, !ownWords && answer.choice === choice, option, () => void choose($, question.id, choice)),
                  )}
                </Box>
                {Input ? (
                  <Input
                    key={`own:${question.id}`}
                    placeholder="Or type your own answer…"
                    value={answer.text ?? ''}
                    onInput={value => void typeOwn($, question.id, value)}
                    onSubmit={value => void typeOwn($, question.id, value)}
                  />
                ) : null}
              </Box>
            )
          })}
          {Input ? (
            <Box key="extra" flexDirection="column" marginTop={1}>
              <Text bold>Anything to add?</Text>
              <Input key="extra-input" placeholder="Optional: a detail, a constraint…" value={up.extra} onInput={value => void typeExtra($, value)} onSubmit={value => void typeExtra($, value)} />
            </Box>
          ) : null}
          {pickLine}
          {up.chipsOpen ? modelRows : null}
          <Box key="actions" flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
            <Button key="improve" label="✨ Improve prompt" variant="primary" hotkey="i" autoFocus onPress={() => void writeUpgrade($)} />
            <Button key="as-is" label="Send as is" hotkey="s" onPress={() => void launch($, 'original')} />
            <Button key="cancel" label="Cancel" hotkey="x" onPress={() => void cancelFromPane($)} />
          </Box>
          <Text dimColor>Cancel or Esc puts your prompt back in the box.</Text>
        </Box>
      )

    if (up.stage === 'writing')
      return (
        <Box flexDirection="column" paddingX={1} width={width}>
          {header}
          {original}
          <Text key="writing" color="claude" bold>
            ◌ Writing your improved prompt…
          </Text>
          <Box key="answers" flexDirection="column" marginTop={1}>
            {up.questions.map(question => {
              const answer = up.answers[question.id]
              const words = answer?.text?.trim() || (answer?.choice !== undefined ? question.options[answer.choice] : '')

              return (
                <Text key={`a:${question.id}`} dimColor wrap="wrap">
                  {question.topic}: {words || '—'}
                </Text>
              )
            })}
            {up.extra.trim() ? (
              <Text key="a:extra" dimColor wrap="wrap">
                Also: {up.extra.trim()}
              </Text>
            ) : null}
          </Box>
          <Box key="actions" flexDirection="row" columnGap={2} marginTop={1}>
            <Button key="as-is" label="Send as is" hotkey="s" onPress={() => void launch($, 'original')} />
          </Box>
        </Box>
      )

    if (up.stage === 'failed')
      return (
        <Box flexDirection="column" paddingX={1} width={width}>
          {header}
          {original}
          <Text key="error" color="warning" wrap="wrap">
            ⚠ {up.error}
          </Text>
          <Box key="actions" flexDirection="row" columnGap={2} marginTop={1}>
            <Button key="retry" label="Try again" variant="primary" hotkey="r" autoFocus onPress={() => void writeUpgrade($)} />
            <Button key="as-is" label="Send as is" hotkey="s" onPress={() => void launch($, 'original')} />
            <Button key="cancel" label="Cancel" hotkey="x" onPress={() => void cancelFromPane($)} />
          </Box>
        </Box>
      )

    return (
      <Box flexDirection="column" paddingX={1} width={width}>
        {header}
        <Box key="improved-head" flexDirection="row" justifyContent="space-between" marginTop={1}>
          <Text bold color="success">
            ✓ Improved prompt
          </Text>
          <Text dimColor>
            {wordCount(up.original)} → {wordCount(up.improved)} words
          </Text>
        </Box>
        <Box key="improved" flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Markdown key="improved-text" text={up.improved} />
        </Box>
        {up.previous.length > 0 ? (
          <Button key="undo" plain onPress={() => void undoTweak($)}>
            <Text color="suggestion">↶ Undo the last change</Text>
          </Button>
        ) : null}
        {modelRows}
        {Input ? (
          <Box key="tweak" flexDirection="column" marginTop={1}>
            <Input key="tweak-input" placeholder="Ask for a change: shorter, add tests…, then Enter" onSubmit={value => void (value.trim() ? writeUpgrade($, value) : undefined)} />
          </Box>
        ) : null}
        {up.notice ? (
          <Text key="notice" color={up.notice.startsWith('✓') || up.notice.startsWith('Copied') ? 'success' : 'warning'} wrap="wrap">
            {up.notice}
          </Text>
        ) : null}
        <Box key="actions" flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
          <Button
            key="launch"
            label={up.chooser ? `▶ Launch on ${label(up.pick)}` : '▶ Launch'}
            variant="primary"
            hotkey="l"
            autoFocus
            onPress={() => void launch($, 'improved')}
          />
          <Button key="copy" label="Copy" hotkey="c" onPress={press => void copyImproved($, press.surface)} />
          <Button key="edit" label="Edit in box" hotkey="e" onPress={press => void editImproved($, press.surface)} />
          <Button key="original" label="Send original" hotkey="o" onPress={() => void launch($, 'original')} />
          {up.switch.kind === 'costly' ? <Button key="new" label="New conversation" hotkey="n" onPress={press => void newConversation($, press.surface)} /> : null}
        </Box>
      </Box>
    )
  })
}
