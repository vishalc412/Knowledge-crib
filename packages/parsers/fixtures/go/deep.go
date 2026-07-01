package deep

// deepGuard demonstrates schema-1.2 behavior nodes: panic, recover, switch, assignment.
func deepGuard(kind int, v interface{}) string {
	x := "init"
	defer func() {
		if r := recover(); r != nil {
			x = "recovered"
		}
	}()
	switch kind {
	case 1:
		x = "one"
	case 2:
		x = "two"
	default:
		panic("unknown kind")
	}
	switch t := v.(type) {
	case int:
		return x + "int"
	case string:
		return x + "string"
	default:
		return x + "other"
	}
}