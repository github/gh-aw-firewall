//go:build linux

package main

import (
	"os"
	"os/exec"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

func TestEnclaveResourceProfilesAreClosed(t *testing.T) {
	script, err := enclaveResourceProfileForRole("script")
	if err != nil {
		t.Fatal(err)
	}
	agent, err := enclaveResourceProfileForRole("agent")
	if err != nil {
		t.Fatal(err)
	}
	if script.uid != 65534 || script.gid != 65534 || script.maxProcesses != 47 ||
		script.maxFileBytes != 512*1024*1024 || script.maxOpenFiles != 1024 ||
		script.primaryTmpfs != "/query" || script.primaryTmpfsMax != 256*1024*1024 {
		t.Fatalf("unexpected script limits: %#v", script)
	}
	if agent.uid != 65534 || agent.gid != 65534 || agent.maxProcesses != 47 ||
		agent.maxFileBytes != 256*1024*1024 || agent.maxOpenFiles != 1024 ||
		agent.primaryTmpfs != "/tmp" || agent.primaryTmpfsMax != 96*1024*1024 {
		t.Fatalf("unexpected agent limits: %#v", agent)
	}
	if _, err := enclaveResourceProfileForRole("primary"); err == nil {
		t.Fatal("unknown role accepted")
	}
}

func TestMountEnclaveTmpfsUsesBoundedPrivateMounts(t *testing.T) {
	originalMount, originalVerify, originalMkdir := mountFilesystem, verifyTmpfsMount, makeTmpfsMountTarget
	defer func() {
		mountFilesystem, verifyTmpfsMount = originalMount, originalVerify
		makeTmpfsMountTarget = originalMkdir
	}()
	var got []string
	mountFilesystem = func(source, target, fstype string, flags uintptr, data string) error {
		if source != "tmpfs" || fstype != "tmpfs" {
			t.Fatalf("unexpected mount: %q %q", source, fstype)
		}
		got = append(got, target+":"+data)
		if flags&(syscall.MS_NOSUID|syscall.MS_NODEV) != syscall.MS_NOSUID|syscall.MS_NODEV {
			t.Fatalf("tmpfs lacks nosuid/nodev: %#x", flags)
		}
		return nil
	}
	verifyTmpfsMount = func(_ string, _ uint64) error { return nil }
	makeTmpfsMountTarget = func(_ string, _ os.FileMode) error { return nil }
	profile, _ := enclaveResourceProfileForRole("agent")
	if err := mountEnclaveTmpfs(profile); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"/tmp:size=100663296,mode=1777,uid=65534,gid=65534",
		"/run:size=16777216,mode=755",
		"/dev/shm:size=33554432,mode=1777",
		"/home/awf-enclave:size=33554432,mode=700,uid=65534,gid=65534",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mounts = %#v, want %#v", got, want)
	}

	verifyTmpfsMount = func(target string, _ uint64) error {
		return os.ErrPermission
	}
	if err := mountEnclaveTmpfs(profile); err == nil || !strings.Contains(err.Error(), "verify bounded enclave tmpfs") {
		t.Fatalf("unverified tmpfs mount was accepted: %v", err)
	}
}

func TestApplyEnclaveRlimitsInChild(t *testing.T) {
	if os.Getenv("AWF_TEST_RLIMIT_HELPER") == "1" {
		profile, _ := enclaveResourceProfileForRole("script")
		if err := applyEnclaveRlimits(profile); err != nil {
			t.Fatal(err)
		}
		if err := verifyEnclaveRlimits(profile); err != nil {
			t.Fatal(err)
		}
		return
	}
	command := exec.Command(os.Args[0], "-test.run=^TestApplyEnclaveRlimitsInChild$")
	command.Env = append(os.Environ(), "AWF_TEST_RLIMIT_HELPER=1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("apply and verify guest rlimits: %v\n%s", err, output)
	}
}

func TestEnclavePrivilegeStatusMustBeVerified(t *testing.T) {
	status := strings.Join([]string{
		"CapEff:\t0000000000000000",
		"CapPrm:\t0000000000000000",
		"CapInh:\t0000000000000000",
		"CapAmb:\t0000000000000000",
		"CapBnd:\t00000000000000c0",
		"NoNewPrivs:\t1",
	}, "\n")
	if err := validateEnclaveCapabilities(status); err != nil || !hasNoNewPrivileges(status) {
		t.Fatalf("valid privilege state rejected: %v", err)
	}
	if err := validateEnclaveCapabilities(strings.Replace(status, "CapEff:\t0000000000000000", "CapEff:\t0000000000000001", 1)); err == nil {
		t.Fatal("nonzero capabilities accepted")
	}
	if err := validateEnclaveCapabilities(strings.Replace(status, "CapBnd:\t00000000000000c0\n", "", 1)); err == nil {
		t.Fatal("missing capability state accepted")
	}
	if err := validateEnclaveCapabilities(strings.Replace(status, "CapBnd:\t00000000000000c0", "CapBnd:\t00000000000000c1", 1)); err == nil {
		t.Fatal("unexpected bounding capability accepted")
	}
	supervisorStatus := strings.Replace(status, "CapEff:\t0000000000000000", "CapEff:\t00000000000000c0", 1)
	supervisorStatus = strings.Replace(supervisorStatus, "CapPrm:\t0000000000000000", "CapPrm:\t00000000000000c0", 1)
	if err := validateEnclaveSupervisorCapabilities(supervisorStatus); err != nil {
		t.Fatalf("minimum trusted launcher capabilities rejected: %v", err)
	}
	if err := validateEnclaveCapabilities(supervisorStatus); err == nil {
		t.Fatal("trusted launcher capabilities accepted in workload")
	}
	if hasNoNewPrivileges(strings.Replace(status, "NoNewPrivs:\t1", "NoNewPrivs:\t0", 1)) {
		t.Fatal("disabled no_new_privs accepted")
	}
}
