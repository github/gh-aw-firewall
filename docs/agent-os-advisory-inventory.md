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
```

The Dockerfile runs `apt-get update` and `apt-get upgrade` during image builds
(`containers/agent/Dockerfile`, `apt_upgrade_retry` and its invocation). This
does not prove these findings are fixed: the versions below remain present in
the published images.

## Reproduced package matches

The repeated packages are grouped by CVE. Each row applies to both image
digests above.

| CVE | Package(s) and installed version(s) | Grype severity | Applicability / disposition |
| --- | --- | --- | --- |
| CVE-2016-2781 | `coreutils` 8.32-4.1ubuntu1.4 | Low; Grype reports “won't fix” | Package present; Ubuntu advisory applicability and runtime reachability not established. Open; no risk acceptance. |
| CVE-2017-11164 | `libpcre3` 2:8.39-13ubuntu0.22.04.1 | Negligible; Grype reports “won't fix” | Package present; Ubuntu advisory applicability and runtime reachability not established. Open; no risk acceptance. |
| CVE-2022-27943 | `gcc-12-base`, `libgcc-s1`, `libstdc++6` 12.3.0-1ubuntu1~22.04.3 | Low | All packages present; Ubuntu advisory applicability and runtime reachability not established. Open; no risk acceptance. |
| CVE-2022-3219 | `dirmngr`, `gnupg`, `gnupg-l10n`, `gnupg-utils`, `gpg`, `gpg-agent`, `gpg-wks-client`, `gpg-wks-server`, `gpgconf`, `gpgsm`, `gpgv` 2.2.27-3ubuntu2.5 | Low; Grype reports “won't fix” | Packages present; Ubuntu advisory applicability and runtime reachability not established. GnuPG is explicitly installed and documented as an agent tool. Open; no risk acceptance. |
| CVE-2022-41409 | `libpcre2-8-0` 10.39-3ubuntu0.1 | Low | Package present; Ubuntu advisory applicability and runtime reachability not established. Open; no risk acceptance. |
| CVE-2022-4899 | `libzstd1` 1.4.8+dfsg-3build1 | Low | Package present; Ubuntu advisory applicability and runtime reachability not established. Open; no risk acceptance. |
| CVE-2023-29383 | `login`, `passwd` 1:4.8.1-2ubuntu2.2 | Low | Packages present; account-management packages support the image's `useradd`/`groupadd` setup. Ubuntu advisory applicability and runtime reachability not established. Open; no risk acceptance. |
| CVE-2023-50495 | `libncurses6`, `libncursesw6`, `libtinfo6`, `ncurses-base`, `ncurses-bin` 6.3-2ubuntu0.3 | Low | Packages present; Ubuntu advisory applicability and runtime reachability not established. Open; no risk acceptance. |
| CVE-2024-52005 | `git`, `git-man` 1:2.34.1-1ubuntu1.17 | Medium | Packages present; Git is an explicitly installed agent tool. Ubuntu advisory applicability and runtime reachability not established. Open; no risk acceptance. |
| CVE-2024-56433 | `login`, `passwd` 1:4.8.1-2ubuntu2.2 | Low | Packages present; account-management packages support the image's `useradd`/`groupadd` setup. Ubuntu advisory applicability and runtime reachability not established. Open; no risk acceptance. |
| CVE-2025-5222 | `libicu70` 70.1-2 | Low | Package present as a dependency of the documented `php-intl` runtime package. Ubuntu advisory applicability and runtime reachability not established. Open; no risk acceptance. |
| CVE-2025-66382 | `libexpat1` 2.4.7-1ubuntu0.9 | Medium | Package present, including as a Git dependency. Ubuntu advisory applicability and runtime reachability not established. Open; no risk acceptance. |
| CVE-2026-22185 | `liblmdb0` 0.9.24-1build2 | Medium | Package present as a dependency of `bind9-libs` used by the DNS tools. Ubuntu advisory applicability and runtime reachability not established. Open; no risk acceptance. |

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
Removing these packages without replacing their function would change the
supported agent image. No package was removed or downgraded as part of this
triage.

No exception was added to `.grype.yaml`, no residual risk was accepted, and no
alert closure is proposed. Complete per-alert dispositions require the missing
alert crosswalk and historical Trivy export, plus Ubuntu advisory/backport
verification and explicit maintainer approval for any accepted residual risk.
