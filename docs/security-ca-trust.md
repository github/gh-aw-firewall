# Emergency CA distrust policy

AWF applies an emergency distrust policy for the October 2026
[eMudhra intermediate-key disclosure](https://emudhra.we-have-a-problem.com/).
There is no evidence of exploitation of AWF. Compromised TLS issuer keys can
enable interception of connections to **already allowed** domains when an
attacker can also redirect traffic; domain allowlisting is not a substitute for
certificate authentication. The two disclosed code-signing issuer keys are not
themselves TLS issuers.

## Policy and compatibility

`src/tls-trust-policy.ts` is the canonical policy. It lists the eight compromised
SPKI SHA-256 hashes from
[`impacted-intermediates.json`](https://emudhra.we-have-a-problem.com/impacted-intermediates.json).
For clients without intermediate-SPKI revocation, AWF also temporarily distrusts
the four issuer/cross-signer root keys listed in
[`roots.json`](https://emudhra.we-have-a-problem.com/roots.json):
emSign Root TLS CA - G3, emSign Root CS CA - G3, AAA Certificate Services
(also distributed as Comodo AAA Services root), and emSign ECC Root CA - G3.
Key-based matching also removes same-key cross-signs with different certificate
fingerprints. This deliberately blocks **unrelated chains under these roots**;
it is a conservative emergency fallback, not a claim that those root private
keys were compromised. Revisit root distrust once upstream runtimes enforce
the intermediate-key revocations.

Generate the checked-in per-image copies with
`node scripts/security/generate-trust-policy.cjs`; `--check` detects drift.
Copies are required because ordinary Docker images have independent component
build contexts. The enclave and Cloud Hypervisor images use `containers/`.

## Protected AWF-controlled paths

- The full/minimal agent, Squid, API/CLI proxies, router, build-tools/DinD sysroots, gh-aw-node,
  enclave images, and Cloud Hypervisor guest base ship filtered OpenSSL bundles
  and hashed directories. Squid interception explicitly uses that store and
  rejects certificate errors. CONNECT/spliced traffic remains end-to-end TLS,
  so its client must validate the upstream certificate.
- Node uses a mandatory runtime preload, not just `NODE_EXTRA_CA_CERTS` (which
  only adds trust). The preload filters default/embedded, extra, and explicit
  custom CAs for HTTPS, direct TLS, and fetch. Image Node launchers preserve the
  preload for child processes and do not depend solely on a caller-preserved
  `NODE_OPTIONS`. The host AWF CLI loads the same policy.
- Chroot imports are filtered into container-local `/run/awf-lib/trust`.
  Read-only bind overlays cover the mounted Debian/RHEL CA directories;
  CAfile aliases and `SSL_CERT_DIR` use only the sanitized store. The host trust
  store is **not modified**. AWF interception and legitimate private CAs remain
  trusted unless their keys are denylisted. Missing, malformed, or entirely
  distrusted stores fail startup rather than silently restoring host trust.
- The CLI proxy's dynamically combined gateway CA bundle is also filtered.
  The API proxy's private upstream CA mount is preserved and filtered by Node.
- All image-built `gh` binaries use Go 1.27.3 (CVE-2026-111943 fix), with a build
  assertion on the **compiled binary's toolchain metadata**, in addition to
  existing source checksums and module-version assertions.
- Release binaries/bundles and checksums/container metadata receive build
  provenance. Bootstrap verifies constrained provenance before installation or
  use of image digests. See [release authentication](releasing.md) for trusted
  verifier requirements and the intentional refusal of unsigned older releases.

## Boundaries and rollout

Rebuild and publish **all affected images and guest rootfs artifacts**, then
upgrade AWF and its image pins together. Existing containers, old image digests,
pre-existing guest rootfs images, and older installed AWF releases are unchanged.
Build runners and the initial installer/verifier must already be obtained through
a trusted channel and have updated TLS trust; an installer cannot authenticate
the script that is already executing.

AWF cannot universally repair arbitrary host-installed or user-provided TLS
runtimes. Update host clients and operating-system stores separately, including
the Docker daemon's registry trust. Java keystores, Python certifi/pip's vendored
certifi, Rust/native embedded-root clients, browser stores, independently
configured CA paths, and applications disabling certificate verification need
their own vendor updates or explicitly configured sanitized trust. A user
command can also override `NODE_OPTIONS`, invoke an unwrapped executable, or
provide its own trust context; this policy is not a new enforcement boundary
against adversarial sandbox commands. Root filtering is not general online
revocation checking and does not replace ordinary CA/runtime updates.

Offline regressions cover SPKI matching, same-key cross-sign removal, hashed
directory fallback, unchanged source stores, private/AWF CA preservation, and
Node HTTPS/direct TLS/fetch behavior. Full Linux mount, Squid configuration,
container build, and guest-boot integration require a Linux Docker/KVM runner;
they cannot be established by the offline tests alone.

## Regression checks

Run `npm test -- src/tls-trust-policy.test.ts scripts/security/ca-trust.test.ts`
for the policy, generated-copy, image-wiring, and offline TLS regressions.
The dependency-free runtime smoke,
`node --test scripts/security/tls-runtime-smoke.cjs`, can also run directly inside
each rebuilt Node image with the repository mounted at `/work`; it needs
OpenSSL and the image's installed Node launcher.

For actual mount validation, run `scripts/security/chroot-trust-smoke.sh` inside
a **disposable Linux container** with `CAP_SYS_ADMIN`, the repository mounted
read-only at `/work`, and `containers/trust` mounted read-only at
`/opt/awf/trust`. It rejects execution outside a container or with an existing
`/host`, verifies the real bind overlays, and checks that the source store stays
unchanged. Do not run this mount test on a host or in a live AWF container.

The three positive action CI jobs use isolated local release fixtures because
historical releases cannot retroactively supply the required provenance.
`scripts/ci/setup-action-test-fixtures.cjs` generates an executable, signed
metadata, and ephemeral Ed25519 signatures, with test-only transport, verifier,
and Docker stand-ins. They exercise the real composite-action shell, required
verification constraints, metadata binding, and digest-pull requests; they do
**not** validate GitHub/Sigstore attestations or download real container images.
There is no fixture option or legacy-release exception in the production action.

Run `npm test -- scripts/ci/release-bootstrap-provenance.test.ts` for these
regressions. Its standalone `node --test scripts/ci/action-fixture-smoke.cjs`
also runs the actual installation scenarios on Linux with a C compiler, Bash,
and `file`; non-Linux hosts only run the fixture verifier checks. Missing legacy
metadata and tampered fixture signatures must still fail closed.
Before rollout, use the **Test Setup Action** workflow's manual
`attested-version` input to test a genuinely published attested release against
real GitHub verification and digest-pinned image pulls. That job never prepares
the local fixtures.
