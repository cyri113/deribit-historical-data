#!/usr/bin/env bash
#
# Claude Code Hook: Test Before Write (Enhanced)
# Runs tests before allowing file modifications to ensure code quality
#
# This hook is triggered before Write/Edit operations on TypeScript files.
# If tests fail, the file change is blocked.

set -euo pipefail

# Get the project root (where this script lives)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Change to project directory
cd "$PROJECT_ROOT"

# Configuration
TEST_TIMEOUT=120  # 2 minutes max for test suite
MIN_TESTS=10      # Minimum number of tests expected

echo "🧪 Running tests before allowing file changes..."
echo ""

# Create temp file for test output
TEST_OUTPUT=$(mktemp)
trap "rm -f $TEST_OUTPUT" EXIT

# Run tests with timeout and capture output
if timeout $TEST_TIMEOUT bun test >$TEST_OUTPUT 2>&1; then
    # Tests passed
    PASS_COUNT=$(grep -oE "[0-9]+ pass" $TEST_OUTPUT | grep -oE "[0-9]+" || echo "0")
    DURATION=$(grep -oE "\[.*ms\]" $TEST_OUTPUT | tail -1 || echo "[?ms]")

    echo "✅ All tests passed!"
    echo "   Tests: $PASS_COUNT passed $DURATION"
    echo ""
    echo "Proceeding with file changes..."
    exit 0
else
    EXIT_CODE=$?

    # Check if timeout occurred
    if [[ $EXIT_CODE -eq 124 ]]; then
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "❌ Test Timeout (>${TEST_TIMEOUT}s)"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "Tests took longer than $TEST_TIMEOUT seconds."
        echo ""
        echo "Possible causes:"
        echo "  • Infinite loop in code"
        echo "  • Hanging network requests"
        echo "  • Slow integration tests"
        echo ""
        echo "💡 Debug: Run tests manually to see which test hangs:"
        echo "   bun test --verbose"
        echo ""
    else
        # Tests failed
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "❌ Tests Failed - File Changes Blocked"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""

        # Extract and show failure summary
        if grep -q "fail" $TEST_OUTPUT; then
            FAIL_COUNT=$(grep -oE "[0-9]+ fail" $TEST_OUTPUT | grep -oE "[0-9]+" || echo "?")
            PASS_COUNT=$(grep -oE "[0-9]+ pass" $TEST_OUTPUT | grep -oE "[0-9]+" || echo "0")

            echo "Test Results:"
            echo "  ✓ $PASS_COUNT passed"
            echo "  ✗ $FAIL_COUNT failed"
            echo ""
        fi

        # Show failing tests
        echo "Failed tests:"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        grep -E "(fail\)|error:)" $TEST_OUTPUT | head -10 || echo "  (See full output above)"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""

        echo "💡 Fix the failing tests before modifying files"
        echo ""
        echo "Run tests manually to see full output:"
        echo "  bun test"
        echo ""
        echo "Run specific test file:"
        echo "  bun test path/to/test.ts"
        echo ""
        echo "Run in watch mode:"
        echo "  bun test --watch"
        echo ""
    fi

    echo "🚫 File changes blocked until tests pass"
    echo ""

    exit 1  # Block changes
fi
