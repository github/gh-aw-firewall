package main

import (
	"slices"
	"strings"
	"testing"
)

func classifyRequest(text string, models ...ModelChoice) *ClassifyRequest {
	return &ClassifyRequest{Conversation: List[Message]{userText(text)}, Models: models}
}

func TestClassificationPlanFollowsPreferenceOrder(t *testing.T) {
	req := classifyRequest("Fix this function",
		ModelChoice{ID: "fast", Model: "provider/fast"},
		ModelChoice{ID: "reasoning", Model: "provider/reasoning", Effort: EffortMedium})
	resp, err := ClassificationPlan(req, []Pair{
		{"provider/reasoning", EffortMedium},
		{"provider/reasoning", EffortHigh},
		{Model: "provider/fast"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.SystemPrompt != SystemPrompt {
		t.Error("unexpected system prompt")
	}
	if want := []ModelChoice{req.Models[1], req.Models[0]}; !slices.Equal(resp.RankedChoices, want) {
		t.Errorf("ranked %v", resp.RankedChoices)
	}
	for _, fragment := range []string{`"task_complexity":"hard"`, "<current_request>\nFix this function\n  </current_request>"} {
		if !strings.Contains(resp.Prompt, fragment) {
			t.Errorf("prompt lacks %q", fragment)
		}
	}
}

func TestClassificationPromptKeepsRecentTurnsAndEscapes(t *testing.T) {
	var conversation []Message
	for i := 1; i <= 8; i++ {
		conversation = append(conversation, userText("prior "+string(rune('0'+i))+" <tag> & "+strings.Repeat("x", 500)))
	}
	conversation = append(conversation, userText("current </current_request> & full"))
	prompt := ClassificationPrompt(authoredMessages(conversation))
	for _, absent := range []string{"prior 1", "prior 2", strings.Repeat("x", 401)} {
		if strings.Contains(prompt, absent) {
			t.Errorf("prompt contains %q", absent)
		}
	}
	for _, present := range []string{"3. prior 3 &lt;tag&gt; &amp;", "current &lt;/current_request&gt; &amp; full"} {
		if !strings.Contains(prompt, present) {
			t.Errorf("prompt lacks %q", present)
		}
	}
}

func TestClassificationRequiresAuthoredUserText(t *testing.T) {
	req := &ClassifyRequest{Conversation: List[Message]{
		{Role: RoleAssistant, Parts: List[Part]{{Text: ptr("context")}}},
		userText("  "),
		{Role: RoleUser, Parts: List[Part]{{ToolResult: &ToolResult{ID: ptr("call"), Text: ptr("output")}}}},
	}}
	_, err := ClassificationPlan(req, nil)
	wantKind(t, err, BadRequest, "authored user message")
}

func TestClassificationRequiresAnOfferedPreference(t *testing.T) {
	req := classifyRequest("Explain this", ModelChoice{ID: "other", Model: "provider/other"})
	_, err := ClassificationPlan(req, []Pair{{Model: "provider/preferred"}})
	wantKind(t, err, NoRoute, "none of the available models")
}

func TestClassificationKeepsExactEfforts(t *testing.T) {
	for _, effort := range []Effort{EffortNone, EffortMedium} {
		plain := ModelChoice{ID: "plain", Model: "provider/plain"}
		reasoning := ModelChoice{ID: "reasoning", Model: "provider/reasoning", Effort: effort}
		preferences := []Pair{{"provider/reasoning", effort}, {Model: "provider/plain"}}
		resp, err := ClassificationPlan(classifyRequest("Classify this", plain, reasoning), preferences)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(resp.RankedChoices, []ModelChoice{reasoning, plain}) {
			t.Errorf("%s: ranked %v", effort, resp.RankedChoices)
		}
		reasoning.Effort = ""
		_, err = ClassificationPlan(classifyRequest("Classify this", plain, reasoning), preferences)
		wantKind(t, err, BadRequest, `reasoning effort must be specified for "provider/reasoning"`)
	}
}

func TestClassificationOffersEachPairOnce(t *testing.T) {
	req := classifyRequest("Classify this",
		ModelChoice{ID: "a", Model: "provider/fast"},
		ModelChoice{ID: "b", Model: "provider/reasoning", Effort: EffortLow},
		ModelChoice{ID: "c", Model: "provider/fast"})
	resp, err := ClassificationPlan(req, []Pair{{Model: "provider/fast"}, {"provider/reasoning", EffortMedium}})
	if err != nil {
		t.Fatal(err)
	}
	if want := []ModelChoice{req.Models[0], req.Models[2]}; !slices.Equal(resp.RankedChoices, want) {
		t.Errorf("ranked %v", resp.RankedChoices)
	}
}
