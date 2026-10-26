import type { ModelName } from '../types'

/** How the chooser ranks work; shared by every read so the picks agree. */
export const POSTURE = `Pick the model and effort that will run the prompt. Aim for the strongest model the task deserves, without waste.
- opus: the default for real work — features, bug fixes, refactors, reviews, plans, anything multi-step or touching several files. effort "high"; "xhigh" for hard debugging, multi-file features, code reviews; "max" only for architecture, migrations, stubborn or subtle bugs (race conditions, leaks), research synthesis, or when the person asks for deep thought.
- sonnet: clearly routine work — a small single-file edit, a quick factual or how-to question, formatting, renaming, translating, git chores, running a command. effort "medium" or "high".
- haiku: trivial only — a greeting, thanks, a one-line lookup. effort "medium".
Never "low". reason: 2 to 5 plain words naming the task's kind ("multi-file feature", "quick question").`

export const CLASSIFY_SYSTEM = `You route a developer's prompt to Claude Code (an agentic coding assistant). ${POSTURE}
Answer with JSON only: {"model":"haiku|sonnet|opus","effort":"medium|high|xhigh|max","reason":"..."}`

export const READ_SYSTEM = `You triage a developer's prompt to Claude Code (an agentic coding assistant that reads and edits the code itself) before it runs. Answer with JSON only.

1. clear: true only when a competent developer could start right away with no decision left open: a precise bug report, a fully specified change, a plain question. A new feature, a redesign, or any request with several reasonable outcomes is NOT clear: ask about the decisions that would change the result. Never ask what Claude can find by reading the code or the project rules, nor what the developer's earlier decisions (listed with the prompt, when there are any) already settle, unless this prompt reopens it.
2. When not clear, ask every question whose answer would change the result (scope, expected outcome, constraints, approach, priorities), as many as the open decisions need and no more, most important first. Skip anything you would only be curious about. Each: "topic" (1-2 words, at most 12 characters), "question" (one short sentence ending in "?"), "options" (2 to 4 distinct answers of at most 48 characters, the likeliest first), "recommended" (index of the likeliest). Write them in the prompt's language.
3. ${POSTURE}
4. intent: what the prompt asks, in at most 6 words, in the prompt's language.

{"clear":false,"intent":"...","model":"opus","effort":"high","reason":"...","questions":[{"topic":"Scope","question":"...?","options":["...","..."],"recommended":0}]}`

const MODEL_HINT: Record<ModelName, string> = {
  opus: 'Opus plans well on its own: give it the goal, the decisions already made, the constraints and how to verify; do not dictate steps it can work out.',
  sonnet: 'Sonnet does best with a bounded task: name the area or files to touch and the exact expected result.',
  haiku: 'Haiku needs one bounded task, explicit steps and the exact expected output.',
}

export const REWRITE_SYSTEM = (target: ModelName) => `You rewrite a developer's prompt to Claude Code (an agentic coding assistant that reads and edits the code itself) so it gets an excellent result on the first try. Fold in the answers the developer just gave.

Rules:
- Keep the developer's intent, facts, names, paths, code and language: write in the language of their prompt. Add no requirement they did not state or choose.
- Claude already reads the project's rules (CLAUDE.md) and the code: never restate them. Mention a rule only when an answer decides something about it.
- Every sentence must change the outcome: no role-play ("You are an expert"), no politeness, no filler, no restating the obvious. Shorter is better when nothing is lost.
- Open with the goal as one imperative sentence. Then, only where they add something: the context Claude cannot find in the code; scope and constraints (what to touch, what to leave alone); the decisions made in the answers; how to tell it is done (behaviour to see, tests to pass). Use short bullets for several points; no headings for a small task.
- ${MODEL_HINT[target]}
- Then pick the model and effort for the rewritten prompt. ${'Opus is the default for real work; Sonnet for clearly routine work; Haiku for trivial work only; effort medium, high, xhigh or max, never low.'}

Answer exactly in this shape, nothing before or after:
<prompt>
the rewritten prompt
</prompt>
PICK: <haiku|sonnet|opus> <medium|high|xhigh|max> | <2 to 5 words naming the task's kind>`

export const RECAP_PROMPT = `Write a handoff note so a fresh Claude Code session can take over this work. Plain text, at most 12 lines: the goal, what is done (with file paths), decisions made and why, what is left, and anything that must not be redone or broken. No preamble.`
