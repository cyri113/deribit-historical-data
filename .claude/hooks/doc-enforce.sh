#!/usr/bin/env bash
#
# Documentation Enforcement Hook
#
# Enforces mandatory documentation updates when critical files change.
# BLOCKS commits if required documentation is not updated.
#
# Usage: Called automatically by Claude Code before commits
# Exit: 0 = all docs updated, 1 = missing required docs

set -euo pipefail

# Get the project root
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

# Load configuration
SETTINGS_FILE=".claude/settings.json"
ENFORCE_DOCS=true
BLOCK_ON_MISSING=true

if [[ -f "$SETTINGS_FILE" ]]; then
  ENFORCE_DOCS=$(grep -o '"enforce_updates":[[:space:]]*true' "$SETTINGS_FILE" >/dev/null && echo "true" || echo "false")
  BLOCK_ON_MISSING=$(grep -o '"block_on_missing":[[:space:]]*true' "$SETTINGS_FILE" >/dev/null && echo "true" || echo "false")
fi

# Skip if doc enforcement not enabled
if [[ "$ENFORCE_DOCS" != "true" ]]; then
  exit 0
fi

# Critical file → Required docs mapping
declare -A DOC_REQUIREMENTS=(
  # CLI changes → operations.md, api-reference.md
  ["src/cli/index.ts"]="docs/operations.md docs/api-reference.md"

  # Database schema → data-model.md
  ["src/infrastructure/database.ts"]="docs/data-model.md"

  # API client → deribit-api.md
  ["src/infrastructure/deribit-client.ts"]="docs/deribit-api.md"

  # JSONL storage → data-model.md, design-decisions.md
  ["src/infrastructure/jsonl-storage.ts"]="docs/data-model.md docs/design-decisions.md"

  # Parquet writer → data-model.md, architecture.md
  ["src/infrastructure/parquet-writer.ts"]="docs/data-model.md docs/architecture.md"

  # Fetchers → architecture.md, design-decisions.md
  ["src/application/fetchers/future-fetcher.ts"]="docs/architecture.md docs/design-decisions.md"
  ["src/application/fetchers/option-fetcher.ts"]="docs/architecture.md docs/design-decisions.md"
  ["src/application/fetchers/delivery-fetcher.ts"]="docs/architecture.md docs/design-decisions.md"

  # Domain logic → api-reference.md
  ["src/domain/black76.ts"]="docs/api-reference.md"
  ["src/domain/moneyness.ts"]="docs/api-reference.md"
  ["src/domain/models.ts"]="docs/api-reference.md docs/data-model.md"
)

# Function to check if file was modified
is_file_modified() {
  local file=$1

  # Check if file has uncommitted changes
  if ! git diff --quiet HEAD -- "$file" 2>/dev/null; then
    return 0  # Modified
  fi

  # Check if file is staged
  if ! git diff --quiet --cached -- "$file" 2>/dev/null; then
    return 0  # Staged
  fi

  return 1  # Not modified
}

# Function to check if docs were updated
docs_updated() {
  local doc_file=$1

  # Check if doc exists
  if [[ ! -f "$doc_file" ]]; then
    return 1  # Doc doesn't exist
  fi

  # Check if doc was modified in this session
  if is_file_modified "$doc_file"; then
    return 0  # Doc updated
  fi

  return 1  # Doc not updated
}

# Main enforcement logic
main() {
  echo "📚 Documentation Enforcement Check"
  echo "════════════════════════════════════"
  echo ""

  # Get list of modified source files
  local modified_files=$(git diff --name-only HEAD 2>/dev/null || echo "")
  modified_files+=$'\n'$(git diff --name-only --cached 2>/dev/null || echo "")

  if [[ -z "$modified_files" ]]; then
    echo "✓ No changes detected"
    exit 0
  fi

  local violations=0
  local warnings=()
  local critical_files_changed=()
  local missing_docs=()

  # Check each critical file
  for src_file in "${!DOC_REQUIREMENTS[@]}"; do
    if echo "$modified_files" | grep -q "^$src_file$"; then
      critical_files_changed+=("$src_file")

      # Check if required docs were updated
      local required_docs=(${DOC_REQUIREMENTS[$src_file]})
      local all_updated=true

      for doc in "${required_docs[@]}"; do
        if ! docs_updated "$doc"; then
          missing_docs+=("$doc")
          all_updated=false
        fi
      done

      if [[ "$all_updated" != "true" ]]; then
        violations=$((violations + 1))
        warnings+=("❌ $src_file → Missing: ${required_docs[*]}")
      fi
    fi
  done

  # Check for wildcard patterns (e.g., src/application/fetchers/*.ts)
  if echo "$modified_files" | grep -qE "^src/application/fetchers/.*\.ts$"; then
    if [[ ! " ${critical_files_changed[@]} " =~ " src/application/fetchers/" ]]; then
      # Fetcher changed but not in exact list
      if ! docs_updated "docs/architecture.md" || ! docs_updated "docs/design-decisions.md"; then
        violations=$((violations + 1))
        warnings+=("❌ src/application/fetchers/*.ts → Missing: docs/architecture.md docs/design-decisions.md")
      fi
    fi
  fi

  # Report results
  if [[ $violations -eq 0 ]]; then
    echo "✓ All required documentation updated"
    echo ""

    # Show what docs were updated
    local updated_docs=$(echo "$modified_files" | grep "^docs/" || true)
    if [[ -n "$updated_docs" ]]; then
      echo "📝 Documentation updates:"
      echo "$updated_docs" | sed 's/^/  ✓ /'
      echo ""
    fi

    exit 0
  fi

  # Violations found
  echo "❌ Documentation Updates Required"
  echo ""

  if [[ ${#critical_files_changed[@]} -gt 0 ]]; then
    echo "Critical files modified:"
    printf '  • %s\n' "${critical_files_changed[@]}"
    echo ""
  fi

  echo "Missing documentation updates:"
  printf '%s\n' "${warnings[@]}" | sed 's/^/  /'
  echo ""

  # Deduplicate missing docs
  local unique_missing=($(printf '%s\n' "${missing_docs[@]}" | sort -u))

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Required Actions:"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  for doc in "${unique_missing[@]}"; do
    echo "📝 Update $doc to reflect changes in:"
    for src_file in "${!DOC_REQUIREMENTS[@]}"; do
      if [[ " ${DOC_REQUIREMENTS[$src_file]} " =~ " $doc " ]]; then
        if echo "$modified_files" | grep -q "^$src_file$"; then
          echo "   • $src_file"
        fi
      fi
    done
    echo ""
  done

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "💡 Documentation Guidelines:"
  echo ""
  echo "  • Explain WHAT changed"
  echo "  • Explain WHY it changed (design decision)"
  echo "  • Update examples if applicable"
  echo "  • Update API signatures if applicable"
  echo "  • Keep docs concise but complete"
  echo ""

  if [[ "$BLOCK_ON_MISSING" == "true" ]]; then
    echo "🚫 Commit blocked until documentation is updated"
    echo ""
    exit 1  # Block
  else
    echo "⚠️  Warning: Documentation missing (not blocking)"
    echo ""
    exit 0  # Warn only
  fi
}

main "$@"
