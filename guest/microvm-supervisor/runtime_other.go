//go:build !linux

package main

import "errors"

func runSupervisor() error {
	return errors.New("the microVM guest supervisor requires Linux")
}
