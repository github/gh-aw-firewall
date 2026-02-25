# API Proxy Local Testing Guide

How to test observability (structured logging, metrics, request tracing) and rate limiting locally.

## Prerequisites

```bash
# Build from the PR branch
git checkout feat/api-proxy-observability-ratelimit
npm run build
```

You need `sudo` access (for iptables) and Docker running.

---

## 1. Observability basics

See structured JSON logs, enhanced `/health`, and `/metrics` endpoint.

```bash
sudo -E awf --enable-api-proxy --build-local --keep-containers \
  --allow-domains api.anthropic.com \
  -- 'bash -c "
    curl -s -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" \
      -d \"{\\\"model\\\":\\\"claude-3-haiku-20240307\\\",\\\"max_tokens\\\":10,\\\"messages\\\":[{\\\"role\\\":\\\"user\\\",\\\"content\\\":\\\"hi\\\"}]}\"
    echo
    echo === HEALTH ===
    curl -s http://172.30.0.30:10000/health | python3 -m json.tool
    echo === METRICS ===
    curl -s http://172.30.0.30:10000/metrics | python3 -m json.tool
  "'
```

**What to look for:**
- Structured JSON log lines in stderr (from the api-proxy container)
- `/health` includes `metrics_summary` with `total_requests: 1` and `rate_limits`
- `/metrics` shows counters, histogram buckets, and latency percentiles

## 2. Request tracing with X-Request-ID

```bash
sudo -E awf --enable-api-proxy --build-local \
  --allow-domains api.anthropic.com \
  -- 'bash -c "
    curl -s -i -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" \
      -H \"X-Request-ID: my-trace-12345\" \
      -d \"{\\\"model\\\":\\\"test\\\"}\" 2>&1 | grep -i x-request-id
  "'
```

**Expected:** `X-Request-ID: my-trace-12345` reflected back in the response headers.

## 3. Rate limiting: trigger a 429

```bash
sudo -E awf --enable-api-proxy --build-local \
  --rate-limit-rpm 3 \
  --allow-domains api.anthropic.com \
  -- 'bash -c "
    for i in 1 2 3 4 5; do
      echo \"--- Request \$i ---\"
      curl -s -w \"\\nHTTP %{http_code}\" -X POST http://172.30.0.30:10001/v1/messages \
        -H \"Content-Type: application/json\" \
        -d \"{\\\"model\\\":\\\"test\\\"}\"
      echo
    done
  "'
```

**Expected:** Requests 1-3 get through (auth error from Anthropic proves routing works). Requests 4-5 get `HTTP 429` with:

```json
{
  "error": {
    "type": "rate_limit_error",
    "message": "Rate limit exceeded for anthropic provider. Limit: 3 requests per minute. Retry after N seconds.",
    "provider": "anthropic",
    "limit": 3,
    "window": "per_minute",
    "retry_after": N
  }
}
```

## 4. Rate limiting disabled

```bash
sudo -E awf --enable-api-proxy --build-local \
  --no-rate-limit \
  --allow-domains api.anthropic.com \
  -- 'bash -c "
    for i in $(seq 1 20); do
      CODE=$(curl -s -o /dev/null -w \"%{http_code}\" -X POST http://172.30.0.30:10001/v1/messages \
        -H \"Content-Type: application/json\" \
        -d \"{\\\"model\\\":\\\"test\\\"}\")
      echo \"Request \$i: HTTP \$CODE\"
    done
  "'
```

**Expected:** No 429s even with 20 rapid requests.

## 5. Bytes-per-minute limit

```bash
sudo -E awf --enable-api-proxy --build-local \
  --rate-limit-rpm 1000 --rate-limit-bytes-pm 500 \
  --allow-domains api.anthropic.com \
  -- 'bash -c "
    BODY_200=$(python3 -c \"print(chr(123) + chr(34) + chr(120) + chr(34) + chr(58) + chr(34) + chr(65)*180 + chr(34) + chr(125))\")

    echo \"Request 1 (200 bytes, should pass):\"
    curl -s -w \"\\nHTTP %{http_code}\" -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" -H \"Content-Length: 200\" -d \"\$BODY_200\"
    echo

    echo \"Request 2 (200 bytes, total 400 < 500, should pass):\"
    curl -s -w \"\\nHTTP %{http_code}\" -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" -H \"Content-Length: 200\" -d \"\$BODY_200\"
    echo

    echo \"Request 3 (200 bytes, total 600 > 500, should get 429):\"
    curl -s -w \"\\nHTTP %{http_code}\" -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" -H \"Content-Length: 200\" -d \"\$BODY_200\"
  "'
```

**Expected:** Requests 1-2 pass, request 3 gets 429 with `limit_type: bytes_pm`.

## 6. Per-provider independence

Exhausting one provider's limit doesn't affect another.

```bash
export ANTHROPIC_API_KEY=sk-ant-fake
export OPENAI_API_KEY=sk-fake

sudo -E awf --enable-api-proxy --build-local \
  --rate-limit-rpm 2 \
  --allow-domains api.anthropic.com,api.openai.com \
  -- 'bash -c "
    # Exhaust Anthropic limit (2 requests)
    curl -s -o /dev/null -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" -d \"{\\\"model\\\":\\\"test\\\"}\"
    curl -s -o /dev/null -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" -d \"{\\\"model\\\":\\\"test\\\"}\"

    echo \"Anthropic 3rd request (should be 429):\"
    curl -s -w \" HTTP %{http_code}\" -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" -d \"{\\\"model\\\":\\\"test\\\"}\"
    echo

    echo \"OpenAI 1st request (should NOT be 429):\"
    curl -s -w \" HTTP %{http_code}\" -X POST http://172.30.0.30:10000/v1/chat/completions \
      -H \"Content-Type: application/json\" -d \"{\\\"model\\\":\\\"gpt-4\\\"}\"
    echo
  "'
```

**Expected:** Anthropic 3rd request gets 429. OpenAI 1st request goes through (independent counter).

---

## Corner Cases

### 7. Content-Length header lies (known gap)

The bytes-per-minute rate limiter reads `Content-Length` to decide, not the actual body size.

```bash
sudo -E awf --enable-api-proxy --build-local \
  --rate-limit-bytes-pm 100 \
  --allow-domains api.anthropic.com \
  -- 'bash -c "
    HUGE_BODY=$(python3 -c \"print(chr(123) + chr(34) + chr(120) + chr(34) + chr(58) + chr(34) + chr(65)*500 + chr(34) + chr(125))\")
    echo \"Sending ~500 bytes with Content-Length: 10 (should bypass bytes limit):\"
    curl -s -w \"\\nHTTP %{http_code}\" -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" \
      -H \"Content-Length: 10\" \
      -d \"\$HUGE_BODY\"
  "'
```

**What happens:** The rate limiter lets it through (thinks it's 10 bytes). The 10MB `MAX_BODY_SIZE` still protects against DoS, but the bytes-per-minute tracking is inaccurate. A malicious agent could set `Content-Length: 0` on every request to bypass the bytes limit entirely.

### 8. X-Request-ID validation

```bash
sudo -E awf --enable-api-proxy --build-local \
  --allow-domains api.anthropic.com \
  -- 'bash -c "
    echo \"=== 128 chars (max allowed, should echo back) ===\"
    curl -s -i -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" \
      -H \"X-Request-ID: $(python3 -c \"print(chr(65)*128)\")\" \
      -d \"{\\\"model\\\":\\\"test\\\"}\" | grep -i x-request-id

    echo \"=== 129 chars (over limit, should generate UUID) ===\"
    curl -s -i -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" \
      -H \"X-Request-ID: $(python3 -c \"print(chr(65)*129)\")\" \
      -d \"{\\\"model\\\":\\\"test\\\"}\" | grep -i x-request-id

    echo \"=== Script tags (invalid chars, should generate UUID) ===\"
    curl -s -i -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" \
      -H \"X-Request-ID: <script>alert(1)</script>\" \
      -d \"{\\\"model\\\":\\\"test\\\"}\" | grep -i x-request-id

    echo \"=== Newline injection (should generate UUID) ===\"
    curl -s -i -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" \
      -H \"X-Request-ID: legit-id\r\nX-Injected: true\" \
      -d \"{\\\"model\\\":\\\"test\\\"}\" | grep -i x-request-id
  "'
```

**Expected:** 128-char alphanumeric ID is accepted. Everything else gets a generated UUID. The validation regex is `/^[\w\-\.]+$/` (alphanumeric, dashes, dots, max 128 chars).

### 9. Sliding window rollover

Verify that rate limit counters reset after the window expires.

```bash
sudo -E awf --enable-api-proxy --build-local --keep-containers \
  --rate-limit-rpm 3 \
  --allow-domains api.anthropic.com \
  -- 'bash -c "
    # Exhaust the limit
    for i in 1 2 3; do
      curl -s -o /dev/null -X POST http://172.30.0.30:10001/v1/messages \
        -H \"Content-Type: application/json\" -d \"{\\\"model\\\":\\\"test\\\"}\"
    done

    echo \"After 3 requests (should be 429):\"
    curl -s -w \" HTTP %{http_code}\" -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" -d \"{\\\"model\\\":\\\"test\\\"}\"
    echo

    echo \"Rate limit status:\"
    curl -s http://172.30.0.30:10000/health | python3 -c \"
import sys, json
d = json.load(sys.stdin)
print(json.dumps(d.get('rate_limits', {}), indent=2))
\"

    echo \"Waiting 61 seconds for window reset...\"
    sleep 61

    echo \"After window reset (should pass):\"
    curl -s -w \" HTTP %{http_code}\" -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" -d \"{\\\"model\\\":\\\"test\\\"}\"
    echo
  "'
```

**Expected:** 429 before the wait, pass after the 61-second wait.

Note: this test takes ~70 seconds. Use `--keep-containers` so you can inspect state afterward.

### 10. No Content-Length header (chunked transfer)

```bash
sudo -E awf --enable-api-proxy --build-local \
  --rate-limit-bytes-pm 100 \
  --allow-domains api.anthropic.com \
  -- 'bash -c "
    echo \"Chunked request with no Content-Length (should bypass bytes limit):\"
    curl -s -w \"\\nHTTP %{http_code}\" -X POST http://172.30.0.30:10001/v1/messages \
      -H \"Content-Type: application/json\" \
      -H \"Transfer-Encoding: chunked\" \
      -d \"{\\\"model\\\":\\\"test\\\"}\"
  "'
```

**What happens:** `Content-Length` is absent, so `parseInt(undefined, 10)` returns `NaN`, which falls back to `0`. The bytes-per-minute limit is not enforced. Same gap as the lying Content-Length case.

### 11. Rate limit flags without --enable-api-proxy

```bash
sudo -E awf --rate-limit-rpm 10 \
  --allow-domains github.com \
  -- 'curl https://github.com'
```

**Expected:** Immediate error: `Rate limit flags require --enable-api-proxy` with exit code 1.

### 12. Metrics under concurrent load

```bash
sudo -E awf --enable-api-proxy --build-local --keep-containers \
  --rate-limit-rpm 1000 \
  --allow-domains api.anthropic.com \
  -- 'bash -c "
    # Blast 50 concurrent requests
    for i in $(seq 1 50); do
      curl -s -o /dev/null -X POST http://172.30.0.30:10001/v1/messages \
        -H \"Content-Type: application/json\" -d \"{\\\"model\\\":\\\"test\\\"}\" &
    done
    wait

    echo === METRICS ===
    curl -s http://172.30.0.30:10000/metrics | python3 -c \"
import sys, json
m = json.load(sys.stdin)
print('Counters:')
for k, v in sorted(m.get('counters', {}).items()):
    print(f'  {k}: {v}')
print()
h = m.get('histograms', {}).get('request_duration_ms', {})
for provider, data in h.items():
    print(f'Latency ({provider}): p50={data[\"p50\"]}ms p90={data[\"p90\"]}ms p99={data[\"p99\"]}ms count={data[\"count\"]}')
print()
print(f'Active requests: {m.get(\"gauges\", {}).get(\"active_requests\", {})}')
print(f'Uptime: {m.get(\"gauges\", {}).get(\"uptime_seconds\", 0)}s')
\"
  "'
```

**What to verify:**
- `requests_total` counters sum to ~50
- `active_requests` gauge is back to 0 (all completed)
- Histogram has count ~50 with reasonable percentiles
- No memory growth (fixed-bucket histograms)

---

## Known Gaps

| Gap | Impact | Mitigation |
|-----|--------|------------|
| Bytes limit uses `Content-Length` header, not actual body | Client can lie to bypass bytes-per-minute | 10MB `MAX_BODY_SIZE` still enforces absolute limit |
| Chunked requests have no Content-Length | Bytes-per-minute limit is not enforced | RPM limit still applies |
| `/health` and `/metrics` are not rate-limited | Could be hammered by agent | Lightweight endpoints, internal network only |
| Rate limit state resets on container restart | Agent could crash proxy to reset counters | `no-new-privileges`, dropped capabilities |

## CLI Flag Reference

| Flag | Default | Description |
|------|---------|-------------|
| `--rate-limit-rpm <n>` | 60 | Max requests per minute per provider |
| `--rate-limit-rph <n>` | 1000 | Max requests per hour per provider |
| `--rate-limit-bytes-pm <n>` | 52428800 (50MB) | Max request bytes per minute per provider |
| `--no-rate-limit` | (rate limiting on) | Disable all rate limiting |

All rate limit flags require `--enable-api-proxy`.
