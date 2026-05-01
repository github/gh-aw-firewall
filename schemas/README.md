# AWF JSONL Schemas

This directory contains versioned [JSON Schema](https://json-schema.org/) files for the JSONL artifact files emitted by AWF at runtime.

## Files

| Schema file | JSONL file | Writer |
|---|---|---|
| [`token-usage.v1.schema.json`](token-usage.v1.schema.json) | `token-usage.jsonl` | `containers/api-proxy/token-tracker.js` |
| [`audit.v1.schema.json`](audit.v1.schema.json) | `audit.jsonl` | Squid proxy (`src/squid-config.ts`) |

## Schema versioning policy

- **Additive changes** (new optional fields) → update the existing `v1` schema, no version bump required.
- **Breaking changes** (field removal, rename, type change, new required field) → create a new `v2` schema file and bump the `_schema` value in the writer.

## Record identification

Every JSONL record includes a `_schema` field that identifies the schema name and version:

```json
{ "_schema": "token-usage/v1", "timestamp": "2025-01-01T00:00:00.000Z", ... }
{ "_schema": "audit/v1", "ts": 1761074374.646, ... }
```

Consumers should check `_schema` before parsing fields so they can handle future versions gracefully.

## Validation

You can validate a JSONL file against its schema using any JSON Schema validator. Example using [`ajv-cli`](https://github.com/ajv-validator/ajv-cli):

```bash
# Install validator
npm install -g ajv-cli

# Validate all records in audit.jsonl
while IFS= read -r line; do
  echo "$line" | ajv validate -s schemas/audit.v1.schema.json -d /dev/stdin
done < /path/to/audit.jsonl
```
