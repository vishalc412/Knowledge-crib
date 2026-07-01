package auth

// Base is embedded by Controller (cross-file embedding → inherits).
type Base struct{}

func (b Base) Run() {}