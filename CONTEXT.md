# pi-profile — Domain Model

## Overview

pi-profile is an identity-switching extension for the Pi coding agent. A **Profile**
represents a runtime identity — a persona that controls model binding, skill
restriction, and UI-only metadata — not what security boundaries it operates
within.

Profile is a **prompt-inert pure identity concept** — orthogonal to security
policies (handled by pi-permission-suite), tool access control, and extension
management, and incapable of touching the system prompt.

## Invariants

### Prompt Purity (cache-stability invariant)

No code path in this extension reads, modifies, or appends to the system
prompt. The system prompt heads the provider's prompt-cache prefix, so any
mutation of it — even one line of UI metadata — invalidates the whole
conversation's cache. Prompt purity is what makes mid-session profile
switches cache-safe. It is enforced architecturally (no handler is
registered for prompt-affecting events), not by input validation. See
ADR 0002 for the investigation evidence that motivated it.

### Profile surface

`name`, `label`, `description` (UI-only), `model` (binding), `skills`
(restriction), `prompts` (autocomplete filtering). Nothing else. Unknown
keys in profile JSON — including `$schema` and legacy removed keys — are
silently ignored and inert by construction.

## Glossary

### Profile
A named set of configuration that defines Pi's runtime identity. Controls
model, skills, prompts, and UI metadata. Does NOT control tool access,
security permissions, extension loading, the system prompt, session naming,
or subagents. Stored as `~/.pi/profiles/<name>.json`.

### Default Profile
The built-in `default` profile. No skill restriction, no model binding. Acts
as the "full power" baseline — Pi's native behavior unchanged, all skills
and templates pass through.

### Identity Switching
The act of changing the active profile at runtime via `/profile <name>` or
CLI `--profile <name>`. This reconfigures model binding, skill restriction,
and UI metadata without restarting the session — and without invalidating
the provider's prompt cache (prompt purity), except when the model itself
changes, which is warned about.

### Skill Restriction
A **two-layer, enforcement-at-use** mechanism. The LLM may still see
restricted skills listed in the prompt (pi lists them natively; prompt-rewriting
extensions may compress them — irrelevant, since profiles never filter the
prompt). Restriction happens when skills are used:

```
Layer 1: Read Tool Interception (tool_call hook)
  → LLM calling read() on a non-allowed SKILL.md → blocked with a reason
    naming the skill and the active profile
  → Works even if the LLM knows the file path from conversation history
  → Path matching handles per-directory (skills/<name>/SKILL.md) and
    flat (skills/<name>.md) layouts

Layer 2: Autocomplete Filtering (autocomplete.ts)
  → /skill:<name> and prompt templates outside the profile do not appear
    in the autocomplete dropdown
```

When a profile's `skills` is undefined (not set), all skills remain usable
(identical to default profile behavior).

### Profile Model Binding
An optional fixed model (`provider` + `model` + `thinkingLevel`) that the
profile enforces via `pi.setModel()` when activated. Launch-time application
(CLI flag, environment variable, saved active-profile file) is silent — the
prompt cache is cold at startup. Mid-session application applies skill
restriction and UI updates immediately, then binds the model last; a warning
notification fires only when the target provider+model differs from the
currently selected model. Thinking-level-only deltas never warn.
Re-applying the same profile never warns.

### Model-Change Warning
The one notification a mid-session switch may fire. Model identity is a hard
prompt-cache boundary: a different provider+model cannot share the cached
prefix. The warning names the new model and says the switch invalidates the
provider's prompt cache for this conversation — making the cache cost a
conscious decision rather than a silent surprise.

## Architecture Layers

```
┌─────────────────────────────────────────────────────────┐
│  Pi Core (infrastructure)                                │
│  ├── Extensions    — always loaded, never                │
│  │                   profile-controlled                   │
│  ├── Skills        — all loaded at startup;              │
│  │                   profile restricts at USE            │
│  │                   (read interception + autocomplete)  │
│  └── System prompt — owned by pi core; profiles never    │
│                      touch it (prompt purity)            │
├─────────────────────────────────────────────────────────┤
│  Profile (prompt-inert runtime identity)                  │
│  ├── model         → pi.setModel() (last; warns when     │
│  │                   the model actually changes)         │
│  ├── skills[ ]     → 2-layer restriction                 │
│  │    Layer 1: read interception (tool_call)             │
│  │    Layer 2: autocomplete filtering                    │
│  ├── prompts[ ]    → autocomplete filtering              │
│  └── label/description → status bar + listings only      │
├─────────────────────────────────────────────────────────┤
│  pi-permission-suite (separate concern)                   │
│  ├── Tool whitelist / blacklist                          │
│  ├── Dangerous command patterns                          │
│  └── Protected paths                                     │
│  — Security is orthogonal to identity —                  │
└─────────────────────────────────────────────────────────┘
```

## Profile Interface

```typescript
interface Profile {
  name: string;                        // Unique ID, lowercase-no-spaces
  label?: string;                      // Display label (emojis OK)
  description?: string;                // One-line summary

  model?: {                            // Optional model binding
    provider: string;                  // e.g. "anthropic", "opencode-go"
    model: string;                     // e.g. "claude-sonnet-4", "kimi-k2.6"
    thinkingLevel?: ThinkingLevel;
  };

  skills?: string[];                   // Allowed skills (undefined = all)
  prompts?: string[];                  // Autocomplete-visible prompt templates
}
```

NOT on Profile (handled elsewhere or removed):
- `tools` — tool access control → pi-permission-suite or Pi settings
- `permissions` — dangerous commands, protected paths → pi-permission-suite
- `systemPrompt` — **removed** (prompt purity, ADR 0002)
- `sessionName` — **removed** (session names belong to the user)
- `subagents` — **removed** (agent markdown files are the single source of
  truth, owned by the orchestration package — ADR 0003)

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Profile vs Extension | Parallel concepts | Extension = registration mechanism, Profile = runtime identity |
| Extensions control | Not needed | All extensions always loaded; orthogonal to identity |
| Skill hiding | **2-layer Skill Restriction** | Enforcement at use; does not depend on the system prompt's format (see ADR 0002) |
| Prompt filtering | **None — prompt purity** | A prompt filter any prompt-rewriting co-extension can silently defeat is not a guarantee; profiles never touch the system prompt |
| Prompt-cache stability | Architectural invariant | Mid-session switches preserve the cached prefix; model changes warn instead of block |
| Tool/permission control | **Not profile's job** | Security is orthogonal to identity; handled by dedicated extension |
| before_agent_start | **Not used** | The prompt-mutation handler is deleted, not fixed |
| Subagent management | **Removed** | Owned by the orchestration package's native agent-file discovery (ADR 0003) |
| Session naming | **Removed** | Profiles never rename sessions |
| Unknown profile keys | Silently ignored | Forward-compatible; safe because prompt purity is architectural, not validated |
| /profile command | Keep existing | No need for /soul alias |
| Switch-then-compact | **Not needed** | The system prompt doesn't change on switch; no history compaction required |

## Related Files

- `~/.pi/profiles/<name>.json` — Profile definitions (no tools/permissions fields)
- `~/.pi/profiles/.active` — Persisted active profile name
