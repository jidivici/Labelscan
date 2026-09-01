# decode-uri-component CommonJS compatibility build

This directory vendors the implementation from
[`decode-uri-component@0.5.0`](https://github.com/SamVerschueren/decode-uri-component/releases/tag/v0.5.0),
including the fix for CVE-2026-45822 / GHSA-vcc3-ghjq-m6fr.

The upstream code and behavior are unchanged. The only compatibility change is
replacing the ESM default export with `module.exports`, because
`query-string@7.1.3` loads this dependency with CommonJS `require()`.

The upstream MIT license is preserved in `LICENSE`.
