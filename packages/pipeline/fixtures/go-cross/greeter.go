package auth

// Greeter is an interface. Go interfaces are satisfied implicitly; the resolver does NOT detect
// that Service (below) implements Greeter — only explicit embedding (struct or interface) is
// captured as `inherits`. This is an honest, documented limitation.
type Greeter interface {
	Greet(user string) string
}