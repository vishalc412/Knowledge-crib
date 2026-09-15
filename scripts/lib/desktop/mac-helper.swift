// macOS desktop-control helper for the native editor certification scenarios.
//
// Implements the nine-operation automation contract over Apple Accessibility (AXUIElement):
// controls are located by ROLE, IDENTIFIER and NAME and driven through their published actions —
// never by fixed screen coordinates, which the plan forbids as the primary control mechanism.
// Keyboard interaction uses CGEvent posting of DOCUMENTED key commands (e.g. cmd+shift+p) built
// from a fixed key map, not synthetic pixel input.
//
// Wire protocol (shared with the Windows and Linux helpers): argv is [operation, payloadJson],
// and exactly one JSON envelope goes to stdout:
//   {"ok": true,  "operation": "<operation>", "result": {...}}
//   {"ok": false, "operation": "<operation>", "error": "..."}
import AppKit
import ApplicationServices
import Foundation

// ─── payload plumbing ───────────────────────────────────────────────────────────────────────

struct HelperError: Error {
  let message: String
  init(_ message: String) { self.message = message }
}

func payloadString(_ payload: [String: Any], _ key: String) throws -> String {
  guard let value = payload[key] as? String, !value.isEmpty else {
    throw HelperError("payload is missing the required string field \(key)")
  }
  return value
}

func payloadInt(_ payload: [String: Any], _ key: String) throws -> Int {
  guard let value = payload[key] as? Int else { throw HelperError("payload is missing the integer field \(key)") }
  return value
}

func respond(operation: String, result: Any) -> Never {
  let envelope: [String: Any] = ["ok": true, "operation": operation, "result": result]
  let data = try! JSONSerialization.data(withJSONObject: envelope)
  FileHandle.standardOutput.write(data)
  exit(0)
}

func refuse(operation: String, _ message: String) -> Never {
  let envelope: [String: Any] = ["ok": false, "operation": operation, "error": message]
  let data = try! JSONSerialization.data(withJSONObject: envelope)
  FileHandle.standardOutput.write(data)
  exit(1)
}

// ─── AXUIElement traversal (roles, identifiers, names — never coordinates) ─────────────────────

func attribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
  return value
}

func attributeString(_ element: AXUIElement, _ attribute: String) -> String {
  guard let value = attribute(element, attribute) else { return "" }
  return value as? String ?? ""
}

func systemWideElement() -> AXUIElement { AXUIElementCreateSystemWide() }

/// The application element for a pid, as the root every search descends from.
func applicationElement(pid: pid_t) -> AXUIElement { AXUIElementCreateApplication(pid) }

/// Depth-first search by accessibility role, subrole-free identifier and name — the three things a
/// selector set may pin. An empty criterion matches nothing (refusing to search "everything").
func findElement(from root: AXUIElement, role: String, name: String?, identifier: String?) throws -> AXUIElement {
  var stack: [AXUIElement] = [root]
  var visited = 0
  while let element = stack.popLast() {
    visited += 1
    if visited > 50_000 { throw HelperError("accessibility search exceeded the traversal bound") }
    let elementRole = attributeString(element, kAXRoleAttribute as String)
    if elementRole == role {
      if identifier != nil && attributeString(element, kAXIdentifierAttribute as String) != identifier { continue }
      if name != nil && attributeString(element, kAXTitleAttribute as String) != name { continue }
      return element
    }
    guard let children = attribute(element, kAXChildrenAttribute as String) as? [AXUIElement] else { continue }
    stack.append(contentsOf: children.reversed())
  }
  let wanted = [role, name.map { "name=\($0)" }, identifier.map { "id=\($0)" }]
    .compactMap { $0 }
    .joined(separator: " ")
  throw HelperError("no element matched \(wanted)")
}

func describe(_ element: AXUIElement) -> [String: Any] {
  var actions: [String] = []
  if let copied = attribute(element, kAXActionsAttribute as String) as? [String] { actions = copied }
  return [
    "role": attributeString(element, kAXRoleAttribute as String),
    "name": attributeString(element, kAXTitleAttribute as String),
    "identifier": attributeString(element, kAXIdentifierAttribute as String),
    "value": attributeString(element, kAXValueAttribute as String),
    "actions": actions,
  ]
}

// ─── documented keyboard commands (CGEvent posting, no pixel input) ───────────────────────────

let keyCodes: [Character: CGKeyCode] = [
  "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34, "j": 38,
  "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 33, "q": 12, "r": 15, "s": 1, "t": 17,
  "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
]

/// Post a documented key command like "cmd+shift+p" or "enter" to the session, built from the fixed
/// key map above. Unknown tokens are refused — a typo'd command must fail loudly, not post nothing.
func postKeyCommand(_ command: String) throws {
  let tokens = command.lowercased().split(separator: "+").map(String.init)
  var held: [CGKeyCode] = []
  var key: CGKeyCode?
  for token in tokens {
    switch token {
    case "cmd", "command": held.append(0x37)
    case "ctrl", "control": held.append(0x3B)
    case "alt", "option": held.append(0x3A)
    case "shift": held.append(0x38)
    case "enter", "return": key = 0x24
    case "tab": key = 0x30
    case "escape", "esc": key = 0x35
    case "space": key = 0x31
    default:
      // The TOKEN decides here, not the whole command: a "cmd+p" would otherwise take the
      // count==1 branch of the full string, look up the first character of "cmd+p", and post
      // a "c" — silently the wrong key, on the one path that exists to type single keys.
      guard token.count == 1, let code = keyCodes[token[token.startIndex]] else {
        throw HelperError("unsupported key command token: \(token)")
      }
      key = code
    }
  }
  guard let keyCode = key else { throw HelperError("key command \(command) names no key") }
  let source = CGEventSource(stateID: .combinedSessionState)
  for modifier in held {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: modifier, keyDown: true) else {
      throw HelperError("failed to create the modifier-key event")
    }
    event.post(tap: .cghidEventTap)
  }
  guard let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
  else { throw HelperError("failed to create the key event for \(command)") }
  down.post(tap: .cghidEventTap)
  up.post(tap: .cghidEventTap)
  for modifier in held.reversed() {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: modifier, keyDown: false) else {
      throw HelperError("failed to create the modifier-key release event")
    }
    event.post(tap: .cghidEventTap)
  }
}

// ─── the nine contract operations ─────────────────────────────────────────────────────────────

func inspectSession(_ payload: [String: Any]) throws -> Any {
  // The frontmost application IS the session under inspection when no pid is supplied.
  var pid = try payloadInt(payload, "pid")
  if pid <= 0 { pid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1 }
  guard pid > 0 else { throw HelperError("no frontmost application to inspect") }
  let app = applicationElement(pid: pid)
  let focused = attribute(app, kAXFocusedWindowAttribute as String) as? AXUIElement
  return [
    "pid": pid,
    "application": attributeString(app, kAXTitleAttribute as String),
    "focusedWindow": focused.map { attributeString($0, kAXTitleAttribute as String) } ?? "",
    "focusedWindowRole": focused.map { attributeString($0, kAXRoleAttribute as String) } ?? "",
  ]
}

func launchApplication(_ payload: [String: Any]) throws -> Any {
  let command = try payloadString(payload, "command")
  let args = payload["args"] as? [String] ?? []
  let process = Process()
  process.executableURL = URL(fileURLWithPath: command)
  process.arguments = args
  if let cwd = payload["cwd"] as? String { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
  try process.run()
  return ["pid": process.processIdentifier]
}

func findElementOperation(_ payload: [String: Any]) throws -> Any {
  let pid = try payloadInt(payload, "pid")
  let role = try payloadString(payload, "role")
  let element = try findElement(
    from: applicationElement(pid: pid),
    role: role,
    name: payload["name"] as? String,
    identifier: payload["identifier"] as? String
  )
  return describe(element)
}

func invokeElement(_ payload: [String: Any]) throws -> Any {
  let pid = try payloadInt(payload, "pid")
  let role = try payloadString(payload, "role")
  let element = try findElement(
    from: applicationElement(pid: pid),
    role: role,
    name: payload["name"] as? String,
    identifier: payload["identifier"] as? String
  )
  let action = (payload["action"] as? String) ?? kAXPressAction as String
  guard AXUIElementPerformAction(element, action as CFString) == .success else {
    throw HelperError("element \(role) refused the action \(action)")
  }
  return ["invoked": true, "action": action]
}

func setTextOperation(_ payload: [String: Any]) throws -> Any {
  let pid = try payloadInt(payload, "pid")
  let role = try payloadString(payload, "role")
  let text = try payloadString(payload, "text")
  let element = try findElement(
    from: applicationElement(pid: pid),
    role: role,
    name: payload["name"] as? String,
    identifier: payload["identifier"] as? String
  )
  guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef) == .success else {
    throw HelperError("element \(role) refused a value write")
  }
  return ["setText": true]
}

func sendKeysOperation(_ payload: [String: Any]) throws -> Any {
  try postKeyCommand(try payloadString(payload, "keys"))
  return ["sent": true]
}

func waitForStateOperation(_ payload: [String: Any]) throws -> Any {
  let pid = try payloadInt(payload, "pid")
  let role = try payloadString(payload, "role")
  let timeoutMs = payload["timeoutMs"] as? Int ?? 60_000
  let absent = payload["absent"] as? Bool ?? false
  let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
  while Date() < deadline {
    let found = try? findElement(
      from: applicationElement(pid: pid),
      role: role,
      name: payload["name"] as? String,
      identifier: payload["identifier"] as? String
    )
    if absent && found == nil { return ["matched": false] }
    if !absent && found != nil { return ["matched": true] }
    usleep(250_000)
  }
  throw HelperError("state did not settle within \(timeoutMs)ms (role=\(role))")
}

func captureDiagnosticsOperation(_ payload: [String: Any]) throws -> Any {
  let pid = try payloadInt(payload, "pid")
  // A bounded summary of the accessibility tree — evidence for the scenario log, never a full dump
  // that could archive whatever the editor happened to be rendering.
  func summarize(_ element: AXUIElement, depth: Int) -> [[String: Any]] {
    if depth > 6 { return [] }
    guard let children = attribute(element, kAXChildrenAttribute as String) as? [AXUIElement] else { return [] }
    return children.prefix(80).map { child in
      var row = describe(child)
      row["children"] = summarize(child, depth: depth + 1)
      return row
    }
  }
  let app = applicationElement(pid: pid)
  return ["pid": pid, "application": attributeString(app, kAXTitleAttribute as String), "tree": summarize(app, depth: 0)]
}

func terminateApplicationOperation(_ payload: [String: Any]) throws -> Any {
  let pid = try payloadInt(payload, "pid")
  guard kill(pid_t(pid), SIGKILL) == 0 else { throw HelperError("failed to signal pid \(pid)") }
  return ["signalled": pid]
}

// ─── dispatch table (every contract operation must appear here) ───────────────────────────────

let operations: [String: ([String: Any]) throws -> Any] = [
  "inspectSession": inspectSession,
  "launchApplication": launchApplication,
  "findElement": findElementOperation,
  "invokeElement": invokeElement,
  "setText": setTextOperation,
  "sendKeys": sendKeysOperation,
  "waitForState": waitForStateOperation,
  "captureDiagnostics": captureDiagnosticsOperation,
  "terminateApplication": terminateApplicationOperation,
]

// ─── main ─────────────────────────────────────────────────────────────────────────────────────

let arguments = CommandLine.arguments
guard arguments.count >= 2 else { refuse(operation: "-", "usage: mac-helper.swift <operation> <payloadJson>") }
let operation = arguments[1]
guard let handler = operations[operation] else {
  refuse(operation: operation, "unknown operation: \(operation)")
}
var payload: [String: Any] = [:]
if arguments.count > 2, arguments[2] != "-" {
  guard let data = arguments[2].data(using: .utf8),
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { refuse(operation: operation, "payload is not a JSON object") }
  payload = parsed
}
do {
  respond(operation: operation, result: try handler(payload))
} catch let error as HelperError {
  refuse(operation: operation, error.message)
} catch {
  refuse(operation: operation, String(describing: error))
}