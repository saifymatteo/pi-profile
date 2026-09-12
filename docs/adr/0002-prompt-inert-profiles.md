# ADR 0002: Prompt-Inert Profiles

*Status: Accepted (supersedes the skill-filtering and system-prompt-append
decisions of ADR 0001; ADR 0001's identity-vs-security boundary stands)*

## Decision

Profiles are **prompt-inert runtime identities**: model binding, 2-layer skill
restriction, and UI-only metadata. Nothing else.

- **No code path modifies the system prompt.** The `before_agent_start`
  handler that filtered the `<available_skills>` XML block and appended a
  profile identity block (label, name, description, system prompt, subagent
  list) is deleted outright. This is an architectural guarantee, not input
  validation: no profile key can modify or append to the system prompt
  because no code path exists that touches it.
- **Unknown profile keys are silently ignored**, including `$schema` and the
  legacy removed keys (`systemPrompt`, `sessionName`, `subagents`). This is
  safe precisely because the guarantee comes from the absence of code, not
  from schema validation. Strict-schema rejection was considered and
  withdrawn — it would add rejection churn without strengthening any
  guarantee.
- **Session naming is removed.** Profiles never call the session-rename API;
  session names a user sets are theirs alone.
- **Model binding is applied at launch (flag, `PI_PROFILE`, saved active
  profile) silently.** Mid-session switches apply skill restriction and UI
  updates immediately, then apply model binding last; a warning fires only
  when the target provider+model differs from the currently selected model.

## Context: why the previous design failed

The extension previously filtered the skills XML block in the system prompt
(Layer 1 of the "3-layer skill defense") and appended a profile identity
block on every turn. Investigation against the shipped pi binary (v0.85.1)
showed this is structurally unreliable:

- **Stock pi** emits the skills section as an XML block
  (`<available_skills>` containing `<skill>` entries with
  `<name>`/`<description>`/`<location>`), so the regex-based filter did match
  stock pi.
- **In real environments, the cache-optimizer package (v2.8.9) rewrites that
  block** into a compressed one-line index built from the *unfiltered*
  native skill list, and its handler runs before this extension's
  (alphabetical extension load order). The filter then finds no XML block
  and silently no-ops.
- **Observed symptom, fully explained:** all skills were listed in the prompt
  while autocomplete filtering and read blocking still worked.
- **Conclusion:** a prompt filter that any prompt-rewriting co-extension can
  silently defeat is not a guarantee. Prompt inertness removes the entire
  class of failure.

## The KV-cache invariant

The system prompt heads the provider's prompt-cache prefix. Any content
change — even a one-line label — invalidates the whole conversation's cache:
every subsequent turn re-prices the full conversation at uncached input
rates. Since profiles appended UI metadata (label, description) and filtered
skill lists into the system prompt on every turn, *any* profile switch
mid-session silently destroyed the cache.

With prompt-inert profiles, a mid-session switch changes only the extension's
own state (skill restriction at tool-use time, autocomplete filtering, status
bar). The system prompt is untouched, so the cached prefix survives. Model
identity is a separate hard cache boundary — a different provider+model
cannot share the cached prefix. That switch is therefore allowed but warned
about: a warning notification fires only when the target model differs from
the currently selected model. Thinking-level-only deltas never warn (they
don't change the prompt prefix), and launch-time application never warns
(the cache is cold anyway). Re-applying the same profile never warns.

## Consequences

- **Skill visibility is native, enforcement is at use.** The LLM may see
  restricted skills listed in the prompt (pi lists them natively — including
  rewritten/compressed listings from other extensions). Restriction is
  enforced identically on every turn by the `tool_call` read interception
  and the autocomplete filter, neither of which depends on the system
  prompt's format.
- **Extension interop is irrelevant by construction.** Profile semantics are
  identical with or without prompt-optimizing extensions, because profiles
  no longer participate in prompt construction.
- **The `before_agent_start` complexity noted in ADR 0001 is gone** — with
  it, the coupling to pi's internal `<available_skills>` format.
- **Removed features cannot regress.** There is no prompt-mutation code to
  reintroduce accidentally without deleting an architectural invariant that
  the test suite asserts (no handler registered for prompt-affecting events).
