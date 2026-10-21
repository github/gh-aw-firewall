package main

import (
	"bytes"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"math"
	"slices"
	"strconv"
	"strings"
)

// decodeOptions make field names exact and case-sensitive and reject unknown fields.
// Repeated keys are removed before decoding.
var decodeOptions = json.RejectUnknownMembers(true)

// DecodeClassifyRequest decodes and validates a classify request body.
func DecodeClassifyRequest(data []byte) (*ClassifyRequest, error) {
	var req ClassifyRequest
	if err := decode(data, &req); err != nil {
		return nil, err
	}
	if req.Conversation == nil {
		return nil, invalid("conversation: field required")
	}
	if req.Models == nil {
		return nil, invalid("models: field required")
	}
	if err := validateConversation(req.Conversation); err != nil {
		return nil, err
	}
	ids := make([]string, len(req.Models))
	for i, m := range req.Models {
		if err := validateChoice(fmt.Sprintf("models[%d]", i), m.ID, m.Model, m.Effort); err != nil {
			return nil, err
		}
		ids[i] = m.ID
	}
	if err := validateUniqueIDs(ids); err != nil {
		return nil, err
	}
	return &req, nil
}

// DecodeRouteRequest decodes and validates a route request body.
func DecodeRouteRequest(data []byte) (*RouteRequest, error) {
	var req RouteRequest
	if err := decode(data, &req); err != nil {
		return nil, err
	}
	if req.Conversation == nil {
		return nil, invalid("conversation: field required")
	}
	if req.Objective == nil {
		return nil, invalid("objective: field required")
	}
	if req.Models == nil {
		req.Models = List[ModelCandidate]{}
	}
	if err := validateConversation(req.Conversation); err != nil {
		return nil, err
	}
	if !slices.Contains([]Goal{GoalCost, GoalCostSpeed}, req.Objective.Goal) {
		return nil, invalid("objective.goal: must be cost or cost-speed")
	}
	if !slices.Contains([]Mode{ModeEconomy, ModeBalanced, ModeRobust, ModeAuto}, req.Objective.Mode) {
		return nil, invalid("objective.mode: must be economy, balanced, robust or auto")
	}
	if req.CurrentID != nil && *req.CurrentID == "" {
		return nil, invalid("current_id: must not be empty")
	}
	if c := req.Classification; c != nil {
		if err := validateLabels(c.Labels); err != nil {
			return nil, err
		}
		if !slices.Contains([]Recommendation{RecommendEconomy, RecommendBalanced, RecommendRobust, RecommendUnknown}, c.Mode) {
			return nil, invalid("classification.mode: must be economy, balanced, robust or unknown")
		}
	}
	ids := make([]string, len(req.Models))
	for i, m := range req.Models {
		if err := validateChoice(fmt.Sprintf("models[%d]", i), m.ID, m.Model, m.Effort); err != nil {
			return nil, err
		}
		ids[i] = m.ID
	}
	if err := validateUniqueIDs(ids); err != nil {
		return nil, err
	}
	return &req, nil
}

// decode reports JSON syntax errors as Malformed before any schema error, then
// unmarshals strictly, reporting type and field errors as Invalid.
func decode(data []byte, v any) error {
	if err := checkSyntax(data); err != nil {
		return &Error{Kind: Malformed, Detail: "invalid JSON: " + err.Error()}
	}
	data, err := lastValueWins(data)
	if err != nil {
		return &Error{Kind: Malformed, Detail: "invalid JSON: " + err.Error()}
	}
	if err := json.Unmarshal(data, v, decodeOptions); err != nil {
		return invalid(strings.TrimPrefix(err.Error(), "json: "))
	}
	return nil
}

// lastValueWins removes each object member whose key is repeated later in the same
// object, so the last value replaces earlier ones, as JavaScript's JSON.parse does,
// rather than being merged with them, which unmarshalling a repeated key into the
// same Go struct would do. Input without repeated keys is returned unchanged.
// Otherwise the output is compact and scalars keep their original text.
func lastValueWins(data []byte) ([]byte, error) {
	superseded, err := supersededMembers(data)
	if err != nil || len(superseded) == 0 {
		return data, err
	}
	dec := jsontext.NewDecoder(bytes.NewReader(data), jsontext.AllowDuplicateNames(true))
	var out bytes.Buffer
	enc := jsontext.NewEncoder(&out, jsontext.AllowDuplicateNames(true), jsontext.PreserveRawStrings(true))
	for {
		if atMemberName(dec) && superseded[dec.InputOffset()] {
			if _, err := dec.ReadToken(); err != nil {
				return nil, err
			}
			if err := dec.SkipValue(); err != nil {
				return nil, err
			}
			continue
		}
		token, err := dec.ReadToken()
		if err == io.EOF {
			return bytes.TrimSuffix(out.Bytes(), []byte("\n")), nil
		}
		if err != nil {
			return nil, err
		}
		if err := enc.WriteToken(token); err != nil {
			return nil, err
		}
	}
}

// supersededMembers returns the input offsets of the object members whose key is
// repeated later in the same object.
func supersededMembers(data []byte) (map[int64]bool, error) {
	dec := jsontext.NewDecoder(bytes.NewReader(data), jsontext.AllowDuplicateNames(true))
	superseded := map[int64]bool{}
	var objects []map[string]int64
	for {
		if atMemberName(dec) {
			offset := dec.InputOffset()
			token, err := dec.ReadToken()
			if err != nil {
				return nil, err
			}
			names := objects[len(objects)-1]
			name := token.String()
			if previous, ok := names[name]; ok {
				superseded[previous] = true
			}
			names[name] = offset
			continue
		}
		token, err := dec.ReadToken()
		if err == io.EOF {
			return superseded, nil
		}
		if err != nil {
			return nil, err
		}
		switch token.Kind() {
		case '{':
			objects = append(objects, map[string]int64{})
		case '}':
			objects = objects[:len(objects)-1]
		}
	}
}

func atMemberName(dec *jsontext.Decoder) bool {
	kind, length := dec.StackIndex(dec.StackDepth())
	return kind == '{' && length%2 == 0 && dec.PeekKind() == '"'
}

func checkSyntax(data []byte) error {
	dec := jsontext.NewDecoder(bytes.NewReader(data), jsontext.AllowDuplicateNames(true))
	if err := dec.SkipValue(); err != nil {
		if err == io.EOF {
			return io.ErrUnexpectedEOF
		}
		return err
	}
	switch _, err := dec.ReadToken(); err {
	case io.EOF:
		return nil
	case nil:
		return errors.New("unexpected data after the top-level value")
	default:
		return err
	}
}

func invalid(detail string) error { return &Error{Kind: Invalid, Detail: detail} }

func validateConversation(conversation []Message) error {
	for i, m := range conversation {
		if !slices.Contains([]Role{RoleSystem, RoleUser, RoleAssistant}, m.Role) {
			return invalid(fmt.Sprintf("conversation[%d].role: must be system, user or assistant", i))
		}
		for j, p := range m.Parts {
			at := fmt.Sprintf("conversation[%d].parts[%d]", i, j)
			set := 0
			for _, present := range []bool{p.Text != nil, p.ToolCall != nil, p.ToolResult != nil} {
				if present {
					set++
				}
			}
			if set != 1 {
				return invalid(at + ": must have exactly one of text, tool_call or tool_result")
			}
			if c := p.ToolCall; c != nil && (c.ID == nil || c.Name == nil) {
				return invalid(at + ".tool_call: id and name are required strings")
			}
			if r := p.ToolResult; r != nil && r.ID == nil {
				return invalid(at + ".tool_result: id is a required string")
			}
		}
	}
	return nil
}

func validateLabels(l Labels) error {
	if !slices.Contains(TaskTypes, l.TaskType) {
		return invalid("classification.labels.task_type: unknown task type")
	}
	if !slices.Contains(TaskScopes, l.Scope) {
		return invalid("classification.labels.scope: unknown scope")
	}
	if !slices.Contains(TaskComplexities, l.TaskComplexity) {
		return invalid("classification.labels.task_complexity: unknown complexity")
	}
	return nil
}

func validateChoice(at, id, model string, effort Effort) error {
	if id == "" {
		return invalid(at + ".id: must not be empty")
	}
	if !ValidModelID(model) {
		return invalid(at + ".model: must be provider/model")
	}
	if effort != "" && !slices.Contains(Efforts, effort) {
		return invalid(at + ".effort: unknown reasoning effort")
	}
	return nil
}

func validateUniqueIDs(ids []string) error {
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			return invalid("model choice ids must be unique")
		}
		seen[id] = true
	}
	return nil
}

// ValidModelID reports whether s is a provider-qualified model id: two non-empty
// segments separated by the only slash.
func ValidModelID(s string) bool {
	provider, name, ok := strings.Cut(s, "/")
	return ok && provider != "" && name != "" && !strings.Contains(name, "/")
}

// List is a JSON array that may be omitted but must not be null. An omitted List
// is nil, and an empty array decodes to an empty, non-nil List.
type List[T any] []T

// UnmarshalJSONFrom implements json.UnmarshalerFrom.
func (l *List[T]) UnmarshalJSONFrom(dec *jsontext.Decoder) error {
	if dec.PeekKind() == 'n' {
		return errors.New("must be an array, not null")
	}
	items := []T{}
	if err := json.UnmarshalDecode(dec, &items); err != nil {
		return err
	}
	*l = items
	return nil
}

// UnmarshalJSONFrom implements json.UnmarshalerFrom. JSON null means the effort was
// omitted. An empty string is rejected rather than treated as omitted.
func (e *Effort) UnmarshalJSONFrom(dec *jsontext.Decoder) error {
	tok, err := dec.ReadToken()
	if err != nil {
		return err
	}
	switch tok.Kind() {
	case 'n':
		*e = ""
	case '"':
		if tok.String() == "" {
			return errors.New("reasoning effort must not be empty")
		}
		*e = Effort(tok.String())
	default:
		return errors.New("reasoning effort must be a string")
	}
	return nil
}

// ContextWindow is a positive token count. Counts beyond 64 bits saturate.
type ContextWindow uint64

// UnmarshalJSONFrom implements json.UnmarshalerFrom. Only integer literals are
// accepted, so 1.0 and 1e3 are rejected.
func (c *ContextWindow) UnmarshalJSONFrom(dec *jsontext.Decoder) error {
	tok, err := dec.ReadToken()
	if err != nil {
		return err
	}
	raw := tok.String()
	if tok.Kind() != '0' || strings.ContainsAny(raw, ".eE") {
		return errors.New("context_window must be an integer")
	}
	if strings.HasPrefix(raw, "-") {
		return errors.New("context_window must be greater than 0")
	}
	n, err := strconv.ParseUint(raw, 10, 64)
	if errors.Is(err, strconv.ErrRange) {
		n = math.MaxUint64
	} else if err != nil {
		return err
	}
	if n == 0 {
		return errors.New("context_window must be greater than 0")
	}
	*c = ContextWindow(n)
	return nil
}
