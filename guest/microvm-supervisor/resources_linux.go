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
		mounts[0].flags |= syscall.MS_NOEXEC
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
	required := map[string]bool{
		"CapEff": false, "CapPrm": false, "CapInh": false, "CapAmb": false, "CapBnd": false,
	}
	for _, line := range strings.Split(status, "\n") {
		name, value, found := strings.Cut(line, ":")
		if _, known := required[name]; found && known {
			if strings.TrimSpace(value) != "0000000000000000" {
				return fmt.Errorf("enclave process has nonzero capability set")
			}
			required[name] = true
		}
	}
	for name, present := range required {
		if !present {
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

func dropEnclaveSupervisorPrivileges(profile enclaveResourceProfile) error {
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
		if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, 24, uintptr(capability), 0); errno != 0 {
			return fmt.Errorf("drop enclave capability %d from bounding set: %w", capability, errno)
		}
	}
	header := capHeader{version: 0x20080522}
	data := [2]capData{}
	if _, _, errno := syscall.RawSyscall(
		syscall.SYS_CAPSET,
		uintptr(unsafe.Pointer(&header)),
		uintptr(unsafe.Pointer(&data[0])),
		0,
	); errno != 0 {
		return fmt.Errorf("clear enclave supervisor capabilities: %w", errno)
	}
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, 38, 1, 0); errno != 0 {
		return fmt.Errorf("set enclave supervisor no_new_privs: %w", errno)
	}
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return fmt.Errorf("verify enclave supervisor privileges: %w", err)
	}
	if err := validateEnclaveCapabilities(string(status)); err != nil {
		return err
	}
	if !hasNoNewPrivileges(string(status)) {
		return fmt.Errorf("enclave supervisor no_new_privs verification failed")
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
