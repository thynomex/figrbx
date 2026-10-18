# Contributing

Thanks for helping. A few things make changes easier to review.

## Ground rules

- Keep the converter data-only. The Figma plugin serializes; `packages/core`
  converts; the Studio plugin instantiates. No layer may execute document
  content.
- Every new approximation must produce a warning. Silent degradation is a bug.

## Workflow

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm build:studio
```

Add a test next to the behaviour you change:

| Area | Location |
| --- | --- |
| conversion rules, tags, fonts | `packages/core/test` |
| geometry invariants | `packages/core/test/geometry.test.ts` |
| bridge routes, auth, store | `packages/bridge/test` |
| generated Studio controller | `tests/behaviors/generate.luau` + selene |

## Docs

- `README.md` is the user-facing guide. Keep the limitation list accurate.
- `docs/schema.md` documents the ODT format and must stay in step with
  `packages/core/src/schema.ts`.
