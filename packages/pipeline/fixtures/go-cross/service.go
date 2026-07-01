package auth

// Service satisfies Greeter implicitly (Greet method). The resolver does NOT emit `implements`
// for implicit interface satisfaction — only explicit embedding would be `inherits`.
type Service struct{}

func (s *Service) Greet(user string) string {
	return user
}