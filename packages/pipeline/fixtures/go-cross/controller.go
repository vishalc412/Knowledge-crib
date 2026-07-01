package auth

// Cross-package import: `auth/util` binds `util` (last path segment = package name).
import "auth/util"

// Controller embeds Base (same package, cross-file) → `inherits` edge Controller → Base.
type Controller struct {
	Base
}

// Run calls util.UtilFn() cross-file → `calls` edge Controller.Run → UtilFn.
func (c *Controller) Run() {
	util.UtilFn()
}