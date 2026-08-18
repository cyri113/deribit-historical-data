#!/usr/bin/env bash
#
# TDD Guard Hook - Enforces Test-First Development
#
# This hook enforces TDD by requiring test files to exist BEFORE
# creating new source files. It blocks creation of new .ts files
# in src/ unless a corresponding test file exists.
#
# Usage: Called automatically by Claude Code before file writes
# Exit: 0 = proceed, 1 = block (test missing)

set -euo pipefail

# Get the project root (2 levels up from .claude/hooks/)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

# Load configuration
SETTINGS_FILE=".claude/settings.json"
TDD_ENABLED=true
REQUIRE_TESTS_FIRST=true

if [[ -f "$SETTINGS_FILE" ]]; then
  TDD_ENABLED=$(grep -o '"enabled":[[:space:]]*true' "$SETTINGS_FILE" >/dev/null && echo "true" || echo "false")
  REQUIRE_TESTS_FIRST=$(grep -o '"require_tests_first":[[:space:]]*true' "$SETTINGS_FILE" >/dev/null && echo "true" || echo "false")
fi

# Skip if TDD not enabled
if [[ "$TDD_ENABLED" != "true" ]] || [[ "$REQUIRE_TESTS_FIRST" != "true" ]]; then
  exit 0
fi

# Function to determine test file path for a source file
get_test_path() {
  local src_file=$1
  local test_file=""

  # Map source directories to test directories
  if [[ $src_file == src/domain/* ]]; then
    # Domain -> Unit tests
    test_file="tests/unit/$(basename "$src_file" .ts).test.ts"
  elif [[ $src_file == src/infrastructure/* ]]; then
    # Infrastructure -> Integration tests
    test_file="tests/integration/$(basename "$src_file" .ts).test.ts"
  elif [[ $src_file == src/application/* ]]; then
    # Application -> Integration tests
    test_file="tests/integration/$(basename "$src_file" .ts).test.ts"
  elif [[ $src_file == src/cli/* ]]; then
    # CLI -> E2E tests
    test_file="tests/e2e/$(basename "$src_file" .ts).test.ts"
  else
    # Default: integration tests
    test_file="tests/integration/$(basename "$src_file" .ts).test.ts"
  fi

  echo "$test_file"
}

# Function to check if this is a new file creation
is_new_file() {
  local file=$1

  # Check if file doesn't exist in git history
  if ! git ls-files --error-unmatch "$file" &>/dev/null; then
    # File not tracked - check if it exists on disk
    if [[ ! -f "$file" ]]; then
      return 0  # Truly new
    fi
  fi

  return 1  # Exists or tracked
}

# Function to generate test template
generate_test_template() {
  local test_file=$1
  local src_file=$2
  local module_name=$(basename "$src_file" .ts)

  cat <<EOF
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
// TODO: Import from $src_file once implemented
// import { YourFunction } from "../../$src_file";

describe("$module_name", () => {
  beforeAll(() => {
    // Setup test fixtures
  });

  afterAll(() => {
    // Cleanup
  });

  test("should fail - implement first test", () => {
    // RED: Write failing test
    expect(true).toBe(false);

    // TODO: Replace with actual test
    // Example:
    // const result = yourFunction(input);
    // expect(result).toBe(expectedOutput);
  });

  test.todo("add more test cases");
});
EOF
}

# Main TDD guard logic
main() {
  # Get file being written from environment or argument
  local target_file="${TOOL_FILE:-${1:-}}"

  if [[ -z "$target_file" ]]; then
    # No file specified, allow (might be bulk operation)
    exit 0
  fi

  # Only check TypeScript files in src/
  if [[ ! $target_file =~ ^src/.*\.ts$ ]]; then
    exit 0
  fi

  # Only check NEW files (TDD guard)
  if ! is_new_file "$target_file"; then
    # Existing file modification - allow (tested by test-before-write.sh)
    exit 0
  fi

  # Get corresponding test file
  local test_file=$(get_test_path "$target_file")

  # Check if test file exists
  if [[ -f "$test_file" ]]; then
    echo "✓ TDD Check: Test file exists at $test_file"
    exit 0
  fi

  # TEST MISSING - Block creation
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "❌ TDD Violation: Test Required First"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "Cannot create: $target_file"
  echo "Required test: $test_file"
  echo ""
  echo "📝 TDD Workflow (Test-Driven Development):"
  echo ""
  echo "  1. Create test file first:"
  echo "     mkdir -p $(dirname "$test_file")"
  echo "     touch $test_file"
  echo ""
  echo "  2. Write FAILING tests (RED phase):"
  echo "     # Describe expected behavior"
  echo "     # Tests should fail initially"
  echo ""
  echo "  3. Run tests in watch mode:"
  echo "     bun test $test_file --watch"
  echo ""
  echo "  4. Implement $target_file (GREEN phase):"
  echo "     # Write minimal code to pass tests"
  echo ""
  echo "  5. Refactor (REFACTOR phase):"
  echo "     # Improve code while keeping tests green"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "💡 Quick start: Run this command to generate test template:"
  echo ""
  echo "   ./.claude/hooks/tdd-init.sh $target_file"
  echo ""
  echo "Or create manually:"
  echo ""

  # Create test directory if needed
  mkdir -p "$(dirname "$test_file")"

  # Generate and show template
  echo "# $test_file"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  generate_test_template "$test_file" "$target_file"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  # Offer to create test file
  echo "Create test file now? (Creates template above)"
  echo ""
  echo "To proceed:"
  echo "  1. Create $test_file with the template above"
  echo "  2. Write failing tests"
  echo "  3. Then I can create $target_file"
  echo ""

  exit 1  # Block file creation
}

main "$@"
