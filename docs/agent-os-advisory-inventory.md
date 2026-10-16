# Agent image OS advisory inventory

**Triage date:** 2026-10-16

**Disposition:** Open. No alerts are closed or accepted as residual risk by this inventory.

This inventory records package evidence for the historical agent OS advisory
backlog. A package match establishes that the package is present in the image;
it does not by itself establish vulnerability applicability, exploitability, or
a basis to close an alert.

## Image and scan evidence

The default agent image is based on Ubuntu 22.04 (`containers/agent/Dockerfile`,
`ARG BASE_IMAGE=ubuntu:22.04`). The supported `v0.28.60` image is Ubuntu
22.04.5 and has 250 installed dpkg packages:

| Image | Immutable reference |
| --- | --- |
| Historical image | `ghcr.io/github/gh-aw-firewall/agent:0.28.54@sha256:fc4f3d07d9f0479aa76d4a6d55f36735c29e0558f10a413fbd36e3d00b34a830` |
| Current release at triage | `ghcr.io/github/gh-aw-firewall/agent:0.28.60@sha256:a749124bee61fa88af7883c0a054a9aa8247d171ffaa02fbdc4bbd775b194af6` |

The [Supply Chain Scan run 38936952850](https://github.com/github/gh-aw-firewall/actions/runs/38936952850)
used Grype v0.116.0
(`ghcr.io/anchore/grype@sha256:fd4ab4d1042b522c896e73bdf09ab8bf384fa417df99d6dd0d6e1008c7e7c821`)
and reported the 32 package/CVE matches below against both immutable references.
The installed versions were also read from the published `v0.28.60` image with
`dpkg-query`. The package versions and Grype severities shown below are scan
evidence, not Ubuntu advisory dispositions.

The inventory can be reproduced from the immutable current-release reference:

```bash
IMAGE=ghcr.io/github/gh-aw-firewall/agent:0.28.60@sha256:a749124bee61fa88af7883c0a054a9aa8247d171ffaa02fbdc4bbd775b194af6
docker pull "$IMAGE"
docker run --rm --entrypoint /bin/sh "$IMAGE" -c \
  'cat /etc/os-release; dpkg-query -W -f="\${Package}\t\${Version}\n" | sort'
docker run --rm --entrypoint /bin/sh "$IMAGE" -c \
  'for x in pcre2test zstd genrb mdb_load nm-new nm; do command -v "$x" || echo "$x absent"; done'
```

The Dockerfile runs `apt-get update` and `apt-get upgrade` during image builds
(`containers/agent/Dockerfile`, `apt_upgrade_retry` and its invocation). This
does not prove these findings are fixed: the versions below remain present in
the published images.

Ubuntu status below comes from Canonical's
[Ubuntu Vulnerability Data](https://github.com/canonical/ubuntu-security-notices/blob/main/README.md)
OSV/OpenVEX records, not the live Ubuntu CVE Tracker, which was inaccessible
during triage. “Affected” is the Ubuntu source-package status; it does not prove
that every listed binary contains the vulnerable code or that code is reachable
in AWF. Where the record or package-to-binary mapping could not be verified, the
finding remains unresolved.

## Reproduced package matches

The repeated packages are grouped by CVE. Each row applies to both image
digests above.

| CVE | Package(s) and installed version(s) | Grype severity | Ubuntu and image applicability / disposition |
| --- | --- | --- | --- |
| CVE-2016-2781 | `coreutils` 8.32-4.1ubuntu1.4 | Low; Grype reports “won't fix” | [Canonical VEX](https://github.com/canonical/ubuntu-security-notices/blob/main/vex/cve/2016/CVE-2016-2781) lists Jammy as affected and explicitly ignored because there is no viable fix. The image contains `coreutils`; image-level exploitability is unresolved. Open; no risk acceptance. |
| CVE-2017-11164 | `libpcre3` 2:8.39-13ubuntu0.22.04.1 | Negligible; Grype reports “won't fix” | [Canonical VEX](https://github.com/canonical/ubuntu-security-notices/blob/main/vex/cve/2017/CVE-2017-11164) lists Jammy as affected and ignored because of a PCRE1 limitation. The image contains `libpcre3`; image-level applicability is unresolved. Open; no risk acceptance. |
| CVE-2022-27943 | `gcc-12-base`, `libgcc-s1`, `libstdc++6` 12.3.0-1ubuntu1~22.04.3 | Low | The exact Jammy status for these GCC 12 binaries is [unverified](https://github.com/canonical/ubuntu-security-notices/blob/main/osv/cve/2022/UBUNTU-CVE-2022-27943.json). The reported flaw concerns GCC's Rust demangler; `nm-new` and `nm` are absent from the image, but this does not establish the tracker status of the matched packages. Open; no risk acceptance. |
| CVE-2022-3219 | `dirmngr`, `gnupg`, `gnupg-l10n`, `gnupg-utils`, `gpg`, `gpg-agent`, `gpg-wks-client`, `gpg-wks-server`, `gpgconf`, `gpgsm`, `gpgv` 2.2.27-3ubuntu2.5 | Low; Grype reports “won't fix” | [Canonical OSV](https://github.com/canonical/ubuntu-security-notices/blob/main/osv/cve/2022/UBUNTU-CVE-2022-3219.json) lists the Jammy version as affected; the exact VEX disposition was not verified. GnuPG is explicitly installed and documented as an agent tool. Open; no risk acceptance. |
| CVE-2022-41409 | `libpcre2-8-0` 10.39-3ubuntu0.1 | Low | [Canonical VEX](https://github.com/canonical/ubuntu-security-notices/blob/main/vex/cve/2022/CVE-2022-41409) lists Jammy as affected; the described flaw is in the `pcre2test` utility. `pcre2test` and `pcre2-utils` are absent from this image. Candidate package-level false positive; keep the alert open until its ID is crosswalked. |
| CVE-2022-4899 | `libzstd1` 1.4.8+dfsg-3build1 | Low | [Canonical VEX](https://github.com/canonical/ubuntu-security-notices/blob/main/vex/cve/2022/CVE-2022-4899) lists Jammy as affected; the flaw is in the `zstd` command-line utility. `zstd` is absent from this image while `libzstd1` remains a system dependency. Candidate package-level false positive; keep the alert open until its ID is crosswalked. |
| CVE-2023-29383 | `login`, `passwd` 1:4.8.1-2ubuntu2.2 | Low | [Canonical VEX](https://github.com/canonical/ubuntu-security-notices/blob/main/vex/cve/2023/CVE-2023-29383) lists the Jammy packages as affected and low priority; no fixed Jammy version was found in the record. These packages support account setup. Open; no risk acceptance. |
| CVE-2023-50495 | `libncurses6`, `libncursesw6`, `libtinfo6`, `ncurses-base`, `ncurses-bin` 6.3-2ubuntu0.3 | Low | [Canonical VEX](https://github.com/canonical/ubuntu-security-notices/blob/main/vex/cve/2023/CVE-2023-50495) lists Jammy as affected and low priority; the issue concerns terminfo parsing. Runtime applicability is unresolved. Open; no risk acceptance. |
| CVE-2024-52005 | `git`, `git-man` 1:2.34.1-1ubuntu1.17 | Medium | [Canonical OSV](https://github.com/canonical/ubuntu-security-notices/blob/main/osv/cve/2024/UBUNTU-CVE-2024-52005.json) lists the Jammy version as affected. Git is an explicitly installed agent tool. Open; no risk acceptance. |
| CVE-2024-56433 | `login`, `passwd` 1:4.8.1-2ubuntu2.2 | Low | [Canonical VEX](https://github.com/canonical/ubuntu-security-notices/blob/main/vex/cve/2024/CVE-2024-56433) lists Jammy as affected; its action statement says Ubuntu understood but had not fixed the issue. These packages support account setup. Open; no risk acceptance. |
| CVE-2025-5222 | `libicu70` 70.1-2 | Low | [Canonical VEX](https://github.com/canonical/ubuntu-security-notices/blob/main/vex/cve/2025/CVE-2025-5222) lists Jammy as affected and says Ubuntu will not fix this low-priority flaw in the `genrb` command-line tool. `genrb` and `icu-devtools` are absent; candidate package-level false positive. Keep the alert open until its ID is crosswalked. |
| CVE-2025-66382 | `libexpat1` 2.4.7-1ubuntu0.9 | Medium | [Canonical OSV](https://github.com/canonical/ubuntu-security-notices/blob/main/osv/cve/2025/UBUNTU-CVE-2025-66382.json) lists Jammy versions through the installed version as affected. The VEX record's exact Jammy status/action was not verified. Open; no risk acceptance. |
| CVE-2026-22185 | `liblmdb0` 0.9.24-1build2 | Medium | [Canonical VEX](https://github.com/canonical/ubuntu-security-notices/blob/main/vex/cve/2026/CVE-2026-22185) marks the Jammy `liblmdb0` entry under investigation; the described `mdb_load` utility and `lmdb-utils` package are absent. This is evidence against that vulnerable component being present, not an Ubuntu “not affected” disposition. Keep the alert open until its ID is crosswalked. |

These 13 CVEs account for 32 package/advisory matches. The issue lists the
following 32 still-reported code-scanning alert IDs:

`35, 67, 39, 57, 69, 38, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 66, 73, 74, 116, 60, 61, 71, 76, 77, 40, 41, 75, 117, 59, 56, 189`

The individual alert-ID-to-package/CVE crosswalk is not available in the issue
description. Requests for code-scanning alert details returned HTTP 403 to this
agent, so the IDs are not assigned to package rows by guesswork or list order.
Do not close an individual alert until its detail record and Ubuntu advisory
evidence have been matched to that alert.

## Historical findings absent from current Grype results

The issue lists these 19 historical alert IDs as absent from current Grype
results. Absence from a different scanner's output is not remediation evidence.
The package, version, CVE, and historical image digest cannot be recovered from
the issue description alone; the historical Trivy report and individual alert
details were not available to this agent. Every item remains explicitly
unresolved.

| Alert IDs | Package / version / CVE / digest | Applicability and disposition |
| --- | --- | --- |
| `70, 72, 58, 118, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 62, 63, 64, 65` | Unknown; historical alert details required | Unresolved. No positive remediation or inapplicability evidence; do not close. |

## Runtime and change assessment

The affected packages are installed directly, inherited from the Ubuntu base,
or required by image tools and their runtime dependencies. Examples verified
from the image include GnuPG and Git (explicitly installed and documented),
`passwd` (used by the image's user/group creation), `libicu70` (used by
`php-intl`), `liblmdb0` (required by `bind9-libs`/DNS tools), and `libpcre2`,
`libexpat1`, and `libzstd1` (dependencies of Git or core system packages).
The `pcre2test`, `zstd`, `genrb`, and `mdb_load` commands named by four
advisories are not present in the pinned image. Removing the corresponding
libraries would still remove runtime dependencies; no package was removed or
downgraded as part of this triage.

No exception was added to `.grype.yaml`, no residual risk was accepted, and no
alert closure is proposed. Complete per-alert dispositions require the missing
alert crosswalk and historical Trivy export, plus explicit maintainer approval
for any accepted residual risk.
