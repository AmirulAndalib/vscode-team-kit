# Changelog

## 1.0.0 (2026-03-19)

- Initial release
- Added `/fix-issue` command — reads a GitHub issue, creates a branch, implements the fix with tests, and summarizes changes
- Added `/commit-and-pr` command — commits current work, pushes the branch, creates a PR via `gh`, and sets auto-merge
- Added `/pr-comments` command — fetches unresolved PR review comments, makes requested changes, and summarizes what was done
