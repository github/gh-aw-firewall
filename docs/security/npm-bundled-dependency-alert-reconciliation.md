# npm-Bundled Dependency Alert Reconciliation

## Evidence snapshot

The source remediation replaces Node's bundled npm with checksum-pinned npm
11.18.0 and removes the old npm trees. This fix was introduced in
[`2bd68503cc35088e4b506354f204a1f2a2a1a385`](https://github.com/github/gh-aw-firewall/commit/2bd68503cc35088e4b506354f204a1f2a2a1a385)
([PR #6505](https://github.com/github/gh-aw-firewall/pull/6505)); the current
implementation is in [`containers/agent/Dockerfile`](../../containers/agent/Dockerfile).

The latest GitHub release at verification time was `v0.28.60` (published
2026-10-16). Its published agent image was inspected by immutable multi-platform
index digest:

`ghcr.io/github/gh-aw-firewall/agent:0.28.60@sha256:a749124bee61fa88af7883c0a054a9aa8247d171ffaa02fbdc4bbd775b194af6`

The index contains Linux amd64
(`sha256:0001b5dbdfddc2f261e933a6718256e87e87df2ed62c18ae2169975f4b720a45`)
and Linux arm64
(`sha256:367ecf900cd8f133c4d471e580d5cc66d4075fd2d5eda57933efb25535774ff7`)
image manifests. Both final filesystems were inspected. On amd64, `npm --version`
reported `11.18.0`; on both architectures, `/usr/lib/node_modules/npm` was
absent and the only matching package manifests in the global Node.js module
trees were:

| Package | Version | Manifest |
| --- | --- | --- |
| `tar` | `7.5.19` | `/usr/local/lib/node_modules/npm/node_modules/tar/package.json` |
| `glob` | `13.0.6` | `/usr/local/lib/node_modules/npm/node_modules/glob/package.json` |
| `minimatch` | `10.2.5` | `/usr/local/lib/node_modules/npm/node_modules/minimatch/package.json` |
| `diff` | `8.0.4` | `/usr/local/lib/node_modules/npm/node_modules/diff/package.json` |

The amd64 inventory was obtained by pulling and running the image by digest,
checking npm's version and enumerating the matching manifests below
`/usr/lib/node_modules` and `/usr/local/lib/node_modules`. The arm64 image was
pulled by its immutable manifest digest
`sha256:367ecf900cd8f133c4d471e580d5cc66d4075fd2d5eda57933efb25535774ff7`,
which is the Linux arm64 manifest listed in the index above, and its merged
root filesystem inspected; runtime execution was unavailable on the amd64
host. The historical findings are therefore verified as removed or replaced
in both published platform filesystems, not merely in the Dockerfile or the npm
tarball.

## Proposed dispositions

The original findings are accepted as valid for the historical image scanned;
they are **not** false positives. For any of these alerts that remains open,
the evidence supports resolving it as fixed in the published agent image above,
not dismissing it as a false positive. The alert API did not permit this
verification to inspect or change alert states, so these are proposed
dispositions, not recorded status transitions.

| Package | Advisory | Alert IDs | Proposed disposition |
| --- | --- | --- | --- |
| `tar` | CVE-2026-23745 | 632, 635, 636 | Fixed in the verified release image |
| `tar` | CVE-2026-23950 | 633, 637, 638 | Fixed in the verified release image |
| `tar` | CVE-2026-24842 | 634, 639, 640 | Fixed in the verified release image |
| `tar` | CVE-2026-26960 | 651, 652, 653 | Fixed in the verified release image |
| `tar` | CVE-2026-29786 | 715, 716, 717 | Fixed in the verified release image |
| `tar` | CVE-2026-31802 | 765, 766, 767 | Fixed in the verified release image |
| `minimatch` | CVE-2026-26996 | 650 | Fixed in the verified release image |
| `minimatch` | CVE-2026-27903 | 707 | Fixed in the verified release image |
| `minimatch` | CVE-2026-27904 | 708 | Fixed in the verified release image |
| `glob` | CVE-2025-64756 | 631 | Fixed in the verified release image |
| `diff` | CVE-2026-24001 | 630 | Fixed in the verified release image |

This maps all 23 alert IDs from [issue #10109](https://github.com/github/gh-aw-firewall/issues/10109).
The verification establishes the contents of release `0.28.60`; it does not
rewrite the historical scanner result or claim that the alert records have
already been closed.
