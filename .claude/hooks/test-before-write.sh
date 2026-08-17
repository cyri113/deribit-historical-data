#!/usr/bin/env bash
#
# Claude Code Hook: Test Before Write
# Runs tests before allowing file modifications to ensure code quality
#
# This hook is triggered before Write/Edit operations on TypeScript files.
# If tests fail, the file change is blocked.

set -e

# Get the project root (where this script lives)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Change to project directory
cd "$PROJECT_ROOT"

echo "🧪 Running tests before allowing file changes..."

# Run tests with bun
if bun test; then
    echo "✅ All tests passed! Proceeding with file changes."
    exit 0
else
    echo "❌ Tests failed! File changes blocked."
    echo ""
    echo "Please fix the failing tests before modifying files."
    exit 1
fi
