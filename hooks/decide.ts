import type { Effort, HoldMode, ModelName, Pick, RememberedAnswer, SwitchCost, TrustEntry, TurnCost, UpgradeAnswer, UpgradeQuestion } from '../types'

// ── The ladder ────────────────────────────────────────────────────────────

export const MODEL_LABEL: Record<ModelName, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }
export const EFFORT_LABEL: Record<Effort, string> = { medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' }
export const MODELS: ModelName[] = ['haiku', 'sonnet', 'opus']
export const EFFORTS: Effort[] = ['medium', 'high', 'xhigh', 'max']
export const MODEL_RANK: Record<ModelName, number> = { haiku: 0, sonnet: 1, opus: 2 }

/** Weakest to strongest; the confirm dialog offers a pick's neighbours. */
export const LADDER: [ModelName, Effort][] = [
  ['haiku', 'medium'],
  ['haiku', 'high'],
  ['sonnet', 'medium'],
  ['sonnet', 'high'],
  ['sonnet', 'xhigh'],
  ['opus', 'high'],
  ['opus', 'xhigh'],
  ['opus', 'max'],
]

export const label = (pick: { model: ModelName; effort: Effort }) => `${MODEL_LABEL[pick.model]} · ${EFFORT_LABEL[pick.effort]}`

/** A four-step meter for the effort: ▰▰▱▱ is High. */
export const meter = (effort: Effort) => {
  const filled = EFFORTS.indexOf(effort) + 1

  return '▰'.repeat(filled) + '▱'.repeat(EFFORTS.length - filled)
}

const rankOf = (pick: { model: ModelName; effort: Effort }) => {
  const exact = LADDER.findIndex(([model, effort]) => model === pick.model && effort === pick.effort)
  if (exact >= 0) return exact
  // Off the ladder (Opus · Medium, Sonnet · Max): the nearest rung of the same model.
  const same = LADDER.map((rung, index) => ({ rung, index })).filter(one => one.rung[0] === pick.model)
  const wanted = EFFORTS.indexOf(pick.effort)

  return [...same].sort((a, b) => Math.abs(EFFORTS.indexOf(a.rung[1]) - wanted) - Math.abs(EFFORTS.indexOf(b.rung[1]) - wanted))[0]?.index ?? 5
}

/** The rungs just above and below a pick, for the confirm dialog. */
export const neighbours = (pick: { model: ModelName; effort: Effort }) => {
  const rank = rankOf(pick)
  const at = (index: number) => {
    const rung = LADDER[index]

    return rung && !(rung[0] === pick.model && rung[1] === pick.effort) ? { model: rung[0], effort: rung[1] } : undefined
  }

  return { up: at(rank + 1), down: at(rank - 1) }
}

export const samePick = (a: { model: ModelName; effort: Effort } | null | undefined, b: { model: ModelName; effort: Effort } | null | undefined) =>
  !!a && !!b && a.model === b.model && a.effort === b.effort

/** The tier a model id belongs to: "claude-opus-5-5[1m]" is opus. */
export const tierOf = (model: string): ModelName | undefined =>
  /opus/i.test(model) ? 'opus' : /sonnet/i.test(model) ? 'sonnet' : /haiku/i.test(model) ? 'haiku' : undefined

// ── Words typed by the person: tags, and a pick in their own words ─────────

export type Tags = {
  text: string
  model?: ModelName
  effort?: Effort
  /** `!!`: no upgrader for this prompt. */
  skipUpgrade: boolean
  /** `??`: the upgrader even for a short prompt. */
  forceUpgrade: boolean
}

const MODEL_WORDS: Record<string, ModelName> = { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku' }
const EFFORT_WORDS: Record<string, Effort> = { medium: 'medium', med: 'medium', high: 'high', extra: 'xhigh', xhigh: 'xhigh', max: 'max' }
const TAG = /^(!!|\?\?|!(opus|sonnet|haiku|medium|med|high|extra|xhigh|max))$/i

/** Reads `!!`, `??` and `!opus`/`!max`… at the start or the end of a prompt, and strips them. */
export const parseTags = (raw: string): Tags => {
  const words = raw.trim().split(/\s+/)
  const tags: string[] = []
  while (words.length > 1 && TAG.test(words[0] ?? '')) tags.push(words.shift() as string)
  while (words.length > 1 && TAG.test(words[words.length - 1] ?? '')) tags.push(words.pop() as string)
  if (tags.length === 0) return { text: raw, skipUpgrade: false, forceUpgrade: false }
  const found: Tags = { text: words.join(' '), skipUpgrade: false, forceUpgrade: false }
  for (const tag of tags.map(one => one.toLowerCase())) {
    if (tag === '!!') found.skipUpgrade = true
    else if (tag === '??') found.forceUpgrade = true
    else {
      const word = tag.slice(1)
      if (MODEL_WORDS[word]) found.model = MODEL_WORDS[word]
      if (EFFORT_WORDS[word]) found.effort = EFFORT_WORDS[word]
    }
  }
  // Keep the person's own line breaks when only the edges carried tags.
  const first = raw.indexOf(words[0] ?? '')
  const last = raw.lastIndexOf(words[words.length - 1] ?? '')
  if (first >= 0 && last >= first) found.text = raw.slice(first, last + (words[words.length - 1] ?? '').length)

  return found
}

/** "sonnet max", "Opus · Extra", "max" typed under Other: a pick, or undefined. */
export const parsePickWords = (words: string, base: { model: ModelName; effort: Effort }) => {
  const lower = words.toLowerCase()
  const model = MODELS.find(one => lower.includes(one))
  const effortWord = Object.keys(EFFORT_WORDS).find(one => new RegExp(`\\b${one}\\b`).test(lower))
  const effort = effortWord ? EFFORT_WORDS[effortWord] : undefined
  if (!model && !effort) return undefined

  return { model: model ?? base.model, effort: effort ?? (model && model !== base.model ? 'high' : base.effort) }
}

// ── What kind of prompt it is ──────────────────────────────────────────────

const ACK =
  /^(y|yes|yeah|yep|yup|ok|okay|k|sure|go|go ahead|go for it|do it|continue|carry on|proceed|next|done|thanks|thank you|thx|merci|oui|non|no|nope|vas-y|vas y|go on|c'est bon|parfait|perfect|great|nice|cool|lgtm|ship it|approved?|agreed|d'accord|ok merci|top|super|[1-9]|[a-d]|option [a-d1-9])[\s.!?]*$/i

export const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

export type PromptKind = 'ack' | 'short' | 'substantial'

/**
 * `ack`: "yes", "continue" — keeps what runs. `short`: a brief instruction or an
 * answer to Claude's question — confirmed only when the pick changes.
 * `substantial`: a new task in its own words — the upgrader's, and always confirmed.
 */
export const kindOf = (text: string, lastAssistant: string): PromptKind => {
  const trimmed = text.trim()
  if (ACK.test(trimmed)) return 'ack'
  const words = wordCount(trimmed)
  const tail = lastAssistant.trim().slice(-400)
  const claudeAsked = /\?\s*$/.test(tail) || /\?\s*\n/.test(tail.slice(-200))
  if (words < 12) return 'short'
  if (claudeAsked && words < 30) return 'short'

  return 'substantial'
}

// ── Go-aheads: replies that continue the work at hand (calibrated on 200 real prompts) ──

const GO_AHEAD =
  /^(y|yes|yeah|yep|ok(ay)?|sure|go|go ahead|go for (it|both|all)|do it|let'?s (go|do it)|work on|move forward|you can (move forward|do|go|proceed|continue|start)|proceed|continue|carry on|please (continue|proceed|resume)|agreed?|approved?|confirmed?|both|all of them|keep|fine|perfect|great|parfait|d'accord|oui|vas[- ]?y|go on|c'est bon|run it( yourself)?|deploy it)\b/i
const SELECTION = /^(ok(ay)?( with| for)? |work on |do |go with )?((option )?[a-e1-9]\b[\s,&+]*(and |et |through |to |à )?)+(are |is )?(a go|yes|ok|oui|go|done)?\b/i
const STATUS =
  /^(i'?ve|i have|i'?m now|i am now|j'ai|c'est|it'?s|app has|the app has|everything|all (these|of them)|done|chrome is|digest|that'?s|it was|ajouté|fait)\b.*\b(done|filled|logged|added|created|set|put|published|reconnected|arrived|configured|available|approved|mis|ajouté|fait|relancé|installé|connecté|ended|views?)\b/i
const RESUME = /\b(resume|reprends|reprend|continue|carry on)\b/i

/**
 * True for a reply that continues the work at hand: a go-ahead ("Work on 1, 3, 4"),
 * a status from the person ("App has been published"), a resume, or a short answer
 * to Claude's own question. The chooser keeps what runs for these, unasked.
 */
export const isContinuation = (text: string, lastAssistant: string) => {
  const trimmed = text.trim()
  const words = wordCount(trimmed)
  if (words === 0) return false
  if (ACK.test(trimmed)) return true
  const tail = lastAssistant.trim().slice(-400)
  if ((/\?\s*$/.test(tail) || /\?\s*\n/.test(tail.slice(-200))) && words <= 25) return true
  if (words <= 12 && RESUME.test(trimmed)) return true
  if (words > 25 || trimmed.includes('?') || MULTI_STEP_RULES[0]?.test(trimmed)) return false

  return GO_AHEAD.test(trimmed) || SELECTION.test(trimmed) || (words <= 15 && STATUS.test(trimmed))
}

// ── The rules: instant picks for the obvious prompts ──────────────────────

const any = (rules: RegExp[], text: string) => rules.filter(rule => rule.test(text)).length

const MAX_RULES = [
  /\barchitect/i,
  /\bfrom scratch\b/i,
  /\bmigrate\b/i,
  /\bmigration (plan|strategy|to|from|of)\b/i,
  /\bmigrer\b/i,
  /\brace condition/i,
  /\bdeadlock/i,
  /\bmemory leak/i,
  /\broot cause\b/i,
  /\bstill (fails?|failing|broken|crash|crashing|doesn'?t work|not working)/i,
  /\btried everything\b/i,
  /\bultrathink\b/i,
  /\bthink (very |really )?hard\b/i,
  /\bsecurity (audit|review)\b/i,
  /\bredesign\b/i,
  /\boverhaul\b/i,
  /\brewrite (the|all|whole|entire)\b/i,
  /\bde z[ée]ro\b/i,
  /\brefonte\b/i,
  /\bfuite m[ée]moire\b/i,
  /\bcause racine\b/i,
  /\btoujours (cass[ée]|pas|en [ée]chec|le m[êe]me bug|un bug)/i,
  /\br[ée]fl[ée]chis (bien|à fond|longuement)\b/i,
  /\b(strategy|strat[ée]gie)\b/i,
]

const EXTRA_RULES = [
  /\bdebug/i,
  /\bbugs?\b/i,
  /\bcrash/i,
  /\bfail(s|ing|ed|ure)?\b/i,
  /\berrors?\b/i,
  /\brefactor/i,
  /\bimplement/i,
  /\bfeatures?\b/i,
  /\breview\b/i,
  /\binvestigat/i,
  /\banaly[sz]/i,
  /\boptimi[sz]/i,
  /\bperformance\b/i,
  /\bwhy (does|is|do|did|doesn'?t|isn'?t)\b/i,
  /\bplan\b/i,
  /\bintegrat/i,
  /\baudit\b/i,
  /\bplante\b/i,
  /\berreurs?\b/i,
  /\bcorrige/i,
  /\bd[ée]bug/i,
  /\bimpl[ée]mente/i,
  /\bfonctionnalit[ée]/i,
  /\brevue\b/i,
  /\banalyse/i,
  /\bpourquoi\b/i,
  /\boptimise/i,
  /\bcon[çc]ois\b/i,
  /\bimprove/i,
  /\bam[ée]liore/i,
  /\bwhat'?s next\b/i,
  /\bparit[yé]/i,
]

/** Several actions chained, or shipping: release work is never a one-liner. */
const MULTI_STEP_RULES = [/\b(release|testflight|production|publish|ship it|mise en prod)\b/i, /\b(and then|then|ensuite|puis|once it'?s)\b/i]

/** A yes/no question about the state of things: a quick check. */
const CHECK_QUESTION = /^(did you|have you|has it|is (it|everything|that|this)|are (they|you|we done)|was it|isn'?t it|do you have|est-ce que (c'est|tout|tu as))\b[^?]{0,200}\?\s*$/i
const STATUS_PING = /\b(still running|toujours en cours|is it done|c'est fini)\b/i
const RUN_IT = /\b(apply|run|deploy|applique|lance)\b.{0,30}\b(migrations?|yourself|toi-m[êe]me)\b/i

const ROUTINE_RULES = [
  /\brename\b/i,
  /\bformat(ting)?\b/i,
  /\btranslate\b/i,
  /\btypos?\b/i,
  /\bcommit\b/i,
  /\bpush\b/i,
  /\bgit (status|log|diff|pull)\b/i,
  /\brun (the )?(tests?|build|lint|linter)\b/i,
  /\bbump\b/i,
  /\bsummari[sz]e\b/i,
  /\bexplain\b/i,
  /\bshow me\b/i,
  /\blist (the|all)\b/i,
  /\bwhat('?s| is| are| does)\b/i,
  /\bhow (do|can|to)\b/i,
  /\btradui[st]\b/i,
  /\brenomme\b/i,
  /\bexplique\b/i,
  /\br[ée]sume\b/i,
  /\bc'est quoi\b/i,
  /\bcomment (je|on|faire)\b/i,
  /\blance (les )?tests\b/i,
]

const TRIVIAL = /^(hi|hello|hey|salut|bonjour|coucou|thanks|thank you|merci|ok|cool|test|ping)\b[\s.!?]*$/i

export type RulePick = { pick: Pick; isConfident: boolean }

/** Instant local pick; `isConfident` false means a quick Haiku read should settle it. */
export const rulePick = (text: string, hasImages: boolean): RulePick => {
  const words = wordCount(text)
  const rules = (model: ModelName, effort: Effort, reason: string, isConfident: boolean): RulePick => ({
    pick: { model, effort, reason, by: 'rules', kind: reason },
    isConfident,
  })
  if (TRIVIAL.test(text.trim())) return rules('haiku', 'medium', 'trivial message', true)
  if (STATUS_PING.test(text) && words <= 8) return rules('haiku', 'medium', 'status check', true)
  const max = any(MAX_RULES, text)
  const extra = any(EXTRA_RULES, text)
  const routine = any(ROUTINE_RULES, text)
  if (RUN_IT.test(text) && max === 0 && words <= 20) return rules('sonnet', 'high', 'run a step', true)
  if (CHECK_QUESTION.test(text.trim()) && max === 0 && words <= 25) return rules('sonnet', 'medium', 'quick check', extra === 0 && words <= 12)
  const isShipping = MULTI_STEP_RULES[0]?.test(text) === true
  const isChained = MULTI_STEP_RULES[1]?.test(text) === true && routine >= 1
  if (max >= 1 && (words >= 20 || extra >= 1 || max >= 2)) return rules('opus', 'max', 'hard, deep problem', true)
  if (max >= 1) return rules('opus', 'xhigh', 'demanding task', true)
  if (extra >= 2) return rules('opus', 'xhigh', words > 40 ? 'multi-part engineering task' : 'debugging or design work', true)
  if (extra === 1 && words >= 50) return rules('opus', 'xhigh', 'detailed engineering task', true)
  if (extra === 1) return rules('opus', 'high', 'engineering task', words >= 6)
  if ((isShipping || isChained) && max === 0) return rules('opus', 'high', 'multi-step chore', isShipping)
  if (hasImages) return rules('opus', 'high', 'task with images', false)
  if (routine >= 1 && words <= 30) return rules('sonnet', words <= 10 ? 'medium' : 'high', 'routine request', words <= 20)
  if (words > 150) return rules('opus', 'high', 'long, detailed task', false)

  return rules('opus', 'high', 'general task', false)
}

/** Keeps a pick sensible: no Low, efforts the model takes, Opus never below Medium. */
export const normalise = (model: string | undefined, effort: string | undefined, fallback: Pick): { model: ModelName; effort: Effort } => {
  const tier = (MODELS as string[]).includes(model ?? '') ? (model as ModelName) : fallback.model
  const level = effort === 'extra' ? 'xhigh' : effort === 'low' ? 'medium' : effort
  const chosen = (EFFORTS as string[]).includes(level ?? '') ? (level as Effort) : fallback.effort

  return { model: tier, effort: chosen }
}

// ── Switching models mid-conversation ──────────────────────────────────────

/** Below this, re-reading a conversation on another model costs next to nothing. */
export const SMALL_CONTEXT = 20_000

export const kTokens = (tokens: number) => (tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`)

export const ago = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`

  return `${Math.round(minutes / 60)} h ago`
}

/** `none`: same model; `cheap`: a plain confirm says so; `costly`: the three-choice switch dialog. */
export type Switch = SwitchCost

/**
 * What moving from the model that runs now to the pick's costs. The cache is
 * per model: a model that answered within the cache's lifetime still holds the
 * conversation, so going back to it is cheap; one that never did re-reads it all.
 */
export const switchCost = (
  pick: { model: ModelName },
  current: { model: ModelName } | null,
  contextTokens: number,
  lastAnswered: Partial<Record<ModelName, number>>,
  now: number,
  cacheMs: number,
): Switch => {
  if (!current || current.model === pick.model) return { kind: 'none', note: '', short: '', tokens: '' }
  const from = MODEL_LABEL[current.model]
  const to = MODEL_LABEL[pick.model]
  if (contextTokens < SMALL_CONTEXT)
    return {
      kind: 'cheap',
      note: `The conversation is still short (${kTokens(contextTokens)} tokens): switching from ${from} costs little.`,
      short: 'Short conversation: switching costs little',
      tokens: kTokens(contextTokens),
    }
  const targetAt = lastAnswered[pick.model]
  if (targetAt !== undefined && now - targetAt < cacheMs)
    return {
      kind: 'cheap',
      note: `${to} still holds this conversation in its cache (answered ${ago(now - targetAt)}): switching back costs little.`,
      short: `${to}'s cache is still warm: switching costs little`,
      tokens: kTokens(contextTokens),
    }
  const currentAt = lastAnswered[current.model]
  if (currentAt !== undefined && now - currentAt >= cacheMs)
    return {
      kind: 'cheap',
      note: `${from}'s cache has gone cold (last answer ${ago(now - currentAt)}): switching costs nothing extra.`,
      short: `${from}'s cache is cold: switching costs nothing extra`,
      tokens: kTokens(contextTokens),
    }

  return {
    kind: 'costly',
    note: `Switching from ${from} re-reads ${kTokens(contextTokens)} tokens on ${to} without the cache; staying on ${from} reads them from its cache.`,
    short: `Re-reads ${kTokens(contextTokens)} tokens on ${to}, without the cache`,
    tokens: kTokens(contextTokens),
  }
}

/**
 * Mid-conversation, a step DOWN in model is rarely worth a full re-read: when
 * the switch would be costly, the stronger model that runs now stays, at Medium.
 */
export const keepStronger = (pick: Pick, current: { model: ModelName; effort: Effort } | null, cost: Switch): Pick => {
  if (!current || cost.kind !== 'costly' || MODEL_RANK[pick.model] >= MODEL_RANK[current.model]) return pick

  return { model: current.model, effort: 'medium', reason: `${pick.reason}, kept on ${MODEL_LABEL[current.model]} (cache warm)`, by: 'kept' }
}

/** Past this, a conversation may not fit another model's window: it stays where it is. */
export const MOVABLE_CONTEXT = 150_000

/** A conversation too long to move keeps its model (the effort still follows the pick). */
export const keepIfTooLong = (pick: Pick, current: { model: ModelName } | null, contextTokens: number): Pick =>
  current && pick.model !== current.model && contextTokens > MOVABLE_CONTEXT
    ? { ...pick, model: current.model, reason: `${pick.reason}, kept on ${MODEL_LABEL[current.model]} (too long to move)`, by: 'kept' }
    : pick

// ── Learning from the person: ask less over time ──────────────────────────

/** Kept the recommendation this many times in a row for a kind of task: stop asking for it. */
export const TRUST_AFTER = 5

/** The kind a pick's trust is kept under: the rules' kind, else its level ("opus:high"). */
export const kindKey = (pick: Pick) => pick.kind ?? `${pick.model}:${pick.effort}`

export const isTrusted = (trust: Record<string, TrustEntry>, kind: string) => (trust[kind]?.streak ?? 0) >= TRUST_AFTER

/** One answer to a plain confirm: kept the recommendation (streak + 1) or chose otherwise (back to 0). */
export const recordAnswer = (trust: Record<string, TrustEntry>, kind: string, kept: boolean, now: number): Record<string, TrustEntry> => ({
  ...trust,
  [kind]: { streak: kept ? (trust[kind]?.streak ?? 0) + 1 : 0, at: now },
})

// ── What a turn costs ──────────────────────────────────────────────────────

export const costKey = (pick: { model: ModelName; effort: Effort }) => `${pick.model}:${pick.effort}`

/** Relative weight of a turn per model (input price ratio) and per effort (thinking spent). */
const MODEL_WEIGHT: Record<ModelName, number> = { haiku: 1, sonnet: 3, opus: 5 }
const EFFORT_WEIGHT: Record<Effort, number> = { medium: 0.7, high: 1, xhigh: 1.4, max: 2 }
const weight = (pick: { model: ModelName; effort: Effort }) => MODEL_WEIGHT[pick.model] * EFFORT_WEIGHT[pick.effort]

/** Readings past this are a window reset or another session's burst, not one turn. */
const MAX_TURN_POINTS = 40

/** Adds one turn's cost (points of the 5-hour window) to the moving average of its level. */
export const recordTurnCost = (costs: Record<string, TurnCost>, key: string, points: number): Record<string, TurnCost> => {
  if (!Number.isFinite(points) || points < 0 || points > MAX_TURN_POINTS) return costs
  const was = costs[key]
  const avg = was ? was.avg * 0.8 + points * 0.2 : points

  return { ...costs, [key]: { avg: Math.round(avg * 100) / 100, n: (was?.n ?? 0) + 1 } }
}

/**
 * A turn's expected cost on a level: its own average once two turns ran on it,
 * else the other levels' averages scaled by weight; undefined with no history.
 */
export const estimateTurn = (costs: Record<string, TurnCost>, pick: { model: ModelName; effort: Effort }): number | undefined => {
  const own = costs[costKey(pick)]
  if (own && own.n >= 2) return own.avg
  const known = Object.entries(costs).filter(([key, one]) => one.n >= 2 && key.includes(':'))
  if (known.length === 0) return undefined
  const perWeight =
    known.reduce((sum, [key, one]) => {
      const [model, effort] = key.split(':') as [ModelName, Effort]
      return MODEL_WEIGHT[model] && EFFORT_WEIGHT[effort] ? sum + one.avg / weight({ model, effort }) : sum
    }, 0) / known.length

  return perWeight * weight(pick)
}

/** "≈3%", "<1%", or '' with no history. */
export const costText = (points: number | undefined) =>
  points === undefined ? '' : points < 1 ? '<1%' : `≈${Math.round(points)}%`

// ── Reading the models' answers ────────────────────────────────────────────

const firstJson = (text: string): unknown => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

const str = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

export type Read = {
  isClear: boolean
  intent: string
  pick: Pick
  questions: UpgradeQuestion[]
}

/** The Haiku read: whether the prompt is clear, the questions worth asking, and the pick. */
export const parseRead = (text: string, fallback: Pick): Read | undefined => {
  const json = firstJson(text) as Record<string, unknown> | undefined
  if (!json || typeof json !== 'object') return undefined
  const { model, effort } = normalise(str(json.model, 10), str(json.effort, 10), fallback)
  const raw = Array.isArray(json.questions) ? json.questions : []
  const questions: UpgradeQuestion[] = []
  for (const [index, one] of raw.entries()) {
    if (!one || typeof one !== 'object') continue
    const item = one as Record<string, unknown>
    const options = (Array.isArray(item.options) ? item.options : [])
      .map(option => str(option, 60))
      .filter(Boolean)
      .slice(0, 4)
    const question = str(item.question, 200)
    if (!question || options.length < 2) continue
    const recommended = typeof item.recommended === 'number' && item.recommended >= 0 && item.recommended < options.length ? item.recommended : 0
    questions.push({ id: `q${index + 1}`, topic: str(item.topic, 14) || `Question ${index + 1}`, question, options, recommended })
  }

  return {
    isClear: json.clear === true || questions.length === 0,
    intent: str(json.intent, 60),
    pick: { model, effort, reason: str(json.reason, 40) || fallback.reason, by: 'haiku' },
    questions,
  }
}

/** The classify-only read. */
export const parseClassify = (text: string, fallback: Pick): Pick | undefined => {
  const json = firstJson(text) as Record<string, unknown> | undefined
  if (!json || typeof json !== 'object') return undefined
  const { model, effort } = normalise(str(json.model, 10), str(json.effort, 10), fallback)

  return { model, effort, reason: str(json.reason, 40) || fallback.reason, by: 'haiku' }
}

/** The rewrite: the prompt between <prompt> tags, then `PICK: opus high | reason`. */
export const parseRewrite = (text: string, fallback: Pick): { prompt: string; pick: Pick } | undefined => {
  const match = /<prompt>\s*([\s\S]*?)\s*<\/prompt>/i.exec(text)
  const prompt = (match?.[1] ?? '').trim()
  if (!prompt) return undefined
  const line = /PICK:\s*([a-z]+)\s+([a-z]+)\s*(?:\|\s*(.+))?/i.exec(text)
  const { model, effort } = normalise(line?.[1]?.toLowerCase(), line?.[2]?.toLowerCase(), fallback)

  return { prompt, pick: { model, effort, reason: (line?.[3] ?? '').trim().slice(0, 40) || fallback.reason, by: 'upgrader' } }
}

/** The answers as the rewrite reads them. */
export const answersText = (questions: UpgradeQuestion[], answers: Record<string, { choice?: number; text?: string }>, extra: string) => {
  const lines = questions.map(question => {
    const answer = answers[question.id]
    const words = answer?.text?.trim() || (answer?.choice !== undefined ? question.options[answer.choice] : undefined)

    return `- ${question.question} → ${words ?? '(no preference)'}`
  })
  if (extra.trim()) lines.push(`- Also: ${extra.trim()}`)

  return lines.join('\n')
}

// ── Batches of questions ───────────────────────────────────────────────────

/** The upgrader asks its questions this many at a time. */
export const BATCH_SIZE = 3

export const batchCount = (questions: readonly UpgradeQuestion[]) => Math.max(1, Math.ceil(questions.length / BATCH_SIZE))

/** The questions of one batch. */
export const batchOf = <T>(questions: readonly T[], batch: number) => questions.slice(batch * BATCH_SIZE, (batch + 1) * BATCH_SIZE)

/** The questions asked so far: every batch up to and including this one. Only these reach the rewrite. */
export const seenQuestions = <T>(questions: readonly T[], batch: number) => questions.slice(0, (batch + 1) * BATCH_SIZE)

/** "Questions 1–3 of 7", or "1 question" / "2 questions" when they fit in one batch. */
export const batchLabel = (count: number, batch: number) => {
  if (count <= BATCH_SIZE) return count === 1 ? '1 question' : `${count} questions`
  const from = batch * BATCH_SIZE + 1
  const to = Math.min(count, (batch + 1) * BATCH_SIZE)

  return from === to ? `Question ${from} of ${count}` : `Questions ${from}–${to} of ${count}`
}

// ── Answers remembered per project ─────────────────────────────────────────

/** How many answers a project keeps; the oldest go first. */
export const MEMORY_KEPT = 40

/** Lower case, accents and punctuation off, spaces squeezed: how two questions are compared. */
export const plainWords = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const memoryKey = (one: { topic: string; question: string }) => `${plainWords(one.topic)}|${plainWords(one.question)}`

/** Adds the newly given answers; a question answered again keeps only its newest answer. */
export const rememberAnswers = (memory: readonly RememberedAnswer[], given: readonly RememberedAnswer[]) => {
  const fresh = given.filter(one => one.answer.trim() !== '')
  const keys = new Set(fresh.map(memoryKey))

  return [...memory.filter(one => !keys.has(memoryKey(one))), ...fresh].sort((a, b) => a.at - b.at).slice(-MEMORY_KEPT)
}

/** The remembered answer for a question: the same question first, else the newest answer on the same topic. */
export const recall = (question: UpgradeQuestion, memory: readonly RememberedAnswer[]) => {
  const same = memory.filter(one => plainWords(one.question) === plainWords(question.question))
  const topic = memory.filter(one => plainWords(one.topic) === plainWords(question.topic))
  const pool = same.length > 0 ? same : topic

  return [...pool].sort((a, b) => b.at - a.at)[0]
}

/** A question's starting answer: the remembered one when there is one (an option it names, else its words), else the recommendation. */
export const startingAnswer = (question: UpgradeQuestion, memory: readonly RememberedAnswer[]): UpgradeAnswer => {
  const found = recall(question, memory)
  if (!found) return { choice: question.recommended }
  const choice = question.options.findIndex(option => plainWords(option) === plainWords(found.answer))

  return choice >= 0 ? { choice, remembered: true } : { choice: question.recommended, text: found.answer, remembered: true }
}

/** The words of an answer: the person's own, else the option chosen. */
export const answerWords = (question: UpgradeQuestion, answer: UpgradeAnswer | undefined) =>
  answer?.text?.trim() || (answer?.choice !== undefined ? (question.options[answer.choice] ?? '') : '')

/** What the read is told about this project's earlier decisions, newest first; empty when there are none. */
export const memoryBlock = (memory: readonly RememberedAnswer[], max = 12) => {
  const newest = [...memory].sort((a, b) => b.at - a.at).slice(0, max)
  if (newest.length === 0) return ''

  return `Decisions the developer already made in this project, in earlier prompts (newest first):\n${newest.map(one => `- ${one.topic}: ${one.question} → ${one.answer}`).join('\n')}`
}

// ── Where a prompt can be held ─────────────────────────────────────────────

/**
 * The panel only where a surface that places panes is attached and the prompt was typed there; the question dialog
 * when it came over Remote Control (a phone, the web) or only a phone is attached; not held at all when nothing
 * draws (a headless run), so no prompt ever waits for a panel nobody can see.
 */
export const holdMode = (origin: string, surfaces: readonly string[]): HoldMode => {
  if (surfaces.length === 0) return 'pass'
  if (origin === 'bridge') return 'dialog'

  return surfaces.some(surface => surface !== 'mobile') ? 'panel' : 'dialog'
}
