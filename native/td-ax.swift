// td-ax.swift — AX tree → scene-graph element JSON.
//
// Usage: td-ax [--app PID|name] [--enhance] [--max-depth N] [--max-elements N] [--json-only]
// stdout: {"meta":{...},"elements":[{id,role,label,x,y,w,h,interactable,value,focused,expanded,selected,ancestors:[{role,label}],region}]}
//
// The scene-graph contract (command-service scene.graph.cjs consumes this):
//   ancestors = nearest-first container chain {role,label}
//   state     = focused/expanded/selected booleans
//   value     = AXValue of text fields — enables type readback without DOM
//   url       = AXURL of AXWebArea/document — browser domain anchor
//
// --enhance sets AXEnhancedUserInterface + AXManualAccessibility so
// Chromium/Electron publish their real DOM via the same AX interface —
// browser and native take ONE code path.
//
// Build: swiftc -O td-ax.swift -o td-ax -framework ApplicationServices -framework AppKit

import AppKit
import ApplicationServices
import Foundation

// ── Args ────────────────────────────────────────────────────────────────────
var maxDepth = 15
var maxElements = 500
var jsonOnly = false
var enhance = false
var targetPID: pid_t? = nil
var targetName: String? = nil

var i = 1
while i < CommandLine.arguments.count {
    switch CommandLine.arguments[i] {
    case "--app":
        i += 1
        if i < CommandLine.arguments.count {
            let a = CommandLine.arguments[i]
            if let p = pid_t(a) { targetPID = p } else { targetName = a }
        }
    case "--max-depth":    i += 1; maxDepth = Int(CommandLine.arguments[i]) ?? maxDepth
    case "--max-elements": i += 1; maxElements = Int(CommandLine.arguments[i]) ?? maxElements
    case "--json-only":    jsonOnly = true
    case "--enhance":      enhance = true
    default: break
    }
    i += 1
}

func log(_ s: String) { if !jsonOnly { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) } }

// ── Permission ──────────────────────────────────────────────────────────────
let trusted = AXIsProcessTrustedWithOptions(
    [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
if !trusted {
    FileHandle.standardError.write("{\"error\":\"accessibility-not-granted\"}\n".data(using: .utf8)!)
    exit(2)
}

// ── Resolve target app ──────────────────────────────────────────────────────
let pid: pid_t
if let p = targetPID {
    pid = p
} else if let name = targetName {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: name).first
        ?? NSWorkspace.shared.runningApplications.first(where: {
            $0.localizedName?.localizedCaseInsensitiveContains(name) == true
        }) else {
        FileHandle.standardError.write("{\"error\":\"app-not-found\",\"query\":\"\(name)\"}\n".data(using: .utf8)!)
        exit(3)
    }
    pid = app.processIdentifier
} else {
    guard let front = NSWorkspace.shared.frontmostApplication else {
        FileHandle.standardError.write("{\"error\":\"no-frontmost-app\"}\n".data(using: .utf8)!)
        exit(3)
    }
    pid = front.processIdentifier
}

// ── Batched attribute read ──────────────────────────────────────────────────
let attrNames = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
    kAXValueAttribute, kAXRoleDescriptionAttribute, kAXPositionAttribute, kAXSizeAttribute,
    kAXEnabledAttribute, kAXChildrenAttribute,
    kAXExpandedAttribute, kAXSelectedAttribute, kAXFocusedAttribute,
    "AXURL", "AXPlaceholderValue", "AXKeyShortcuts",
] as CFArray

func readAttrs(_ el: AXUIElement) -> [String: AnyObject]? {
    var values: CFArray?
    let err = AXUIElementCopyMultipleAttributeValues(el, attrNames, [], &values)
    guard err == .success, let arr = values as? [AnyObject] else { return nil }
    var out: [String: AnyObject] = [:]
    for (idx, name) in (attrNames as! [String]).enumerated() {
        let v = arr[idx]
        if v is NSNull { continue }
        out[name] = v
    }
    return out
}

func str(_ attrs: [String: AnyObject], _ k: String) -> String {
    (attrs[k] as? String) ?? ""
}
func flag(_ attrs: [String: AnyObject], _ k: String) -> Bool {
    (attrs[k] as? NSNumber)?.boolValue ?? false
}

func cgPoint(_ v: AnyObject?) -> CGPoint? {
    guard let v else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func cgSize(_ v: AnyObject?) -> CGSize? {
    guard let v else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

// Roles we treat as interactable
let interactRoles: Set<String> = [
    "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXComboBox", "AXMenuButton", "AXLink", "AXSlider",
    "AXTab", "AXSwitch", "AXIncrementor", "AXSearchField", "AXMenuItem",
    "AXCell", "AXRow", "AXStaticText", "AXImage", "AXGroup", "AXToolbar",
    "AXMenuBarItem", "AXDisclosureTriangle",
]
let containerRoles: Set<String> = [
    "AXScrollArea", "AXSplitGroup", "AXTabGroup", "AXList", "AXOutline",
    "AXTable", "AXBrowser", "AXGroup", "AXSection", "AXLayoutArea", "AXWebArea",
    "AXMenu", "AXDialog", "AXSheet", "AXDrawer", "AXPopover",
]
let skipRoles: Set<String> = [
    "AXUnknown", "AXLayoutItem", "AXHeading", "AXColorWell",
]

// Landmark-ish roles → region labels for the flat element contract.
func regionFor(role: String, y: Double, screenH: Double) -> String {
    switch role {
    case "AXMenuBar", "AXToolbar": return "header"
    case "AXMenu", "AXDialog", "AXSheet", "AXPopover", "AXDrawer": return "dialog"
    case "AXWebArea", "AXScrollArea", "AXTable", "AXList", "AXOutline",
         "AXLayoutArea", "AXGroup", "AXSplitGroup", "AXTabGroup": return "main"
    default:
        return y < screenH * 0.12 ? "header"
             : y > screenH * 0.88 ? "footer"
             : "main"
    }
}

// ── Walk ────────────────────────────────────────────────────────────────────
struct Anc { let role: String; let label: String }

struct El {
    let id: Int
    let role: String
    let label: String
    let x, y, w, h: Double
    let interactable: Bool
    let value: String
    let focused: Bool
    let expanded: Bool
    let selected: Bool
    let keys: String
    let ancestors: [Anc]
    let region: String
    let url: String
    let win: Int
}

var elements: [El] = []
var visited = 0
var webAreaRetried = false
var pageURL = ""
var timeoutAt = Date().addingTimeInterval(10)

func isTimedOut() -> Bool { Date() > timeoutAt }

func labelFor(_ attrs: [String: AnyObject]) -> String {
    let title = str(attrs, kAXTitleAttribute)
    let desc = str(attrs, kAXDescriptionAttribute)
    let roleDesc = str(attrs, kAXRoleDescriptionAttribute)
    let value = str(attrs, kAXValueAttribute)
    let ph = str(attrs, "AXPlaceholderValue")
    if !title.isEmpty { return title }
    if !ph.isEmpty { return ph }
    if !value.isEmpty { return String(value.prefix(120)) }
    if !desc.isEmpty { return desc }
    return roleDesc
}

func walk(_ el: AXUIElement, _ depth: Int, _ chain: [Anc]) {
    guard depth <= maxDepth, elements.count < maxElements, !isTimedOut() else { return }
    visited += 1
    guard let attrs = readAttrs(el) else { return }

    let role = str(attrs, kAXRoleAttribute)

    // Chromium/Electron: web areas publish DOM only when enhanced UI is on —
    // set it on the element itself, not just the app root, then re-read
    // children (the batch we already have may predate the flip).
    if enhance && (role == "AXWebArea" || role == "AXScrollArea" || role == "AXGroup") {
        AXUIElementSetAttributeValue(el, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        var kids2 = readAttrs(el)?[kAXChildrenAttribute] as? [AXUIElement]
        if (kids2 ?? []).isEmpty && role == "AXWebArea" && !webAreaRetried {
            // The batch predates the flag flip — the renderer publishes
            // asynchronously. Give it a beat and re-read ONCE, and only
            // for web areas: sleeping per empty group burns the whole
            // walk budget (observed: 10s timeout at 25 elements).
            webAreaRetried = true
            usleep(500_000)
            kids2 = readAttrs(el)?[kAXChildrenAttribute] as? [AXUIElement]
        }
        if let kids2, !kids2.isEmpty {
            var chain2 = chain
            let lbl = labelFor(attrs)
            if containerRoles.contains(role) && (!lbl.isEmpty || role == "AXWebArea") {
                chain2.insert(Anc(role: role, label: lbl.isEmpty ? "webarea" : lbl), at: 0)
            }
            for k in kids2 {
                walk(k, depth + 1, chain2)
                if elements.count >= maxElements || isTimedOut() { return }
            }
            return
        }
    }

    // Browser domain anchor — the web area carries the document URL.
    if pageURL.isEmpty, let u = attrs["AXURL"] as? String, u.hasPrefix("http") {
        pageURL = u
    }

    var chain2 = chain
    if !skipRoles.contains(role) {
        let label = labelFor(attrs)
        let pos = cgPoint(attrs[kAXPositionAttribute])
        let size = cgSize(attrs[kAXSizeAttribute])
        let onScreen = pos != nil && size != nil && size!.width > 0 && size!.height > 0
        let roleDesc = str(attrs, kAXRoleDescriptionAttribute)
        let interactable = interactRoles.contains(role) ||
            roleDesc.localizedCaseInsensitiveContains("button") ||
            roleDesc.localizedCaseInsensitiveContains("link") ||
            roleDesc.localizedCaseInsensitiveContains("field")

        if onScreen && (!label.isEmpty || (interactable && !containerRoles.contains(role))) {
            let screenH = NSScreen.main?.frame.height ?? 900
            elements.append(El(
                id: elements.count, role: role,
                label: label,
                x: pos!.x, y: pos!.y, w: size!.width, h: size!.height,
                interactable: interactable,
                value: str(attrs, kAXValueAttribute),
                focused: flag(attrs, kAXFocusedAttribute),
                expanded: flag(attrs, kAXExpandedAttribute),
                selected: flag(attrs, kAXSelectedAttribute),
                keys: str(attrs, "AXKeyShortcuts"),
                ancestors: chain,
                region: chain.first.map { regionFor(role: $0.role, y: pos!.y, screenH: screenH) }
                        ?? regionFor(role: role, y: pos!.y, screenH: screenH),
                url: "", win: currentWin))
        }

        // This node becomes an ancestor for its children when it's a labeled
        // container — the scene tree's "menu 'Add to playlist' ├ searchbox".
        // AXWebArea enters the chain even unlabeled: it's the boundary that
        // separates web content from browser chrome (tabs, omnibox, toolbar).
        if containerRoles.contains(role) && (!label.isEmpty || role == "AXWebArea") {
            chain2.insert(Anc(role: role, label: label.isEmpty ? "webarea" : label), at: 0)
            if chain2.count > 6 { chain2.removeLast() }
        }
    }

    if let kids = attrs[kAXChildrenAttribute] as? [AXUIElement] {
        for k in kids {
            walk(k, depth + 1, chain2)
            if elements.count >= maxElements || isTimedOut() { return }
        }
    }
}

// ── Main ────────────────────────────────────────────────────────────────────
let t0 = Date()
let app = AXUIElementCreateApplication(pid)

// Electron/Chromium fix: telling the app we want the enhanced UI makes its
// renderer publish the real DOM tree instead of a shallow shell.
if enhance {
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    // Chromium needs a beat to publish the tree after the flag flips
    usleep(300_000)
}

// Prefer walking windows rather than the whole app (skips menus etc.)
var currentWin = -1
var winCount = 0
var focusedWinIdx = -1
var fwRef: CFTypeRef?
AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &fwRef)
var windowsRef: CFTypeRef?
let werr = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRef)
if werr == .success, let wins = windowsRef as? [AXUIElement], !wins.isEmpty {
    winCount = wins.count
    for (wi, w) in wins.enumerated() {
        if let fw = fwRef, CFEqual(fw as! AXUIElement, w) { focusedWinIdx = wi }
        currentWin = wi
        walk(w, 0, [])
    }
} else {
    walk(app, 0, [])
}
currentWin = -1
let elapsed = Date().timeIntervalSince(t0)

let labeled = elements.filter { !$0.label.isEmpty }.count
let inter = elements.filter { $0.interactable }.count

let appName = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "?"
var meta: [String: Any] = [
    "app": appName, "pid": pid,
    "visited_nodes": visited, "elements": elements.count,
    "interactable": inter, "labeled": labeled,
    "label_pct": elements.isEmpty ? 0 : Int(100 * labeled / elements.count),
    "walk_ms": Int(elapsed * 1000),
    "timed_out": isTimedOut(), "hit_cap": elements.count >= maxElements,
]
if !pageURL.isEmpty { meta["url"] = pageURL }
if focusedWinIdx >= 0 { meta["focused_window"] = focusedWinIdx }
meta["windows"] = winCount

// Emit
let elArr: [[String: Any]] = elements.map { e in
    var d: [String: Any] = ["id": e.id, "role": e.role, "label": e.label,
     "x": e.x, "y": e.y, "w": e.w, "h": e.h, "interactable": e.interactable,
     "region": e.region, "win": e.win]
    if !e.value.isEmpty { d["value"] = e.value }
    if e.focused { d["focused"] = true }
    if e.expanded { d["expanded"] = true }
    if e.selected { d["selected"] = true }
    if !e.keys.isEmpty { d["keys"] = e.keys }
    if !e.ancestors.isEmpty {
        d["ancestors"] = e.ancestors.map { ["role": $0.role, "label": $0.label] }
    }
    return d
}
let root: [String: Any] = ["meta": meta, "elements": elArr]
if let d = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted]),
   let s = String(data: d, encoding: .utf8) {
    print(s)
}
_ = meta
