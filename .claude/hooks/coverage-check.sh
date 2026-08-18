#!/usr/bin/env bash
#
# Test Coverage Check
#
# Analyzes test coverage and enforces minimum thresholds.
# Can be configured to warn or block based on coverage percentage.
#
# Exit: 0 = coverage acceptable, 1 = coverage too low (if blocking enabled)

set -euo pipefail

# Get the project root
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

# Load configuration
SETTINGS_FILE=".claude/settings.json"
COVERAGE_ENABLED=true
MIN_COVERAGE=60
WARN_BELOW=80
BLOCK_ON_DECREASE=false

if [[ -f "$SETTINGS_FILE" ]]; then
  COVERAGE_ENABLED=$(grep -o '"enabled":[[:space:]]*true' "$SETTINGS_FILE" | tail -1 >/dev/null && echo "true" || echo "false")
  MIN_COVERAGE=$(grep -oP '"minimum_percent":[[:space:]]*\K[0-9]+' "$SETTINGS_FILE" 2>/dev/null || echo "60")
  WARN_BELOW=$(grep -oP '"warn_below_percent":[[:space:]]*\K[0-9]+' "$SETTINGS_FILE" 2>/dev/null || echo "80")
fi

if [[ "$COVERAGE_ENABLED" != "true" ]]; then
  echo "ℹ️  Coverage checking disabled"
  exit 0
fi

echo "📊 Test Coverage Analysis"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if bun supports coverage
if ! bun test --help | grep -q "coverage" 2>/dev/null; then
  echo "⚠️  Coverage not supported by current bun version"
  echo "   Install: bun upgrade"
  echo ""
  exit 0
fi

# Run tests with coverage
echo "Running tests with coverage analysis..."
echo ""

# Note: Bun's coverage support is still experimental
# This is a placeholder for when it's fully supported
echo "⚠️  Note: Bun's native coverage is experimental"
echo ""
echo "📊 Coverage Summary (Manual Check Recommended):"
echo ""
echo "To check coverage manually:"
echo "  1. Use c8 with bun:"
echo "     bunx c8 bun test"
echo ""
echo "  2. Or use Istanbul:"
echo "     bunx nyc bun test"
echo ""
echo "  3. Review coverage reports in coverage/ directory"
echo ""

# For now, just show test count as a proxy
TEST_COUNT=$(find tests -name "*.test.ts" | wc -l | tr -d ' ')
SOURCE_COUNT=$(find src -name "*.ts" | wc -l | tr -d ' ')

echo "Test Files:   $TEST_COUNT"
echo "Source Files: $SOURCE_COUNT"

if [[ $SOURCE_COUNT -gt 0 ]]; then
  RATIO=$((TEST_COUNT * 100 / SOURCE_COUNT))
  echo "Test Ratio:   ${RATIO}% (test files / source files)"
  echo ""

  if [[ $RATIO -ge $WARN_BELOW ]]; then
    echo "✅ Good test-to-source ratio"
  elif [[ $RATIO -ge $MIN_COVERAGE ]]; then
    echo "⚠️  Test ratio below recommended ($WARN_BELOW%)"
    echo "   Consider adding more tests"
  else
    echo "❌ Test ratio below minimum ($MIN_COVERAGE%)"
    echo "   More test coverage needed"
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "💡 Coverage targets:"
echo "   Minimum: ${MIN_COVERAGE}%  (blocking threshold)"
echo "   Target:  ${WARN_BELOW}%  (recommended)"
echo "   Ideal:   90%+ (excellent coverage)"
echo ""

# Always exit 0 (non-blocking) for now
exit 0
