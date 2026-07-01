package auth

// Token is a same-package type constructed via composite literal in controller.go.
// Composite literals (`Token{...}`) are NOT resolved to a call edge (honest: `{` is not a call).
type Token struct {
	Value string
}