#!/usr/bin/env bash
#
# Pre-Commit Orchestrator Hook
#
# Runs comprehensive validation before allowing commits:
# 1. Full test suite
# 2. Documentation enforcement
# 3. Coverage check (warning only)
#
# This hook ensures commits meet quality standards.
#
# Exit: 0 = all checks passed, 1 = any check failed (blocks commit)

set -euo pipefail

# Get the project root
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

HOOKS_DIR=".claude/hooks"

echo ""
echo "═══════════════════════════════════════════════"
echo "🔒 Pre-Commit Quality Gate"
echo "═══════════════════════════════════════════════"
echo ""

# Check if there are changes to commit
if git diff --quiet && git diff --cached --quiet; then
  echo "ℹ️  No changes to commit"
  exit 0
fi

# Show what's being committed
echo "📝 Changes to be committed:"
git diff --name-only --cached | sed 's/^/  • /' || git status --short | sed 's/^/  /'
echo ""

# Phase 1: Full Test Suite (BLOCKING)
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Phase 1/3: Full Test Suite"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "🧪 Running full test suite..."
if bun test; then
  echo ""
  echo "✅ All tests passed"
else
  echo ""
  echo "❌ Tests failed"
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "🚫 Pre-Commit Quality Gate: FAILED"
  echo "═══════════════════════════════════════════════"
  echo ""
  echo "💡 Fix failing tests before committing"
  exit 1
fi
echo ""

# Phase 2: Documentation Enforcement (BLOCKING)
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Phase 2/3: Documentation Enforcement"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [[ -x "$HOOKS_DIR/doc-enforce.sh" ]]; then
  if "$HOOKS_DIR/doc-enforce.sh"; then
    echo "✅ Documentation requirements met"
  else
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "🚫 Pre-Commit Quality Gate: FAILED"
    echo "═══════════════════════════════════════════════"
    exit 1
  fi
else
  echo "⚠️  Doc enforcement hook not found (skipping)"
fi
echo ""

# Phase 3: Coverage Check (WARNING ONLY, non-blocking)
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Phase 3/3: Coverage Check (informational)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [[ -x "$HOOKS_DIR/coverage-check.sh" ]]; then
  # Coverage check warns but doesn't block
  "$HOOKS_DIR/coverage-check.sh" || true
else
  echo "ℹ️  Coverage check not configured (optional)"
fi
echo ""

# All checks passed
echo "═══════════════════════════════════════════════"
echo "✅ Pre-Commit Quality Gate: PASSED"
echo "═══════════════════════════════════════════════"
echo ""
echo "Commit allowed ✓"
echo ""

exit 0
