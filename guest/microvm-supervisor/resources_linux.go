//go:build linux

package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

const tmpfsMagic = 0x01021994
const rlimitNproc = 6
const enclaveCredentialCapabilities = uint64(1<<6 | 1<<7)
const (
	prCapbsetDrop   = 24
	prSetNoNewPrivs = 38
)
const (
	enclaveRuntimeTag          = "enclave-runtime"
	enclaveRuntimeSource       = "/runtime"
	enclaveAgentRuntimeTarget  = "/agent"
	enclaveCompatibilityTarget = "/awf"
	enclaveCompatibilityMax    = 1 * 1024 * 1024
)

type enclaveResourceProfile struct {
	uid             uint32
	gid             uint32
	maxProcesses    uint64
	maxFileBytes    uint64
	maxOpenFiles    uint64
	primaryTmpfs    string
	primaryTmpfsMax uint64
}

var makeTmpfsMountTarget = os.MkdirAll
var createEnclaveSymlink = os.Symlink

func enclaveResourceProfileForRole(role string) (enclaveResourceProfile, error) {
	switch role {
	case "script":
		return enclaveResourceProfile{
			uid: 65534, gid: 65534, maxProcesses: 47,
			maxFileBytes: 512 * 1024 * 1024, maxOpenFiles: 1024,
			primaryTmpfs: "/query", primaryTmpfsMax: 256 * 1024 * 1024,
		}, nil
	case "agent":
		return enclaveResourceProfile{
			uid: 65534, gid: 65534, maxProcesses: 47,
			maxFileBytes: 256 * 1024 * 1024, maxOpenFiles: 1024,
			primaryTmpfs: "/tmp", primaryTmpfsMax: 96 * 1024 * 1024,
		}, nil
	default:
		return enclaveResourceProfile{}, fmt.Errorf("unsupported enclave resource profile %q", role)
	}
}

func mountEnclaveTmpfs(profile enclaveResourceProfile) error {
	mounts := []struct {
		target string
		size   uint64
		mode   os.FileMode
		uid    uint32
		gid    uint32
		flags  uintptr
	}{
		{target: profile.primaryTmpfs, size: profile.primaryTmpfsMax, mode: 0700, uid: profile.uid, gid: profile.gid, flags: syscall.MS_NOSUID | syscall.MS_NODEV},
		{target: "/run", size: 16 * 1024 * 1024, mode: 0755, flags: syscall.MS_NOSUID | syscall.MS_NODEV},
		{target: "/dev/shm", size: 32 * 1024 * 1024, mode: 01777, flags: syscall.MS_NOSUID | syscall.MS_NODEV},
	}
	mounts[0].flags |= syscall.MS_NOEXEC
	if profile.primaryTmpfs != "/tmp" {
		mounts = append(mounts, struct {
			target string
			size   uint64
			mode   os.FileMode
			uid    uint32
			gid    uint32
			flags  uintptr
		}{target: "/tmp", size: 16 * 1024 * 1024, mode: 01777, flags: syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC})
	} else {
		mounts[0].mode = 01777
		mounts = append(mounts, struct {
			target string
			size   uint64
			mode   os.FileMode
			uid    uint32
			gid    uint32
			flags  uintptr
		}{target: "/home/awf-enclave", size: 32 * 1024 * 1024, mode: 0700, uid: profile.uid, gid: profile.gid, flags: syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC})
	}
	for _, mount := range mounts {
		if err := makeTmpfsMountTarget(mount.target, 0755); err != nil {
			return fmt.Errorf("create enclave tmpfs target %q: %w", mount.target, err)
		}
		data := fmt.Sprintf("size=%d,mode=%o", mount.size, mount.mode)
		if mount.uid != 0 || mount.gid != 0 {
			data += fmt.Sprintf(",uid=%d,gid=%d", mount.uid, mount.gid)
		}
		if err := mountFilesystem("tmpfs", mount.target, "tmpfs", mount.flags, data); err != nil {
			return fmt.Errorf("mount bounded enclave tmpfs at %q: %w", mount.target, err)
		}
		if err := verifyTmpfsMount(mount.target, mount.size); err != nil {
			return fmt.Errorf("verify bounded enclave tmpfs at %q: %w", mount.target, err)
		}
	}
	if profile.primaryTmpfs == "/tmp" {
		if err := makeTmpfsMountTarget("/run/awf-enclave-github", 0700); err != nil {
			return fmt.Errorf("create agent enclave runtime directory: %w", err)
		}
	}
	return nil
}

func mountEnclaveCompatibilityPaths(role string) error {
	if role != "script" && role != "agent" {
		return fmt.Errorf("unsupported enclave compatibility role %q", role)
	}
	if err := makeTmpfsMountTarget(enclaveCompatibilityTarget, 0755); err != nil {
		return fmt.Errorf("create enclave compatibility target: %w", err)
	}
	if err := mountFilesystem(
		"tmpfs",
		enclaveCompatibilityTarget,
		"tmpfs",
		syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC,
		fmt.Sprintf("size=%d,mode=0755", enclaveCompatibilityMax),
	); err != nil {
		return fmt.Errorf("mount enclave compatibility tmpfs: %w", err)
	}
	if err := verifyTmpfsMount(enclaveCompatibilityTarget, enclaveCompatibilityMax); err != nil {
		verifyErr := fmt.Errorf("verify enclave compatibility tmpfs: %w", err)
		if unmountErr := unmountFilesystem(enclaveCompatibilityTarget, 0); unmountErr != nil {
			return fmt.Errorf("%w; unmount failed: %v", verifyErr, unmountErr)
		}
		return verifyErr
	}
	if err := createEnclaveCompatibilityLinks(role, ""); err != nil {
		if unmountErr := unmountFilesystem(enclaveCompatibilityTarget, 0); unmountErr != nil {
			return fmt.Errorf("%w; unmount failed: %v", err, unmountErr)
		}
		return err
	}
	return nil
}

func createEnclaveCompatibilityLinks(role, root string) error {
	links := [][2]string{
		{"/input-seed", "/awf/seed"},
		{"/output/out", "/awf/out"},
	}
	if role == "script" {
		links = append(links, [2]string{"/input-request/query-script.py", "/awf/query-script.py"})
	} else if role == "agent" {
		links = append(links,
			[2]string{"/input-request/task.txt", "/awf/task.txt"},
			[2]string{"/input-request/schema.json", "/awf/schema.json"},
			[2]string{"/runtime/session.jsonl", "/awf/session.jsonl"},
			[2]string{"/session-handoff/github-agent-id", "/run/awf-enclave-github/agent-id"},
			[2]string{"/session-handoff/github-bearer", "/run/awf-enclave-github/bearer"},
		)
	} else {
		return fmt.Errorf("unsupported enclave compatibility role %q", role)
	}
	for _, link := range links {
		target := link[0]
		linkPath := link[1]
		if root != "" {
			target = root + target
			linkPath = root + linkPath
		}
		if err := createEnclaveSymlink(target, linkPath); err != nil {
			return fmt.Errorf("create enclave compatibility path %q: %w", link[1], err)
		}
	}
	return nil
}

var verifyTmpfsMount = func(target string, maximumBytes uint64) error {
	var stats syscall.Statfs_t
	if err := syscall.Statfs(target, &stats); err != nil {
		return err
	}
	if uint64(stats.Type) != tmpfsMagic {
		return fmt.Errorf("filesystem is not tmpfs")
	}
	capacity := uint64(stats.Blocks) * uint64(stats.Bsize)
	if capacity > maximumBytes+4095 {
		return fmt.Errorf("tmpfs capacity %d exceeds configured limit %d", capacity, maximumBytes)
	}
	return nil
}

func applyEnclaveRlimits(profile enclaveResourceProfile) error {
	limits := []struct {
		resource int
		value    uint64
		name     string
	}{
		{resource: rlimitNproc, value: profile.maxProcesses, name: "process count"},
		{resource: syscall.RLIMIT_FSIZE, value: profile.maxFileBytes, name: "file size"},
		{resource: syscall.RLIMIT_NOFILE, value: profile.maxOpenFiles, name: "open files"},
	}
	for _, limit := range limits {
		if limit.value == 0 {
			return fmt.Errorf("enclave %s limit is missing", limit.name)
		}
		value := syscall.Rlimit{Cur: limit.value, Max: limit.value}
		if err := syscall.Setrlimit(limit.resource, &value); err != nil {
			return fmt.Errorf("apply enclave %s limit: %w", limit.name, err)
		}
		var actual syscall.Rlimit
		if err := syscall.Getrlimit(limit.resource, &actual); err != nil {
			return fmt.Errorf("verify enclave %s limit: %w", limit.name, err)
		}
		if actual.Cur != limit.value || actual.Max != limit.value {
			return fmt.Errorf("enclave %s limit was not applied", limit.name)
		}
	}
	return nil
}

func validateEnclaveCapabilities(status string) error {
	return validateEnclaveCapabilitySets(status, "0000000000000000", "0000000000000000")
}

func validateEnclaveSupervisorCapabilities(status string) error {
	return validateEnclaveCapabilitySets(status, "00000000000000c0", "00000000000000c0")
}

func validateEnclaveCapabilitySets(status, effective, permitted string) error {
	expected := map[string]string{
		"CapEff": effective,
		"CapPrm": permitted,
		"CapInh": "0000000000000000",
		"CapAmb": "0000000000000000",
		"CapBnd": "00000000000000c0",
	}
	capabilityFound := make(map[string]bool, len(expected))
	for _, line := range strings.Split(status, "\n") {
		name, value, hasValue := strings.Cut(line, ":")
		if expectedValue, known := expected[name]; hasValue && known {
			if strings.TrimSpace(value) != expectedValue {
				return fmt.Errorf("enclave process has unexpected capability set")
			}
			capabilityFound[name] = true
		}
	}
	for name := range expected {
		if !capabilityFound[name] {
			return fmt.Errorf("enclave process capability state is missing %s", name)
		}
	}
	return nil
}

func hasNoNewPrivileges(status string) bool {
	for _, line := range strings.Split(status, "\n") {
		if key, value, found := strings.Cut(line, ":"); found && key == "NoNewPrivs" {
			return strings.TrimSpace(value) == "1"
		}
	}
	return false
}

func verifyEnclaveRlimits(profile enclaveResourceProfile) error {
	for _, limit := range []struct {
		resource int
		value    uint64
		name     string
	}{
		{rlimitNproc, profile.maxProcesses, "process count"},
		{syscall.RLIMIT_FSIZE, profile.maxFileBytes, "file size"},
		{syscall.RLIMIT_NOFILE, profile.maxOpenFiles, "open files"},
	} {
		var actual syscall.Rlimit
		if err := syscall.Getrlimit(limit.resource, &actual); err != nil {
			return fmt.Errorf("verify enclave %s limit: %w", limit.name, err)
		}
		if actual.Cur != limit.value || actual.Max != limit.value {
			return fmt.Errorf("enclave %s limit verification failed", limit.name)
		}
	}
	return nil
}

// dropEnclaveSupervisorPrivileges restricts every Go runtime thread, not only
// the calling one. Capabilities, the bounding set, and no_new_privs are
// per-thread kernel state, so each change is applied with AllThreadsSyscall
// (which requires a cgo-free binary) and then verified for every task.
func dropEnclaveSupervisorPrivileges() error {
	if err := syscall.Setgroups([]int{}); err != nil {
		return fmt.Errorf("clear enclave supplementary groups: %w", err)
	}
	groups, err := syscall.Getgroups()
	if err != nil || len(groups) != 0 {
		return fmt.Errorf("verify cleared enclave supplementary groups")
	}
	lastCapBytes, err := os.ReadFile("/proc/sys/kernel/cap_last_cap")
	if err != nil {
		return fmt.Errorf("read kernel capability limit: %w", err)
	}
	lastCap, err := strconv.Atoi(strings.TrimSpace(string(lastCapBytes)))
	if err != nil || lastCap < 0 || lastCap > 63 {
		return fmt.Errorf("invalid kernel capability limit")
	}
	for capability := 0; capability <= lastCap; capability++ {
		if enclaveCredentialCapabilities&(1<<uint(capability)) != 0 {
			continue
		}
		if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, prCapbsetDrop, uintptr(capability), 0); errno != 0 {
			return fmt.Errorf("drop enclave capability %d from bounding set: %w", capability, errno)
		}
	}
	header := &capHeader{version: 0x20080522}
	data := &[2]capData{}
	for word := range data {
		data[word].effective = uint32(enclaveCredentialCapabilities >> (word * 32))
		data[word].permitted = uint32(enclaveCredentialCapabilities >> (word * 32))
	}
	if _, _, errno := syscall.AllThreadsSyscall(
		syscall.SYS_CAPSET,
		uintptr(unsafe.Pointer(header)),
		uintptr(unsafe.Pointer(&data[0])),
		0,
	); errno != 0 {
		return fmt.Errorf("clear enclave supervisor capabilities: %w", errno)
	}
	if err := setNoNewPrivilegesAllThreads(); err != nil {
		return fmt.Errorf("set enclave supervisor no_new_privs: %w", err)
	}
	return verifyEnclaveThreads("/proc/self/task", validateEnclaveSupervisorCapabilities)
}

func setNoNewPrivilegesAllThreads() error {
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0); errno != 0 {
		return errno
	}
	return nil
}

// verifyEnclaveThreads checks the capability state and no_new_privs of every
// task in the thread group. Threads created afterwards inherit this state.
func verifyEnclaveThreads(taskDirectory string, validate func(string) error) error {
	entries, err := os.ReadDir(taskDirectory)
	if err != nil {
		return fmt.Errorf("list enclave process threads: %w", err)
	}
	if len(entries) == 0 {
		return fmt.Errorf("enclave process has no visible threads")
	}
	for _, entry := range entries {
		status, err := os.ReadFile(taskDirectory + "/" + entry.Name() + "/status")
		if err != nil {
			return fmt.Errorf("read enclave thread %s privileges: %w", entry.Name(), err)
		}
		if err := validate(string(status)); err != nil {
			return fmt.Errorf("enclave thread %s: %w", entry.Name(), err)
		}
		if !hasNoNewPrivileges(string(status)) {
			return fmt.Errorf("enclave thread %s no_new_privs verification failed", entry.Name())
		}
	}
	return nil
}

// mountEnclaveAgentRuntime exposes the invocation-private writable /runtime
// export at /agent, the runtime root the agent entrypoint expects, because
// the enclave root filesystem is read-only.
func mountEnclaveAgentRuntime(config bootConfig) error {
	hasRuntime := false
	for _, mount := range config.VirtiofsMounts {
		if mount.Tag == enclaveRuntimeTag && mount.Target == enclaveRuntimeSource && !mount.ReadOnly {
			hasRuntime = true
		}
	}
	if !hasRuntime {
		return fmt.Errorf("agent enclave requires its writable runtime export")
	}
	if err := makeTmpfsMountTarget(enclaveAgentRuntimeTarget, 0755); err != nil {
		return fmt.Errorf("create agent enclave runtime target: %w", err)
	}
	if err := mountFilesystem(enclaveRuntimeSource, enclaveAgentRuntimeTarget, "", syscall.MS_BIND, ""); err != nil {
		return fmt.Errorf("bind agent enclave runtime: %w", err)
	}
	if err := mountFilesystem("", enclaveAgentRuntimeTarget, "",
		syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_NOSUID|syscall.MS_NODEV, ""); err != nil {
		unmountFilesystem(enclaveAgentRuntimeTarget, 0)
		return fmt.Errorf("restrict agent enclave runtime: %w", err)
	}
	return nil
}

type capHeader struct {
	version uint32
	pid     int32
}

type capData struct {
	effective   uint32
	permitted   uint32
	inheritable uint32
}
