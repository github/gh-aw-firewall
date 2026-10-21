package main

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

type cues []string

var (
	explainLeads = cues{"explain", "summarize", "summarise", "describe", "walk me through", "walk through", "clarify", "elaborate"}
	fixLeads     = cues{"fix", "debug", "repair", "resolve", "troubleshoot", "diagnose", "correct"}
	planLeads    = cues{"plan", "design", "architect", "propose", "compare", "evaluate"}
	choreLeads   = cues{"bump", "upgrade", "downgrade", "format", "reformat", "pin"}
	planCues     = cues{
		"plan", "planning", "design", "architect", "architecture", "propose an approach",
		"implementation approach", "implementation plan", "break down", "tradeoff",
		"what would it take", "how should we", "before implementing", "possible approaches",
	}
	fixSymptoms = cues{
		"error", "stack trace", "traceback", "panic", "exception", "failing", "fails", "failed",
		"broken", "doesn't work", "not working", "crash", "regression", "bug", "wrong", "incorrect",
		"unexpected", "times out", "deadlock", "memory leak", "segfault", "null pointer", "flaky",
		"won't compile", "doesn't compile", "stopped working", "no longer works", "hangs", "freezes",
		"infinite loop", "stuck",
	}
	followUpCues = cues{
		"execute this plan", "execute that plan", "execute the plan", "execute the proposed plan",
		"make this change", "make that change", "make the change", "make these changes",
		"make those changes", "make the proposed change", "make the proposed changes",
		"make proposed change", "make proposed changes", "apply this change", "apply that change",
		"apply the change", "apply these changes", "apply those changes", "apply the proposed change",
		"apply the proposed changes", "apply proposed change", "apply proposed changes", "apply these",
		"apply those",
	}
	explainCues = cues{
		"explain", "summarize", "summarise", "summary of", "describe", "clarify", "elaborate",
		"walk me through", "walk through", "tell me about", "understand", "overview", "high level",
	}
	questionLeads = cues{"why", "what", "how", "what's", "whats"}
	questionCues  = cues{
		"why", "what is", "what are", "what does", "what it does", "what it is", "what's", "how does",
		"how do", "where is",
	}
	choreCues = cues{
		"bump", "upgrade", "downgrade", "update deps", "dependency", "dependencies", "lockfile",
		"lock file", "version bump", "pin the", "ci config", "config file", "gitignore", "rustfmt",
		"clippy", "prettier", "eslint", "reformat", "formatting", "cargo update", "npm update",
		"workflow file", "github action", "typo",
	}
	refactorCues = cues{
		"refactor", "rename", "clean up", "cleanup", "restructure", "extract", "simplify",
		"reorganize", "deduplicate", "de-duplicate", "tidy", "consolidate", "modularize",
		"modularise", "decouple", "encapsulate", "untangle", "factor out", "pull out", "split up",
	}
	imperativeVerbs = cues{
		"add", "create", "implement", "build", "write", "make", "update", "change", "remove", "delete",
		"support", "handle", "wire", "generate", "introduce", "set up", "replace", "rewrite", "extend",
		"expose", "enable", "disable", "convert", "migrate", "improve", "optimize", "optimise",
		"ensure", "allow", "port",
	}
	crossSystemCues = cues{
		"cross-system", "cross system", "end-to-end", "end to end", "multiple services",
		"across services", "frontend and backend", "client and server", "all crates", "all packages",
		"entire workspace",
	}
	subsystemCues = cues{
		"subsystem", "service", "module", "crate", "package", "architecture", "codebase", "repository",
		"this repo", "the repo", "whole repo", "entire repo", "repo-wide", "repo wide", "this project",
		"the project", "whole project", "entire project", "project-wide", "project wide",
	}
	multiFileCues = cues{
		"multiple files", "several files", "across files", "components", "call sites",
		"implementations", "all files", "every file", "both files", "two files",
	}
	localCues = cues{
		"this function", "this method", "this file", "this test", "this type", "this component",
		"one file", "single file",
	}
	politePrefixes = []string{"please ", "kindly ", "can you ", "could you ", "would you ", "will you "}
)

var leadRules = []struct {
	taskType TaskType
	leads    cues
}{
	{TaskExplain, explainLeads},
	{TaskFix, fixLeads},
	{TaskPlan, planLeads},
	{TaskChore, choreLeads},
	{TaskRefactor, refactorCues},
}

var scopeRules = []struct {
	scope TaskScope
	cues  cues
}{
	{ScopeCrossSystem, crossSystemCues},
	{ScopeSubsystem, subsystemCues},
	{ScopeMultiFile, multiFileCues},
	{ScopeLocal, localCues},
}

// InferLabels prefers explicit actions over incidental keywords and leaves
// complexity unknown.
func InferLabels(message string) Labels {
	text := strings.Join(fields(strings.ToLower(message)), " ")
	return Labels{
		TaskType:       inferTaskType(text),
		Scope:          inferScope(text),
		TaskComplexity: ComplexityUnknown,
	}
}

func inferTaskType(text string) TaskType {
	action := stripPoliteness(text)
	for _, rule := range leadRules {
		if rule.leads.leads(action) {
			return rule.taskType
		}
	}
	switch {
	case cues{"update"}.leads(action) && choreCues.anywhere(text):
		return TaskChore
	case len(fields(action)) >= 2 && imperativeVerbs.leads(action), followUpCues.anywhere(text):
		return TaskImplement
	case planCues.anywhere(text):
		return TaskPlan
	case fixSymptoms.anywhere(text):
		return TaskFix
	case explainCues.anywhere(text), questionLeads.leads(action), questionCues.anywhere(text):
		return TaskExplain
	case choreCues.anywhere(text):
		return TaskChore
	case refactorCues.anywhere(text):
		return TaskRefactor
	}
	return TaskUnknown
}

func inferScope(text string) TaskScope {
	for _, rule := range scopeRules {
		if rule.cues.anywhere(text) {
			return rule.scope
		}
	}
	return ScopeUnknown
}

// stripPoliteness removes leading requests such as "please" and "could you".
// Whitespace in text is already normalized to single spaces.
func stripPoliteness(text string) string {
	for {
		stripped := text
		for _, prefix := range politePrefixes {
			stripped = strings.TrimPrefix(stripped, prefix)
		}
		if stripped == text {
			return text
		}
		text = stripped
	}
}

// leads reports whether text starts with a cue that is not followed by a word character.
func (c cues) leads(text string) bool {
	for _, cue := range c {
		if rest, ok := strings.CutPrefix(text, cue); ok {
			if r, _ := utf8.DecodeRuneInString(rest); rest == "" || !isWord(r) {
				return true
			}
		}
	}
	return false
}

// anywhere reports whether a cue appears as whole words: not preceded or followed
// by a word character.
func (c cues) anywhere(text string) bool {
	previous := ' '
	for i, r := range text {
		if !isWord(previous) && c.leads(text[i:]) {
			return true
		}
		previous = r
	}
	return false
}

// isWord reports whether r is a word character: a letter, a number or the underscore.
func isWord(r rune) bool {
	return r == '_' || unicode.IsLetter(r) || unicode.IsNumber(r)
}

// isSpace extends unicode.IsSpace with the information separators U+001C to
// U+001F, which Python's str.split and str.strip treat as whitespace, so the
// heuristics label text as the original Python router did.
func isSpace(r rune) bool {
	return unicode.IsSpace(r) || r >= 0x1c && r <= 0x1f
}

func fields(s string) []string { return strings.FieldsFunc(s, isSpace) }

func trimSpace(s string) string { return strings.TrimFunc(s, isSpace) }
