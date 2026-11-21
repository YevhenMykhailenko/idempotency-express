# Changelog

## 3.0.0

Breaking changes and compatibility notes for 3.0. Existing 2.x deployments must follow the migration runbook; a version change does not establish that a production cutover has been completed.

### Breaking

- Require stable application namespace and explicit authorized scope; require keys by default.
- Replace raw Store lookup with versioned, hashed namespace/scope/key tuples.
- Store protocol v3: mandatory ownership, begin/read/commit, explicit commit outcomes, no get/abort/release.
- Store completed supported 4xx/5xx responses rather than treating status codes as permission to repeat effects.
- Gate buffered transport end on commit acknowledgement; report uncertain outcomes on technical failures.
- Store Buffer bodies with strict schema/byte budgets; remove public Captured/setOn internals.
- Add stable error codes, stricter key/extractor/config validation and safe headers before storage.

### Added

- Bounded volatile MemoryStore without live-record eviction.
- Optional `/redis` adapter, atomic Lua transitions, authoritative Redis expiry and canonical first-write-wins replay, with no required Redis runtime dependency.
- Custom verified-event extraction, isolated diagnostic events, disconnect-aware wait and response lifecycle.
- Store/HTTP/native/Redis/cross-process/crash/lost-ACK/persistence-boundary tests.
- Tested application recipes, guarantees/reconciliation and migration runbooks, installed-tarball/type checks and Express 4/5 test configuration.

### Development dependencies and verification

- Update body-parser to 1.20.9 and qs to 6.16.1 in the development lockfile, without adding runtime dependencies or changing Express peer ranges.
- Align the development @typescript-eslint family at 8.73.0, using minimatch 11.0.1 through its supported parent range, without global overrides or a TypeScript-native compiler.
- Full development `npm audit` and local `prepublishOnly` passed on 2026-11-19 after remediation. This does not update or audit downstream applications' framework/driver dependency trees.
- Add test-owned, ready IPv4 listeners and seven HTTP fixture isolation/cleanup regressions; no runtime change is implied by this test-harness fix.

### Compatibility and release notes

- Fingerprint format 2 is preserved.
- Node `>=18.0.0` compatibility is retained; Node 18/20 are upstream EOL, and production should use maintained Node. Development tools need Node 22.12+; optional drivers have independent requirements.
- ESM-only; no production PostgreSQL adapter, universal streaming support, automatic takeover, migration bridge or exactly-once external-effects guarantee.
- Keep legacy records and follow the [migration runbook](docs/migration.md); do not mix live v2/v3 writers or flush deduplication history.
- Keep the full dependency audit as a blocking gate and validate integrations, migration and rollback for the target deployment; local policy tests are not a production cutover. This changelog does not authorize Git writes, package publication or a security advisory.
