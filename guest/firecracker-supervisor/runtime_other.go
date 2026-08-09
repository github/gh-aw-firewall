//go:build !linux

package main

import "errors"

func runSupervisor() error {
	return errors.New("the Firecracker guest supervisor requires Linux")
}
