# Package Entrypoints And Integration Guarantees

This document defines the package-level contract for `@echofiles/echo-pdf`.

It tells downstream consumers which imports are public, which runtime expectations are supported, and what a clean consumer install may rely on.

## Supported Public Entrypoints

Only these package entrypoints are public:

- `@echofiles/echo-pdf`
- `@echofiles/echo-pdf/local`

Entrypoint intent:

- `@echofiles/echo-pdf`
  - root local API
  - semver-stable public package surface
- `@echofiles/echo-pdf/local`
  - local-first document primitives for Node/Bun
  - semver-stable public package surface

Everything else is private implementation detail, including:

- `src/*`
- `dist/*`
- internal relative modules
- non-exported files in the published tarball

Downstream consumers must not deep-import private paths.

## Runtime Expectations

Supported runtime expectations:

- Node.js `>=20`
- ESM import support
- package `exports` support
- standard `fetch` support in the consumer runtime

TypeScript consumer expectation:

- `module=NodeNext`
- `moduleResolution=NodeNext`

Entrypoint-specific boundary:

- `@echofiles/echo-pdf`
  - root alias for the supported local library surface
- `@echofiles/echo-pdf/local`
  - intended for local Node/Bun app and CLI use
  - may depend on Node-only capabilities through the documented local boundary

## Semver Contract

The semver contract applies to:

- the exported entrypoint paths listed above
- the exported symbols reachable from those public entrypoints
- the documented runtime expectations in this file

Semver rules in the current phase:

- breaking changes to public entrypoints or exported symbols require a major release
- additive exports or backward-compatible parameter expansion may ship in minor or patch releases
- private implementation files may change without notice

Specific compatibility expectations:

- `@echofiles/echo-pdf` remains the documented root local API surface
- `@echofiles/echo-pdf/local` remains the documented local document primitive surface

## Clean Consumer Guarantees

A clean consumer install should be able to:

- install the published package artifact without patching package metadata
- import each supported public entrypoint directly
- execute the supported built local runtime path after install
- typecheck NodeNext imports against the published declaration files

The clean-consumer expectation is:

1. install the package into a fresh directory
2. import:
   - `@echofiles/echo-pdf`
   - `@echofiles/echo-pdf/local`
3. observe successful runtime import
4. execute the packaged local document/render runtime without patching private paths
5. observe successful NodeNext typechecking

This is the packaging-level guarantee for downstream adoption.

## Smoke Verification Contract

The repo already carries the corresponding smoke checks:

- `tests/integration/npm-pack-import.integration.test.ts`
  - verifies fresh import from a packed artifact and exercises the packaged local document/render runtime
- `tests/integration/ts-nodenext-consumer.integration.test.ts`
  - verifies a fresh NodeNext consumer typechecks the public imports
- `bun run test:import-smoke`
  - the packaged smoke entrypoint used before publishing

These checks are the expected verification path for package-level guarantees.

## What This Contract Does Not Promise

This contract does not promise:

- deep imports into non-exported package paths
- source-checkout developer workflows through package imports
- hosted service behavior
- MCP-first product behavior
- domain-specific product semantics

Package guarantees are about the published npm artifact and its documented public entrypoints.
