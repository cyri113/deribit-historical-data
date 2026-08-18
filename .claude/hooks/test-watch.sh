#!/usr/bin/env bash
#
# Smart Test Watcher
#
# Runs tests in watch mode, with smart filtering based on changed files.
# Useful for TDD workflow.
#
# Usage: ./test-watch.sh [pattern]
#   ./test-watch.sh                    # Watch all tests
#   ./test-watch.sh unit               # Watch unit tests only
#   ./test-watch.sh integration        # Watch integration tests only
#   ./test-watch.sh path/to/test.ts    # Watch specific test file

set -euo pipefail

# Get the project root
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}🔍 Smart Test Watcher${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Determine test pattern
if [[ $# -eq 0 ]]; then
  # No arguments - watch all tests
  PATTERN="tests/**/*.test.ts"
  DESCRIPTION="all tests"
elif [[ $1 == "unit" ]]; then
  PATTERN="tests/unit/**/*.test.ts"
  DESCRIPTION="unit tests"
elif [[ $1 == "integration" ]]; then
  PATTERN="tests/integration/**/*.test.ts"
  DESCRIPTION="integration tests"
elif [[ $1 == "e2e" ]]; then
  PATTERN="tests/e2e/**/*.test.ts"
  DESCRIPTION="e2e tests"
elif [[ -f $1 ]]; then
  PATTERN="$1"
  DESCRIPTION="$(basename "$1")"
else
  PATTERN="$1"
  DESCRIPTION="$1"
fi

echo -e "Watching: ${GREEN}$DESCRIPTION${NC}"
echo -e "Pattern:  ${YELLOW}$PATTERN${NC}"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "💡 Tips:"
echo "  • Tests auto-run on file changes"
echo "  • Press Ctrl+C to stop watching"
echo "  • Modify tests or source to trigger re-run"
echo ""
echo "Starting watch mode..."
echo ""

# Run tests in watch mode
bun test "$PATTERN" --watch
