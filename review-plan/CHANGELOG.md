# Changelog

## 1.0.0 — 2026-04-17

Initial standalone release, extracted from the `review-areas` plugin.

### Added

- **review-plan skill** — reviews implementation plans by fanning out parallel subagents across completeness, feasibility, sequencing, scope, and risk, then synthesizes deduplicated findings ordered by severity.
- **remind-plan-review hook** — PostToolUse hook that fires after `plan.md` is written to session memory and reminds the agent to run the review before proceeding.
