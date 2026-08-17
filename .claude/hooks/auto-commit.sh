#!/usr/bin/env bash
#
# Claude Code Hook: Auto-commit
# Automatically commits changes when significant work is completed
#
# This hook is triggered at conversation end or can be called manually.
# It stages all changes and creates a descriptive commit message.

set -e

# Get the project root
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Change to project directory
cd "$PROJECT_ROOT"

# Check if there are any changes to commit
if git diff --quiet && git diff --cached --quiet; then
    echo "ℹ️  No changes to commit"
    exit 0
fi

echo "📝 Staging changes for commit..."

# Get status before staging
MODIFIED_FILES=$(git status --porcelain | head -10)

# Stage all changes
git add .

# Generate commit message based on changes
COMMIT_MSG=$(cat <<EOF
🤖 Auto-commit: CLI refactoring and improvements

Changes made by Claude Code:
$(echo "$MODIFIED_FILES" | sed 's/^/- /')

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)

# Create the commit
git commit -m "$COMMIT_MSG"

echo "✅ Changes committed successfully!"
echo ""
echo "Commit message:"
echo "$COMMIT_MSG"
