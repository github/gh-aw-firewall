# AWF JSONL Schemas

This directory contains [JSON Schema](https://json-schema.org/) files for the JSONL artifact files emitted by AWF at runtime.

## Files

| Schema file | JSONL file | Writer |
|---|---|---|
| [`token-usage.schema.json`](token-usage.schema.json) | `token-usage.jsonl` | `containers/api-proxy/token-tracker.js` |
| [`audit.schema.json`](audit.schema.json) | `audit.jsonl` | Squid proxy (`src/squid-config.ts`) |

## Schema versioning policy

Schema files do not carry an independent version suffix. Instead, the repo release tag is used as the version:

- The `$id` field in each schema is updated at release time to a stable release download URL (e.g. `https://github.com/github/gh-aw-firewall/releases/download/v0.26.0/audit.schema.json`).
- The `_schema` wire-format field in each JSONL record embeds the repo version (e.g. `"_schema": "audit/v0.26.0"`).
- **Additive changes** (new optional fields) → update the schema file directly; no special action required.
- **Breaking changes** (field removal, rename, type change, new required field) → document in the changelog; consumers should pin to a specific release tag.

## Record identification

Every JSONL record includes a `_schema` field that identifies the record type and the AWF version that produced it:

```json
{ "_schema": "token-usage/v0.26.0", "timestamp": "2025-01-01T00:00:00.000Z", ... }
{ "_schema": "audit/v0.26.0", "ts": 1761074374.646, ... }
```

The `_schema` field uses the pattern `<type>/v<semver>`. Consumers should use a prefix match (`_schema.startsWith("audit/")`) rather than an exact match to handle future versions gracefully.

## Release download URLs

Each release publishes all schemas as release assets:

```
https://github.com/github/gh-aw-firewall/releases/download/<tag>/audit.schema.json
https://github.com/github/gh-aw-firewall/releases/download/<tag>/token-usage.schema.json
https://github.com/github/gh-aw-firewall/releases/download/<tag>/awf-config.schema.json
```

For always-latest (main branch) references:

```
https://raw.githubusercontent.com/github/gh-aw-firewall/main/schemas/audit.schema.json
https://raw.githubusercontent.com/github/gh-aw-firewall/main/schemas/token-usage.schema.json
https://raw.githubusercontent.com/github/gh-aw-firewall/main/docs/awf-config.schema.json
```

## Validation

You can validate a JSONL file against its schema using any JSON Schema validator. Example using [`ajv-cli`](https://github.com/ajv-validator/ajv-cli):

```bash
# Install validator
npm install -g ajv-cli

# Validate all records in audit.jsonl
while IFS= read -r line; do
  echo "$line" | ajv validate -s schemas/audit.schema.json -d /dev/stdin
done < /path/to/audit.jsonl
```
