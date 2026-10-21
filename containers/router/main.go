// Command gh-aw-router plans classifier calls and ranks offered models from
// compiled routing tables. openapi.yaml describes the request and response
// contract; README.md describes the commands.
package main

import "os"

// version is the router release. It must match openapi.yaml and the Dockerfile.
const version = "0.2.0"

func main() {
	os.Exit(run(os.Args[1:], os.Getenv, os.Stdin, os.Stdout, os.Stderr))
}
