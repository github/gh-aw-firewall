package main

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// TaskType is the kind of work a request asks for.
type TaskType string

// The task types.
const (
	TaskExplain   TaskType = "explain"
	TaskPlan      TaskType = "plan"
	TaskFix       TaskType = "fix"
	TaskRefactor  TaskType = "refactor"
	TaskChore     TaskType = "chore"
	TaskImplement TaskType = "implement"
	TaskUnknown   TaskType = "unknown"
)

// TaskTypes lists the task types in table order.
var TaskTypes = []TaskType{TaskExplain, TaskPlan, TaskFix, TaskRefactor, TaskChore, TaskImplement, TaskUnknown}

// TaskScope is the breadth of a request.
type TaskScope string

// The task scopes.
const (
	ScopeLocal       TaskScope = "local"
	ScopeMultiFile   TaskScope = "multi_file"
	ScopeSubsystem   TaskScope = "subsystem"
	ScopeCrossSystem TaskScope = "cross_system"
	ScopeUnknown     TaskScope = "unknown"
)

// TaskScopes lists the scopes in table order.
var TaskScopes = []TaskScope{ScopeLocal, ScopeMultiFile, ScopeSubsystem, ScopeCrossSystem, ScopeUnknown}

// TaskComplexity is the intrinsic difficulty of a request.
type TaskComplexity string

// The task complexities.
const (
	ComplexityTrivial TaskComplexity = "trivial"
	ComplexityEasy    TaskComplexity = "easy"
	ComplexityMedium  TaskComplexity = "medium"
	ComplexityHard    TaskComplexity = "hard"
	ComplexityExpert  TaskComplexity = "expert"
	ComplexityUnknown TaskComplexity = "unknown"
)

// TaskComplexities lists the complexities in table order.
var TaskComplexities = []TaskComplexity{
	ComplexityTrivial, ComplexityEasy, ComplexityMedium, ComplexityHard, ComplexityExpert, ComplexityUnknown,
}

// Goal is a routing goal.
type Goal string

// The routing goals.
const (
	GoalCost      Goal = "cost"
	GoalCostSpeed Goal = "cost-speed"
)

// Mode is a requested routing mode. ModeAuto resolves to a classifier recommendation.
type Mode string

// The routing modes.
const (
	ModeEconomy  Mode = "economy"
	ModeBalanced Mode = "balanced"
	ModeRobust   Mode = "robust"
	ModeAuto     Mode = "auto"
)

// Recommendation is the mode a classifier recommends.
type Recommendation string

// The classifier mode recommendations.
const (
	RecommendEconomy  Recommendation = "economy"
	RecommendBalanced Recommendation = "balanced"
	RecommendRobust   Recommendation = "robust"
	RecommendUnknown  Recommendation = "unknown"
)

// Effort is a reasoning effort. The empty Effort means the caller omitted it.
type Effort string

// The reasoning efforts, in ascending order.
const (
	EffortNone    Effort = "none"
	EffortMinimal Effort = "minimal"
	EffortLow     Effort = "low"
	EffortMedium  Effort = "medium"
	EffortHigh    Effort = "high"
	EffortXHigh   Effort = "xhigh"
	EffortMax     Effort = "max"
)

// Efforts lists the reasoning efforts in ascending order.
var Efforts = []Effort{EffortNone, EffortMinimal, EffortLow, EffortMedium, EffortHigh, EffortXHigh, EffortMax}

// Role is the author of a conversation message.
type Role string

// The message roles.
const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
)

// Labels describe a request for the routing tables.
type Labels struct {
	Scope          TaskScope      `json:"scope"`
	TaskComplexity TaskComplexity `json:"task_complexity"`
	TaskType       TaskType       `json:"task_type"`
}

// Key returns the label cell key used by routing tables: task_type/scope/task_complexity.
func (l Labels) Key() string {
	return string(l.TaskType) + "/" + string(l.Scope) + "/" + string(l.TaskComplexity)
}

// Message is one conversation turn.
type Message struct {
	Parts List[Part] `json:"parts"`
	Role  Role       `json:"role"`
}

// Text joins the message's text parts, excluding tool content.
func (m Message) Text() string {
	var text strings.Builder
	for _, part := range m.Parts {
		if part.Text != nil {
			text.WriteString(*part.Text)
		}
	}
	return text.String()
}

// Part is exactly one of a text fragment, a tool call or a tool result.
type Part struct {
	Text       *string     `json:"text,omitzero"`
	ToolCall   *ToolCall   `json:"tool_call,omitzero"`
	ToolResult *ToolResult `json:"tool_result,omitzero"`
}

// UnmarshalJSONFrom rejects a part with more than one member, even when the others
// are null, so every part is exactly one variant.
func (p *Part) UnmarshalJSONFrom(dec *jsontext.Decoder) error {
	value, err := dec.ReadValue()
	if err != nil {
		return err
	}
	var members map[string]jsontext.Value
	if err := json.Unmarshal(value, &members, jsontext.AllowDuplicateNames(true)); err != nil {
		return err
	}
	if len(members) > 1 {
		return errors.New("must have exactly one of text, tool_call or tool_result")
	}
	type part Part
	return json.Unmarshal(value, (*part)(p), dec.Options())
}

// ToolCall is a tool invocation. Input is free-form JSON, kept as raw text; it is
// empty when omitted.
type ToolCall struct {
	ID    *string        `json:"id"`
	Input jsontext.Value `json:"input,omitzero"`
	Name  *string        `json:"name"`
}

// ToolResult is the outcome of a tool call.
type ToolResult struct {
	ID   *string `json:"id"`
	OK   *bool   `json:"ok,omitzero"`
	Text *string `json:"text,omitzero"`
}

// Pair is a model and optional explicit reasoning effort, as ranked by routing tables.
type Pair struct {
	Model  string
	Effort Effort
}

// String returns the table spelling of the pair: model, or model:effort.
func (p Pair) String() string {
	if p.Effort == "" {
		return p.Model
	}
	return p.Model + ":" + string(p.Effort)
}

// ModelChoice is a caller-identified model and optional reasoning effort.
type ModelChoice struct {
	Effort Effort `json:"effort,omitzero"`
	ID     string `json:"id"`
	Model  string `json:"model"`
}

// Pair returns the choice's model and effort.
func (c ModelChoice) Pair() Pair { return Pair{Model: c.Model, Effort: c.Effort} }

// ModelCandidate is a model choice offered for routing.
type ModelCandidate struct {
	ContextWindow *ContextWindow `json:"context_window,omitzero"`
	Effort        Effort         `json:"effort,omitzero"`
	ID            string         `json:"id"`
	Model         string         `json:"model"`
}

// Pair returns the candidate's model and effort.
func (c ModelCandidate) Pair() Pair { return Pair{Model: c.Model, Effort: c.Effort} }

// Choice returns the candidate without its context window.
func (c ModelCandidate) Choice() ModelChoice {
	return ModelChoice{ID: c.ID, Model: c.Model, Effort: c.Effort}
}

// Profile names one published routing table.
type Profile struct {
	Goal Goal `json:"goal"`
	Mode Mode `json:"mode"`
}

// Key returns the goal/mode key used to index routing tables.
func (p Profile) Key() string { return string(p.Goal) + "/" + string(p.Mode) }

// Profiles lists the fixed routing profiles in capabilities order.
var Profiles = []Profile{
	{GoalCost, ModeEconomy},
	{GoalCost, ModeBalanced},
	{GoalCost, ModeRobust},
	{GoalCostSpeed, ModeEconomy},
	{GoalCostSpeed, ModeBalanced},
	{GoalCostSpeed, ModeRobust},
}

// ClassifierOutput is the result of a classifier call.
type ClassifierOutput struct {
	Labels Labels         `json:"labels"`
	Mode   Recommendation `json:"mode"`
}

// ClassifyRequest asks for a classifier call plan.
type ClassifyRequest struct {
	Conversation List[Message]     `json:"conversation"`
	Models       List[ModelChoice] `json:"models"`
}

// ClassifyResponse is a classifier call plan.
type ClassifyResponse struct {
	Prompt        string        `json:"prompt"`
	RankedChoices []ModelChoice `json:"ranked_choices"`
	SystemPrompt  string        `json:"system_prompt"`
}

// RouteRequest asks for a ranking of offered models.
type RouteRequest struct {
	Classification *ClassifierOutput    `json:"classification,omitzero"`
	Conversation   List[Message]        `json:"conversation"`
	CurrentID      *string              `json:"current_id,omitzero"`
	Models         List[ModelCandidate] `json:"models"`
	Objective      *Profile             `json:"objective"`
}

// RouteResponse ranks the eligible offered models.
type RouteResponse struct {
	RankedChoices []ModelChoice `json:"ranked_choices"`
}

// ExecutionModel is one catalogue model and the explicit efforts it is ranked with.
type ExecutionModel struct {
	Efforts []Effort `json:"efforts"`
	Model   string   `json:"model"`
}

// ExecutionCatalogue lists the models the routing tables rank.
type ExecutionCatalogue struct {
	Models []ExecutionModel `json:"models"`
}

// Capabilities describes the service.
type Capabilities struct {
	ExecutionCatalogue ExecutionCatalogue `json:"execution_catalogue"`
	Name               string             `json:"name"`
	RoutingProfiles    []Profile          `json:"routing_profiles"`
	Version            string             `json:"version"`
}

// ErrorCode is the machine-readable code in an HTTP error response.
type ErrorCode string

// The HTTP error codes published in openapi.yaml.
const (
	CodeInvalidJSON          ErrorCode = "invalid_json"
	CodeInvalidRequest       ErrorCode = "invalid_request"
	CodePayloadTooLarge      ErrorCode = "payload_too_large"
	CodeUnsupportedMediaType ErrorCode = "unsupported_media_type"
	CodeNotFound             ErrorCode = "not_found"
	CodeMethodNotAllowed     ErrorCode = "method_not_allowed"
	CodeNoRoute              ErrorCode = "no_route"
	CodeInternalError        ErrorCode = "internal_error"
)

// ErrorResponse is the body of every HTTP error response.
type ErrorResponse struct {
	Code   ErrorCode `json:"code"`
	Detail string    `json:"detail"`
}

// Kind classifies a request failure so each transport can map it consistently.
type Kind int

// The request failure kinds.
const (
	// Malformed means the body is not valid JSON.
	Malformed Kind = iota + 1
	// Invalid means the body is valid JSON that breaks the request schema.
	Invalid
	// BadRequest means a decoded request is unsupported by the loaded tables.
	BadRequest
	// NoRoute means no offered model can serve the request.
	NoRoute
)

// Error is a request failure with a human-readable detail.
type Error struct {
	Kind   Kind
	Detail string
}

func (e *Error) Error() string { return e.Detail }

// HTTP returns the status and error code a transport answers with.
func (e *Error) HTTP() (int, ErrorCode) {
	switch e.Kind {
	case Malformed:
		return http.StatusBadRequest, CodeInvalidJSON
	case Invalid:
		return http.StatusUnprocessableEntity, CodeInvalidJSON
	case NoRoute:
		return http.StatusUnprocessableEntity, CodeNoRoute
	default:
		return http.StatusUnprocessableEntity, CodeInvalidRequest
	}
}

// requestError returns an *Error of the given kind.
func requestError(kind Kind, format string, args ...any) error {
	return &Error{Kind: kind, Detail: fmt.Sprintf(format, args...)}
}

// KindOf returns the kind of a request failure, or 0 if err is not one.
func KindOf(err error) Kind {
	var e *Error
	if errors.As(err, &e) {
		return e.Kind
	}
	return 0
}
