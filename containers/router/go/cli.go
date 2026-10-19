package main

import (
	"encoding/json/v2"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
)

const (
	tablesEnv     = "GH_AW_ROUTER_ROUTING_TABLES"
	defaultTables = "routing"
)

const usage = `usage: gh-aw-router [--version] [--routing-tables PATH] COMMAND [--input PATH]

Standalone gh-aw-router classification planning and routing.

Commands:
  classify       create a classification call plan
  route          rank model candidates
  validate-data  validate the compiled routing tables

Options:
  --version              print the version and exit
  --routing-tables PATH  routing table file or directory; can also be set with
                         ` + tablesEnv + `, otherwise ./` + defaultTables + ` when it exists
  --input PATH           (classify, route) request JSON file, otherwise stdin
`

// usageError is a command-line mistake. It exits 2 after printing the usage text.
type usageError struct{ msg string }

func (e usageError) Error() string { return e.msg }

// run runs one command and returns its exit status: 0 on success, 2 for usage,
// model data and request errors, and 3 when no offered model can serve a route.
func run(args []string, getenv func(string) string, stdin io.Reader, stdout, stderr io.Writer) int {
	cmd, err := parseArgs(args, getenv)
	if errors.Is(err, flag.ErrHelp) {
		fmt.Fprint(stdout, usage)
		return 0
	}
	if err != nil {
		fmt.Fprintf(stderr, "%sgh-aw-router: error: %v\n", usage, err)
		return 2
	}
	if cmd.version {
		fmt.Fprintf(stdout, "gh-aw-router %s\n", version)
		return 0
	}
	service, err := LoadService(cmd.tables)
	if err != nil {
		fmt.Fprintf(stderr, "invalid model data: %v\n", err)
		return 2
	}
	result, err := cmd.execute(service, stdin)
	if err != nil {
		if KindOf(err) == NoRoute {
			fmt.Fprintf(stderr, "no route: %v\n", err)
			return 3
		}
		fmt.Fprintf(stderr, "invalid request: %v\n", err)
		return 2
	}
	out, err := json.Marshal(result)
	if err != nil {
		fmt.Fprintf(stderr, "internal error: %v\n", err)
		return 1
	}
	if _, err := stdout.Write(append(out, '\n')); err != nil {
		fmt.Fprintf(stderr, "write error: %v\n", err)
		return 1
	}
	return 0
}

type command struct {
	name    string
	tables  string
	input   string
	version bool
}

func parseArgs(args []string, getenv func(string) string) (*command, error) {
	cmd := &command{}
	global := newFlagSet()
	global.BoolVar(&cmd.version, "version", false, "")
	global.StringVar(&cmd.tables, "routing-tables", "", "")
	if err := global.Parse(args); err != nil {
		return nil, err
	}
	if cmd.version {
		return cmd, nil
	}
	if global.NArg() == 0 {
		return nil, usageError{"a command is required: classify, route or validate-data"}
	}
	cmd.name = global.Arg(0)
	sub := newFlagSet()
	switch cmd.name {
	case "classify", "route":
		sub.StringVar(&cmd.input, "input", "", "")
	case "validate-data":
	default:
		return nil, usageError{fmt.Sprintf("unknown command %q: choose classify, route or validate-data", cmd.name)}
	}
	if err := sub.Parse(global.Args()[1:]); err != nil {
		return nil, err
	}
	if sub.NArg() > 0 {
		return nil, usageError{"unexpected arguments: " + strings.Join(sub.Args(), " ")}
	}
	if cmd.tables == "" {
		cmd.tables = getenv(tablesEnv)
	}
	if cmd.tables == "" {
		if _, err := os.Stat(defaultTables); err != nil {
			return nil, usageError{"--routing-tables or " + tablesEnv + " is required when ./" + defaultTables + " does not exist"}
		}
		cmd.tables = defaultTables
	}
	return cmd, nil
}

func newFlagSet() *flag.FlagSet {
	fs := flag.NewFlagSet("gh-aw-router", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

func (c *command) execute(service *Service, stdin io.Reader) (any, error) {
	if c.name == "validate-data" {
		return validateData(service), nil
	}
	body, err := c.readInput(stdin)
	if err != nil {
		return nil, err
	}
	if c.name == "classify" {
		req, err := DecodeClassifyRequest(body)
		if err != nil {
			return nil, err
		}
		return service.Classify(req)
	}
	req, err := DecodeRouteRequest(body)
	if err != nil {
		return nil, err
	}
	return service.Route(req)
}

func (c *command) readInput(stdin io.Reader) ([]byte, error) {
	if c.input != "" {
		return os.ReadFile(c.input)
	}
	return io.ReadAll(stdin)
}

type dataSummary struct {
	LabelCells int      `json:"label_cells"`
	Models     int      `json:"models"`
	Profiles   []string `json:"profiles"`
	Repository string   `json:"repository"`
}

func validateData(s *Service) dataSummary {
	var profiles []string
	for p := range s.tables {
		profiles = append(profiles, p.Key())
	}
	slices.Sort(profiles)
	models := map[string]bool{}
	for _, p := range s.primary.Pairs {
		models[p.Model] = true
	}
	return dataSummary{
		LabelCells: s.primary.LabelCells(),
		Models:     len(models),
		Profiles:   profiles,
		Repository: s.primary.Repository,
	}
}
