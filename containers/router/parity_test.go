package main

import (
	"encoding/base64"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"os"
	"path/filepath"
	"testing"
)

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
			_, err := DecodeRouteRequest(body)
			if got, want := resultOf(err), c.Expect.Result; got != want {
				t.Errorf("got %s, want %s (err: %v)", got, want, err)
			}
		})
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
	data, err := os.ReadFile(filepath.Join("testdata", "parity", name))
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
	for _, c := range doc.Cases {
		t.Run(c.ID, func(t *testing.T) {
			conversation := []byte(c.Conversation)
			if c.ConversationText != nil {
				conversation = []byte(*c.ConversationText)
			}
			characters, tokens := estimateContext(conversationRequest(t, conversation).Conversation)
			if characters != c.Expect.Characters || tokens != c.Expect.Tokens {
				t.Errorf("got %d characters, %d tokens; want %d, %d", characters, tokens, c.Expect.Characters, c.Expect.Tokens)
			}
		})
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
