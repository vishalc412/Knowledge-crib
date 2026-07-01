package guarded

// classify branches on score: a guarded procedure with calls + returns in each branch.
func classify(score int) string {
	if score > 0 {
		Log("positive")
		return "high"
	} else {
		Log("nonpositive")
		return "low"
	}
}

// loopit walks a for-loop body (inLoop:true, branch:LOOP condition).
func loopit(items []string) {
	for i := 0; i < len(items); i++ {
		Log("iter")
	}
}

// switchy exercises one condition per case predicate (branch:CASE).
func switchy(code int) string {
	switch code {
	case 1:
		Log("one")
		return "a"
	case 2:
		Log("two")
		return "b"
	default:
		Log("other")
		return "z"
	}
}

// Log is the bare-call target (same-file top-level func) for the calls edges above.
func Log(msg string) {}