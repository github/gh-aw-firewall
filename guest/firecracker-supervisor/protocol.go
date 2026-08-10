package main

// This file implements the guest side of the AWF framed guest-supervisor
// protocol. It is intentionally VMM-neutral: the length-prefixed JSON
// framing and frame types here mirror src/microvm/guest-protocol.ts on the
// host side, and this binary (despite its package's historical
// "firecracker-supervisor" name/path) does not depend on any
// Firecracker-specific transport. A future VMM backend can reuse this
// supervisor as-is, addressed through the same vsock/UDS compatibility
// boundary, without protocol changes.

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
)

const (
	ProtocolVersion      = 1
	MaxFramePayloadBytes = 1 << 20
	MaxStreamChunkBytes  = 64 << 10
	MaxEncodedChunkBytes = 4 * ((MaxStreamChunkBytes + 2) / 3)
	MaxEnvEntries        = 512
	MaxArgvEntries       = 4096
	MaxStringBytes       = 256 << 10
	MaxSafeInteger       = int64(9_007_199_254_740_991)
)

type errorCode string

const (
	errorInvalidFrame            errorCode = "invalid_frame"
	errorProtocolVersionMismatch errorCode = "protocol_version_mismatch"
	errorInvalidRequest          errorCode = "invalid_request"
	errorRequestInProgress       errorCode = "request_in_progress"
	errorRequestNotFound         errorCode = "request_not_found"
	errorTTYUnsupported          errorCode = "tty_unsupported"
	errorInternal                errorCode = "internal_error"
)

var (
	ErrFrameTooLarge = &protocolError{code: errorInvalidFrame, message: "frame exceeds 1 MiB"}
	ErrInvalidFrame  = &protocolError{code: errorInvalidFrame, message: "invalid frame"}
	requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
	envNamePattern   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

type protocolError struct {
	code            errorCode
	message         string
	expectedVersion *int
}

func (e *protocolError) Error() string { return e.message }

func (e *protocolError) Is(target error) bool {
	other, ok := target.(*protocolError)
	return ok && e.code == other.code
}

// Frame is the exact JSON shape accepted by src/firecracker/vsock-protocol.ts.
type Frame struct {
	Version         int               `json:"version"`
	Type            string            `json:"type"`
	RequestID       string            `json:"requestId"`
	Argv            []string          `json:"argv,omitempty"`
	Env             map[string]string `json:"env,omitempty"`
	Cwd             string            `json:"cwd,omitempty"`
	UID             int64             `json:"uid,omitempty"`
	GID             int64             `json:"gid,omitempty"`
	TTY             bool              `json:"tty,omitempty"`
	TimeoutMS       *int64            `json:"timeoutMs,omitempty"`
	Data            *string           `json:"data,omitempty"`
	EOF             *bool             `json:"eof,omitempty"`
	Columns         int               `json:"columns,omitempty"`
	Rows            int               `json:"rows,omitempty"`
	Reason          string            `json:"reason,omitempty"`
	ExitCode        *int              `json:"exitCode,omitempty"`
	Signal          *string           `json:"signal,omitempty"`
	TimedOut        bool              `json:"timedOut,omitempty"`
	Code            errorCode         `json:"code,omitempty"`
	Message         string            `json:"message,omitempty"`
	ExpectedVersion *int              `json:"expectedVersion,omitempty"`
	Capabilities    map[string]bool   `json:"capabilities,omitempty"`
}

func newFrame(frameType, requestID string) Frame {
	return Frame{Version: ProtocolVersion, Type: frameType, RequestID: requestID}
}

func (f Frame) MarshalJSON() ([]byte, error) {
	switch f.Type {
	case "execute":
		return json.Marshal(struct {
			Version   int               `json:"version"`
			Type      string            `json:"type"`
			RequestID string            `json:"requestId"`
			Argv      []string          `json:"argv"`
			Env       map[string]string `json:"env"`
			Cwd       string            `json:"cwd"`
			UID       int64             `json:"uid"`
			GID       int64             `json:"gid"`
			TTY       bool              `json:"tty"`
			TimeoutMS *int64            `json:"timeoutMs,omitempty"`
		}{
			Version: f.Version, Type: f.Type, RequestID: f.RequestID,
			Argv: f.Argv, Env: f.Env, Cwd: f.Cwd, UID: f.UID, GID: f.GID,
			TTY: f.TTY, TimeoutMS: f.TimeoutMS,
		})
	case "result":
		return json.Marshal(struct {
			Version   int     `json:"version"`
			Type      string  `json:"type"`
			RequestID string  `json:"requestId"`
			ExitCode  *int    `json:"exitCode"`
			Signal    *string `json:"signal"`
			TimedOut  bool    `json:"timedOut"`
		}{
			Version: f.Version, Type: f.Type, RequestID: f.RequestID,
			ExitCode: f.ExitCode, Signal: f.Signal, TimedOut: f.TimedOut,
		})
	default:
		type frameAlias Frame
		return json.Marshal(frameAlias(f))
	}
}

func validateFrameKeys(payload []byte, frameType string) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		return invalidFrame("malformed JSON: " + err.Error())
	}
	allowed := map[string][]string{
		"ready":         {"version", "type", "requestId", "capabilities"},
		"execute":       {"version", "type", "requestId", "argv", "env", "cwd", "uid", "gid", "tty", "timeoutMs"},
		"stdout":        {"version", "type", "requestId", "data"},
		"stderr":        {"version", "type", "requestId", "data"},
		"stdin":         {"version", "type", "requestId", "data", "eof"},
		"resize":        {"version", "type", "requestId", "columns", "rows"},
		"cancel":        {"version", "type", "requestId", "reason"},
		"result":        {"version", "type", "requestId", "exitCode", "signal", "timedOut"},
		"error":         {"version", "type", "requestId", "code", "message", "expectedVersion"},
		"shutdown":      {"version", "type", "requestId"},
		"shutting_down": {"version", "type", "requestId"},
	}
	names, known := allowed[frameType]
	if !known {
		return invalidRequest("unknown frame type")
	}
	for _, name := range names {
		if _, ok := fields[name]; !ok {
			switch frameType {
			case "stdin":
				continue
			case "execute":
				if name == "timeoutMs" {
					continue
				}
			case "error":
				if name == "expectedVersion" {
					continue
				}
			}
			return invalidRequest("missing frame property " + name)
		}
	}
	for name := range fields {
		found := false
		for _, allowedName := range names {
			if name == allowedName {
				found = true
				break
			}
		}
		if !found {
			return invalidRequest("unexpected frame property " + name)
		}
	}
	return nil
}

func ReadFrame(r io.Reader) (Frame, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return Frame{}, err
	}
	length := binary.BigEndian.Uint32(header[:])
	if length == 0 {
		return Frame{}, invalidFrame("empty payload")
	}
	if length > MaxFramePayloadBytes {
		return Frame{}, ErrFrameTooLarge
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return Frame{}, err
	}
	var frame Frame
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&frame); err != nil {
		return Frame{}, invalidFrame("malformed JSON: " + err.Error())
	}
	if err := ensureEOF(decoder); err != nil {
		return frame, invalidFrame("trailing JSON: " + err.Error())
	}
	if err := ValidateFrame(frame); err != nil {
		return frame, err
	}
	if err := validateFrameKeys(payload, frame.Type); err != nil {
		return frame, err
	}
	return frame, nil
}

func WriteFrame(w io.Writer, frame Frame) error {
	if err := ValidateFrame(frame); err != nil {
		return err
	}
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	if len(payload) > MaxFramePayloadBytes {
		return ErrFrameTooLarge
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	if err := writeFull(w, header[:]); err != nil {
		return err
	}
	return writeFull(w, payload)
}

func writeFull(w io.Writer, data []byte) error {
	for len(data) > 0 {
		count, err := w.Write(data)
		if err != nil {
			return err
		}
		if count <= 0 {
			return io.ErrShortWrite
		}
		data = data[count:]
	}
	return nil
}

func ensureEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if err == io.EOF {
		return nil
	}
	if err == nil {
		return errors.New("multiple JSON values")
	}
	return err
}

func ValidateFrame(f Frame) error {
	if f.Version != ProtocolVersion {
		expected := ProtocolVersion
		return &protocolError{
			code:            errorProtocolVersionMismatch,
			message:         fmt.Sprintf("unsupported protocol version %d", f.Version),
			expectedVersion: &expected,
		}
	}
	if err := validateString(f.Type, "type", 64, false); err != nil {
		return err
	}
	if err := validateRequestID(f.RequestID); err != nil {
		return err
	}
	switch f.Type {
	case "ready":
		if f.RequestID != "control" {
			return invalidRequest("ready requestId must be control")
		}
		if len(f.Capabilities) != 3 || f.Capabilities == nil {
			return invalidRequest("ready requires exactly stdin, tty, and resize capabilities")
		}
		for _, name := range []string{"stdin", "tty", "resize"} {
			if _, ok := f.Capabilities[name]; !ok {
				return invalidRequest("ready is missing capability " + name)
			}
		}
	case "execute":
		if len(f.Argv) == 0 || len(f.Argv) > MaxArgvEntries {
			return invalidRequest("argv must contain 1-4096 strings")
		}
		for _, arg := range f.Argv {
			if err := validateString(arg, "argv entry", MaxStringBytes, false); err != nil {
				return err
			}
		}
		if f.Env == nil || len(f.Env) > MaxEnvEntries {
			return invalidRequest("env exceeds 512 entries")
		}
		for name, value := range f.Env {
			if len(name) > 256 || !envNamePattern.MatchString(name) {
				return invalidRequest("invalid environment variable name")
			}
			if err := validateString(value, "environment value", MaxStringBytes, true); err != nil {
				return err
			}
		}
		if err := validateString(f.Cwd, "cwd", 4096, false); err != nil {
			return err
		}
		if !strings.HasPrefix(f.Cwd, "/") {
			return invalidRequest("cwd must be absolute")
		}
		if f.UID <= 0 || f.UID > MaxSafeInteger || f.GID <= 0 || f.GID > MaxSafeInteger {
			return invalidRequest("uid and gid must be positive")
		}
		if f.TimeoutMS != nil && (*f.TimeoutMS <= 0 || *f.TimeoutMS > MaxSafeInteger) {
			return invalidRequest("timeoutMs must be positive")
		}
	case "stdout", "stderr":
		if f.Data == nil {
			return invalidRequest("stream frame requires data")
		}
		if err := validateBase64Chunk(*f.Data); err != nil {
			return err
		}
	case "stdin":
		if f.Data == nil && (f.EOF == nil || !*f.EOF) {
			return invalidRequest("stdin requires data or eof=true")
		}
		if f.Data != nil {
			if err := validateBase64Chunk(*f.Data); err != nil {
				return err
			}
		}
	case "resize":
		if f.Columns < 1 || f.Columns > 65535 || f.Rows < 1 || f.Rows > 65535 {
			return invalidRequest("columns and rows must be in 1-65535")
		}
	case "cancel":
		if err := validateString(f.Reason, "reason", 4096, false); err != nil {
			return err
		}
	case "result":
		if (f.ExitCode == nil) == (f.Signal == nil) {
			return invalidRequest("result requires exactly one of exitCode or signal")
		}
		if f.ExitCode != nil && (*f.ExitCode < 0 || *f.ExitCode > 255) {
			return invalidRequest("exitCode must be in 0-255")
		}
		if f.Signal != nil {
			if err := validateString(*f.Signal, "signal", 64, false); err != nil {
				return err
			}
		}
	case "error":
		if !validErrorCode(f.Code) {
			return invalidRequest("unknown error code")
		}
		if err := validateString(f.Message, "message", 16<<10, false); err != nil {
			return err
		}
		if f.ExpectedVersion != nil && *f.ExpectedVersion <= 0 {
			return invalidRequest("expectedVersion must be positive")
		}
	case "shutdown", "shutting_down":
	default:
		return invalidRequest("unknown frame type " + f.Type)
	}
	return nil
}

func validErrorCode(code errorCode) bool {
	switch code {
	case errorInvalidFrame, errorProtocolVersionMismatch, errorInvalidRequest,
		errorRequestInProgress, errorRequestNotFound, errorTTYUnsupported, errorInternal:
		return true
	}
	return false
}

func validateRequestID(id string) error {
	if !requestIDPattern.MatchString(id) {
		return invalidRequest("invalid requestId")
	}
	return nil
}

func validateString(value, label string, maximum int, allowEmpty bool) error {
	if (!allowEmpty && value == "") || strings.IndexByte(value, 0) >= 0 || len(value) > maximum {
		return invalidRequest(label + " is invalid")
	}
	return nil
}

func validateBase64Chunk(encoded string) error {
	if len(encoded) > MaxEncodedChunkBytes || len(encoded)%4 != 0 {
		return invalidRequest("stream data is not canonical base64")
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || base64.StdEncoding.EncodeToString(decoded) != encoded || len(decoded) > MaxStreamChunkBytes {
		return invalidRequest("stream data is not canonical base64")
	}
	return nil
}

func invalidFrame(message string) error {
	return &protocolError{code: errorInvalidFrame, message: message}
}

func invalidRequest(message string) error {
	return &protocolError{code: errorInvalidRequest, message: message}
}
