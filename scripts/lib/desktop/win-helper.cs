// Windows desktop-control helper for the native editor certification scenarios.
//
// Implements the nine-operation automation contract over Microsoft UI Automation: controls are
// located by ControlType/LocalizedControlType (role), AutomationId (identifier) and Name, and
// driven through their published patterns (Invoke, Value, Toggle) — never by fixed screen
// coordinates, which the plan forbids as the primary control mechanism. Keyboard interaction uses
// SendKeys with DOCUMENTED key commands (e.g. "^+p" for ctrl+shift+p).
//
// Wire protocol (shared with the macOS and Linux helpers): argv is [operation, payloadJson], and
// exactly one JSON envelope goes to stdout:
//   {"ok": true,  "operation": "<operation>", "result": {...}}
//   {"ok": false, "operation": "<operation>", "error": "..."}
//
// The source is written as C# 5 for the .NET Framework compiler every Windows install already
// carries (C:\Windows\Microsoft.NET\...\v4.0.30319\csc.exe): no string interpolation, no nullable
// annotations, no ArgumentList, no Kill(entireProcessTree) — none of those exist under that
// toolchain. scripts/desktop-backends.mjs compiles it locally at resolve time, referencing
// UIAutomationClient/UIAutomationTypes/System.Windows.Forms/System.Web.Extensions from the
// framework directory, and caches the exe beside the source digest.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

internal static class WinHelper
{
    private sealed class HelperError : Exception
    {
        public HelperError(string message) : base(message) { }
    }

    // ─── payload plumbing ────────────────────────────────────────────────────────────────────

    private static string PayloadString(Dictionary<string, object> payload, string key)
    {
        object value;
        if (payload != null && payload.TryGetValue(key, out value) && value is string &&
            !string.IsNullOrEmpty((string)value))
        {
            return (string)value;
        }
        throw new HelperError("payload is missing the required string field " + key);
    }

    private static int PayloadInt(Dictionary<string, object> payload, string key)
    {
        object value;
        if (payload != null && payload.TryGetValue(key, out value))
        {
            // JavaScriptSerializer hands JSON numbers back as the narrowest of int/long/double it
            // can parse them into, so accept all three rather than assume one.
            if (value is int) return (int)value;
            if (value is long) return (int)(long)value;
            if (value is double) return (int)(double)value;
        }
        throw new HelperError("payload is missing the integer field " + key);
    }

    private static string PayloadOptionalString(Dictionary<string, object> payload, string key)
    {
        object value;
        if (payload != null && payload.TryGetValue(key, out value) && value is string)
        {
            return (string)value;
        }
        return null;
    }

    // ─── process launch (quoted argv — ProcessStartInfo has no ArgumentList under the Framework) ──

    /// The reverse of CommandLineToArgvW: every element of the argv the scenario hands over is
    /// re-encoded into the single Windows command line with its spaces, tabs and trailing
    /// backslashes intact, so an argument can never be split or truncated by the shell parsing.
    private static string QuoteArgument(string argument)
    {
        if (argument == null) return "\"\"";
        if (argument.Length > 0 && argument.IndexOf(' ') < 0 && argument.IndexOf('\t') < 0 &&
            argument.IndexOf('"') < 0)
        {
            return argument;
        }
        StringBuilder builder = new StringBuilder();
        builder.Append('"');
        int backslashes = 0;
        foreach (char c in argument)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            if (c == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }
            builder.Append('\\', backslashes);
            backslashes = 0;
            builder.Append(c);
        }
        builder.Append('\\', backslashes * 2);
        builder.Append('"');
        return builder.ToString();
    }

    // ─── UIA search (role, identifier, name — never coordinates) ──────────────────────────────

    /// The editor process's UIA root, the ancestor every search descends from.
    private static AutomationElement ProcessRoot(int pid)
    {
        AutomationElement root = AutomationElement.RootElement;
        PropertyCondition condition =
            new PropertyCondition(AutomationElement.ProcessIdProperty, pid);
        AutomationElement element = root.FindFirst(TreeScope.Children, condition);
        if (element == null)
        {
            throw new HelperError("no UIA element found for pid " + pid);
        }
        return element;
    }

    private static AndCondition Match(string role, string name, string identifier)
    {
        List<PropertyCondition> conditions = new List<PropertyCondition>();
        // LocalizedControlType is the role vocabulary selector sets pin ("text area", "button").
        conditions.Add(new PropertyCondition(AutomationElement.LocalizedControlTypeProperty, role));
        if (name != null) conditions.Add(new PropertyCondition(AutomationElement.NameProperty, name));
        if (identifier != null)
        {
            conditions.Add(new PropertyCondition(AutomationElement.AutomationIdProperty, identifier));
        }
        return new AndCondition(conditions.ToArray());
    }

    private static AutomationElement FindElement(int pid, string role, string name, string identifier)
    {
        AutomationElement element =
            ProcessRoot(pid).FindFirst(TreeScope.Descendants, Match(role, name, identifier));
        if (element == null)
        {
            string description = "no element matched " + role;
            if (name != null) description += " name=" + name;
            if (identifier != null) description += " id=" + identifier;
            throw new HelperError(description);
        }
        return element;
    }

    private static string PatternText(object pattern)
    {
        return pattern == null ? null : "supported";
    }

    private static Dictionary<string, object> Describe(AutomationElement element)
    {
        string invoke = null;
        string value = null;
        string toggle = null;
        try { invoke = PatternText(element.GetCurrentPattern(InvokePattern.Pattern)); }
        catch { }
        try { value = PatternText(element.GetCurrentPattern(ValuePattern.Pattern)); }
        catch { }
        try { toggle = PatternText(element.GetCurrentPattern(TogglePattern.Pattern)); }
        catch { }
        Dictionary<string, object> row = new Dictionary<string, object>();
        row["role"] = element.Current.LocalizedControlType;
        row["name"] = element.Current.Name;
        row["identifier"] = element.Current.AutomationId;
        row["invokePattern"] = invoke;
        row["valuePattern"] = value;
        row["togglePattern"] = toggle;
        return row;
    }

    // ─── the nine contract operations ────────────────────────────────────────────────────────

    private static object InspectSession(Dictionary<string, object> payload)
    {
        int pid = PayloadInt(payload, "pid");
        AutomationElement root = ProcessRoot(pid);
        AutomationElement focusable = root.FindFirst(
            TreeScope.Descendants,
            new PropertyCondition(AutomationElement.IsKeyboardFocusableProperty, true));
        string focusedWindow = focusable == null ? "" : focusable.Current.Name;
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["pid"] = pid;
        result["application"] = root.Current.Name;
        result["focusedWindow"] = focusedWindow;
        return result;
    }

    private static object LaunchApplication(Dictionary<string, object> payload)
    {
        string command = PayloadString(payload, "command");
        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = command;
        startInfo.UseShellExecute = false;
        object argsValue;
        if (payload.TryGetValue("args", out argsValue) && argsValue is object[])
        {
            List<string> parts = new List<string>();
            foreach (object arg in (object[])argsValue)
            {
                parts.Add(QuoteArgument(Convert.ToString(arg)));
            }
            startInfo.Arguments = string.Join(" ", parts.ToArray());
        }
        string cwd = PayloadOptionalString(payload, "cwd");
        if (cwd != null) startInfo.WorkingDirectory = cwd;
        Process process = Process.Start(startInfo);
        if (process == null)
        {
            throw new HelperError("failed to start " + command);
        }
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["pid"] = process.Id;
        return result;
    }

    private static object FindElementOperation(Dictionary<string, object> payload)
    {
        int pid = PayloadInt(payload, "pid");
        string role = PayloadString(payload, "role");
        return Describe(
            FindElement(pid, role, PayloadOptionalString(payload, "name"),
                PayloadOptionalString(payload, "identifier")));
    }

    private static object InvokeElement(Dictionary<string, object> payload)
    {
        int pid = PayloadInt(payload, "pid");
        string role = PayloadString(payload, "role");
        AutomationElement element = FindElement(
            pid, role, PayloadOptionalString(payload, "name"),
            PayloadOptionalString(payload, "identifier"));
        object pattern = element.GetCurrentPattern(TogglePattern.Pattern);
        TogglePattern toggle = pattern as TogglePattern;
        if (toggle != null)
        {
            toggle.Toggle();
            Dictionary<string, object> toggled = new Dictionary<string, object>();
            toggled["invoked"] = true;
            toggled["pattern"] = "toggle";
            return toggled;
        }
        pattern = element.GetCurrentPattern(InvokePattern.Pattern);
        InvokePattern invoke = pattern as InvokePattern;
        if (invoke != null)
        {
            invoke.Invoke();
            Dictionary<string, object> invoked = new Dictionary<string, object>();
            invoked["invoked"] = true;
            invoked["pattern"] = "invoke";
            return invoked;
        }
        throw new HelperError("element " + role + " exposes neither an invoke nor a toggle pattern");
    }

    private static object SetTextOperation(Dictionary<string, object> payload)
    {
        int pid = PayloadInt(payload, "pid");
        string role = PayloadString(payload, "role");
        string text = PayloadString(payload, "text");
        AutomationElement element = FindElement(
            pid, role, PayloadOptionalString(payload, "name"),
            PayloadOptionalString(payload, "identifier"));
        object pattern = element.GetCurrentPattern(ValuePattern.Pattern);
        ValuePattern value = pattern as ValuePattern;
        if (value != null)
        {
            value.SetValue(text);
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["setText"] = true;
            return result;
        }
        throw new HelperError("element " + role + " exposes no value pattern to write text into");
    }

    private static object SendKeysOperation(Dictionary<string, object> payload)
    {
        // SendKeys takes DOCUMENTED key commands ("^+p" = ctrl+shift+p, "{ENTER}"); anything a
        // selector set sends must be spelled out, never synthesized from screen positions.
        SendKeys.SendWait(PayloadString(payload, "keys"));
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["sent"] = true;
        return result;
    }

    private static object WaitForStateOperation(Dictionary<string, object> payload)
    {
        int pid = PayloadInt(payload, "pid");
        string role = PayloadString(payload, "role");
        int timeoutMs = 60000;
        object timeoutValue;
        if (payload.TryGetValue("timeoutMs", out timeoutValue))
        {
            // JavaScriptSerializer numbers: accept int/long/double rather than assume one.
            if (timeoutValue is int) timeoutMs = (int)timeoutValue;
            else if (timeoutValue is long) timeoutMs = (int)(long)timeoutValue;
            else if (timeoutValue is double) timeoutMs = (int)(double)timeoutValue;
        }
        object absentValue;
        bool absent = false;
        if (payload.TryGetValue("absent", out absentValue) && absentValue is bool)
        {
            absent = (bool)absentValue;
        }
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            AutomationElement found = ProcessRoot(pid).FindFirst(
                TreeScope.Descendants,
                Match(role, PayloadOptionalString(payload, "name"),
                    PayloadOptionalString(payload, "identifier")));
            Dictionary<string, object> result = new Dictionary<string, object>();
            if (absent && found == null)
            {
                result["matched"] = false;
                return result;
            }
            if (!absent && found != null)
            {
                result["matched"] = true;
                return result;
            }
            Thread.Sleep(250);
        }
        throw new HelperError("state did not settle within " + timeoutMs + "ms (role=" + role + ")");
    }

    // A bounded summary of the UIA tree — evidence for the scenario log, never a full dump that
    // could archive whatever the editor happened to be rendering.
    private static object Summarize(AutomationElement element, int depth)
    {
        List<object> rows = new List<object>();
        if (depth > 6) return rows;
        foreach (AutomationElement child in
            element.FindAll(TreeScope.Children, Condition.TrueCondition).Cast<AutomationElement>().Take(80))
        {
            Dictionary<string, object> row = Describe(child);
            row["children"] = Summarize(child, depth + 1);
            rows.Add(row);
        }
        return rows;
    }

    private static object CaptureDiagnosticsOperation(Dictionary<string, object> payload)
    {
        int pid = PayloadInt(payload, "pid");
        AutomationElement root = ProcessRoot(pid);
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["pid"] = pid;
        result["application"] = root.Current.Name;
        result["tree"] = Summarize(root, 0);
        return result;
    }

    private static object TerminateApplicationOperation(Dictionary<string, object> payload)
    {
        int pid = PayloadInt(payload, "pid");
        // Kill exactly the target the scenario names, WITH its descendants — the same tree-scoped
        // interruption the harness confirms termination on afterwards. Kill(entireProcessTree) is a
        // .NET Core API, so the tree scope comes from the OS's own taskkill /T instead.
        Process killer = Process.Start(new ProcessStartInfo
        {
            FileName = "taskkill",
            Arguments = "/PID " + pid + " /T /F",
            UseShellExecute = false,
            CreateNoWindow = true,
        });
        if (killer == null)
        {
            throw new HelperError("failed to start taskkill for pid " + pid);
        }
        if (!killer.WaitForExit(10000))
        {
            throw new HelperError("taskkill for pid " + pid + " did not exit within 10s");
        }
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["signalled"] = pid;
        return result;
    }

    // ─── dispatch table (every contract operation must appear here) ───────────────────────────

    private static readonly Dictionary<string, Func<Dictionary<string, object>, object>> Operations =
        new Dictionary<string, Func<Dictionary<string, object>, object>>
        {
            { "inspectSession", InspectSession },
            { "launchApplication", LaunchApplication },
            { "findElement", FindElementOperation },
            { "invokeElement", InvokeElement },
            { "setText", SetTextOperation },
            { "sendKeys", SendKeysOperation },
            { "waitForState", WaitForStateOperation },
            { "captureDiagnostics", CaptureDiagnosticsOperation },
            { "terminateApplication", TerminateApplicationOperation },
        };

    // ─── main ────────────────────────────────────────────────────────────────────────────────

    private static Dictionary<string, object> ParsePayload(string json)
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        Dictionary<string, object> payload =
            serializer.Deserialize<Dictionary<string, object>>(string.IsNullOrEmpty(json) ? "{}" : json);
        if (payload == null)
        {
            throw new HelperError("payload is not a JSON object");
        }
        return payload;
    }

    private static string Emit(Dictionary<string, object> envelope)
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        serializer.MaxJsonLength = int.MaxValue;
        return serializer.Serialize(envelope);
    }

    [STAThread]
    private static int Main(string[] args)
    {
        string operation = args.Length > 0 ? args[0] : "-";
        try
        {
            if (args.Length < 1)
            {
                throw new HelperError("usage: win-helper <operation> <payloadJson>");
            }
            Func<Dictionary<string, object>, object> handler;
            if (!Operations.TryGetValue(operation, out handler))
            {
                throw new HelperError("unknown operation: " + operation);
            }
            Dictionary<string, object> payload = ParsePayload(args.Length > 1 ? args[1] : "{}");
            Dictionary<string, object> success = new Dictionary<string, object>();
            success["ok"] = true;
            success["operation"] = operation;
            success["result"] = handler(payload);
            Console.WriteLine(Emit(success));
            return 0;
        }
        catch (Exception error)
        {
            Dictionary<string, object> failure = new Dictionary<string, object>();
            failure["ok"] = false;
            failure["operation"] = operation;
            failure["error"] = error.Message;
            Console.WriteLine(Emit(failure));
            return 1;
        }
    }
}