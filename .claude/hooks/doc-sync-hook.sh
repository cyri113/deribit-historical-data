#!/bin/bash
#
# Documentation Sync Hook
#
# Triggers before Write/Edit operations to check if documentation needs updates.
# Detects changes to critical files and suggests which docs should be reviewed.
#
# Usage: Called automatically by Claude Code before file modifications
# Exit: 0 = proceed, 1 = block (not used currently, only warns)

set -euo pipefail

# Get the project root (2 levels up from .claude/hooks/)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

# Files that trigger doc checks
declare -A DOC_TRIGGERS=(
  # CLI changes → operations.md, api-reference.md
  ["src/cli/index.ts"]="docs/operations.md docs/api-reference.md"

  # API client changes → deribit-api.md
  ["src/infrastructure/deribit-client.ts"]="docs/deribit-api.md"

  # Database schema changes → data-model.md
  ["src/infrastructure/database.ts"]="docs/data-model.md"

  # JSONL storage changes → data-model.md, design-decisions.md
  ["src/infrastructure/jsonl-storage.ts"]="docs/data-model.md docs/design-decisions.md"

  # Fetcher changes → architecture.md, design-decisions.md
  ["src/application/fetchers/future-fetcher.ts"]="docs/architecture.md docs/design-decisions.md"
  ["src/application/fetchers/option-fetcher.ts"]="docs/architecture.md docs/design-decisions.md"

  # Domain logic changes → api-reference.md
  ["src/domain/black76.ts"]="docs/api-reference.md"
  ["src/domain/moneyness.ts"]="docs/api-reference.md"
  ["src/domain/models.ts"]="docs/api-reference.md docs/data-model.md"
)

# Function to check if file was recently modified
check_file_changes() {
  local file=$1

  # Check if file exists in git
  if ! git ls-files --error-unmatch "$file" &>/dev/null; then
    return 1
  fi

  # Check if file has uncommitted changes
  if git diff --quiet HEAD -- "$file" 2>/dev/null; then
    return 1
  fi

  return 0
}

# Main check logic
main() {
  echo "📚 Documentation Sync Check"
  echo "─────────────────────────────"

  local found_changes=0
  local docs_to_update=()

  # Check each trigger file
  for file in "${!DOC_TRIGGERS[@]}"; do
    if check_file_changes "$file"; then
      found_changes=1
      echo "⚠️  Changed: $file"

      # Add suggested docs to list (deduplicate)
      for doc in ${DOC_TRIGGERS[$file]}; do
        if [[ ! " ${docs_to_update[@]} " =~ " ${doc} " ]]; then
          docs_to_update+=("$doc")
        fi
      done
    fi
  done

  if [[ $found_changes -eq 0 ]]; then
    echo "✓ No documentation-critical changes detected"
    exit 0
  fi

  echo ""
  echo "📝 Suggested documentation updates:"
  for doc in "${docs_to_update[@]}"; do
    echo "   • $doc"
  done

  echo ""
  echo "💡 Tip: Review these docs to ensure they reflect the changes"
  echo ""

  # Don't block (exit 0), just warn
  exit 0
}

main "$@"
