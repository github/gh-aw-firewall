//go:build linux

package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	afVsock      = 40
	vmaddrCIDAny = ^uint32(0)
	cancelGrace  = 2 * time.Second
	maxTimeoutMS = int64(24 * 60 * 60 * 1000)
)

type sockaddrVM struct {
	Family   uint16
	Reserved uint16
	Port     uint32
	CID      uint32
	Zero     [4]byte
}

type vsockListener struct{ fd int }

func listenVsock(port uint32) (*vsockListener, error) {
	fd, err := syscall.Socket(afVsock, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	address := sockaddrVM{Family: afVsock, Port: port, CID: vmaddrCIDAny}
	if _, _, errno := syscall.Syscall(syscall.SYS_BIND, uintptr(fd), uintptr(unsafe.Pointer(&address)), unsafe.Sizeof(address)); errno != 0 {
		syscall.Close(fd)
		return nil, errno
	}
	if err := syscall.Listen(fd, 16); err != nil {
		syscall.Close(fd)
		return nil, err
	}
	return &vsockListener{fd: fd}, nil
}

func (l *vsockListener) Accept() (*os.File, error) {
	var address sockaddrVM
	length := uint32(unsafe.Sizeof(address))
	fd, _, errno := syscall.Syscall6(syscall.SYS_ACCEPT4, uintptr(l.fd), uintptr(unsafe.Pointer(&address)), uintptr(unsafe.Pointer(&length)), syscall.SOCK_CLOEXEC, 0, 0)
	if errno != 0 {
		return nil, errno
	}
	return os.NewFile(fd, "vsock-client"), nil
}

func (l *vsockListener) Close() error { return syscall.Close(l.fd) }

func runSupervisor() error {
	if os.Getpid() == 1 {
		if err := mountProc(); err != nil {
			return err
		}
	}
	cmdline, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return fmt.Errorf("read kernel command line: %w", err)
	}
	config, err := parseBootConfig(string(cmdline))
	if err != nil {
		return err
	}
	if err := mountWorkspace(config); err != nil {
		return err
	}
	if err := configureNetwork(config); err != nil {
		return err
	}
	listener, err := listenVsock(config.VsockPort)
	if err != nil {
		return fmt.Errorf("listen on vsock: %w", err)
	}
	defer listener.Close()
	for {
		connection, err := listener.Accept()
		if err != nil {
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			return err
		}
		shutdown := serveClient(connection, config)
		connection.Close()
		if shutdown {
			return shutdownGuest(config)
		}
	}
}

func mountProc() error {
	if err := os.MkdirAll("/proc", 0555); err != nil {
		return fmt.Errorf("create proc mount: %w", err)
	}
	if err := syscall.Mount("proc", "/proc", "proc", 0, ""); err != nil && !errors.Is(err, syscall.EBUSY) {
		return fmt.Errorf("mount proc: %w", err)
	}
	return nil
}

func shutdownGuest(config bootConfig) error {
	syscall.Sync()
	if err := syscall.Unmount(config.WorkspaceMount, 0); err != nil {
		return fmt.Errorf("unmount workspace: %w", err)
	}
	if err := syscall.Reboot(syscall.LINUX_REBOOT_CMD_POWER_OFF); err != nil {
		return fmt.Errorf("power off guest: %w", err)
	}
	return nil
}

func mountWorkspace(config bootConfig) error {
	info, err := os.Stat(config.WorkspaceDevice)
	if err != nil {
		return fmt.Errorf("stat workspace device: %w", err)
	}
	if info.Mode()&os.ModeDevice == 0 || info.Mode()&os.ModeCharDevice != 0 {
		return fmt.Errorf("workspace device is not a block device")
	}
	if err := os.MkdirAll(config.WorkspaceMount, 0755); err != nil {
		return fmt.Errorf("create workspace mount: %w", err)
	}
	if err := syscall.Mount(config.WorkspaceDevice, config.WorkspaceMount, "", 0, ""); err != nil {
		return fmt.Errorf("mount workspace: %w", err)
	}
	return nil
}

func configureNetwork(config bootConfig) error {
	ip, err := ipCommand()
	if err != nil {
		return err
	}
	env := []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	run := func(args ...string) error {
		command := exec.Command(ip, args...)
		command.Env = env
		if output, err := command.CombinedOutput(); err != nil {
			return fmt.Errorf("ip %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
		}
		return nil
	}
	if err := run("link", "set", "dev", config.Interface, "up"); err != nil {
		return err
	}
	if err := run("address", "replace", config.GuestIP.String()+fmt.Sprintf("/%d", config.GuestPrefix), "dev", config.Interface); err != nil {
		return err
	}
	return run("route", "replace", "default", "via", config.Gateway.String(), "dev", config.Interface)
}

func ipCommand() (string, error) {
	for _, path := range []string{"/sbin/ip", "/usr/sbin/ip"} {
		if info, err := os.Stat(path); err == nil && !info.IsDir() && info.Mode()&0111 != 0 {
			return path, nil
		}
	}
	return "", errors.New("ip utility is required to configure guest networking")
}

type session struct {
	connection *os.File
	config     bootConfig
	writeMu    sync.Mutex
	activeMu   sync.Mutex
	active     *execution
}

type execution struct {
	requestID   string
	command     *exec.Cmd
	stdin       io.WriteCloser
	cancel      context.CancelFunc
	done        chan struct{}
	once        sync.Once
	output      sync.WaitGroup
	stdinMu     sync.Mutex
	stdinClosed bool
}

func serveClient(connection *os.File, config bootConfig) bool {
	s := &session{connection: connection, config: config}
	_ = s.send(Frame{Version: ProtocolVersion, Type: "ready", RequestID: "control", Capabilities: map[string]bool{
		"stdin": true, "tty": false, "resize": false,
	}})
	for {
		frame, err := ReadFrame(connection)
		if err != nil {
			var protocol *protocolError
			if errors.As(err, &protocol) {
				s.sendProtocolError(safeRequestID(frame.RequestID), protocol)
			}
			s.stopActive()
			return false
		}
		switch frame.Type {
		case "execute":
			if err := s.start(frame); err != nil {
				var typed typedError
				if errors.As(err, &typed) {
					s.sendError(frame.RequestID, typed.code, typed.message)
				} else {
					s.sendError(frame.RequestID, errorInvalidRequest, err.Error())
				}
			}
		case "stdin":
			s.writeStdin(frame)
		case "cancel":
			s.cancel(frame.RequestID)
		case "resize":
			s.sendError(frame.RequestID, errorTTYUnsupported, "TTY and resize are unsupported")
		case "shutdown":
			_ = s.send(newFrame("shutting_down", frame.RequestID))
			s.stopActive()
			return true
		default:
			s.sendError(frame.RequestID, errorInvalidRequest, "frame is not accepted from the client")
		}
	}
}

func (s *session) send(frame Frame) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return WriteFrame(s.connection, frame)
}

func (s *session) sendError(requestID string, code errorCode, message string) {
	f := newFrame("error", safeRequestID(requestID))
	f.Code, f.Message = code, message
	_ = s.send(f)
}

func (s *session) sendProtocolError(requestID string, protocol *protocolError) {
	f := newFrame("error", requestID)
	f.Code, f.Message, f.ExpectedVersion = protocol.code, protocol.message, protocol.expectedVersion
	_ = s.send(f)
}

func safeRequestID(requestID string) string {
	if requestIDPattern.MatchString(requestID) {
		return requestID
	}
	return "control"
}

func (s *session) start(frame Frame) error {
	if frame.TTY {
		return typedError{errorTTYUnsupported, "TTY is not supported by this guest"}
	}
	if frame.TimeoutMS != nil && *frame.TimeoutMS > maxTimeoutMS {
		return fmt.Errorf("timeoutMs exceeds maximum of %d", maxTimeoutMS)
	}
	if frame.UID > int64(^uint32(0)) || frame.GID > int64(^uint32(0)) {
		return fmt.Errorf("uid and gid must fit Linux credential limits")
	}
	cwd, err := resolveCWD(s.config.WorkspaceMount, frame.Cwd)
	if err != nil {
		return err
	}
	s.activeMu.Lock()
	defer s.activeMu.Unlock()
	if s.active != nil {
		return typedError{errorRequestInProgress, "another command is already running"}
	}
	ctx := context.Background()
	var cancel context.CancelFunc
	if frame.TimeoutMS != nil {
		ctx, cancel = context.WithTimeout(ctx, time.Duration(*frame.TimeoutMS)*time.Millisecond)
	} else {
		ctx, cancel = context.WithCancel(ctx)
	}
	resolvedCommand, err := resolveCommand(frame.Argv[0], frame.Env)
	if err != nil {
		cancel()
		return err
	}
	command := exec.Command(resolvedCommand, frame.Argv[1:]...)
	command.Dir = cwd
	command.Env = environment(frame.Env)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Credential: &syscall.Credential{Uid: uint32(frame.UID), Gid: uint32(frame.GID)}}
	stdin, err := command.StdinPipe()
	if err != nil {
		cancel()
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		cancel()
		stdin.Close()
		return err
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		cancel()
		stdin.Close()
		return err
	}
	if err := command.Start(); err != nil {
		cancel()
		stdin.Close()
		return err
	}
	execution := &execution{requestID: frame.RequestID, command: command, stdin: stdin, cancel: cancel, done: make(chan struct{})}
	s.active = execution
	execution.output.Add(2)
	go s.streamOutput(execution, "stdout", stdout)
	go s.streamOutput(execution, "stderr", stderr)
	go func() {
		select {
		case <-ctx.Done():
			s.terminate(execution)
		case <-execution.done:
		}
	}()
	go s.wait(execution, ctx)
	return nil
}

func (s *session) writeStdin(frame Frame) {
	s.activeMu.Lock()
	execution := s.active
	s.activeMu.Unlock()
	if execution == nil || execution.requestID != frame.RequestID {
		s.sendError(frame.RequestID, errorRequestNotFound, "no matching command is running")
		return
	}
	execution.stdinMu.Lock()
	defer execution.stdinMu.Unlock()
	if frame.Data != nil {
		data, _ := base64.StdEncoding.DecodeString(*frame.Data)
		if _, err := execution.stdin.Write(data); err != nil {
			s.sendError(frame.RequestID, errorInternal, "write stdin: "+err.Error())
		}
	}
	if frame.EOF != nil && *frame.EOF && !execution.stdinClosed {
		execution.stdinClosed = true
		if err := execution.stdin.Close(); err != nil {
			s.sendError(frame.RequestID, errorInternal, "close stdin: "+err.Error())
		}
	}
}

func (s *session) cancel(requestID string) {
	s.activeMu.Lock()
	execution := s.active
	s.activeMu.Unlock()
	if execution == nil || execution.requestID != requestID {
		s.sendError(requestID, errorRequestNotFound, "no matching command is running")
		return
	}
	s.terminate(execution)
}

func (s *session) stopActive() {
	s.activeMu.Lock()
	execution := s.active
	s.activeMu.Unlock()
	if execution == nil {
		return
	}
	s.terminate(execution)
	select {
	case <-execution.done:
	case <-time.After(cancelGrace + time.Second):
	}
}

func (s *session) terminate(execution *execution) {
	select {
	case <-execution.done:
		return
	default:
	}
	execution.once.Do(func() {
		execution.cancel()
		_ = syscall.Kill(-execution.command.Process.Pid, syscall.SIGTERM)
		go func() {
			select {
			case <-execution.done:
			case <-time.After(cancelGrace):
				_ = syscall.Kill(-execution.command.Process.Pid, syscall.SIGKILL)
			}
		}()
	})
}

func (s *session) wait(execution *execution, ctx context.Context) {
	execution.output.Wait()
	err := execution.command.Wait()
	execution.stdinMu.Lock()
	if !execution.stdinClosed {
		execution.stdinClosed = true
		_ = execution.stdin.Close()
	}
	execution.stdinMu.Unlock()
	terminateAndReapDescendants(execution.command.Process.Pid)
	// Prevent a just-cancelled context watcher from signalling a reaped PID.
	execution.once.Do(func() {})
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	result := newFrame("result", execution.requestID)
	result.TimedOut = timedOut
	if exitError, ok := err.(*exec.ExitError); ok {
		status := exitError.Sys().(syscall.WaitStatus)
		if status.Signaled() {
			signal := signalName(status.Signal())
			result.Signal = &signal
		} else {
			code := status.ExitStatus()
			result.ExitCode = &code
		}
	} else if err == nil {
		code := 0
		result.ExitCode = &code
	} else {
		s.sendError(execution.requestID, errorInternal, "execution failed: "+err.Error())
	}
	s.activeMu.Lock()
	if s.active == execution {
		s.active = nil
	}
	s.activeMu.Unlock()
	close(execution.done)
	execution.cancel()
	if result.ExitCode != nil || result.Signal != nil {
		_ = s.send(result)
	}
}

func terminateAndReapDescendants(processGroup int) {
	_ = syscall.Kill(-processGroup, syscall.SIGTERM)
	deadline := time.Now().Add(cancelGrace)
	killed := false
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
		if pid > 0 {
			continue
		}
		if err != nil && !errors.Is(err, syscall.ECHILD) {
			return
		}
		if errors.Is(err, syscall.ECHILD) {
			return
		}
		if !killed && time.Now().After(deadline) {
			_ = syscall.Kill(-processGroup, syscall.SIGKILL)
			killed = true
			deadline = time.Now().Add(time.Second)
		}
		if killed && time.Now().After(deadline) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (s *session) streamOutput(execution *execution, frameType string, reader io.Reader) {
	defer execution.output.Done()
	// 48 KiB encodes to exactly 64 KiB, keeping the protocol chunk limit.
	buffer := make([]byte, 48<<10)
	for {
		count, err := reader.Read(buffer)
		if count > 0 {
			frame := newFrame(frameType, execution.requestID)
			data := base64.StdEncoding.EncodeToString(buffer[:count])
			frame.Data = &data
			_ = s.send(frame)
		}
		if err != nil {
			return
		}
	}
}

func environment(values map[string]string) []string {
	environment := make([]string, 0, len(values))
	for key, value := range values {
		environment = append(environment, key+"="+value)
	}
	return environment
}

func resolveCommand(command string, env map[string]string) (string, error) {
	if strings.Contains(command, "/") {
		if !filepath.IsAbs(command) {
			return "", errors.New("argv[0] must be absolute when it includes a path separator")
		}
		return command, nil
	}
	searchPath := env["PATH"]
	if searchPath == "" {
		searchPath = "/usr/sbin:/usr/bin:/sbin:/bin"
	}
	for _, directory := range filepath.SplitList(searchPath) {
		if directory == "" || !filepath.IsAbs(directory) {
			continue
		}
		candidate := filepath.Join(directory, command)
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() || info.Mode()&0111 == 0 {
			continue
		}
		return candidate, nil
	}
	return "", fmt.Errorf("command not found in PATH: %s", command)
}

func resolveCWD(workspace, cwd string) (string, error) {
	if !filepath.IsAbs(cwd) {
		return "", errors.New("cwd must be an absolute path under the workspace mount")
	}
	resolvedWorkspace, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return "", fmt.Errorf("resolve workspace mount: %w", err)
	}
	resolvedCWD, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		return "", fmt.Errorf("resolve cwd: %w", err)
	}
	relative, err := filepath.Rel(resolvedWorkspace, resolvedCWD)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return "", errors.New("cwd must remain under the workspace mount")
	}
	info, err := os.Stat(resolvedCWD)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("cwd is not a directory")
	}
	return resolvedCWD, nil
}

func signalName(signal syscall.Signal) string {
	if name, ok := map[syscall.Signal]string{
		syscall.SIGHUP: "SIGHUP", syscall.SIGINT: "SIGINT", syscall.SIGQUIT: "SIGQUIT",
		syscall.SIGILL: "SIGILL", syscall.SIGABRT: "SIGABRT", syscall.SIGFPE: "SIGFPE",
		syscall.SIGKILL: "SIGKILL", syscall.SIGSEGV: "SIGSEGV", syscall.SIGPIPE: "SIGPIPE",
		syscall.SIGALRM: "SIGALRM", syscall.SIGTERM: "SIGTERM", syscall.SIGUSR1: "SIGUSR1",
		syscall.SIGUSR2: "SIGUSR2", syscall.SIGCHLD: "SIGCHLD", syscall.SIGCONT: "SIGCONT",
		syscall.SIGSTOP: "SIGSTOP", syscall.SIGTSTP: "SIGTSTP", syscall.SIGTTIN: "SIGTTIN",
		syscall.SIGTTOU: "SIGTTOU",
	}[signal]; ok {
		return name
	}
	return fmt.Sprintf("SIG%d", signal)
}

type typedError struct {
	code    errorCode
	message string
}

func (e typedError) Error() string { return e.message }
