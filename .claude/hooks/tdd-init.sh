#!/usr/bin/env bash
#
# TDD Initializer - Test File Generator
#
# Generates test file templates for new source files following TDD workflow.
# Creates test file in appropriate location and opens in watch mode.
#
# Usage: ./tdd-init.sh src/path/to/file.ts

set -euo pipefail

# Get the project root
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to determine test file path
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

# Function to get test type description
get_test_type() {
  local test_path=$1

  if [[ $test_path == tests/unit/* ]]; then
    echo "Unit Test (Pure Functions, Domain Logic)"
  elif [[ $test_path == tests/integration/* ]]; then
    echo "Integration Test (Database, External Systems)"
  elif [[ $test_path == tests/e2e/* ]]; then
    echo "End-to-End Test (Full Workflow)"
  else
    echo "Test"
  fi
}

# Function to generate test template
generate_test_template() {
  local test_file=$1
  local src_file=$2
  local module_name=$(basename "$src_file" .ts)
  local test_type=$(get_test_type "$test_file")

  # Different templates for different test types
  if [[ $test_file == tests/unit/* ]]; then
    # Unit test template
    cat <<EOF
import { test, expect, describe } from "bun:test";
// TODO: Import from $src_file once implemented
// import { yourFunction } from "../../$src_file";

/**
 * Unit Tests for $module_name
 *
 * Test Strategy:
 * - Pure function testing
 * - Edge cases and boundary conditions
 * - Input validation
 * - Error handling
 */

describe("$module_name", () => {
  describe("YourFunction", () => {
    test("should handle valid input", () => {
      // Arrange
      const input = "test";

      // Act
      // const result = yourFunction(input);

      // Assert
      expect(true).toBe(false); // RED: Write failing test first
      // expect(result).toBe(expectedOutput);
    });

    test("should handle edge cases", () => {
      // TODO: Test edge cases
      expect(true).toBe(false);
    });

    test("should throw on invalid input", () => {
      // TODO: Test error handling
      expect(true).toBe(false);
    });
  });

  // Add more describe blocks for other functions
});

/**
 * TDD Workflow Reminder:
 *
 * 🔴 RED Phase:
 * 1. Write failing tests first
 * 2. Tests should describe desired behavior
 * 3. Run: bun test $test_file --watch
 *
 * 🟢 GREEN Phase:
 * 4. Implement minimal code in $src_file
 * 5. Make tests pass
 * 6. Verify with: bun test $test_file
 *
 * 🔵 REFACTOR Phase:
 * 7. Improve code quality
 * 8. Keep tests green
 * 9. Run full suite: bun test
 */
EOF
  elif [[ $test_file == tests/integration/* ]]; then
    # Integration test template
    cat <<EOF
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
// TODO: Import from $src_file once implemented
// import { YourClass } from "../../$src_file";

/**
 * Integration Tests for $module_name
 *
 * Test Strategy:
 * - Database interactions
 * - External system integration
 * - State management
 * - Resource cleanup
 */

describe("$module_name Integration Tests", () => {
  // Test fixtures
  let testInstance: any;

  beforeAll(() => {
    // Setup: Initialize test environment
    // - Create test database
    // - Setup test data
    // - Initialize dependencies
  });

  beforeEach(() => {
    // Reset state between tests
  });

  afterAll(() => {
    // Cleanup: Remove test data
    // - Close connections
    // - Clean up resources
  });

  test("should initialize correctly", () => {
    // TODO: Test initialization
    expect(true).toBe(false); // RED: Failing test
  });

  test("should handle database operations", () => {
    // TODO: Test CRUD operations
    expect(true).toBe(false);
  });

  test("should handle errors gracefully", () => {
    // TODO: Test error scenarios
    expect(true).toBe(false);
  });

  test("should clean up resources", () => {
    // TODO: Test cleanup
    expect(true).toBe(false);
  });
});

/**
 * TDD Workflow for Integration Tests:
 *
 * 1. Write failing integration test
 * 2. Run: bun test $test_file --watch
 * 3. Implement integration in $src_file
 * 4. Ensure proper setup/teardown
 * 5. Test with actual database/systems
 */
EOF
  else
    # E2E test template
    cat <<EOF
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
// TODO: Import from $src_file once implemented

/**
 * End-to-End Tests for $module_name
 *
 * Test Strategy:
 * - Complete user workflows
 * - CLI command execution
 * - Integration of all components
 * - Real-world scenarios
 */

describe("$module_name E2E Tests", () => {
  beforeAll(() => {
    // Setup: Prepare end-to-end environment
  });

  afterAll(() => {
    // Cleanup: Restore environment
  });

  test("should complete full workflow", () => {
    // TODO: Test complete user journey
    expect(true).toBe(false); // RED: Failing test
  });

  test("should handle realistic data", () => {
    // TODO: Test with production-like data
    expect(true).toBe(false);
  });

  test("should handle errors end-to-end", () => {
    // TODO: Test error flows
    expect(true).toBe(false);
  });
});

/**
 * E2E Testing Notes:
 * - Test complete user workflows
 * - Use realistic data and scenarios
 * - Verify all components work together
 * - Test error handling across system
 */
EOF
  fi
}

# Main function
main() {
  if [[ $# -eq 0 ]]; then
    echo -e "${RED}Error: No source file specified${NC}"
    echo ""
    echo "Usage: $0 src/path/to/file.ts"
    echo ""
    echo "Examples:"
    echo "  $0 src/domain/new-calculator.ts     # Creates unit test"
    echo "  $0 src/infrastructure/new-client.ts # Creates integration test"
    echo "  $0 src/cli/new-command.ts           # Creates e2e test"
    exit 1
  fi

  local src_file=$1

  # Validate source file path
  if [[ ! $src_file =~ ^src/.*\.ts$ ]]; then
    echo -e "${RED}Error: Source file must be in src/ directory and end with .ts${NC}"
    echo "Got: $src_file"
    exit 1
  fi

  # Get test file path
  local test_file=$(get_test_path "$src_file")
  local test_type=$(get_test_type "$test_file")

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo -e "${BLUE}🧪 TDD Test File Generator${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo -e "Source file:  ${YELLOW}$src_file${NC}"
  echo -e "Test file:    ${GREEN}$test_file${NC}"
  echo -e "Test type:    $test_type"
  echo ""

  # Check if test file already exists
  if [[ -f "$test_file" ]]; then
    echo -e "${YELLOW}⚠️  Test file already exists!${NC}"
    echo ""
    echo "Options:"
    echo "  1. Open existing test: bun test $test_file --watch"
    echo "  2. Delete and recreate: rm $test_file && $0 $src_file"
    echo ""
    exit 0
  fi

  # Create test directory
  mkdir -p "$(dirname "$test_file")"

  # Generate test file
  generate_test_template "$test_file" "$src_file" > "$test_file"

  echo -e "${GREEN}✅ Test file created!${NC}"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo -e "${BLUE}📝 Next Steps (TDD Workflow)${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "1. 🔴 RED Phase - Write Failing Tests:"
  echo "   Open:  $test_file"
  echo "   Write: Describe expected behavior"
  echo "   Run:   bun test $test_file"
  echo ""
  echo "2. 🟢 GREEN Phase - Make Tests Pass:"
  echo "   Create: $src_file"
  echo "   Code:   Implement minimal solution"
  echo "   Run:    bun test $test_file --watch"
  echo ""
  echo "3. 🔵 REFACTOR Phase - Improve Code:"
  echo "   Refactor: Clean up implementation"
  echo "   Verify:   Tests stay green"
  echo "   Run:      bun test"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  # Ask if user wants to start watch mode
  echo -e "${YELLOW}Start test watch mode now?${NC}"
  echo "Command: bun test $test_file --watch"
  echo ""
  echo -e "Press ${GREEN}ENTER${NC} to start, or ${RED}Ctrl+C${NC} to exit"
  read

  # Start watch mode
  echo ""
  echo "Starting test watch mode..."
  echo ""
  bun test "$test_file" --watch
}

main "$@"
