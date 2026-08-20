# Development Guide

Guide for contributing to the Deribit Historical Data Pipeline.

## Development Setup

### Prerequisites
- Bun v1.0+
- Git
- Code Editor (VS Code recommended)

### Clone & Install
```bash
git clone https://github.com/YOUR_USERNAME/deribit-historical-data.git
cd deribit-historical-data
bun install
```

### Run Tests
```bash
# All tests
bun test

# Watch mode
bun test --watch

# Specific file
bun test tests/unit/black76.test.ts

# Coverage
bun test --coverage
```

### Development Workflow
1. Create feature branch: `git checkout -b feature/my-feature`
2. Make changes
3. Run tests: `bun test`
4. Run CLI locally: `bun src/cli/index.ts <command>`
5. Commit: `git commit -m "feat: add feature"`
6. Push and create Pull Request

---

## Project Structure

```
src/
├── cli/index.ts                    # CLI entry point
├── application/
│   ├── fetchers/                   # Future, Option, Delivery fetchers
│   ├── analytics/                  # ParquetMerger, DuckDBEnricher
│   └── filters/                    # RiskFilters
├── domain/                         # black76, moneyness, models (pure functions)
└── infrastructure/                 # deribit-client, database, storage, duckdb

tests/
├── unit/                           # Pure function tests
├── integration/                    # DB + API tests
└── e2e/                            # Full pipeline tests
```

### Layer Responsibilities
- **CLI:** Parse commands, display progress, error handling
- **Application:** Orchestrate workflows, coordinate services, retry logic
- **Domain:** Pure business logic, no I/O, fully testable
- **Infrastructure:** External integrations, DB ops, file system, HTTP

---

## Testing

### Unit Tests (`tests/unit/`)

Test pure functions in isolation.

```typescript
import { test, expect } from "bun:test";
import { black76Call } from "../../src/domain/black76.ts";

test("black76Call calculates correct price", () => {
  const price = black76Call(100, 100, 1, 0.2, 1);
  expect(price).toBeCloseTo(7.97, 2);
});
```

### Integration Tests (`tests/integration/`)

Test components with real dependencies.

```typescript
import { test, expect } from "bun:test";
import { Database } from "../../src/infrastructure/database.ts";

test("database stores and retrieves trades", () => {
  const db = new Database(":memory:");
  const trades = [{
    id: "1",
    instrumentName: "BTC-PERPETUAL",
    price: 62500,
    amount: 1.0,
    direction: "buy" as const,
    timestamp: Date.now(),
    indexPrice: 62000,
  }];

  db.insertTrades(trades);
  const retrieved = db.getTrades("BTC-PERPETUAL");

  expect(retrieved).toHaveLength(1);
  expect(retrieved[0]?.price).toBe(62500);
  db.close();
});
```

### Test Coverage Goals
- **Unit tests:** 100% coverage (pure functions)
- **Integration tests:** 80%+ coverage
- **E2E tests:** Critical paths only

---

## Code Style

### TypeScript Strict Mode
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true
  }
}
```

**No `any`:**
```typescript
// ❌ Bad
function process(data: any) { }

// ✅ Good
function process(data: unknown) {
  if (typeof data === "object" && data !== null) {
    // Type guard
  }
}
```

**Explicit Return Types:**
```typescript
function calculatePrice(strike: number): number {
  return strike * 1.1;
}
```

### Naming Conventions
- **Files:** kebab-case (`future-fetcher.ts`)
- **Classes:** PascalCase (`FutureFetcher`)
- **Functions:** camelCase (`fetchInstrument`)
- **Constants:** UPPER_SNAKE_CASE (`MAX_RETRIES`)
- **Private:** Prefix with `_` or use `private` keyword

### Error Handling
```typescript
class DeribitAPIError extends Error {
  constructor(
    message: string,
    public code?: number,
    public data?: unknown
  ) {
    super(message);
    this.name = "DeribitAPIError";
  }
}

// ✅ Good: Throw typed errors
throw new DeribitAPIError("Invalid response", 400);

// ❌ Bad: Throw strings
throw "Invalid response";
```

### Comments
Document complex logic, explain "why" not "what":

```typescript
/**
 * Calculate Black-76 call option price
 * @param forwardPrice - Current forward/future price
 * @param strike - Strike price
 * @param timeToExpiry - Time to expiration in years
 * @param volatility - Implied volatility (0-1 scale)
 * @returns Option price
 */
export function black76Call(...): number { }

// ✅ Good: Explains reasoning
// Use MAX guard to prevent progress rollback on concurrent crashes
UPDATE option_progress SET last_no = MAX(last_no, ?)

// ❌ Bad: Obvious
// Increment counter
counter++;
```

---

## Adding Features

### Adding a CLI Command

1. Add to `COMMANDS` array:
```typescript
const COMMANDS = ["fetch-instruments", "fetch-trades", "my-command"] as const;
```

2. Create handler:
```typescript
async function myCommandHandler(args: string[]) {
  const parsed = parseArgs(args);
  // Implementation
}
```

3. Update help text and add to main switch

### Adding a Fetcher

1. Create class in `src/application/fetchers/`:
```typescript
export class MyFetcher {
  constructor(config: MyFetcherConfig) { }
  async fetch(instrument: string): Promise<void> { }
}
```

2. Add tests in `tests/integration/`

3. Integrate with CLI

### Adding Domain Logic

Pure functions only:
```typescript
// src/domain/my-logic.ts
export function calculateSomething(
  input: number,
  params: { a: number; b: number }
): number {
  return input * params.a + params.b;  // Pure computation
}
```

Add unit tests in `tests/unit/`

---

## Contributing

### Pull Request Process

1. Fork repository
2. Create branch: `git checkout -b feature/my-feature`
3. Make changes following code style
4. Add tests for new functionality
5. Run tests: `bun test` (must pass)
6. Commit using conventional commits:
   - `feat: add new feature`
   - `fix: resolve bug`
   - `docs: update documentation`
   - `refactor: improve code structure`
   - `test: add tests`
7. Push and create PR with clear description

### PR Requirements
- ✅ All tests pass
- ✅ Code follows style guide
- ✅ New features have tests
- ✅ Documentation updated (if needed)
- ✅ No breaking changes (or clearly documented)

### Code Review

PRs reviewed for:
- Correctness
- Test coverage
- Code style
- Performance
- Documentation

### Release Process

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Create git tag: `git tag v1.2.0`
4. Push tag: `git push origin v1.2.0`
5. Create GitHub release

---

**Next:** [API Reference →](api-reference.md)
