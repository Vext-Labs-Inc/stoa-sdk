# Contributing to @stoa/sdk

The Stoa SDK is the TypeScript reference client for the [Stoa open standard](https://github.com/stoa-spec/stoa-spec).

## The spec governs

If you're changing wire behavior (envelope shapes, error codes, receipt fields), open an RFC on the spec repo first: [github.com/stoa-spec/stoa-spec](https://github.com/stoa-spec/stoa-spec). The SDK follows the spec — it doesn't lead it.

## Development

```bash
git clone https://github.com/Vext-Labs-Inc/stoa-sdk
cd stoa-sdk
npm install
npm run build
npm test
```

## Structure

- `src/wire.ts` — Zod schemas for all Stoa/1 envelopes. Touch only when spec changes.
- `src/types.ts` — TypeScript types derived from the spec.
- `src/plan.ts` — Plan builder (composition primitives, STOA.md §15).
- `src/execute.ts` — HTTP execution engine.
- `src/verify.ts` — Receipt verification (STOA.md §11).
- `src/offline.ts` — Bundle loading (STOA.md §14).
- `src/sandbox.ts` — Sandbox execution (STOA.md §16).
- `src/lineage.ts` — Lineage graph (STOA.md §16).
- `bin/stoa.ts` — CLI entry point.

## Tests

```bash
npm test          # vitest run (all)
npm run test:watch
```

Tests live in `tests/`. Each module has a corresponding test file.

## Pull requests

- Keep PRs small and focused.
- New features need tests.
- Wire schema changes need spec references in the PR description.
- No emoji in user-facing strings (CLI output, error messages).

## License

By contributing you agree your changes are licensed under Apache-2.0.
