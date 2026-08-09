package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	timeout := int64(1000)
	input := Frame{
		Version: ProtocolVersion, Type: "execute", RequestID: "request-1",
		Argv: []string{"/bin/echo", "hello"}, Env: map[string]string{"LANG": "C"},
		Cwd: "/workspace", UID: 1000, GID: 1000, TimeoutMS: &timeout,
	}
	var wire bytes.Buffer
	if err := WriteFrame(&wire, input); err != nil {
		t.Fatalf("WriteFrame: %v", err)
	}
	output, err := ReadFrame(&wire)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if output.Type != input.Type || output.RequestID != input.RequestID || output.Argv[1] != "hello" {
		t.Fatalf("round trip mismatch: %#v", output)
	}
}

func TestReadFrameRejectsOversizedPayloadBeforeAllocation(t *testing.T) {
	var wire bytes.Buffer
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], MaxFramePayloadBytes+1)
	wire.Write(header[:])
	_, err := ReadFrame(&wire)
	if !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("expected ErrFrameTooLarge, got %v", err)
	}
}

func TestReadFrameRejectsUnknownJSONFields(t *testing.T) {
	payload := []byte(`{"version":1,"type":"shutdown","unexpected":true}`)
	var wire bytes.Buffer
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	wire.Write(header[:])
	wire.Write(payload)
	if _, err := ReadFrame(&wire); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("expected ErrInvalidFrame, got %v", err)
	}
}

func TestValidateFrameRejectsInvalidSchemas(t *testing.T) {
	cases := []Frame{
		{Version: 2, Type: "shutdown", RequestID: "shutdown"},
		{Version: ProtocolVersion, Type: "execute", RequestID: "id", Env: map[string]string{}, Cwd: "/workspace", UID: 1, GID: 1},
		{Version: ProtocolVersion, Type: "stdin", RequestID: "id", Data: stringPointer("not base64!")},
		{Version: ProtocolVersion, Type: "result", RequestID: "id"},
		{Version: ProtocolVersion, Type: "unknown", RequestID: "id"},
	}
	for _, frame := range cases {
		if err := ValidateFrame(frame); err == nil {
			t.Errorf("ValidateFrame(%#v) unexpectedly succeeded", frame)
		}
	}
}

func TestOutputChunkLimit(t *testing.T) {
	data := bytes.Repeat([]byte("x"), MaxStreamChunkBytes)
	encoded := base64.StdEncoding.EncodeToString(data)
	if len(encoded) != MaxEncodedChunkBytes {
		t.Fatalf("encoded size = %d, want %d", len(encoded), MaxEncodedChunkBytes)
	}
	if err := ValidateFrame(Frame{Version: ProtocolVersion, Type: "stdout", RequestID: "id", Data: &encoded}); err != nil {
		t.Fatalf("valid maximum output chunk rejected: %v", err)
	}
	tooLarge := encoded + "AAAA"
	if err := ValidateFrame(Frame{Version: ProtocolVersion, Type: "stdout", RequestID: "id", Data: &tooLarge}); err == nil {
		t.Fatal("oversized output chunk accepted")
	}
}

func TestResultIncludesExplicitNull(t *testing.T) {
	code := 0
	frame := newFrame("result", "request-1")
	frame.ExitCode = &code
	var wire bytes.Buffer
	if err := WriteFrame(&wire, frame); err != nil {
		t.Fatalf("WriteFrame: %v", err)
	}
	if !bytes.Contains(wire.Bytes(), []byte(`"signal":null`)) || !bytes.Contains(wire.Bytes(), []byte(`"exitCode":0`)) {
		t.Fatalf("result lacks required explicit fields: %s", wire.Bytes())
	}
}

func TestReadyHasExactCapabilities(t *testing.T) {
	frame := newFrame("ready", "control")
	frame.Capabilities = map[string]bool{"stdin": true, "tty": false, "resize": false}
	if err := ValidateFrame(frame); err != nil {
		t.Fatalf("valid ready rejected: %v", err)
	}
	frame.Capabilities["cancel"] = true
	if err := ValidateFrame(frame); err == nil {
		t.Fatal("ready with an extra capability accepted")
	}
}

func TestExecuteWritesRequiredFalseAndEmptyFields(t *testing.T) {
	frame := newFrame("execute", "request-1")
	frame.Argv = []string{"/bin/true"}
	frame.Env = map[string]string{}
	frame.Cwd = "/workspace"
	frame.UID, frame.GID = 1000, 1000
	var wire bytes.Buffer
	if err := WriteFrame(&wire, frame); err != nil {
		t.Fatalf("WriteFrame: %v", err)
	}
	payload := wire.Bytes()[4:]
	for _, required := range [][]byte{[]byte(`"env":{}`), []byte(`"tty":false`)} {
		if !bytes.Contains(payload, required) {
			t.Fatalf("execute lacks required property %s: %s", required, payload)
		}
	}
}

func TestStdinEOFAndVersionMismatch(t *testing.T) {
	eof := true
	if err := ValidateFrame(Frame{
		Version: ProtocolVersion, Type: "stdin", RequestID: "request-1", EOF: &eof,
	}); err != nil {
		t.Fatalf("stdin eof rejected: %v", err)
	}
	err := ValidateFrame(Frame{Version: 2, Type: "shutdown", RequestID: "shutdown"})
	var protocol *protocolError
	if !errors.As(err, &protocol) || protocol.code != errorProtocolVersionMismatch || protocol.expectedVersion == nil {
		t.Fatalf("version mismatch was not typed: %v", err)
	}
}

func stringPointer(value string) *string { return &value }
