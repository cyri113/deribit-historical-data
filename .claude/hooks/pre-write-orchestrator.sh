#!/usr/bin/env bash
#
# Pre-Write Orchestrator Hook
#
# Coordinates all pre-write checks in the correct sequence:
# 1. TDD Guard (new files only)
# 2. Test Suite (all tests)
# 3. Documentation Check (warnings)
#
# This is the main hook for user-prompt-submit or tool-call events.
#
# Exit: 0 = all checks passed, 1 = any check failed (blocks write)

set -euo pipefail

# Get the project root
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

HOOKS_DIR=".claude/hooks"

echo "═══════════════════════════════════════════════"
echo "🔒 Pre-Write Quality Gate"
echo "═══════════════════════════════════════════════"
echo ""

# Phase 1: TDD Guard (for new files)
echo "📋 Phase 1/3: TDD Guard (Test-First Check)"
echo "───────────────────────────────────────────────"
if [[ -x "$HOOKS_DIR/tdd-guard.sh" ]]; then
  if "$HOOKS_DIR/tdd-guard.sh" "$@"; then
    echo "✓ TDD check passed"
  else
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "🚫 Pre-Write Quality Gate: FAILED"
    echo "═══════════════════════════════════════════════"
    exit 1
  fi
else
  echo "⚠️  TDD guard not found (skipping)"
fi
echo ""

# Phase 2: Test Suite
echo "📋 Phase 2/3: Test Suite"
echo "───────────────────────────────────────────────"
if [[ -x "$HOOKS_DIR/test-before-write.sh" ]]; then
  if "$HOOKS_DIR/test-before-write.sh" "$@"; then
    echo "✓ All tests passed"
  else
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "🚫 Pre-Write Quality Gate: FAILED"
    echo "═══════════════════════════════════════════════"
    exit 1
  fi
else
  echo "⚠️  Test hook not found (skipping)"
fi
echo ""

# Phase 3: Documentation Check (non-blocking, informational)
echo "📋 Phase 3/3: Documentation Check"
echo "───────────────────────────────────────────────"
if [[ -x "$HOOKS_DIR/doc-sync-hook.sh" ]]; then
  # Doc sync only warns, doesn't block
  "$HOOKS_DIR/doc-sync-hook.sh" "$@" || true
else
  echo "⚠️  Doc sync hook not found (skipping)"
fi
echo ""

# All checks passed
echo "═══════════════════════════════════════════════"
echo "✅ Pre-Write Quality Gate: PASSED"
echo "═══════════════════════════════════════════════"
echo ""
echo "Proceeding with file write..."
echo ""

exit 0
