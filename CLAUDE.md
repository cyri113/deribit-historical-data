---
description: Claude Code bootstrap. Read before every task.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: true
---

# Claude Code Rules

## Read First

1. `./.claude/README.md` – Hooks system
2. `./docs/design-decisions.md` – Constraints
3. `./docs/architecture.md` – System design

## Your Hooks

- **test-before-write.sh**: Blocks on test failure. Tests must pass.
- **doc-sync-hook.sh**: Warns which docs need updates. Acknowledge the warning.
- **doc-update-hook.sh**: Runs at end. Review and apply recommendations.
- **auto-commit.sh**: Manual only. Never assume it runs automatically.

## Workflow

**Before coding:** Identify files you'll change → check doc mappings in `./.claude/README.md` → read those docs → check `design-decisions.md` for conflicts.

**After coding:** Tests run. If they pass, acknowledge doc-sync warnings and update flagged docs. At session end, review doc-update recommendations.

**At end:** Offer to commit. Don't commit without your confirmation.

## Red Flags

- ❌ Skip checking `design-decisions.md` before major changes
- ❌ Skip doc updates after code changes
- ❌ Commit without confirmation
- ❌ Use `npm`, `yarn`, `pnpm`, or `node` (use `bun` instead)

## Bun Only

Commands: `bun <file>`, `bun test`, `bun run <script>`, `bun install`, `bunx <pkg>`

APIs: `Bun.serve()`, `bun:sqlite`, `Bun.sql`, `Bun.file()`, `Bun.$`cmd``

No `express`, `jest`, `webpack`, `better-sqlite3`, or `pg`.

Frontend: Use HTML imports + `Bun.serve()`. No `vite`.

```ts#index.ts
import index from "./index.html"
Bun.serve({ routes: { "/": index } })
```

See `node_modules/bun-types/docs/**.mdx` for details.