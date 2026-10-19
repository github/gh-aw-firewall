package main

import (
	"encoding/base64"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"os"
	"path/filepath"
	"testing"
)

// decodingDifferences lists parity cases where the Go decoder deliberately differs
// from the Python reference. Go's decoder has no nesting or digit limits, treats
// NaN and Infinity as syntax errors, and saturates huge context windows.
var decodingDifferences = map[string]string{
	"tool-input-nan":                  "malformed",
	"tool-input-infinity":             "malformed",
	"tool-input-negative-infinity":    "malformed",
	"context-window-nan":              "malformed",
	"limit-depth-arrays-over":         "decoded",
	"limit-depth-arrays-scalar-over":  "decoded",
	"limit-depth-objects-scalar-over": "decoded",
	"limit-digits-over":               "decoded",
	"limit-digits-negative-over":      "decoded",
	"context-window-digit-limit-over": "decoded",
}

func TestDecodingParity(t *testing.T) {
	var doc struct {
		Cases []struct {
			ID         string         `json:"id"`
			Request    jsontext.Value `json:"request"`
			Body       *string        `json:"body"`
			BodyBase64 *string        `json:"body_base64"`
			Expect     struct {
				Result string `json:"result"`
			} `json:"expect"`
		} `json:"cases"`
	}
	readFixture(t, "decoding.json", &doc)
	if len(doc.Cases) == 0 {
		t.Fatal("no cases")
	}
	used := map[string]bool{}
	for _, c := range doc.Cases {
		t.Run(c.ID, func(t *testing.T) {
			var body []byte
			switch {
			case c.Request != nil:
				body = c.Request
			case c.Body != nil:
				body = []byte(*c.Body)
			case c.BodyBase64 != nil:
				var err error
				if body, err = base64.StdEncoding.DecodeString(*c.BodyBase64); err != nil {
					t.Fatal(err)
				}
			default:
				t.Fatal("case has no input")
			}
			want := c.Expect.Result
			if diff, ok := decodingDifferences[c.ID]; ok {
				used[c.ID] = true
				want = diff
			}
			_, err := DecodeRouteRequest(body)
			if got := resultOf(err); got != want {
				t.Errorf("got %s, want %s (err: %v)", got, want, err)
			}
		})
	}
	for id := range decodingDifferences {
		if !used[id] {
			t.Errorf("known difference %q matches no case", id)
		}
	}
}

func resultOf(err error) string {
	switch KindOf(err) {
	case 0:
		if err != nil {
			return "unexpected error: " + err.Error()
		}
		return "decoded"
	case Malformed:
		return "malformed"
	case Invalid:
		return "invalid"
	default:
		return "other error kind"
	}
}

func readFixture(t *testing.T, name string, v any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(routerDir, "tests", "fixtures", "parity", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatal(err)
	}
}

// conversationRequest wraps a raw conversation in a route request and decodes it.
func conversationRequest(t *testing.T, conversation []byte) *RouteRequest {
	t.Helper()
	body := `{"objective":{"goal":"cost","mode":"balanced"},"conversation":` + string(conversation) + `}`
	req, err := DecodeRouteRequest([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	return req
}

// contextDifferences lists cases where Go's estimate deliberately differs. Go
// re-encodes tool input numbers in ES6 shortest form rather than Python's repr,
// and rejects NaN and Infinity as malformed JSON (shown as -1).
var contextDifferences = map[string]struct{ characters, tokens int }{
	"token-int-zero-negative":       {6, 2},
	"token-float-zero-negative":     {6, 2},
	"token-float-exponent-upper":    {10, 3},
	"token-float-1e15":              {20, 5},
	"token-float-1e16":              {21, 6},
	"token-float-small-exponent":    {10, 3},
	"token-float-1e-5":              {11, 3},
	"token-float-underflow":         {5, 2},
	"token-float-overflow":          {9, 3},
	"token-float-nan":               {-1, -1},
	"token-float-infinity":          {-1, -1},
	"token-float-negative-infinity": {-1, -1},
	"token-float-hundred":           {7, 2},
	"token-float-large":             {25, 7},
	"token-float-unsafe-int":        {20, 5},
}

func TestContextParity(t *testing.T) {
	var doc struct {
		Cases []struct {
			ID               string         `json:"id"`
			Conversation     jsontext.Value `json:"conversation"`
			ConversationText *string        `json:"conversation_text"`
			Expect           struct {
				Characters int `json:"characters"`
				Tokens     int `json:"tokens"`
			} `json:"expect"`
		} `json:"cases"`
	}
	readFixture(t, "context.json", &doc)
	if len(doc.Cases) == 0 {
		t.Fatal("no cases")
	}
	used := map[string]bool{}
	for _, c := range doc.Cases {
		t.Run(c.ID, func(t *testing.T) {
			want := struct{ characters, tokens int }{c.Expect.Characters, c.Expect.Tokens}
			if diff, ok := contextDifferences[c.ID]; ok {
				used[c.ID] = true
				want = diff
			}
			conversation := []byte(c.Conversation)
			if c.ConversationText != nil {
				conversation = []byte(*c.ConversationText)
			}
			if want.characters < 0 {
				if _, err := DecodeRouteRequest([]byte(`{"objective":{"goal":"cost","mode":"balanced"},"conversation":` + string(conversation) + `}`)); KindOf(err) != Malformed {
					t.Errorf("want malformed, got %v", err)
				}
				return
			}
			characters, tokens := estimateContext(conversationRequest(t, conversation).Conversation)
			if characters != want.characters || tokens != want.tokens {
				t.Errorf("got %d characters, %d tokens; want %d, %d", characters, tokens, want.characters, want.tokens)
			}
		})
	}
	for id := range contextDifferences {
		if !used[id] {
			t.Errorf("known difference %q matches no case", id)
		}
	}
}

func TestClassificationParity(t *testing.T) {
	var doc struct {
		SystemPrompt           string `json:"system_prompt"`
		ClassificationContract string `json:"classification_contract"`
		Cases                  []struct {
			ID           string         `json:"id"`
			Conversation jsontext.Value `json:"conversation"`
			Expect       struct {
				ConversationData *string `json:"conversation_data"`
				Error            *string `json:"error"`
			} `json:"expect"`
		} `json:"cases"`
	}
	readFixture(t, "classification.json", &doc)
	if doc.SystemPrompt != SystemPrompt {
		t.Error("SystemPrompt differs from the fixture")
	}
	if doc.ClassificationContract != ClassificationContract {
		t.Error("ClassificationContract differs from the fixture")
	}
	if len(doc.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range doc.Cases {
		t.Run(c.ID, func(t *testing.T) {
			authored := authoredMessages(conversationRequest(t, c.Conversation).Conversation)
			switch {
			case c.Expect.Error != nil:
				if *c.Expect.Error != "no_authored_turn" || len(authored) != 0 {
					t.Errorf("want error %s, got %d authored turns", *c.Expect.Error, len(authored))
				}
			case len(authored) == 0:
				t.Fatal("no authored turns")
			default:
				want := ClassificationContract + "\n\n" + *c.Expect.ConversationData
				if got := ClassificationPrompt(authored); got != want {
					t.Errorf("prompt data:\n%s\nwant:\n%s", got[len(ClassificationContract):], want[len(ClassificationContract):])
				}
			}
		})
	}
}
