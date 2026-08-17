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
