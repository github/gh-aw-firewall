// firecracker-supervisor is the minimal guest-side command supervisor.
package main

import (
	"flag"
	"fmt"
	"os"
)

var version = "dev"

func main() {
	showVersion := flag.Bool("version", false, "print version")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	if err := runSupervisor(); err != nil {
		fmt.Fprintln(os.Stderr, "firecracker-supervisor:", err)
		os.Exit(1)
	}
}
