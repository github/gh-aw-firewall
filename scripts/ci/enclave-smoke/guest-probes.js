'use strict';

function buildConstantObjectSchema(expected) {
  return {
    type: 'object',
    fields: Object.fromEntries(
      Object.entries(expected).map(([name, value]) => [name, { type: 'const', value }]),
    ),
  };
}

function buildAgentGuestProbe({ githubEnabled = false } = {}) {
  const expected = {
    uid: 65534,
    gid: 65534,
    onlyExpectedInterfaces: true,
    emptyEffectiveCapabilities: true,
    noNewPrivileges: true,
    processLimit: 47,
    fileSizeLimit: 268435456,
    openFileLimit: 1024,
    apiProxyReachable: true,
    wrongPortBlocked: true,
    wrongPeerBlocked: true,
    githubPeerBlocked: !githubEnabled,
    publicEgressBlocked: true,
  };
  const schema = buildConstantObjectSchema(expected);
  const python = [
    'import json, os, re, resource, socket',
    'status = open("/proc/self/status", encoding="ascii").read()',
    'effective = int(re.search(r"^CapEff:\\s+([0-9a-f]+)$", status, re.M).group(1), 16)',
    'no_new_privileges = re.search(r"^NoNewPrivs:\\s+1$", status, re.M) is not None',
    'interfaces = [name for _, name in socket.if_nameindex()]',
    'def reachable(ip, port):',
    '    try:',
    '        with socket.create_connection((ip, port), timeout=0.75):',
    '            return True',
    '    except OSError:',
    '        return False',
    'result = {',
    '    "uid": os.geteuid(), "gid": os.getegid(),',
    '    "onlyExpectedInterfaces": len(interfaces) == 2 and interfaces.count("lo") == 1,',
    '    "emptyEffectiveCapabilities": effective == 0, "noNewPrivileges": no_new_privileges,',
    '    "processLimit": resource.getrlimit(resource.RLIMIT_NPROC)[0],',
    '    "fileSizeLimit": resource.getrlimit(resource.RLIMIT_FSIZE)[0],',
    '    "openFileLimit": resource.getrlimit(resource.RLIMIT_NOFILE)[0],',
    '    "apiProxyReachable": reachable("172.31.0.30", 10002),',
    '    "wrongPortBlocked": not reachable("172.31.0.30", 10000),',
    '    "wrongPeerBlocked": not reachable("172.31.0.99", 10002),',
    '    "githubPeerBlocked": not reachable("172.31.0.40", 8080),',
    '    "publicEgressBlocked": not reachable("1.1.1.1", 443),',
    '}',
    'encoded = json.dumps(result, separators=(",", ":"))',
    'print(encoded)',
    'open("/awf/out", "w", encoding="utf8").write(encoded)',
  ].join('\n');
  return {
    expected,
    schema,
    prompt: [
      'Run this exact diagnostic with your shell tool using python3. Do not inspect repository files or make network requests other than those in the script.',
      '```bash',
      "python3 - <<'PY'",
      python,
      'PY',
      '```',
      'Return exactly the JSON object printed by the diagnostic, with no extra fields. Write that exact object to /awf/out as required by your result contract.',
    ].join('\n'),
  };
}

function buildScriptGuestProbe() {
  const expected = {
    uid: 65534,
    gid: 65534,
    seedReadOnly: true,
    noNetwork: true,
    onlyLoopback: true,
    privilegeDropDenied: true,
    noNewPrivileges: true,
    emptyEffectiveCapabilities: true,
    processLimit: 47,
    fileSizeLimit: 536870912,
    openFileLimit: 1024,
  };
  return { expected, schema: buildConstantObjectSchema(expected) };
}

function buildEnospcProbeScript(maxStorageMib = 1024) {
  if (maxStorageMib !== 512 && maxStorageMib !== 1024) {
    throw new Error('Live enclave storage probe requires a supported role ceiling');
  }
  const maximumFiles = maxStorageMib / 64;
  return [
    'import errno, json, os, stat, sys',
    'def record(stage, **flags):',
    '    fd = None',
    '    try:',
    '        fd = os.open("/tmp/.awf-enclave-storage-probe.jsonl", os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)',
    '        if not stat.S_ISREG(os.fstat(fd).st_mode):',
    '            raise OSError(errno.EINVAL, "invalid diagnostic file")',
    '        data = (json.dumps({"stage": stage, **flags}, separators=(",", ":")) + "\\n").encode("ascii")',
    '        if os.write(fd, data) != len(data):',
    '            raise OSError(errno.EIO, "short diagnostic write")',
    '    except OSError:',
    '        print("AWF_ENCLAVE_PROBE_DIAGNOSTIC write-failed", file=sys.stderr)',
    '    finally:',
    '        if fd is not None:',
    '            try:',
    '                os.close(fd)',
    '            except OSError:',
    '                print("AWF_ENCLAVE_PROBE_DIAGNOSTIC close-failed", file=sys.stderr)',
    'record("started")',
    'directory = "/output"',
    'chunk = b"x" * (8 * 1024 * 1024)',
    'created = []',
    'observed = False',
    'try:',
    `    for index in range(${maximumFiles}):`,
    '        name = os.path.join(directory, ".awf-live-enospc-" + str(index))',
    '        try:',
    '            fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)',
    '        except OSError as error:',
    '            if error.errno != errno.ENOSPC:',
    '                raise',
    '            observed = True',
    '            break',
    '        created.append(name)',
    '        try:',
    '            for _ in range(8):',
    '                remaining = memoryview(chunk)',
    '                while remaining:',
    '                    try:',
    '                        written = os.write(fd, remaining)',
    '                    except OSError as error:',
    '                        if error.errno != errno.ENOSPC:',
    '                            raise',
    '                        observed = True',
    '                        break',
    '                    if written < 1:',
    '                        raise OSError(errno.EIO, "zero-byte write during bounded storage probe")',
    '                    remaining = remaining[written:]',
    '                if observed:',
    '                    break',
    '        finally:',
    '            os.close(fd)',
    '        if observed:',
    '            break',
    '    record("storage-complete", enospcObserved=observed)',
    '    result = {"enospcObserved": observed, "probeFilesRemoved": False}',
    'finally:',
    '    record("cleanup-started")',
    '    for name in created:',
    '        os.unlink(name)',
    'result["probeFilesRemoved"] = all(not os.path.exists(name) for name in created)',
    'record("cleanup-complete", probeFilesRemoved=result["probeFilesRemoved"])',
    'encoded = json.dumps(result, separators=(",", ":"))',
    'print(encoded)',
    'record("output-write-started")',
    'with open("/output/out", "w", encoding="utf8") as output:',
    '    output.write(encoded)',
    'record("output-write-complete")',
    'def check(operation, action):',
    '    try: return action()',
    '    except OSError as error:',
    '        record("output-check-failed", operation=operation, errno=error.errno)',
    'def readback(name, label):',
    '    handle = check(label+"-open", lambda: open(name, "rb", opener=lambda n,f: os.open(n,f|os.O_NONBLOCK)))',
    '    if handle is None: return None',
    '    try: return check(label+"-read", lambda: handle.read(1025))',
    '    finally: check(label+"-close", handle.close)',
    'link = check("link-lstat", lambda: os.lstat("/awf/out"))',
    'is_link = link is not None and stat.S_ISLNK(link.st_mode)',
    'target = check("link-readlink", lambda: os.readlink("/awf/out")) if is_link else None',
    'direct = readback("/output/out", "direct")',
    'alias = readback("/awf/out", "alias")',
    'a = check("direct-stat", lambda: os.stat("/output/out"))',
    'b = check("alias-stat", lambda: os.stat("/awf/out"))',
    'record("output-verified", symlink=is_link, targetMatches=target=="/output/out",',
    '       sameFile=a is not None and b is not None and (a.st_dev,a.st_ino)==(b.st_dev,b.st_ino),',
    '       directReadable=direct is not None, aliasReadable=alias is not None,',
    '       directMatchesExpected=direct==encoded.encode(), aliasMatchesExpected=alias==encoded.encode())',
  ].join('\n');
}

function buildAgentEnospcProbe() {
  const expected = { enospcObserved: true, probeFilesRemoved: true };
  return {
    expected,
    schema: buildConstantObjectSchema(expected),
    prompt: [
      'Run this exact Python diagnostic in your shell. Do not inspect repository files or make network requests.',
      '```bash',
      "python3 - <<'PY'",
      buildEnospcProbeScript(512),
      'PY',
      '```',
      'Return the diagnostic\'s exact JSON object, without extra fields, in /awf/out.',
    ].join('\n'),
  };
}

function buildOomProbeScript() {
  return [
    'import json, os, subprocess, sys',
    'def oom_kills():',
    '    with open("/proc/vmstat", encoding="ascii") as status:',
    '        for line in status:',
    '            name, _, value = line.partition(" ")',
    '            if name == "oom_kill":',
    '                return int(value)',
    '    return -1',
    'before = oom_kills()',
    'child = subprocess.Popen([',
    '    sys.executable, "-c",',
    '    "blocks=[]\\nwhile True:\\n b=bytearray(32*1024*1024)\\n for i in range(0,len(b),4096): b[i]=1\\n blocks.append(b)",',
    '], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
    'signal = child.wait()',
    'after = oom_kills()',
    'result = {',
    '    "childKilledByOom": signal == -9 and before >= 0 and after > before,',
    '    "oomKillCounterIncreased": before >= 0 and after > before,',
    '}',
    'with open("/awf/out", "w", encoding="utf8") as output:',
    '    json.dump(result, output, separators=(",", ":"))',
  ].join('\n');
}

function buildScopedGithubGuestProbe() {
  const expected = { sourceRead: true, issueRead: true, toolsExact: true,
    wrongToolDenied: true, wrongRepoDenied: true, wrongIdentityDenied: true };
  const python = [
    'import json, pathlib, urllib.request, urllib.error',
    'assert pathlib.Path("/awf/seed/README.md").read_bytes()',
    'config = json.loads(pathlib.Path("/agent/github-mcp.json").read_text())["mcpServers"]["github"]',
    'assert config["url"] == "http://172.31.0.40:8080/mcp/github"',
    'assert sorted(config["tools"]) == ["issue_read", "list_issues"]',
    'def rpc(method, params, auth=None):',
    '    req = urllib.request.Request(config["url"], json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode(),',
    '        {"Content-Type":"application/json","Authorization":auth or config["headers"]["Authorization"]})',
    '    try:',
    '        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=10) as r:',
    '            return r.status, json.loads(r.read(16384))',
    '    except urllib.error.HTTPError as e:',
    '        return e.code, None',
    'status, listed = rpc("tools/list", {})',
    'assert status == 200 and sorted(t["name"] for t in listed["result"]["tools"]) == ["issue_read", "list_issues"]',
    'args = {"owner":"github","repo":"gh-aw-firewall","method":"get","issue_number":1}',
    'status, issue = rpc("tools/call", {"name":"issue_read","arguments":args})',
    'assert status == 200 and issue["result"]["structuredContent"] == {"number":1,"title":"AWF controlled scoped issue","repository":"github/gh-aw-firewall"}',
    'assert rpc("tools/call", {"name":"issue_write","arguments":args})[0] == 403',
    'assert rpc("tools/call", {"name":"issue_read","arguments":dict(args, repo="other")})[0] == 403',
    'assert rpc("tools/list", {}, "invalid-executor-identity-" * 2)[0] == 403',
    `result = dict.fromkeys(${JSON.stringify(Object.keys(expected))}, True)`,
    'encoded = json.dumps(result, separators=(",", ":"))',
    'print(encoded)',
    'pathlib.Path("/awf/out").write_text(encoded)',
  ].join('\n');
  return {
    expected, schema: buildConstantObjectSchema(expected), python,
    prompt: [
      'Run this exact controlled fixture diagnostic with your shell tool. Never print credentials or repository contents.',
      "```bash\npython3 - <<'PY'", python, 'PY\n```',
      'Return exactly the JSON object printed, and write it to /awf/out.',
    ].join('\n'),
  };
}

module.exports = {
  buildConstantObjectSchema,
  buildAgentGuestProbe,
  buildScriptGuestProbe,
  buildEnospcProbeScript,
  buildAgentEnospcProbe,
  buildOomProbeScript,
  buildScopedGithubGuestProbe,
};
