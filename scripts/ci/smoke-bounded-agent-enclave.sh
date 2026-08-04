#!/usr/bin/env bash
set -euo pipefail

runtime="${1:-docker}"
case "$runtime" in
  docker) runtime_args=() ;;
  gvisor)
    if ! docker info --format '{{range $name, $_ := .Runtimes}}{{println $name}}{{end}}' |
      grep -qx runsc; then
      echo "BLOCKED: gVisor bounded-agent smoke requires registered runsc"
      exit 0
    fi
    runtime_args=(--runtime runsc)
    ;;
  *)
    echo "BLOCKED: unsupported bounded-agent smoke runtime: $runtime" >&2
    exit 2
    ;;
esac

if ! docker info >/dev/null 2>&1; then
  echo "BLOCKED: Docker daemon is unavailable"
  exit 0
fi

image="awf-bounded-agent-smoke:${runtime}"
run_id="$(printf '%08x%08x' "$$" "$RANDOM")"
network="awf-bounded-agent-smoke-${run_id}"
proxy="awf-bounded-agent-smoke-proxy-${run_id}"
root="$(mktemp -d "${TMPDIR:-/tmp}/awf-bounded-agent-smoke.XXXXXX")"
seccomp="$(pwd)/containers/bounded-query/query-seccomp.json"

cleanup() {
  docker rm -f "$proxy" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT INT TERM

docker build --quiet --target enclave -t "$image" -f containers/bounded-agent/Dockerfile containers >/dev/null
docker network create --internal "$network" >/dev/null

mkdir -p "$root/seed"
printf 'LIVE-SMOKE-MARKER\n' > "$root/seed/SECURITY.md"
printf 'Does SECURITY.md exist?\n' > "$root/task.txt"
printf '{"type":"boolean"}\n' > "$root/schema.json"
: > "$root/out"
: > "$root/session.jsonl"
chmod -R a+rX "$root/seed" "$root/task.txt" "$root/schema.json"
chmod a+rw "$root/out" "$root/session.jsonl"

proxy_program='
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def send_json(self, payload, status=200):
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)
    def do_GET(self):
        self.send_json({
            "object": "list",
            "data": [{
                "id": "live-smoke",
                "object": "model",
                "created": 0,
                "owned_by": "awf",
            }],
        })
    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        request = self.rfile.read(length).decode("utf-8", errors="replace")
        body = json.loads(request)
        tool_names = [
            tool.get("function", {}).get("name")
            for tool in body.get("tools", [])
        ]
        print(json.dumps({
            "path": self.path,
            "model": body.get("model"),
            "messageRoles": [
                message.get("role") for message in body.get("messages", [])
            ],
            "tools": tool_names,
        }), flush=True)
        if "LIVE-SMOKE-MARKER" in request:
            message = {"role": "assistant", "content": "true"}
            finish_reason = "stop"
        elif "view" in tool_names:
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": "live-view",
                    "type": "function",
                    "function": {
                        "name": "view",
                        "arguments": "{\"path\":\"/awf/seed/SECURITY.md\"}",
                    },
                }],
            }
            finish_reason = "tool_calls"
        else:
            self.send_json({"error": {"message": "native view tool was not offered"}}, 400)
            return
        self.send_json({
            "id": "chatcmpl-live-smoke",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": "live-smoke",
            "choices": [{
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }],
            "usage": {
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "total_tokens": 2,
            },
        })
    def log_message(self, *_args):
        pass
HTTPServer(("0.0.0.0", 10000), Handler).serve_forever()
'
docker run -d --name "$proxy" --network "$network" --network-alias api-proxy \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --entrypoint python3 "$image" -c "$proxy_program" >/dev/null

proxy_ready=false
for _ in $(seq 1 30); do
  if docker exec "$proxy" python3 -c \
    'import socket; socket.create_connection(("127.0.0.1",10000),1).close()' >/dev/null 2>&1; then
    proxy_ready=true
    break
  fi
  sleep 1
done
if [[ "$proxy_ready" != true ]]; then
  echo "FAIL: bounded-agent fake API proxy did not become ready" >&2
  exit 1
fi
proxy_ip="$(
  docker inspect "$proxy" \
    --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
)"
if [[ -z "$proxy_ip" ]]; then
  echo "FAIL: bounded-agent fake API proxy has no enclave-network address" >&2
  exit 1
fi

set +e
logs="$(
  docker run --rm "${runtime_args[@]}" \
    --name "awf-bounded-agent-smoke-${run_id}" \
    --network "$network" \
    --read-only \
    --user 65534:65534 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --security-opt "seccomp=${seccomp}" \
    --memory 512m --memory-swap 512m --cpus 1 --pids-limit 128 \
    --ulimit fsize=33554432 --ulimit nofile=1024:1024 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
    --tmpfs /agent:rw,nosuid,nodev,size=64m,uid=65534,gid=65534,mode=0700 \
    --hostname bounded-agent \
    --workdir /awf/seed \
    -v "$root/seed:/awf/seed:ro" \
    -v "$root/task.txt:/awf/task.txt:ro" \
    -v "$root/schema.json:/awf/schema.json:ro" \
    -v "$root/out:/agent/out:rw" \
    -v "$root/session.jsonl:/agent/session.jsonl:rw" \
    -e AWF_BOUNDED_AGENT_ENGINE=copilot \
    -e HOME=/agent/home \
    -e COPILOT_HOME=/agent/copilot \
    -e COPILOT_OFFLINE=true \
    -e COPILOT_GITHUB_TOKEN=****** \
    -e COPILOT_TOKEN=****** \
    -e COPILOT_API_URL="http://${proxy_ip}:10000" \
    -e COPILOT_PROVIDER_BASE_URL="http://${proxy_ip}:10000" \
    -e COPILOT_MODEL=live-smoke \
    -e AWF_BOUNDED_AGENT_API_ENDPOINT="http://${proxy_ip}:10000" \
    -e AWF_BOUNDED_AGENT_PROFILE=openai \
    -e AWF_BOUNDED_AGENT_MODEL=live-smoke \
    -e AWF_BOUNDED_AGENT_MAX_MODEL_REQUESTS=2 \
    -e AWF_BOUNDED_AGENT_MAX_MODEL_TOKENS=64 \
    -e AWF_BOUNDED_AGENT_MAX_OUTPUT_BYTES=64 \
    -e AWF_BOUNDED_AGENT_DEADLINE_SECONDS=30 \
    -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONUNBUFFERED=1 \
    --entrypoint /usr/local/bin/run-bounded-agent \
    "$image" 2>&1
)"
status=$?
set -e
if [[ $status -ne 0 || -n "$logs" || "$(cat "$root/out")" != "true" ]]; then
  docker logs "$proxy" >&2 || true
  cat "$root/session.jsonl" >&2 || true
  echo "FAIL: $runtime enclave did not produce one silent canonical result" \
    "(status=$status, streamBytes=${#logs}, resultBytes=$(wc -c < "$root/out"))" >&2
  exit 1
fi

docker run --rm "${runtime_args[@]}" --network "$network" --entrypoint python3 "$image" -c '
import socket, sys, urllib.request
socket.create_connection((sys.argv[1], 10000), 2).close()
try:
    urllib.request.urlopen("https://example.com", timeout=2)
except Exception:
    sys.exit(0)
sys.exit(1)
' "$proxy_ip"

peers="$(docker network inspect "$network" --format '{{len .Containers}}')"
if [[ "$peers" != "1" ]]; then
  echo "FAIL: API-proxy-only network retained unexpected peers: $peers" >&2
  exit 1
fi

echo "SUPPORTED: $runtime bounded-agent enclave live smoke passed"
