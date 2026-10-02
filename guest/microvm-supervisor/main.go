// microvm-supervisor is the minimal guest-side command supervisor.
package main

import (
	"flag"
	"fmt"
	"os"
	"syscall"
)

var version = "dev"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--awf-enclave-exec" {
		if err := runEnclaveExec(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "microvm-supervisor:", err)
			os.Exit(126)
		}
		return
	}
	showVersion := flag.Bool("version", false, "print version")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	if err := runSupervisor(); err != nil {
		fmt.Fprintln(os.Stderr, "microvm-supervisor:", err)
		os.Exit(1)
	}
}

func runEnclaveExec(args []string) error {
	if len(args) < 3 {
		return fmt.Errorf("invalid enclave execution trampoline arguments")
	}
	profile, err := enclaveResourceProfileForRole(args[0])
	if err != nil {
		return err
	}
	if os.Getuid() != int(profile.uid) || os.Getgid() != int(profile.gid) {
		return fmt.Errorf("enclave process identity verification failed")
	}
	groups, err := os.Getgroups()
	if err != nil {
		return fmt.Errorf("verify enclave supplementary groups: %w", err)
	}
	if len(groups) != 0 {
		return fmt.Errorf("enclave process has supplementary groups")
	}
	if err := setNoNewPrivilegesAllThreads(); err != nil {
		return fmt.Errorf("set enclave process no_new_privs: %w", err)
	}
	if err := verifyEnclaveThreads("/proc/self/task", validateEnclaveCapabilities); err != nil {
		return err
	}
	if err := verifyEnclaveRlimits(profile); err != nil {
		return err
	}
	return syscall.Exec(args[1], args[2:], os.Environ())
}
