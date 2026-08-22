#!/usr/bin/env bash
#
# Documentation Update Hook
#
# Runs at conversation end to review changes and update documentation.
# Analyzes all modified files and generates update suggestions.
#
# Usage: Called automatically by Claude Code at conversation end

set -euo pipefail

# Get the project root
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

echo "📚 Documentation Update Check"
echo "══════════════════════════════"
echo ""

# Get list of modified files
MODIFIED_FILES=$(git diff --name-only HEAD 2>/dev/null || echo "")

if [[ -z "$MODIFIED_FILES" ]]; then
  echo "✓ No changes detected"
  exit 0
fi

echo "Modified files in this session:"
echo "$MODIFIED_FILES" | sed 's/^/  • /'
echo ""

# Categorize changes
CLI_CHANGES=$(echo "$MODIFIED_FILES" | grep -E "^src/cli/" || true)
INFRA_CHANGES=$(echo "$MODIFIED_FILES" | grep -E "^src/infrastructure/" || true)
DOMAIN_CHANGES=$(echo "$MODIFIED_FILES" | grep -E "^src/domain/" || true)
APP_CHANGES=$(echo "$MODIFIED_FILES" | grep -E "^src/application/" || true)
DOC_CHANGES=$(echo "$MODIFIED_FILES" | grep -E "^docs/" || true)

# Generate recommendations
RECOMMENDATIONS=()

if [[ -n "$CLI_CHANGES" ]]; then
  RECOMMENDATIONS+=("• Update docs/operations.md - CLI command changes")
  RECOMMENDATIONS+=("• Update docs/api-reference.md - CLI API changes")
fi

if [[ -n "$INFRA_CHANGES" ]]; then
  if echo "$INFRA_CHANGES" | grep -q "database.ts"; then
    RECOMMENDATIONS+=("• Update docs/data-model.md - Database schema changes")
  fi
  if echo "$INFRA_CHANGES" | grep -q "deribit-client.ts"; then
    RECOMMENDATIONS+=("• Update docs/deribit-api.md - API client changes")
  fi
  if echo "$INFRA_CHANGES" | grep -q "jsonl-storage.ts"; then
    RECOMMENDATIONS+=("• Update docs/data-model.md - Storage format changes")
  fi
fi

if [[ -n "$DOMAIN_CHANGES" ]]; then
  RECOMMENDATIONS+=("• Update docs/api-reference.md - Domain logic changes")
  if echo "$DOMAIN_CHANGES" | grep -q "models.ts"; then
    RECOMMENDATIONS+=("• Update docs/data-model.md - Type definition changes")
  fi
fi

if [[ -n "$APP_CHANGES" ]]; then
  if echo "$APP_CHANGES" | grep -q "fetchers/"; then
    RECOMMENDATIONS+=("• Update docs/architecture.md - Fetch strategy changes")
    RECOMMENDATIONS+=("• Update docs/design-decisions.md - Implementation changes")
  fi
fi

# Display recommendations
if [[ ${#RECOMMENDATIONS[@]} -gt 0 ]]; then
  echo "📝 Recommended Documentation Updates:"
  echo ""
  printf '%s\n' "${RECOMMENDATIONS[@]}" | sort -u
  echo ""
fi

# Check if docs were updated
if [[ -n "$DOC_CHANGES" ]]; then
  echo "✓ Documentation updated:"
  echo "$DOC_CHANGES" | sed 's/^/  ✓ /'
  echo ""
fi

# Summary
echo "───────────────────────────────"
echo "💡 Next steps:"
echo "  1. Review recommended doc updates"
echo "  2. Run: bun src/cli/index.ts help"
echo "  3. Test changes with: bun test"
echo ""

exit 0
