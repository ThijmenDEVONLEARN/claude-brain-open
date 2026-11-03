# scripts

- `gen-fixtures.ts`: maakt een nep-kluis (`pnpm tsx scripts/gen-fixtures.ts --out <map> --count 300000`).
- `bench-index.ts`: meet de index (rebuild, queries) op zo'n kluis.
- `bench-e2e.ts`: eindcontrole voor een release. Start de echte server op een map met een gebouwde index en meet wat Claude en de UI merken (map, find, read, write, overzicht, zoeken, dashboard) tegen vaste doelen. Schrijft alleen in de groep `bench-e2e` en ruimt die op.

```sh
BRAIN_HOME=/pad/naar/map pnpm tsx scripts/bench-e2e.ts   # exit 1 als een doel niet gehaald wordt
```
