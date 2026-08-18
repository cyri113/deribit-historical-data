# Development Guide

Guide for developers who want to contribute to or extend the Deribit Historical Data Pipeline.

## Table of Contents

1. [Development Setup](#development-setup)
2. [Project Structure](#project-structure)
3. [Testing](#testing)
4. [Code Style](#code-style)
5. [Adding Features](#adding-features)
6. [Contributing](#contributing)

---

## Development Setup

### Prerequisites

- **Bun** v1.0+
- **Git**
- **Code Editor** (VS Code recommended)

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

# Specific test file
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
6. Push: `git push origin feature/my-feature`
7. Create Pull Request

---

## Project Structure

```
deribit-historical-data/
├── src/
│   ├── cli/
│   │   └── index.ts              # CLI entry point
│   ├── application/
│   │   ├── fetchers/
│   │   │   ├── future-fetcher.ts  # Futures download strategy
│   │   │   ├── option-fetcher.ts  # Options download strategy
│   │   │   └── delivery-fetcher.ts
│   │   ├── analytics/
│   │   │   └── greeks-calculator.ts
│   │   └── filters/
│   │       └── risk-filters.ts
│   ├── domain/
│   │   ├── black76.ts            # Pure pricing functions
│   │   ├── moneyness.ts          # ITM/OTM logic
│   │   └── models.ts             # Types & schemas
│   └── infrastructure/
│       ├── deribit-client.ts     # API client
│       ├── database.ts           # SQLite wrapper
│       ├── jsonl-storage.ts      # File I/O
│       └── rate-limiter.ts       # Token bucket
├── tests/
│   ├── unit/                     # Pure function tests
│   ├── integration/              # DB + API tests
│   └── e2e/                      # Full pipeline tests
├── docs/                         # Documentation
├── data/
│   └── jsonl/                    # Trade data files
├── deribit-data.db               # Metadata database
├── package.json
├── tsconfig.json
└── README.md
```

### Layer Responsibilities

**CLI Layer (`src/cli/`):**
- Parse commands
- Instantiate services
- Display progress
- Error handling for users

**Application Layer (`src/application/`):**
- Orchestrate workflows
- Coordinate services
- Progress tracking
- Retry logic

**Domain Layer (`src/domain/`):**
- Pure business logic
- No I/O or side effects
- Mathematical correctness
- Fully testable

**Infrastructure Layer (`src/infrastructure/`):**
- External integrations
- Database operations
- File system access
- HTTP requests

---

## Testing

### Test Categories

#### Unit Tests (`tests/unit/`)

Test pure functions in isolation.

```typescript
import { test, expect } from "bun:test";
import { black76Call, delta } from "../../src/domain/black76.ts";

test("black76Call calculates correct price", () => {
  const price = black76Call(
    100,  // forward price
    100,  // strike
    1,    // 1 year to expiry
    0.2,  // 20% vol
    1     // no discounting
  );

  expect(price).toBeCloseTo(7.97, 2);
});
```

**Run:** `bun test tests/unit/`

#### Integration Tests (`tests/integration/`)

Test components with real dependencies (DB, filesystem).

```typescript
import { test, expect } from "bun:test";
import { Database } from "../../src/infrastructure/database.ts";

test("database stores and retrieves trades", () => {
  const db = new Database(":memory:");

  const trades = [
    {
      id: "1",
      instrumentName: "BTC-PERPETUAL",
      price: 62500,
      amount: 1.0,
      direction: "buy" as const,
      timestamp: Date.now(),
      indexPrice: 62000,
    }
  ];

  db.insertTrades(trades);
  const retrieved = db.getTrades("BTC-PERPETUAL");

  expect(retrieved).toHaveLength(1);
  expect(retrieved[0]?.price).toBe(62500);

  db.close();
});
```

**Run:** `bun test tests/integration/`

#### E2E Tests (`tests/e2e/`)

Test complete workflows end-to-end.

```typescript
import { test, expect } from "bun:test";
import { FutureFetcher } from "../../src/application/fetchers/future-fetcher.ts";

test("fetch-trades pipeline", async () => {
  const client = new DeribitClient();
  const db = new Database(":memory:");
  const storage = new JSONLStorage("./test-data");

  const fetcher = new FutureFetcher({ client, database: db, storage });

  // Fetch first 100 trades
  await fetcher.fetchInstrument("BTC-PERPETUAL", { maxSeq: 100 });

  // Verify storage
  const trades = await storage.readTrades("BTC-PERPETUAL");
  expect(trades.length).toBe(100);

  // Verify database
  const stats = db.getFutureChunkStats("BTC-PERPETUAL");
  expect(stats.done).toBeGreaterThan(0);

  // Cleanup
  db.close();
  await storage.closeAll();
});
```

**Run:** `bun test tests/e2e/`

### Test Coverage

Aim for:
- **Unit tests:** 100% coverage (pure functions)
- **Integration tests:** 80%+ coverage
- **E2E tests:** Critical paths only

Check coverage:
```bash
bun test --coverage
```

### Mocking

Use Bun's built-in mock:

```typescript
import { mock } from "bun:test";

test("rate limiter called", async () => {
  const mockAcquire = mock(() => Promise.resolve());
  const rateLimiter = { acquire: mockAcquire };

  const client = new DeribitClient({ rateLimiter });
  await client.getInstruments("BTC");

  expect(mockAcquire).toHaveBeenCalled();
});
```

---

## Code Style

### TypeScript

**Strict Mode:**
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
function process(data: any) { ... }

// ✅ Good
function process(data: unknown) {
  if (typeof data === "object" && data !== null) {
    // Type guard
  }
}
```

**Explicit Return Types:**
```typescript
// ✅ Good
function calculatePrice(strike: number): number {
  return strike * 1.1;
}
```

### Naming Conventions

**Files:**
- kebab-case: `future-fetcher.ts`

**Classes:**
- PascalCase: `FutureFetcher`

**Functions:**
- camelCase: `fetchInstrument`

**Constants:**
- UPPER_SNAKE_CASE: `MAX_RETRIES`

**Private members:**
- Prefix with `_` or use `private`: `private readonly _cache`

### Error Handling

**Custom Errors:**
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
```

**Error Propagation:**
```typescript
// ✅ Good: Throw typed errors
throw new DeribitAPIError("Invalid response", 400);

// ❌ Bad: Throw strings
throw "Invalid response";
```

### Comments

**Document complex logic:**
```typescript
/**
 * Calculate Black-76 call option price
 *
 * @param forwardPrice - Current forward/future price
 * @param strike - Strike price
 * @param timeToExpiry - Time to expiration in years
 * @param volatility - Implied volatility (0-1 scale)
 * @returns Option price
 */
export function black76Call(...): number {
  // Implementation
}
```

**Explain "why", not "what":**
```typescript
// ❌ Bad: Obvious
// Increment counter
counter++;

// ✅ Good: Explains reasoning
// Use MAX guard to prevent progress rollback on concurrent crashes
UPDATE option_progress SET last_no = MAX(last_no, ?)
```

---

## Adding Features

### Adding a New CLI Command

**Step 1:** Add command to `COMMANDS` array
```typescript
const COMMANDS = ["fetch-instruments", "fetch-trades", "my-command"] as const;
```

**Step 2:** Create command handler
```typescript
async function myCommandHandler(args: string[]) {
  const parsed = parseArgs(args);
  // Implementation
}
```

**Step 3:** Update help text
```typescript
function printHelp() {
  console.log(`
    my-command <arg>
      Description of command

      Examples:
        bun src/cli/index.ts my-command foo
  `);
}
```

**Step 4:** Add to main switch
```typescript
switch (command) {
  case "my-command":
    await myCommandHandler(args.slice(1));
    break;
}
```

### Adding a New Fetcher

**Step 1:** Create fetcher class
```typescript
// src/application/fetchers/my-fetcher.ts
export class MyFetcher {
  constructor(config: MyFetcherConfig) { }

  async fetch(instrument: string): Promise<void> {
    // Implementation
  }
}
```

**Step 2:** Add tests
```typescript
// tests/integration/my-fetcher.test.ts
test("MyFetcher fetches data", async () => {
  const fetcher = new MyFetcher({ ... });
  await fetcher.fetch("BTC-PERPETUAL");
  // Assertions
});
```

**Step 3:** Integrate with CLI
```typescript
const myFetcher = new MyFetcher({ client, database, storage });
await myFetcher.fetch(instrumentName);
```

### Adding Domain Logic

**Pure functions only:**
```typescript
// src/domain/my-logic.ts
export function calculateSomething(
  input: number,
  params: { a: number; b: number }
): number {
  // Pure computation (no I/O)
  return input * params.a + params.b;
}
```

**Add unit tests:**
```typescript
// tests/unit/my-logic.test.ts
test("calculateSomething", () => {
  const result = calculateSomething(10, { a: 2, b: 5 });
  expect(result).toBe(25);
});
```

---

## Contributing

### Pull Request Process

1. **Fork** the repository
2. **Create branch:** `git checkout -b feature/my-feature`
3. **Make changes** following code style
4. **Add tests** for new functionality
5. **Run tests:** `bun test` (must pass)
6. **Commit:** Use conventional commits
   - `feat: add new feature`
   - `fix: resolve bug`
   - `docs: update documentation`
   - `refactor: improve code structure`
   - `test: add tests`
7. **Push:** `git push origin feature/my-feature`
8. **Create PR** with clear description

### PR Requirements

- ✅ All tests pass
- ✅ Code follows style guide
- ✅ New features have tests
- ✅ Documentation updated (if needed)
- ✅ No breaking changes (or clearly documented)

### Code Review

PRs will be reviewed for:
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
