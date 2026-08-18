# Claude Code Hooks Configuration

This directory contains hooks for Claude Code to enforce testing and auto-commit workflows.

## Available Hooks

### 1. `test-before-write.sh`
Runs tests before allowing file modifications to ensure code quality.

**When it runs:** Before Write/Edit operations on TypeScript files
**What it does:** Executes `bun test` and blocks changes if tests fail
**Exit code:** 0 = tests passed, 1 = tests failed (blocks change)

### 2. `auto-commit.sh`
Automatically commits changes with a descriptive message.

**When it runs:** Can be called manually or at conversation end
**What it does:** Stages all changes and creates a git commit with AI-generated message
**Exit code:** Always 0 (never blocks)

## Configuration

To enable these hooks, update your Claude Code configuration file at `~/.config/claude/config.json`:

```json
{
  "hooks": {
    "tool-call-hook": "/Users/cyrille/github.nosync/personal/deribit-historical-data/.claude/hooks/test-before-write.sh",
    "conversation-end-hook": "/Users/cyrille/github.nosync/personal/deribit-historical-data/.claude/hooks/auto-commit.sh"
  }
}
```

**Note:** Replace the paths with the absolute path to your project.

### Alternative: Use relative paths

If you want to use relative paths, you can set hooks per-project by using:

```bash
# In your project directory
export CLAUDE_HOOKS_DIR="$(pwd)/.claude/hooks"
```

## Manual Usage

You can also run these hooks manually:

```bash
# Run tests
./.claude/hooks/test-before-write.sh

# Commit changes
./.claude/hooks/auto-commit.sh
```

## How It Works

1. **Test Hook (`tool-call-hook`):**
   - Triggered before Write/Edit tool calls
   - Runs `bun test` in project root
   - If tests pass (exit 0): allows the file change
   - If tests fail (exit 1): blocks the file change and shows error

2. **Commit Hook (`conversation-end-hook`):**
   - Can be triggered at conversation end or manually
   - Checks if there are changes (`git diff`)
   - Stages all changes (`git add .`)
   - Creates commit with descriptive message
   - Includes Co-Authored-By for attribution

## Workflow Example

```bash
# Claude Code workflow with hooks enabled:

1. User: "Update the fetch-trades function"
2. Claude: [modifies file]
3. Hook: test-before-write.sh runs
4. Hook: ✅ All tests passed! Proceeding with file changes.
5. File is written
6. User: "Great, commit the changes"
7. Claude: [conversation ends or user requests commit]
8. Hook: auto-commit.sh runs
9. Hook: ✅ Changes committed successfully!
```

## Disabling Hooks

To temporarily disable hooks, you can:

1. **Comment out in config:**
   ```json
   {
     "hooks": {
       // "tool-call-hook": "...",
       // "conversation-end-hook": "..."
     }
   }
   ```

2. **Or remove the hooks section entirely**

## Troubleshooting

**Tests failing unexpectedly?**
- Run `bun test` manually to see detailed output
- Check that all dependencies are installed
- Ensure you're in the correct directory

**Commits not being created?**
- Check that you're in a git repository
- Verify you have git configured (name/email)
- Ensure the hook script is executable (`chmod +x`)

**Hook not running?**
- Verify the path in `~/.config/claude/config.json` is absolute and correct
- Check that the script is executable
- Look at Claude Code logs for hook errors

---

## Documentation Hooks

### 3. `doc-sync-hook.sh`
Checks if code changes require documentation updates (warns but doesn't block).

**When it runs:** Before Write/Edit operations on critical files
**What it does:**
- Detects changes to CLI, API, database schema, or core logic
- Suggests which documentation files should be reviewed
- Warns but allows changes to proceed

**Exit code:** Always 0 (never blocks, only warns)

**Triggered by changes to:**
- `src/cli/index.ts` → docs/operations.md, docs/api-reference.md
- `src/infrastructure/deribit-client.ts` → docs/deribit-api.md
- `src/infrastructure/database.ts` → docs/data-model.md
- `src/infrastructure/jsonl-storage.ts` → docs/data-model.md, docs/design-decisions.md
- `src/application/fetchers/*.ts` → docs/architecture.md, docs/design-decisions.md
- `src/domain/*.ts` → docs/api-reference.md

**Example output:**
```
📚 Documentation Sync Check
─────────────────────────────
⚠️  Changed: src/cli/index.ts

📝 Suggested documentation updates:
   • docs/operations.md
   • docs/api-reference.md

💡 Tip: Review these docs to ensure they reflect the changes
```

### 4. `doc-update-hook.sh`
Runs at conversation end to review all changes and recommend documentation updates.

**When it runs:** Conversation end (automatically)
**What it does:**
- Analyzes all modified files in the session
- Categorizes changes by layer (CLI, Infrastructure, Domain, Application)
- Generates comprehensive update recommendations
- Shows which docs were already updated

**Exit code:** Always 0 (informational only)

**Example output:**
```
📚 Documentation Update Check
══════════════════════════════

Modified files in this session:
  • src/cli/index.ts
  • src/infrastructure/database.ts
  • docs/operations.md

📝 Recommended Documentation Updates:

• Update docs/api-reference.md - CLI API changes
• Update docs/data-model.md - Database schema changes
• Update docs/operations.md - CLI command changes

✓ Documentation updated:
  ✓ docs/operations.md

───────────────────────────────
💡 Next steps:
  1. Review recommended doc updates
  2. Run: bun src/cli/index.ts help
  3. Test changes with: bun test
```

### 5. `doc-reference-hook.sh`
On-demand tool to extract API reference from code.

**When it runs:** Manually (not automatic)
**What it does:**
- Extracts CLI help text
- Lists public function exports from domain layer
- Lists public class exports
- Provides summary of API surface

**Usage:**
```bash
./.claude/hooks/doc-reference-hook.sh
```

**Example output:**
```
📖 Documentation Reference Generator
════════════════════════════════════

Generating CLI reference...
✓ Found CLI commands:
  • fetch-instruments
  • fetch-trades
  • fetch-deliveries
  • fetch-all
  • stats
  • help

Checking TypeScript exports...
✓ Black-76 exports:
  • export function black76Call
  • export function black76Put
  • export function delta
  • export function gamma
  • export function vega
  • export function theta
  • export function calculateGreeks

✓ Moneyness exports:
  • export function determineMoneyness
  • export enum Moneyness

✓ Public classes:
  • DeribitClient
  • Database
  • JSONLStorage
  • FutureFetcher
  • OptionFetcher
  • DeliveryFetcher

───────────────────────────────
📚 Reference Documentation:
  • CLI Commands: 6 commands
  • Black-76 Functions: 7 exports
  • Moneyness Functions: 2 exports

💡 To update api-reference.md:
  1. Review extracted signatures above
  2. Manually update docs/api-reference.md
  3. Ensure examples are current
```

## Documentation Hook Configuration

To enable documentation hooks alongside test and commit hooks:

```json
{
  "hooks": {
    "tool-call-hook": "/path/to/.claude/hooks/doc-sync-hook.sh",
    "conversation-end-hook": "/path/to/.claude/hooks/doc-update-hook.sh"
  }
}
```

**Note:** You can chain multiple hooks using a wrapper script if needed.

## Manual Usage

```bash
# Check if docs need updates before making changes
./.claude/hooks/doc-sync-hook.sh

# Review session changes and get update recommendations
./.claude/hooks/doc-update-hook.sh

# Generate API reference from code
./.claude/hooks/doc-reference-hook.sh
```

## Documentation Workflow

1. **Before coding:** Review relevant docs in `/docs`
2. **While coding:** doc-sync-hook warns if critical files changed
3. **After coding:** doc-update-hook suggests which docs to update
4. **Periodic:** Run doc-reference-hook to sync API reference with code

## Documentation Structure

```
docs/
├── README.md              # Documentation hub
├── overview.md            # Project goals and use cases
├── architecture.md        # System design and layers
├── design-decisions.md    # Architectural choices and trade-offs
├── data-model.md          # Database schema and JSONL format
├── deribit-api.md         # API integration details
├── operations.md          # Installation and usage
├── development.md         # Contributing guide
└── api-reference.md       # CLI and TypeScript API reference
```

See `docs/README.md` for complete documentation index.
