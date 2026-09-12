# ADR 0003: Standalone Fork Scope

*Status: Accepted*

## Context

This package began as a copy of
[Eddie0521/pi-profile](https://github.com/Eddie0521/pi-profile) (MIT,
Copyright 2026 acumen7) and evolved in a direction the upstream package did
not follow: ADR 0002 makes profiles prompt-inert, which removes the
system-prompt feature at the core of the original design. The fork also
duplicates capabilities the maintainer's own orchestration package already
owns (subagent fleet management).

Continuing to publish under the unscoped name would imply continuity with
upstream that no longer exists, and would leave ownership of the npm name
ambiguous.

## Decision

1. **Scoped npm name.** The package publishes as `@saifymatteo/pi-profile`,
   version line starting at **0.3.0**. Upstream's `pi-profile` package is
   untouched.
2. **Credit.** The MIT license text retains the upstream copyright line
   (`acumen7`) and adds the fork author's line (`saifymatteo`). The README
   carries a Credits section naming the origin repository. ADR 0001 and
   ADR 0002 record which upstream decisions stand and which are withdrawn.
3. **Upstream remote removed.** The `upstream` git remote is deleted so
   nothing can ever be pushed to the original repository by accident. All
   work happens on `saifymatteo/pi-profile`; nothing is ever posted to the
   upstream tracker.
4. **Cut list.** The following are removed outright, with no migration
   tooling:
   - **System prompt feature** — profile `systemPrompt` key and the
     `before_agent_start` handler (see ADR 0002).
   - **Session naming** — profile `sessionName` key and every call to the
     session-rename API.
   - **Subagent sync subsystem** — the sync module (manifest tracking,
     conflict detection, orphan cleanup), all calls in profile
     application/removal/session-start paths, the status-panel subagent
     block, and the subagent configuration type. Agent fleets are owned by
     the orchestration package's native agent-file discovery; agent markdown
     files are the single source of truth.
5. **No migration shim.** The fork has no deployed users. Legacy keys in
   profile files are tolerated silently and are inert by construction
   (unknown keys are ignored — ADR 0002). There is no migration tooling for
   legacy manifests or previously synced agent files, and no dead weight in
   the codebase for users that don't exist.
6. **English-only documentation.** The Chinese README and its
   language-switcher links are removed; localization is out of scope for
   this fork's maintenance appetite.

## Consequences

- Users of upstream `pi-profile` are not affected; upstream remains theirs.
- Pre-fork profile files with removed keys keep loading — the keys are
  ignored, not rejected.
- Fleet composition moves entirely to the orchestration package's native
  mechanism (agent markdown files in user-level and project-level
  directories). Per-profile fleet composition, if ever needed again, belongs
  in that package, not here.
