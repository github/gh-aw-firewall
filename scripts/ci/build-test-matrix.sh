#!/usr/bin/env bash
set -uo pipefail

DATA_DIR="${BUILD_TEST_DATA_DIR:-/tmp/gh-aw/build-test}"
WORK_DIR="$DATA_DIR/work"
LOG_DIR="$DATA_DIR/logs"
RECORDS_FILE="$DATA_DIR/records.jsonl"
RESULTS_FILE="$DATA_DIR/results.json"
MAVEN_REPO="$DATA_DIR/m2"

mkdir -p "$WORK_DIR" "$LOG_DIR"
rm -f "$RECORDS_FILE" "$RESULTS_FILE"

record_project() {
  BUILD_TEST_RECORDS_FILE="$RECORDS_FILE" \
    BUILD_TEST_ECOSYSTEM="$1" \
    BUILD_TEST_PROJECT="$2" \
    BUILD_TEST_BUILD_STATUS="$3" \
    BUILD_TEST_TEST_STATUS="$4" \
    BUILD_TEST_TEST_KIND="$5" \
    BUILD_TEST_TEST_LOG="$6" \
    BUILD_TEST_ERROR="$7" \
    node <<'NODE'
const fs = require("node:fs");
const record = {
  ecosystem: process.env.BUILD_TEST_ECOSYSTEM,
  project: process.env.BUILD_TEST_PROJECT,
  buildStatus: process.env.BUILD_TEST_BUILD_STATUS,
  testStatus: process.env.BUILD_TEST_TEST_STATUS,
  testKind: process.env.BUILD_TEST_TEST_KIND,
  testLog: process.env.BUILD_TEST_TEST_LOG,
  error: process.env.BUILD_TEST_ERROR,
};
fs.appendFileSync(process.env.BUILD_TEST_RECORDS_FILE, `${JSON.stringify(record)}\n`);
NODE
}

run_stage() {
  local command="$1"
  local log_file="$2"
  timeout --foreground --kill-after=10s 15m bash -o pipefail -c "$command" >"$log_file" 2>&1
}

failure_details() {
  tail -n 8 "$1" | tr '\t\n' '  ' | cut -c1-600
}

clone_repo() {
  local ecosystem="$1"
  local url="$2"
  local target="$WORK_DIR/$ecosystem"
  local log_file="$LOG_DIR/clone-$ecosystem.log"
  rm -rf "$target"
  echo "::group::Clone $ecosystem"
  if git clone --depth 1 "$url" "$target" >"$log_file" 2>&1; then
    echo "::endgroup::"
    return 0
  fi
  cat "$log_file"
  echo "::endgroup::"
  return 1
}

record_clone_failed() {
  local ecosystem="$1"
  local project="$2"
  local error="$3"
  record_project "$ecosystem" "$project" CLONE_FAILED SKIPPED none "" "$error"
}

record_project_result() {
  local ecosystem="$1"
  local project="$2"
  local dir="$3"
  local build_command="$4"
  local test_command="$5"
  local test_kind="$6"
  local prefix="$LOG_DIR/$ecosystem-$project"
  local build_status=N/A
  local test_status=N/A
  local error=""

  if [ "$build_command" != N/A ]; then
    echo "::group::$ecosystem / $project / build"
    if run_stage "cd \"$dir\" && $build_command" "$prefix-build.log"; then
      build_status=PASS
    else
      build_status=FAIL
      error="$(failure_details "$prefix-build.log")"
    fi
    echo "::endgroup::"
  fi

  if [ "$test_command" != N/A ]; then
    if [ "$build_status" = FAIL ]; then
      test_status=SKIPPED
    else
      echo "::group::$ecosystem / $project / test"
      if run_stage "cd \"$dir\" && $test_command" "$prefix-test.log"; then
        test_status=PASS
      else
        test_status=FAIL
        test_error="$(failure_details "$prefix-test.log")"
        error="${error:+$error; }$test_error"
      fi
      echo "::endgroup::"
    fi
  fi

  record_project "$ecosystem" "$project" "$build_status" "$test_status" \
    "$test_kind" "$prefix-test.log" "$error"
}

install_optional_runtimes() {
  local log_file
  log_file="$LOG_DIR/install-bun.log"
  echo "::group::Install Bun"
  if BUN_INSTALL="$DATA_DIR/bun" curl -fsSL https://bun.sh/install | BUN_INSTALL="$DATA_DIR/bun" bash >"$log_file" 2>&1; then
    export BUN_INSTALL="$DATA_DIR/bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    BUN_INSTALL_STATUS=PASS
  else
    BUN_INSTALL_STATUS=FAIL
    BUN_INSTALL_ERROR="$(failure_details "$log_file")"
  fi
  echo "::endgroup::"

  log_file="$LOG_DIR/install-deno.log"
  echo "::group::Install Deno"
  if DENO_INSTALL="$DATA_DIR/deno" curl -fsSL https://deno.land/install.sh | DENO_INSTALL="$DATA_DIR/deno" sh -s -- -y >"$log_file" 2>&1; then
    export DENO_INSTALL="$DATA_DIR/deno"
    export PATH="$DENO_INSTALL/bin:$PATH"
    DENO_INSTALL_STATUS=PASS
  else
    DENO_INSTALL_STATUS=FAIL
    DENO_INSTALL_ERROR="$(failure_details "$log_file")"
  fi
  echo "::endgroup::"
}

mkdir -p "$MAVEN_REPO"
install_optional_runtimes

clone_status=()
ecosystems=(Bun C++ Deno .NET Go Java Node.js Rust)
clone_urls=(
  https://github.com/Mossaka/gh-aw-firewall-test-bun.git
  https://github.com/Mossaka/gh-aw-firewall-test-cpp.git
  https://github.com/Mossaka/gh-aw-firewall-test-deno.git
  https://github.com/Mossaka/gh-aw-firewall-test-dotnet.git
  https://github.com/Mossaka/gh-aw-firewall-test-go.git
  https://github.com/Mossaka/gh-aw-firewall-test-java.git
  https://github.com/Mossaka/gh-aw-firewall-test-node.git
  https://github.com/Mossaka/gh-aw-firewall-test-rust.git
)
clone_dirs=(bun cpp deno dotnet go java node rust)
clone_failed_count=0

for index in "${!ecosystems[@]}"; do
  ecosystem="${ecosystems[$index]}"
  clone_dir="${clone_dirs[$index]}"
  if clone_repo "$clone_dir" "${clone_urls[$index]}"; then
    clone_status[$index]=PASS
  else
    clone_status[$index]=FAIL
    clone_failed_count=$((clone_failed_count + 1))
    clone_error="$(failure_details "$LOG_DIR/clone-$ecosystem.log" 2>/dev/null || true)"
    clone_error="${clone_error:-git clone failed for ${clone_urls[$index]}}"
    case "$ecosystem" in
      Bun) projects=(elysia hono) ;;
      C++) projects=(fmt json) ;;
      Deno) projects=(oak std) ;;
      .NET) projects=(hello-world json-parse) ;;
      Go) projects=(color env uuid) ;;
      Java) projects=(gson caffeine) ;;
      Node.js) projects=(clsx execa p-limit) ;;
      Rust) projects=(fd zoxide) ;;
    esac
    for project in "${projects[@]}"; do
      record_clone_failed "$ecosystem" "$project" "$clone_error"
    done
  fi
done

if [ "${clone_status[0]}" = PASS ]; then
  for project in elysia hono; do
    if [ "$BUN_INSTALL_STATUS" = PASS ]; then
      record_project_result Bun "$project" "$WORK_DIR/bun/$project" "bun install" "bun test" bun
    else
      record_project Bun "$project" FAIL SKIPPED bun "" "Bun installation failed: $BUN_INSTALL_ERROR"
    fi
  done
fi

if [ "${clone_status[1]}" = PASS ]; then
  for project in fmt json; do
    record_project_result "C++" "$project" "$WORK_DIR/cpp/$project" \
      "mkdir -p build && cd build && cmake .. && cmake --build . --parallel 2" N/A none
  done
fi

if [ "${clone_status[2]}" = PASS ]; then
  for project in oak std; do
    if [ "$DENO_INSTALL_STATUS" = PASS ]; then
      record_project_result Deno "$project" "$WORK_DIR/deno/$project" N/A "deno test" deno
    else
      record_project Deno "$project" N/A FAIL deno "$LOG_DIR/deno-$project-test.log" \
        "Deno installation failed: $DENO_INSTALL_ERROR"
    fi
  done
fi

if [ "${clone_status[3]}" = PASS ]; then
  for project in hello-world json-parse; do
    record_project_result ".NET" "$project" "$WORK_DIR/dotnet/$project" \
      "dotnet restore && dotnet build --no-restore && dotnet run --no-build" N/A none
  done
fi

if [ "${clone_status[4]}" = PASS ]; then
  for project in color env uuid; do
    record_project_result Go "$project" "$WORK_DIR/go/$project" "go mod download" \
      "go test -json ./..." go
  done
fi

if [ "${clone_status[5]}" = PASS ]; then
  for project in gson caffeine; do
    record_project_result Java "$project" "$WORK_DIR/java/$project" \
      "mvn -ntp -Dmaven.repo.local=\"$MAVEN_REPO\" compile" \
      "mvn -ntp -Dmaven.repo.local=\"$MAVEN_REPO\" test" maven
  done
fi

if [ "${clone_status[6]}" = PASS ]; then
  for project in clsx execa p-limit; do
    record_project_result "Node.js" "$project" "$WORK_DIR/node/$project" "npm install" "npm test" node
  done
fi

if [ "${clone_status[7]}" = PASS ]; then
  for project in fd zoxide; do
    record_project_result Rust "$project" "$WORK_DIR/rust/$project" "cargo build" "cargo test" rust
  done
fi

BUILD_TEST_RECORDS_FILE="$RECORDS_FILE" \
  BUILD_TEST_RESULTS_FILE="$RESULTS_FILE" \
  BUILD_TEST_CLONE_FAILED_COUNT="$clone_failed_count" \
  node <<'NODE'
const fs = require("node:fs");

function testCounts(kind, logPath) {
  if (kind === "none" || !logPath || !fs.existsSync(logPath)) return null;
  const log = fs.readFileSync(logPath, "utf8");
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let matched = false;

  if (kind === "go") {
    for (const line of log.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.Test && event.Action === "pass") {
          passed++;
          matched = true;
        } else if (event.Test && event.Action === "fail") {
          failed++;
          matched = true;
        }
      } catch {}
    }
  } else if (kind === "maven") {
    for (const match of log.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/g)) {
      const [run, failures, errors, ignored] = match.slice(1).map(Number);
      passed += run - failures - errors - ignored;
      failed += failures + errors;
      skipped += ignored;
      matched = true;
    }
  } else if (kind === "rust") {
    for (const match of log.matchAll(/test result: .*?(\d+) passed; (\d+) failed; (\d+) ignored/g)) {
      passed += Number(match[1]);
      failed += Number(match[2]);
      skipped += Number(match[3]);
      matched = true;
    }
  } else {
    const patterns = kind === "bun"
      ? [[/(\d+)\s+pass(?:ed)?/gi, /(\d+)\s+fail(?:ed)?/gi]]
      : kind === "deno"
        ? [[/(\d+)\s+passed/gi, /(\d+)\s+failed/gi]]
        : [[/(\d+)\s+passing/gi, /(\d+)\s+failing/gi]];
    for (const [passPattern, failPattern] of patterns) {
      const passMatches = [...log.matchAll(passPattern)];
      const failMatches = [...log.matchAll(failPattern)];
      if (passMatches.length || failMatches.length) {
        passed = passMatches.reduce((sum, match) => sum + Number(match[1]), 0);
        failed = failMatches.reduce((sum, match) => sum + Number(match[1]), 0);
        matched = true;
      }
    }
    if (!matched && kind === "node") {
      const jest = log.match(/Tests:\s+(?:(\d+)\s+passed(?:,\s*(\d+)\s+failed)?|(\d+)\s+total)/);
      const vitest = log.match(/Tests\s+(\d+)\s+passed(?:\s+\|\s+(\d+)\s+failed)?/);
      const tap = log.match(/# pass (\d+)[\s\S]*?# fail (\d+)/);
      const match = jest || vitest || tap;
      if (match) {
        passed = Number(match[1] || match[3] || 0);
        failed = Number(match[2] || 0);
        matched = true;
      }
    }
  }
  return matched ? { passed, failed, skipped, total: passed + failed + skipped } : null;
}

const records = fs.readFileSync(process.env.BUILD_TEST_RECORDS_FILE, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const record = JSON.parse(line);
    const tests = testCounts(record.testKind, record.testLog);
    const status = record.buildStatus === "CLONE_FAILED"
      ? "CLONE_FAILED"
      : record.buildStatus === "FAIL" || record.testStatus === "FAIL"
        ? "FAIL"
        : "PASS";
    return {
      ecosystem: record.ecosystem,
      project: record.project,
      build: record.buildStatus,
      tests: record.testStatus === "N/A" || record.testStatus === "SKIPPED"
        ? null
        : { status: record.testStatus, counts: tests },
      status,
      error: record.error || null,
    };
  });

const ecosystems = ["Bun", "C++", "Deno", ".NET", "Go", "Java", "Node.js", "Rust"]
  .map((name) => {
    const projects = records.filter((record) => record.ecosystem === name);
    return {
      name,
      status: projects.length > 0 && projects.every((project) => project.status === "PASS") ? "PASS" : "FAIL",
      projects,
    };
  });
const ecosystemsPassed = ecosystems.filter((ecosystem) => ecosystem.status === "PASS").length;
const results = {
  status: ecosystemsPassed === ecosystems.length ? "PASS" : "FAIL",
  ecosystemsPassed,
  ecosystemCount: ecosystems.length,
  allClonesFailed: Number(process.env.BUILD_TEST_CLONE_FAILED_COUNT) === ecosystems.length,
  ecosystems,
};
fs.writeFileSync(process.env.BUILD_TEST_RESULTS_FILE, `${JSON.stringify(results, null, 2)}\n`);
console.log(`Build-test matrix: ${ecosystemsPassed}/${ecosystems.length} ecosystems passed`);
console.log(`Results written to ${process.env.BUILD_TEST_RESULTS_FILE}`);
NODE
