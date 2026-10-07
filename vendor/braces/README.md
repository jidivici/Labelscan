# Bounded braces compatibility build

This private package vendors the runtime files from
[micromatch/braces PR #82](https://github.com/micromatch/braces/pull/82), pinned to
commit `f6e4d5d12d0223d4ea9d667f1267de3b5ec8dd31` in `Passpass92/braces`.
The runtime code is unchanged from that commit; the upstream MIT license is
preserved. The package metadata identifies this as `@labelscan/braces`, version
`3.0.3-labelscan.1`, not an official upstream release.

The published `braces@3.0.3` is affected by
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
No patched npm release exists as of 2026-10-07. The inspected upstream proposal
bounds parser nesting and preflights AST traversal before recursive processing,
including child cycles, excessive depth and repeated shared nodes. Expansion
uses traversal queues instead of trusting caller-provided parent metadata.

The root dependency and `$braces` override make Metro and Jest resolve this
implementation. Keep the local security regression tests in
`src/__tests__/dependencySecurity.test.ts`: npm's registry audit cannot establish
the safety of private vendored code. Ordinary brace/glob matching and NYC YAML
configuration loading are checked alongside malicious nesting and AST inputs.

Replace this package and the override when an official release includes these
guards, then rerun the security regressions, app tests and Android export.
