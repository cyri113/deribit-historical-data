#!/usr/bin/env bash
#
# Documentation Reference Generator
#
# On-demand hook to auto-generate API reference documentation from code.
# Extracts CLI help text, function signatures, and type definitions.
#
# Usage: ./.claude/hooks/doc-reference-hook.sh

set -euo pipefail

# Get the project root
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

echo "📖 Documentation Reference Generator"
echo "════════════════════════════════════"
echo ""

# Generate CLI reference from help output
echo "Generating CLI reference..."
CLI_HELP=$(bun src/cli/index.ts help 2>&1 || echo "Failed to get CLI help")

# Extract command list
COMMANDS=$(echo "$CLI_HELP" | grep -A 100 "Commands:" | grep "^  " | sed 's/^  //' || echo "")

echo "✓ Found CLI commands:"
echo "$COMMANDS" | sed 's/^/  • /'
echo ""

# Check TypeScript exports
echo "Checking TypeScript exports..."

# Extract public functions from black76.ts
BLACK76_EXPORTS=$(grep -E "^export (function|interface|type|const)" src/domain/black76.ts || true)
echo "✓ Black-76 exports:"
echo "$BLACK76_EXPORTS" | sed 's/^/  • /'
echo ""

# Extract public functions from moneyness.ts
MONEYNESS_EXPORTS=$(grep -E "^export (function|interface|type|const)" src/domain/moneyness.ts || true)
echo "✓ Moneyness exports:"
echo "$MONEYNESS_EXPORTS" | sed 's/^/  • /'
echo ""

# Extract public classes
echo "✓ Public classes:"
grep -rh "^export class" src/ | sed 's/^export class /  • /' | sed 's/ {.*//' || true
echo ""

# Summary
echo "───────────────────────────────"
echo "📚 Reference Documentation:"
echo "  • CLI Commands: $(echo "$COMMANDS" | wc -l | tr -d ' ') commands"
echo "  • Black-76 Functions: $(echo "$BLACK76_EXPORTS" | wc -l | tr -d ' ') exports"
echo "  • Moneyness Functions: $(echo "$MONEYNESS_EXPORTS" | wc -l | tr -d ' ') exports"
echo ""
echo "💡 To update api-reference.md:"
echo "  1. Review extracted signatures above"
echo "  2. Manually update docs/api-reference.md"
echo "  3. Ensure examples are current"
echo ""

exit 0
