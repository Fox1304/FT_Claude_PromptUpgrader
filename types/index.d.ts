export type ModelName = 'haiku' | 'sonnet' | 'opus'

/** The four levels the chooser uses; `xhigh` is shown as "Extra". Low is never used. */
export type Effort = 'medium' | 'high' | 'xhigh' | 'max'

/** Who settled a pick: the local rules, a Haiku read, the upgrader's rewrite, the person, or the chooser keeping what runs. */
export type PickSource = 'rules' | 'haiku' | 'upgrader' | 'you' | 'kept' | 'trusted'

export type Pick = {
  model: ModelName
  effort: Effort
  /** Two to five plain words: "multi-file feature". */
  reason: string
  by: PickSource
  /** The kind of task the rules saw ("engineering", "routine"…); trust is kept per kind. */
  kind?: string
}

/** How many times in a row the person kept the recommended pick for one kind of task. */
export type TrustEntry = { streak: number; at: number }

/** What one turn on a model and effort costs, in points of the 5-hour window (a moving average). */
export type TurnCost = { avg: number; n: number }

/** The 5-hour window's reading when a main turn started, and what it ran on. */
export type TurnStartMark = { key: string; percent: number }

export type UpgradeQuestion = {
  id: string
  /** A short chip: "Scope", "Done when". */
  topic: string
  question: string
  options: string[]
  /** Index of the option preselected. */
  recommended: number
}

/**
 * A question's answer: an option, or the person's own words (which win).
 * `touched`: the person chose or typed it; `remembered`: it came from this project's memory.
 */
export type UpgradeAnswer = { choice?: number; text?: string; touched?: boolean; remembered?: boolean }

/** An answer the person gave in an earlier upgrade of the same project, kept on this machine only. */
export type RememberedAnswer = { topic: string; question: string; answer: string; at: number }

/** How a held prompt is worked on: the panel, the question dialog (a phone, the web), or not held at all. */
export type HoldMode = 'panel' | 'dialog' | 'pass'

export type UpgradeStage = 'questions' | 'writing' | 'ready' | 'failed'

/** What moving to another model mid-conversation costs: nothing to say, little, or a full re-read. */
export type SwitchCost = {
  kind: 'none' | 'cheap' | 'costly'
  /** A sentence for the panel. */
  note: string
  /** A clause for the dialog. */
  short: string
  /** The conversation's size, "90k". */
  tokens: string
}

/** One run of the prompt upgrader, drawn by its panel. */
export type Upgrade = {
  id: string
  stage: UpgradeStage
  original: string
  /** What the prompt asks, in six words or fewer. */
  intent: string
  questions: UpgradeQuestion[]
  /** Which group of three questions the panel shows (0 first); the questions before it were seen too. */
  batch: number
  answers: Record<string, UpgradeAnswer>
  /** "Anything to add?" */
  extra: string
  improved: string
  /** Earlier rewrites, newest last, so a tweak can be taken back. */
  previous: string[]
  pick: Pick
  /** True once the person changed the model or effort in the panel: the rewrite then keeps it. */
  pickTouched: boolean
  /** The model/effort chips are open in the questions step. */
  chipsOpen: boolean
  /** Whether the model chooser is on: the panel then shows and applies the pick. */
  chooser: boolean
  /** What runs now in this conversation (null in a fresh one), and how much it holds. */
  from: { model: ModelName; effort: Effort } | null
  contextTokens: number
  switch: SwitchCost
  /** What went wrong while writing. */
  error: string
  /** A one-line confirmation after Copy. */
  notice: string
}

/** A usage window as the band shows it. */
export type UsageWindow = { kind: string; percent: number; resetsAt?: string }

/** The prompt cache's state per model: when each last answered in this conversation. */
export type CacheClock = Partial<Record<ModelName, number>>

/** An improved prompt handed to the box to edit: the next prompt runs on its pick, with no questions. */
export type Handoff = { pick: Pick; until: number }

declare module 'claude-code' {
  interface PluginState {
    'prompt-pilot': {
      /** What runs now: every main request of the session goes to it. */
      active: Pick | null
      /** The upgrader's panel, while one runs. */
      upgrade: Upgrade | null
      /** What the band says while a prompt is being read. */
      busy: string
      usage: UsageWindow[]
      cache: CacheClock
      handoff: Handoff | null
      turnStart: TurnStartMark | null
      chooserOn: boolean
      upgraderOn: boolean
    }
  }
}
