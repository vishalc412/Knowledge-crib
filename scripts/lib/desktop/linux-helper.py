#!/usr/bin/env python3
"""Linux desktop-control helper for the native editor certification scenarios.

Implements the nine-operation automation contract over GNOME AT-SPI (pyatspi): controls are
located by ROLE (getRoleName), NAME and DESCRIPTION/ID, and driven through their published action
and editable-text interfaces — never by fixed screen coordinates, which the plan forbids as the
primary control mechanism. Keyboard interaction uses AT-SPI's generateKeyboardEvent with
DOCUMENTED key commands (keycodes, not synthesized pixel input).

Wire protocol (shared with the macOS and Windows helpers): argv is [operation, payloadJson], and
exactly one JSON envelope goes to stdout:
  {"ok": true,  "operation": "<operation>", "result": {...}}
  {"ok": false, "operation": "<operation>", "error": "..."}
"""
import json
import os
import signal
import subprocess
import sys
import time

import pyatspi


class HelperError(Exception):
    pass


def _payload_string(payload, key):
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise HelperError(f"payload is missing the required string field {key}")
    return value


def _payload_int(payload, key):
    value = payload.get(key)
    if not isinstance(value, int):
        raise HelperError(f"payload is missing the integer field {key}")
    return value


def _optional_string(payload, key):
    value = payload.get(key)
    return value if isinstance(value, str) and value else None


# ─── AT-SPI traversal (roles, names — never coordinates) ───────────────────────────────────────


def _application(pid):
    desktop = pyatspi.Registry.getDesktop(0)
    for index in range(desktop.childCount):
        app = desktop.getChildAtIndex(index)
        try:
            if app.get_process_id() == pid:
                return app
        except Exception:
            continue
    raise HelperError(f"no AT-SPI application element found for pid {pid}")


def _matches(element, role, name, identifier):
    try:
        if element.getRoleName() != role:
            return False
        if name is not None and element.name != name:
            return False
        if identifier is not None and element.get_description() != identifier:
            return False
        return True
    except Exception:
        return False


def _find_element(root, role, name, identifier, bound=50000):
    """Depth-first search by role/name/identifier, bounded so a pathological tree cannot hang a
    scenario step. An empty criterion matches nothing — refusing to search "everything"."""
    stack = [root]
    visited = 0
    while stack:
        element = stack.pop()
        visited += 1
        if visited > bound:
            raise HelperError("accessibility search exceeded the traversal bound")
        if _matches(element, role, name, identifier):
            return element
        try:
            stack.extend(reversed([element.getChildAtIndex(i) for i in range(element.childCount)]))
        except Exception:
            continue
    wanted = " ".join(
        part
        for part in [role, f"name={name}" if name else None, f"id={identifier}" if identifier else None]
        if part
    )
    raise HelperError(f"no element matched {wanted}")


def _describe(element):
    actions = []
    try:
        actions = list(element.queryAction())
    except Exception:
        pass
    return {
        "role": element.getRoleName(),
        "name": element.name,
        "description": element.get_description(),
        "childCount": element.childCount,
        "actions": actions,
    }


# ─── the nine contract operations ─────────────────────────────────────────────────────────────


def inspect_session(payload):
    pid = _payload_int(payload, "pid")
    app = _application(pid)
    return {
        "pid": pid,
        "application": app.name,
        "childCount": app.childCount,
    }


def launch_application(payload):
    command = _payload_string(payload, "command")
    args = payload.get("args", [])
    if not isinstance(args, list):
        raise HelperError("payload field args must be a list")
    process = subprocess.Popen(
        [command, *args],
        cwd=payload.get("cwd") if isinstance(payload.get("cwd"), str) else None,
        start_new_session=True,  # own process group, so the interruption can kill the whole tree
    )
    return {"pid": process.pid}


def find_element_operation(payload):
    pid = _payload_int(payload, "pid")
    role = _payload_string(payload, "role")
    return _describe(
        _find_element(_application(pid), role, _optional_string(payload, "name"), _optional_string(payload, "identifier"))
    )


def invoke_element(payload):
    pid = _payload_int(payload, "pid")
    role = _payload_string(payload, "role")
    element = _find_element(
        _application(pid), role, _optional_string(payload, "name"), _optional_string(payload, "identifier")
    )
    try:
        action = element.queryAction()
    except Exception:
        action = None
    if action is None or action.nActions == 0:
        raise HelperError(f"element {role} exposes no action to invoke")
    wanted = payload.get("action")
    for index in range(action.nActions):
        if wanted is None or action.getName(index) == wanted:
            action.doAction(index)
            return {"invoked": True, "action": action.getName(index)}
    raise HelperError(f"element {role} exposes no action named {wanted}")


def set_text_operation(payload):
    pid = _payload_int(payload, "pid")
    role = _payload_string(payload, "role")
    text = _payload_string(payload, "text")
    element = _find_element(
        _application(pid), role, _optional_string(payload, "name"), _optional_string(payload, "identifier")
    )
    try:
        editable = element.queryEditableText()
    except Exception:
        raise HelperError(f"element {role} is not an editable-text control")
    if not editable.setTextContents(text):
        raise HelperError(f"element {role} refused a value write")
    return {"setText": True}


# Documented keycode map for sendKeys: lowercase letters use their ASCII code, plus the special
# keys a scenario legitimately needs. Anything outside the map is refused — a typo'd command must
# fail loudly, not silently post nothing.
_SPECIAL_KEYS = {
    "enter": 65293,
    "tab": 65289,
    "escape": 65307,
    "space": 32,
    "up": 65362,
    "down": 65364,
    "left": 65361,
    "right": 65363,
}


def send_keys_operation(payload):
    keys = _payload_string(payload, "keys")
    if len(keys) == 1:
        keycode = ord(keys.lower())
    elif keys.lower() in _SPECIAL_KEYS:
        keycode = _SPECIAL_KEYS[keys.lower()]
    else:
        raise HelperError(f"unsupported key command: {keys}")
    pyatspi.Registry.generateKeyboardEvent(keycode, None, pyatspi.KEY_SYNCHRONOUS)
    return {"sent": True}


def wait_for_state_operation(payload):
    pid = _payload_int(payload, "pid")
    role = _payload_string(payload, "role")
    timeout_ms = payload.get("timeoutMs", 60_000)
    absent = bool(payload.get("absent"))
    deadline = time.monotonic() + timeout_ms / 1000.0
    while time.monotonic() < deadline:
        try:
            _find_element(_application(pid), role, _optional_string(payload, "name"), _optional_string(payload, "identifier"))
            if not absent:
                return {"matched": True}
        except HelperError:
            if absent:
                return {"matched": False}
        time.sleep(0.25)
    raise HelperError(f"state did not settle within {timeout_ms}ms (role={role})")


def capture_diagnostics_operation(payload):
    pid = _payload_int(payload, "pid")

    def summarize(element, depth):
        if depth > 6:
            return []
        rows = []
        try:
            children = [element.getChildAtIndex(i) for i in range(min(element.childCount, 80))]
        except Exception:
            return rows
        for child in children:
            row = _describe(child)
            row["children"] = summarize(child, depth + 1)
            rows.append(row)
        return rows

    app = _application(pid)
    return {"pid": pid, "application": app.name, "tree": summarize(app, 0)}


def terminate_application_operation(payload):
    pid = _payload_int(payload, "pid")
    # The editor runs in its own session (start_new_session=True), so killing the process GROUP is
    # what takes its whole tree down — the interruption the harness confirms afterwards.
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except ProcessLookupError:
        raise HelperError(f"no process group found for pid {pid}")
    return {"signalled": pid}


# ─── dispatch table (every contract operation must appear here) ────────────────────────────────

OPERATIONS = {
    "inspectSession": inspect_session,
    "launchApplication": launch_application,
    "findElement": find_element_operation,
    "invokeElement": invoke_element,
    "setText": set_text_operation,
    "sendKeys": send_keys_operation,
    "waitForState": wait_for_state_operation,
    "captureDiagnostics": capture_diagnostics_operation,
    "terminateApplication": terminate_application_operation,
}


def main(argv):
    operation = argv[1] if len(argv) > 1 else "-"
    try:
        if len(argv) < 2:
            raise HelperError("usage: linux-helper.py <operation> <payloadJson>")
        handler = OPERATIONS.get(operation)
        if handler is None:
            raise HelperError(f"unknown operation: {operation}")
        payload = json.loads(argv[2]) if len(argv) > 2 and argv[2] != "-" else {}
        if not isinstance(payload, dict):
            raise HelperError("payload is not a JSON object")
        print(json.dumps({"ok": True, "operation": operation, "result": handler(payload)}))
        return 0
    except HelperError as error:
        print(json.dumps({"ok": False, "operation": operation, "error": str(error)}))
        return 1
    except Exception as error:  # noqa: BLE001 — the envelope must carry any failure by name
        print(json.dumps({"ok": False, "operation": operation, "error": f"{type(error).__name__}: {error}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))