# Claude Prompt Upgrader

A Claude Code mod that works on every prompt you send, in two parts you can switch on and off separately:

- **Prompt upgrader**: when a prompt asks for something substantial but leaves things open, it is held for a moment while a small model reads it. Clear prompts go through untouched. Otherwise a panel asks you up to three short questions, then offers a rewritten prompt you can launch, edit, copy or drop in favour of your original.
- **Model chooser**: picks the model (Opus, Sonnet, Haiku) and the effort (Medium, High, Extra, Max) that fit each prompt, and asks you to confirm when it matters.

The two live in one mod because the upgrader must run first and hand the chooser the model it settled on.

The mod's plugin name is `prompt-pilot`.

## What it does

### Prompt upgrader

- Runs on prompts of 12 words or more that are not an answer to a question Claude just asked, and have no attachment.
- A small model (Haiku) reads the prompt with the start of your project's `CLAUDE.md` as context. If the prompt is clear, it runs as typed, with « ✓ Your prompt is clear ».
- If not, the prompt is held and the **Prompt upgrader** pane opens:
  - up to 3 questions, each with ready answers (●/○) or « Or type your own answer… », plus « Anything to add? »;
  - **Improve**: Sonnet rewrites the prompt with your answers and proposes a model and effort;
  - then **Launch** on the proposed model, change the model or effort, « Ask for a change », **Copy**, **Edit in box** (puts it back in your prompt box), **Send original**, or **Cancel** (your prompt comes back to the box).

### Model chooser

- Rules first (English and French keywords: shipping, planning, quick checks, status pings, long engineering prompts…), and a quick Haiku read only when the rules are unsure.
- Asks you to confirm for substantial prompts, and for short ones only when the pick would change. Go-aheads (« yes », « continue », « vas-y ») are never asked.
- After 5 kept recommendations in a row for one kind of prompt, it stops asking for that kind (« · auto » in its band). `/chooser reset` makes it ask again.
- Mid-conversation, switching to another model re-reads the whole conversation without the prompt cache. When that is costly, it offers **Switch**, **Stay** (cheapest) or **New conversation (with recap)**. A long conversation (over about 150k tokens) never moves.
- A band above the prompt shows the current pick and, on a subscription plan, how much of the 5-hour and weekly windows you have used. Toasts warn at 80 % (configurable) and 95 %.

### Tags

Put them at the start or the end of a prompt; they are removed before it is sent.

| Tag | Effect |
|---|---|
| `!!` | no upgrader for this prompt |
| `??` | the upgrader even for a short prompt |
| `!opus` `!sonnet` `!haiku` | force the model |
| `!medium` `!high` `!extra` `!max` | force the effort |

## Requirements

- **Claude Code 2.1.288 or later** (terminal, or the desktop app's Code tab).
- **Mods (plugin hooks modules) enabled for your account.** They are an early-access feature that Anthropic switches on per account. When the switch is off, Claude Code still installs the mod but does not load it.
- Access to the models it uses: by default `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` (change them in the options). The upgrader's reads and rewrites run on your own account, like any other Claude Code request.
- macOS for one fallback only: when the app cannot put text in your prompt box or clipboard, the mod uses `pbcopy`. Elsewhere that one fallback is skipped.
- No other dependency: no npm install, no build step.

## Install

In a **terminal** Claude Code session (the desktop app's Code tab does not offer this command), type:

```
/plugin install prompt-pilot --marketplace Fox1304/FT_Claude_PromptUpgrader
```

Answer `y` to add the marketplace, then pick the **user** scope so it loads in every project. The mod is active at once in that session, and in every session started afterwards, including the desktop app.

Or from a shell, with the same result:

```
claude plugin marketplace add Fox1304/FT_Claude_PromptUpgrader
claude plugin install prompt-pilot@claude-prompt-upgrader --scope user
```

To remove it: `/plugin uninstall prompt-pilot`, or `claude plugin uninstall prompt-pilot@claude-prompt-upgrader`.

### Run it from a clone instead

```
git clone https://github.com/Fox1304/FT_Claude_PromptUpgrader.git
claude --plugin-dir ./FT_Claude_PromptUpgrader
```

To load it in every session without installing it, add the clone's absolute path to `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`.

## Usage

Type prompts as usual. Then:

- `/upgrader on`, `/upgrader off`: switch the prompt upgrader on or off in every session.
- `/chooser on`, `/chooser off`: the same for the model chooser; `/chooser reset` makes it ask for confirmation again.
- Esc or **Cancel** in the upgrader pane gives you your prompt back, untouched.

### Options

Set them in `/config` (or under `pluginConfigs` in `~/.claude/settings.json`):

| Option | Default | What it does |
|---|---|---|
| `opusModel` | `claude-opus-5-5` | the model id used for Opus picks |
| `sonnetModel` | `claude-sonnet-5-5` | the model id used for Sonnet picks and rewrites |
| `haikuModel` | `claude-haiku-5-5` | the model id used for Haiku picks and for reading prompts |
| `cacheMinutes` | `60` | how long a model's prompt cache counts as warm after its last answer |
| `usageWarnPercent` | `80` | plan usage share that triggers a warning |

## Your data

The mod keeps its switches and what it learned (kept recommendations, the average cost of a turn per model and effort) in Claude Code's own plugin store (`~/.claude/plugins/store/`). It sends nothing anywhere except to Claude, through your own Claude Code session.

## Development

```
claude plugin validate .
claude plugin test .
```

`claude plugin test` runs the `tests/*.test.ts(x)` files against Claude Code's own engine (it needs mods enabled). Claude Code lays the API typings in `.claude-plugin/types/` the first time it loads the mod; `tsc -p .` type-checks it after that.

| Path | What it holds |
|---|---|
| `hooks/register.tsx` | the hooks: prompt interception, the upgrader pane, the chooser's confirm and band |
| `hooks/decide.ts` | pure logic: rules, tags, switch costs, trust and turn-cost learning |
| `hooks/prompts.ts` | the instructions the small models read |
| `types/index.d.ts` | the shapes of the mod's state |
| `tests/` | engine tests, with `world.ts` standing in for the store, the clock and the models |

## Licence

MIT, see [LICENSE](LICENSE).
