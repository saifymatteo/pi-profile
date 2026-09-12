# @saifymatteo/pi-profile

A pi extension for **prompt-inert runtime identity switching** — swap model
binding and skill restrictions in the same session, no restart needed, with
zero impact on the system prompt or the provider's prompt cache.

```bash
/profile researcher          # switch to the researcher identity
/profile default             # back to default
pi --profile researcher      # start directly in a profile
```

## Install

```bash
pi install npm:@saifymatteo/pi-profile
```

Example profiles (`default`, `researcher`) ship in the repo's
[`profiles/`](profiles/) directory — copy them to `~/.pi/profiles/` to start,
or build your own with `/profile create`.

## Quick start

```bash
# Use the researcher profile (ships as example)
pi --profile researcher

# Inside an interactive session
/profile researcher

# List all profiles
/profile list
```

## How it works

A profile is a **prompt-inert runtime identity**: model binding, 2-layer skill
restriction, and UI-only metadata. Nothing else. No profile key can modify or
append to the system prompt, because no code path exists that touches it —
the guarantee is architectural, not input validation.

| Concern | Mechanism | Effect |
|---------|-----------|--------|
| **Skills** | `tool_call` read interception | Reads of non-allowed `SKILL.md` files are blocked; the reason names the skill and the active profile |
| **Skills** | `addAutocompleteProvider` | Non-allowed `/skill:` entries and prompt templates are filtered from autocomplete |
| **Model** | `pi.setModel()` | Different profiles use different models; a mid-session switch that changes the model warns that it invalidates the provider's prompt cache |
| **Metadata** | status bar, listings | `label` / `description` are shown only to humans — they never reach the LLM |

> **Identity, not security.** Profile controls *who the AI is* — not what tools
> it can use or what commands are dangerous. Tool access and security policies
> are handled by dedicated extensions like `pi-permission-suite`.

## Profile files

Stored as `~/.pi/profiles/<name>.json`:

```json
{
  "name": "researcher",
  "label": "🔬 Deep Researcher",
  "description": "Deep research mode focused on web search and source synthesis",
  "model": {
    "provider": "opencode-go",
    "model": "kimi-k2.6",
    "thinkingLevel": "high"
  },
  "skills": ["learn", "wiki-read", "wiki-write"]
}
```

### Profile interface

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique ID (lowercase, no spaces); forced from the filename |
| `label` | `string?` | Display label (emojis OK) — status bar and listings only |
| `description` | `string?` | One-line summary shown in profile listings |
| `model` | `{provider, model, thinkingLevel?}` | Optional fixed model binding |
| `skills` | `string[]?` | Allowed skills (undefined = no restriction) |
| `prompts` | `string[]?` | Prompt templates visible in autocomplete |

Unknown keys — including `$schema` and legacy keys such as `systemPrompt`,
`sessionName`, or `subagents` — are silently ignored and have no effect.

### Skill restriction (2 layers)

When `skills` is set, non-allowed skills are restricted **at use**:

| Layer | What | How |
|-------|------|-----|
| 1 | Read interception | LLM calling `read()` on a non-allowed `SKILL.md` is blocked; the reason names the skill and the active profile |
| 2 | Autocomplete | `/skill:<name>` and prompt templates outside the profile don't appear in suggestions |

The LLM may still see restricted skills listed in the prompt (pi lists them
natively); enforcement happens when they are used. Path matching handles both
per-directory (`skills/<name>/SKILL.md`) and flat (`skills/<name>.md`) layouts.

### Prompt-cache stability

The system prompt heads the provider's prompt-cache prefix. Because profiles
never touch it:

- **Mid-session switches keep the cached prompt prefix** — you don't re-pay
  full input tokens after every switch.
- The one exception is the model itself: switching to a different
  provider+model invalidates the cache. That's a conscious decision, so a
  warning notification fires — but only when the model actually changes.
  Same-model switches, thinking-level-only changes, and launch-time
  application (CLI flag, `PI_PROFILE`, saved state) stay silent.

## Commands

| Command | Description |
|---------|-------------|
| `/profile` | Show current profile + available list |
| `/profile <name>` | Switch profile |
| `/profile list` | List all profiles |
| `/profile show <name>` | Show profile JSON |
| `/profile create` | Interactive wizard (AI-guided or manual) |
| `/profile rm <name>` | Delete profile |

## CLI

```bash
pi --profile <name>       # Start with profile (silent, cache is cold)
PI_PROFILE=<name> pi      # Via environment variable
```

## Credits

This package is a hard fork of
[pi-profile](https://github.com/Eddie0521/pi-profile) by
[acumen7 (Eddie0521)](https://github.com/Eddie0521). The fork removes the
system-prompt, session-name, and subagent-sync features in favor of
prompt-inert profiles (see
[ADR 0002](docs/adr/0002-prompt-inert-profiles.md) and
[ADR 0003](docs/adr/0003-standalone-fork.md)), and is published under its own
npm identity. Thank you to the original author for the foundation.
