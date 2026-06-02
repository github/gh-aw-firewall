#!/bin/bash
# Export audit analysis script — writes context markdown to stdout.
# Caller is responsible for redirecting output to the context file.
set -o pipefail

echo "## Pre-computed Data"
echo

# TypeScript compiler errors
echo "TypeScript build output:"
echo '```'
npx tsc --noEmit 2>&1 | head -40 || true
echo '```'
echo

# Export inventory (capped at 30)
echo "Exported symbols sample:"
echo '```'
echo "=== All exported symbols from src/ ==="
grep -rn "^export[[:space:]]\+\(function\|class\|const\|let\|var\|type\|interface\|enum\)" src/ --include="*.ts" | \
  grep -v "\.test\.ts" | \
  sed 's|.*export[[:space:]]\+\(function\|class\|const\|let\|var\|type\|interface\|enum\)[[:space:]]\+\([a-zA-Z_][a-zA-Z0-9_]*\).*|\2|' | \
  sort | head -30
echo '```'
echo

# Unused exports (capped at 15)
echo "Unused exports:"
echo '```'
UNUSED_EXPORTS=""
if command -v ts-prune >/dev/null 2>&1; then
  UNUSED_EXPORTS=$(ts-prune | grep -v "\.test\.ts" | head -15)
else
  echo "ts-prune unavailable, falling back to grep analysis"
  UNUSED_EXPORTS=$(grep -rn "^export " src/ --include="*.ts" | grep -v "\.test\.ts" | \
    while IFS=: read -r file line rest; do
      name=$(echo "$rest" | sed -n 's/.*export \(function\|class\|const\|type\|interface\|enum\) \([a-zA-Z_][a-zA-Z0-9_]*\).*/\2/p')
      [ -z "$name" ] && continue
      count=$(grep -rwn "${name}" src/ --include="*.ts" 2>/dev/null | grep -v "^${file}:" | wc -l)
      [ "$count" -eq 0 ] && echo "UNUSED: $name ($file:$line)"
    done | head -15)
fi
echo "$UNUSED_EXPORTS"
echo '```'
echo

# Verified unused exports (pre-verify top 10)
echo "Verified unused exports:"
echo '```'
if [ -n "$UNUSED_EXPORTS" ]; then
  echo "$UNUSED_EXPORTS" | \
    while IFS= read -r line; do
      file=""
      sym=""
      if echo "$line" | grep -qE '^[^[:space:]]+\.ts:[0-9]+ - [^[:space:]]+'; then
        file=$(echo "$line" | sed -E 's/^([^[:space:]]+\.ts):[0-9]+ - .*/\1/')
        sym=$(echo "$line" | sed -E 's/^[^[:space:]]+\.ts:[0-9]+ - ([^[:space:]]+).*/\1/')
      elif echo "$line" | grep -qE '^UNUSED: [^[:space:]]+ \([^)]*\)$'; then
        sym=$(echo "$line" | sed -E 's/^UNUSED: ([^[:space:]]+) \([^)]*\)$/\1/')
        file=$(echo "$line" | sed -E 's/^UNUSED: [^[:space:]]+ \(([^:]+):[0-9]+\)$/\1/')
      fi
      if [ -n "$file" ] && [ -n "$sym" ]; then
        echo "${file}"$'\t'"${sym}"
      fi
    done | \
    awk -F'\t' 'NF == 2 && !seen[$0]++' | \
    head -10 | \
    while IFS=$'\t' read -r file sym; do
      count=$(grep -rwl "$sym" src/ --include="*.ts" 2>/dev/null | \
        grep -v "\.test\.ts" | \
        awk -v file="$file" '$0 != file' | \
        wc -l)
      echo "${sym}: used_outside_defining_file=${count}_files"
    done
fi
echo '```'
echo

# Circular dependencies
echo "Circular dependencies:"
echo '```'
if command -v madge >/dev/null 2>&1; then
  madge --circular src/ 2>&1 | head -20
else
  echo "madge unavailable, cannot check circular deps"
fi
echo '```'
echo

# Naming issues (capped at 10)
echo "Naming issues:"
echo '```'
echo "=== Types/interfaces not in PascalCase ==="
grep -rn "^export type\|^export interface" src/ --include="*.ts" | \
  grep -v "\.test\.ts" | \
  sed 's/.*export \(type\|interface\) \([a-zA-Z_][a-zA-Z0-9_]*\).*/\2/' | \
  grep -v "^[A-Z]" | head -10
echo "=== api-proxy provider exports ==="
for f in containers/api-proxy/providers/*.js; do
  [ -f "$f" ] || continue
  [ "$(basename "$f")" = "index.js" ] && continue
  echo "--- $(basename "$f") ---"
  grep -n "^module\.exports\|^exports\." "$f" | head -3
done
echo '```'
echo

# Test imports (3 lines/file, max 8 files)
echo "Test imports:"
echo '```'
echo "=== Test files: imports from src/ ==="
find src -type f -name "*.test.ts" | sort | head -8 | while IFS= read -r f; do
  [ -f "$f" ] || continue
  echo "--- $f ---"
  grep "^import\|^const.*=.*require" "$f" 2>/dev/null | head -3
done
echo "=== Check for tests importing from dist/ ==="
grep -rn "from '.*dist/\|require('.*dist/" src/ --include="*.test.ts" | head -10
echo "=== Check for tests reaching into private implementation ==="
grep -rn "from '\.\.\/\.\.\/" src/ --include="*.test.ts" | head -10
echo '```'
echo

# API proxy exports
echo "API proxy exports:"
echo '```'
echo "=== api-proxy/providers: export consistency ==="
for f in containers/api-proxy/providers/*.js; do
  [ -f "$f" ] || continue
  [ "$(basename "$f")" = "index.js" ] && continue
  echo "--- $f ---"
  grep -n "^module\.exports\|^exports\." "$f" | head -5
done | head -50
echo "=== providers/index.js: registered providers ==="
cat containers/api-proxy/providers/index.js 2>/dev/null | grep -n "require\|createAdapter\|register" | head -20
echo "=== server.js: imports from providers ==="
grep -n "require.*providers\|from.*providers" containers/api-proxy/server.js 2>/dev/null | head -10
echo '```'
