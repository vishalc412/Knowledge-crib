package util

// UtilFn is a top-level func in the `util` subpackage. Imported by controller.go and called via
// `util.UtilFn()` → cross-file `calls` edge + `imports` edge (controller.go → UtilFn).
func UtilFn() string {
	return "ok"
}