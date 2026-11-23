// td-ui-parse.swift — persistent screen-parse + act daemon for ThinkDrop.
//
// Reads JSON-lines commands on stdin, writes one JSON object per line to
// stdout. Logs/progress on stderr as {"event":...} lines.
//
// Commands:
//   {"cmd":"parse","display":0,"mode":"fast|full","caption":false,"annotate":path}
//   {"cmd":"click","x":1067,"y":230,"button":"left|right","double":false}
//   {"cmd":"type","text":"..."}
//   {"cmd":"key","key":"return|tab|escape|...","mods":["cmd","shift",...]}
//   {"cmd":"scroll","x":960,"y":540,"dx":0,"dy":-300}
//   {"cmd":"focus","bundle":"com.google.Chrome"|"app":"Chrome"}
//   {"cmd":"menubar"} → frontmost app's AX menubar items with key equivalents
//   {"cmd":"ping"} → {"ok":true,"models":{...}}
//   {"cmd":"quit"}
//
// Pipeline (parse): SCK capture → CoreML YOLO detect → Vision OCR (.fast) →
// merge OCR into icon boxes → unmatched OCR boxes become type:"text" elements
// → filter/dedupe → elements JSON.
//
// Build: swiftc -O td-ui-parse.swift -o bin/td-ui-parse \
//          -framework ScreenCaptureKit -framework Vision -framework CoreML
//        wrap in .app for its own TCC identity (see build.sh)

import Foundation
import AppKit
import ScreenCaptureKit
import CoreML
import Vision

// ── Config via env / args ───────────────────────────────────────────────────
let MODEL_PATH = ProcessInfo.processInfo.environment["TD_UI_MODEL"]
    ?? FileManager.default.currentDirectoryPath + "/models/icon_detect_v8.mlpackage"
let CONF_FLOOR: Double = 0.15
let NMS_IOU: Double = 0.45
let MIN_BOX_PX: Double = 5
let OCR_TEXT_MIN_CONF: Float = 0.4

func log(_ event: String, _ msg: String = "") {
    var d: [String: Any] = ["event": event]
    if !msg.isEmpty { d["msg"] = msg }
    if let data = try? JSONSerialization.data(withJSONObject: d),
       let s = String(data: data, encoding: .utf8) {
        FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
    }
}

func out(_ d: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: d),
       let s = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
    }
}

// ── Model load ──────────────────────────────────────────────────────────────
var model: MLModel? = nil
var modelSide = 1280
func loadModel() -> Bool {
    guard FileManager.default.fileExists(atPath: MODEL_PATH) else {
        log("model-missing", MODEL_PATH); return false
    }
    do {
        let compiled = try MLModel.compileModel(at: URL(fileURLWithPath: MODEL_PATH))
        let cfg = MLModelConfiguration(); cfg.computeUnits = .all
        model = try MLModel(contentsOf: compiled, configuration: cfg)
        if let c = model?.modelDescription.inputDescriptionsByName["image"]?.imageConstraint {
            modelSide = c.pixelsWide
        }
        log("model-loaded", "side=\(modelSide)")
        return true
    } catch {
        log("model-error", error.localizedDescription); return false
    }
}

// ── Screen capture ──────────────────────────────────────────────────────────
// ThinkDrop's own windows (UnifiedOverlay, GhostLayer, avatar, pills) must
// never reach automation captures — their text/borders/pills would taint OCR
// and screenshots with our own chrome. Matched by owning app: the packaged
// bundle id contains "thinkdrop"; dev runs are the raw Electron binary.
func thinkDropWindows(_ content: SCShareableContent) -> [SCWindow] {
    content.windows.filter { w in
        guard let app = w.owningApplication else { return false }
        let bid = app.bundleIdentifier.lowercased()
        let name = app.applicationName.lowercased()
        return bid.contains("thinkdrop") || bid == "com.github.electron"
            || name == "electron" || name.contains("thinkdrop")
    }
}

func captureDisplay(_ index: Int, cursor: Bool = true) async throws -> (CGImage, SCDisplay) {
    if #available(macOS 14.0, *) {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard !content.displays.isEmpty else { throw NSError(domain: "td", code: 2, userInfo: [NSLocalizedDescriptionKey: "no displays"]) }
        // index <0 → auto: the display holding the frontmost app's window.
        var idx = index
        if idx < 0 {
            let (_, _, frontWin) = frontAppInfo()
            if let w = frontWin {
                let c = CGPoint(x: w.midX, y: w.midY)
                idx = content.displays.firstIndex(where: { $0.frame.contains(c) }) ?? 0
            } else { idx = 0 }
        }
        guard idx < content.displays.count else { throw NSError(domain: "td", code: 2, userInfo: [NSLocalizedDescriptionKey: "no display \(idx)"]) }
        let disp = content.displays[idx]
        let filter = SCContentFilter(display: disp, excludingApplications: [],
                                   exceptingWindows: thinkDropWindows(content))
        let cfg = SCStreamConfiguration(); cfg.showsCursor = cursor
        let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        return (img, disp)
    }
    throw NSError(domain: "td", code: 1, userInfo: [NSLocalizedDescriptionKey: "requires macOS 14+"])
}

// Match a captured SCDisplay to its NSScreen via displayID — SCK display
// ordering ≠ NSScreen ordering, so indexing by position misassigns scale
// and origin on multi-monitor setups (elements land in the wrong space).
func nsScreenFor(_ disp: SCDisplay) -> NSScreen? {
    NSScreen.screens.first {
        ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID) == disp.displayID
    }
}

// Capture only the frontmost app's largest on-screen window. Returns the image
// plus the window's screen-space rect (points, top-left origin — matches
// CGEvent/CGWindowList convention). Dialogs/sheets: they're separate windows,
// so capturing the *frontmost* window (not the biggest) would miss the app —
// we take the biggest on-screen layer window of the frontmost app.
func captureFrontWindow(cursor: Bool = true) async throws -> (CGImage, CGRect) {
    if #available(macOS 14.0, *) {
        let (frontName, frontPid, _) = frontAppInfo()
        guard frontPid != 0 else {
            throw NSError(domain: "td", code: 3, userInfo: [NSLocalizedDescriptionKey: "no frontmost app"])
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let wins = content.windows.filter {
            $0.owningApplication?.processID == frontPid
                && $0.frame.width > 100 && $0.frame.height > 100
        }
        guard let win = wins.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
            throw NSError(domain: "td", code: 4, userInfo: [NSLocalizedDescriptionKey: "no on-screen window for \(frontName)"])
        }
        let filter = SCContentFilter(desktopIndependentWindow: win)
        let cfg = SCStreamConfiguration(); cfg.showsCursor = cursor
        let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        return (img, win.frame)
    }
    throw NSError(domain: "td", code: 1, userInfo: [NSLocalizedDescriptionKey: "requires macOS 14+"])
}

// Frontmost app info — NSWorkspace.frontmostApplication is unreliable in this
// background daemon, so derive it from CGWindowList z-order: the first
// on-screen layer-0 window (list is front-to-back) belongs to the frontmost
// app. Returns (name, pid, rect of its largest window).
func frontAppInfo() -> (String, pid_t, CGRect?) {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return ("", 0, nil) }
    let myPid = ProcessInfo.processInfo.processIdentifier
    var frontPid: pid_t = 0
    var frontName = ""
    var frontWin: CGRect? = nil
    var bestArea: CGFloat = 0
    for w in list {
        guard let owner = w[kCGWindowOwnerPID as String] as? Int32, owner != myPid,
              let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
              let bd = w[kCGWindowBounds as String] as? [String: Any] else { continue }
        var r = CGRect.zero
        guard CGRectMakeWithDictionaryRepresentation(bd as CFDictionary, &r),
              r.width > 60, r.height > 60 else { continue }
        if frontPid == 0 {
            frontPid = owner
            frontName = (w[kCGWindowOwnerName as String] as? String) ?? ""
        }
        if owner == frontPid, r.width * r.height > bestArea {
            bestArea = r.width * r.height
            frontWin = r
        }
    }
    return (frontName, frontPid, frontWin)
}

// Native transient-layer oracle — context menus, popups and toasts live on
// the window server's popup level (kCGPopUpMenuWindowLevel = 101) as their
// own windows. OCR and window-scoped AX both miss them intermittently; the
// window list is ground truth. Returns each popup window's owner+rect so the
// caller can probe exactly that region.
func popupLayers() -> [[String: Any]] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [] }
    let myPid = ProcessInfo.processInfo.processIdentifier
    var layers: [[String: Any]] = []
    for w in list {
        guard let owner = w[kCGWindowOwnerPID as String] as? Int32, owner != myPid,
              let layer = w[kCGWindowLayer as String] as? Int,
              layer == kCGPopUpMenuWindowLevel || layer == kCGPopUpMenuWindowLevel + 1,
              let bd = w[kCGWindowBounds as String] as? [String: Any] else { continue }
        var r = CGRect.zero
        guard CGRectMakeWithDictionaryRepresentation(bd as CFDictionary, &r),
              r.width > 20, r.height > 20 else { continue }
        layers.append([
            "owner": (w[kCGWindowOwnerName as String] as? String) ?? "",
            "pid": Int(owner),
            "layer": layer,
            "rect": [r.minX.rounded(), r.minY.rounded(), r.width.rounded(), r.height.rounded()],
        ])
    }
    return layers
}

// Region rects in top-left-origin points, derived from NSScreen visibleFrame
// (excludes menubar + dock): top gap = menubar band; leftover gaps = dock.
func screenRegions() -> (menubars: [CGRect], docks: [CGRect]) {
    let primaryH = NSScreen.screens.first?.frame.height ?? 0
    var menubars: [CGRect] = []; var docks: [CGRect] = []
    for s in NSScreen.screens {
        let f = s.frame, v = s.visibleFrame
        let tlY = primaryH - f.maxY           // screen top, top-left origin
        let vtlY = primaryH - v.maxY          // visible area top
        if vtlY > tlY {
            menubars.append(CGRect(x: f.minX, y: tlY, width: f.width, height: vtlY - tlY))
        }
        let vMaxY = vtlY + v.height
        let fMaxY = tlY + f.height
        if vMaxY < fMaxY {  // dock at bottom
            docks.append(CGRect(x: f.minX, y: vMaxY, width: f.width, height: fMaxY - vMaxY))
        }
        if v.minX > f.minX {  // dock at left
            docks.append(CGRect(x: f.minX, y: tlY, width: v.minX - f.minX, height: f.height))
        }
        if v.maxX < f.maxX {  // dock at right
            docks.append(CGRect(x: v.maxX, y: tlY, width: f.maxX - v.maxX, height: f.height))
        }
    }
    return (menubars, docks)
}

func regionOf(_ p: CGPoint, _ frontWin: CGRect?, _ menubars: [CGRect], _ docks: [CGRect]) -> String {
    for r in menubars where r.contains(p) { return "menubar" }
    for r in docks where r.contains(p) { return "dock" }
    if let w = frontWin, w.contains(p) { return "app" }
    return "other"
}

// ── Pixel buffer (stretch to model side²) ───────────────────────────────────
func makePixelBuffer(_ image: CGImage, _ s: Int) -> CVPixelBuffer? {
    var pb: CVPixelBuffer?
    let attrs: [CFString: Any] = [
        kCVPixelBufferCGImageCompatibilityKey: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
    ]
    guard CVPixelBufferCreate(kCFAllocatorDefault, s, s, kCVPixelFormatType_32BGRA,
                              attrs as CFDictionary, &pb) == kCVReturnSuccess, let buf = pb else { return nil }
    CVPixelBufferLockBaseAddress(buf, [])
    defer { CVPixelBufferUnlockBaseAddress(buf, []) }
    guard let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf), width: s, height: s,
                              bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buf),
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) else { return nil }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: s, height: s))
    return buf
}

// ── Detect ──────────────────────────────────────────────────────────────────
struct Det { var x: Double; var y: Double; var w: Double; var h: Double; var conf: Double }

func detect(_ img: CGImage, _ mdl: MLModel) -> [Det] {
    guard let pb = makePixelBuffer(img, modelSide) else { return [] }
    var d: [String: MLFeatureValue] = ["image": MLFeatureValue(pixelBuffer: pb)]
    for (name, f) in mdl.modelDescription.inputDescriptionsByName where name != "image" {
        if let c = f.multiArrayConstraint,
           let arr = try? MLMultiArray(shape: c.shape, dataType: .double) {
            arr[0] = NSNumber(value: name.lowercased().contains("iou") ? NMS_IOU : CONF_FLOOR)
            d[name] = MLFeatureValue(multiArray: arr)
        }
    }
    guard let provider = try? MLDictionaryFeatureProvider(dictionary: d),
          let result = try? mdl.prediction(from: provider) else { return [] }

    var coords: MLMultiArray? = nil
    var confs: MLMultiArray? = nil
    for name in result.featureNames {
        guard let mv = result.featureValue(for: name)?.multiArrayValue else { continue }
        if name == "coordinates" { coords = mv }
        if name == "confidence" { confs = mv }
    }
    guard let c = coords else { return [] }

    func dval(_ arr: MLMultiArray, _ off: Int) -> Double {
        arr.dataType == .float32
            ? Double(arr.dataPointer.assumingMemoryBound(to: Float32.self)[off])
            : Double(arr.dataPointer.assumingMemoryBound(to: Float16.self)[off])
    }
    var dets: [Det] = []
    let n = c.shape[0].intValue
    var maxConf: [Double] = []
    if let cf = confs {
        let rows = cf.shape[0].intValue, cols = cf.shape.count > 1 ? cf.shape[1].intValue : 1
        for r in 0..<rows {
            var m: Double = 0
            for j in 0..<cols { m = max(m, dval(cf, r * cols + j)) }
            maxConf.append(m)
        }
    }
    for k in 0..<n {
        let conf = k < maxConf.count ? maxConf[k] : 1.0
        guard conf >= CONF_FLOOR else { continue }
        let cx = dval(c, k * 4), cy = dval(c, k * 4 + 1)
        let w = dval(c, k * 4 + 2), h = dval(c, k * 4 + 3)
        dets.append(Det(x: cx - w/2, y: cy - h/2, w: w, h: h, conf: conf))
    }
    // NMS
    dets.sort { $0.conf > $1.conf }
    var kept: [Det] = []
    for det in dets {
        var sup = false
        for kd in kept {
            let ix = max(0, min(det.x + det.w, kd.x + kd.w) - max(det.x, kd.x))
            let iy = max(0, min(det.y + det.h, kd.y + kd.h) - max(det.y, kd.y))
            let inter = ix * iy, uni = det.w * det.h + kd.w * kd.h - inter
            if uni > 0 && inter / uni > NMS_IOU { sup = true; break }
        }
        if !sup { kept.append(det) }
    }
    return kept
}

// ── OCR ─────────────────────────────────────────────────────────────────────
// accurate: .accurate + language correction — used on small region crops where
// the cost is trivial and the quality gain kills Rgcents-class noise.
struct OcrWord { let text: String; let box: CGRect; let conf: Float }
func ocr(_ img: CGImage, accurate: Bool = false) -> [(String, CGRect, Float, [OcrWord])] {
    var boxes: [(String, CGRect, Float, [OcrWord])] = []
    let sem = DispatchSemaphore(value: 0)
    let req = VNRecognizeTextRequest { r, _ in
        for obs in (r.results as? [VNRecognizedTextObservation]) ?? [] {
            guard let cand = obs.topCandidates(1).first else { continue }
            // Word-precision sub-boxes: split the line on whitespace and ask
            // Vision for each word's own rect. Click targets resolve to the
            // WORD, not the merged line center — "Edit details Delete" gets
            // three separate clickable boxes.
            var words: [OcrWord] = []
            var cursor = cand.string.startIndex
            for w in cand.string.split(separator: " ", omittingEmptySubsequences: false) where !w.isEmpty {
                let end = cand.string.index(cursor, offsetBy: w.count)
                if let wb = try? cand.boundingBox(for: cursor..<end) {
                    words.append(OcrWord(text: String(w), box: wb.boundingBox, conf: cand.confidence))
                }
                cursor = end < cand.string.endIndex ? cand.string.index(after: end) : end
            }
            boxes.append((cand.string, obs.boundingBox, cand.confidence, words))
        }
        sem.signal()
    }
    req.recognitionLevel = accurate ? .accurate : .fast
    req.usesLanguageCorrection = accurate
    try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
    sem.wait()
    return boxes
}

// ── Merge + element emit ────────────────────────────────────────────────────
func buildElements(dets: [Det], ocrBoxes: [(String, CGRect, Float, [OcrWord])],
                   sw: Double, sh: Double) -> [[String: Any]] {
    var els: [[String: Any]] = []
    var usedOCR = Set<Int>()

    func toPx(_ d: Det) -> CGRect { CGRect(x: d.x * sw, y: d.y * sh, width: d.w * sw, height: d.h * sh) }
    func ocrPx(_ b: CGRect) -> CGRect {
        CGRect(x: b.minX * sw, y: (1 - b.maxY) * sh, width: b.width * sw, height: b.height * sh)
    }
    // Word sub-boxes in pixel space for one OCR observation.
    func wordsPx(_ words: [OcrWord]) -> [[String: Any]] {
        words.compactMap { w in
            let r = ocrPx(w.box)
            guard r.width >= 3, r.height >= 5 else { return nil }
            return ["text": w.text,
                    "bbox": [r.minX.rounded(), r.minY.rounded(), r.width.rounded(), r.height.rounded()],
                    "conf": Double(w.conf)] as [String: Any]
        }
    }

    for d in dets {
        let r = toPx(d)
        guard r.width >= MIN_BOX_PX, r.height >= MIN_BOX_PX,
              r.width < sw * 0.95, r.height < sh * 0.95 else { continue }
        var label = ""
        var rows: [[String: Any]] = []
        var words: [[String: Any]] = []
        for (i, (txt, b, _, ws)) in ocrBoxes.enumerated() {
            let or_ = ocrPx(b)
            let inter = r.intersection(or_)
            if !inter.isNull && inter.width * inter.height > 0.3 * min(r.width * r.height, or_.width * or_.height) {
                label += (label.isEmpty ? "" : " ") + txt
                usedOCR.insert(i)
                rows.append(["text": txt,
                             "bbox": [or_.minX.rounded(), or_.minY.rounded(), or_.width.rounded(), or_.height.rounded()]])
                words.append(contentsOf: wordsPx(ws))
            }
        }
        var el: [String: Any] = [
            "id": els.count, "type": "icon", "label": label,
            "conf": (d.conf * 100).rounded() / 100,
            "bbox": [r.minX.rounded(), r.minY.rounded(), r.width.rounded(), r.height.rounded()],
            "center": [r.midX.rounded(), r.midY.rounded()],
            "src": label.isEmpty ? "detector" : "merged",
        ]
        // Only expose sub-granularity when it differs from the container —
        // multi-row labels ("Edit details Delete") get per-row boxes;
        // multi-word labels get per-word boxes.
        if rows.count > 1 { el["rows"] = rows }
        if words.count > 1 { el["words"] = words }
        els.append(el)
    }

    // OCR-as-elements: text not inside a detected box (input fields, links, plain buttons)
    for (i, (txt, b, cf, ws)) in ocrBoxes.enumerated() where !usedOCR.contains(i) && cf >= OCR_TEXT_MIN_CONF {
        let r = ocrPx(b)
        guard r.width >= MIN_BOX_PX, r.height >= 8 else { continue }
        // skip if substantially inside an emitted icon box
        var inside = false
        for e in els {
            guard let bb = e["bbox"] as? [Any], bb.count == 4,
                  let x = (bb[0] as? NSNumber)?.doubleValue,
                  let y = (bb[1] as? NSNumber)?.doubleValue,
                  let w = (bb[2] as? NSNumber)?.doubleValue,
                  let h = (bb[3] as? NSNumber)?.doubleValue else { continue }
            let er = CGRect(x: x, y: y, width: w, height: h)
            let inter = er.intersection(r)
            if !inter.isNull && inter.width * inter.height > 0.7 * r.width * r.height { inside = true; break }
        }
        if inside { continue }
        var el: [String: Any] = [
            "id": els.count, "type": "text", "label": txt,
            "conf": Double(cf),
            "bbox": [r.minX.rounded(), r.minY.rounded(), r.width.rounded(), r.height.rounded()],
            "center": [r.midX.rounded(), r.midY.rounded()],
            "src": "ocr",
        ]
        let wpx = wordsPx(ws)
        if wpx.count > 1 { el["words"] = wpx }
        els.append(el)
    }
    return els
}

// ── Annotate (debug) ────────────────────────────────────────────────────────
func annotate(_ img: CGImage, _ els: [[String: Any]], _ path: String) {
    let sw = img.width, sh = img.height
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: sw, pixelsHigh: sh,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                     isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0) else { return }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSImage(cgImage: img, size: .zero).draw(in: NSRect(x: 0, y: 0, width: sw, height: sh))
    var drawn = 0
    for e in els {
        guard let bb = e["bbox"] as? [Any], bb.count == 4, let id = e["id"] as? Int,
              let bx = (bb[0] as? NSNumber)?.doubleValue, let by = (bb[1] as? NSNumber)?.doubleValue,
              let bw = (bb[2] as? NSNumber)?.doubleValue, let bh = (bb[3] as? NSNumber)?.doubleValue else { continue }
        drawn += 1
        let r = NSRect(x: bx, y: Double(sh) - by - bh, width: bw, height: bh)
        ((e["type"] as? String) == "text" ? NSColor.systemBlue : NSColor.systemRed).setStroke()
        let p = NSBezierPath(rect: r); p.lineWidth = 2; p.stroke()
        ("\(id)" as NSString).draw(at: NSPoint(x: r.minX, y: r.minY - 13),
            withAttributes: [.foregroundColor: NSColor.yellow,
                             .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .bold)])
        // Sub-granularity: rows (green) and words (orange dotted) — the new
        // precision boxes the click resolver uses instead of the merged bbox.
        for key in ["rows", "words"] {
            let color: NSColor = key == "rows" ? .systemGreen : .systemOrange
            for sub in (e[key] as? [[String: Any]]) ?? [] {
                guard let sb = sub["bbox"] as? [Any], sb.count == 4,
                      let sx = (sb[0] as? NSNumber)?.doubleValue,
                      let sy = (sb[1] as? NSNumber)?.doubleValue,
                      let sw2 = (sb[2] as? NSNumber)?.doubleValue,
                      let sh2 = (sb[3] as? NSNumber)?.doubleValue else { continue }
                color.setStroke()
                let sp = NSBezierPath(rect: NSRect(x: sx, y: Double(sh) - sy - sh2, width: sw2, height: sh2))
                sp.lineWidth = 1; sp.stroke()
            }
        }
    }
    NSGraphicsContext.restoreGraphicsState()
    try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    log("annotated", "path=\(path) els=\(els.count) drawn=\(drawn)")
}

// ── Crop fingerprint (aHash + luminance) ────────────────────────────────────
// 16x16 grayscale average-hash → 256-bit hex + mean luminance. Two captures of
// the same rect: hamming(phash)≈small + |lumΔ|≈0 → unchanged; small hamming +
// lumΔ → glow/brightness affordance; large hamming → icon swap/structural.
// Brightness-invariant hash separates structure changes from shade changes.
func cropFingerprint(_ img: CGImage) -> (phash: String, lum: Double) {
    let N = 16, npx = N * N
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: N, pixelsHigh: N,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                     isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: N * 4, bitsPerPixel: 32),
          let gctx = NSGraphicsContext(bitmapImageRep: rep) else { return ("", 0) }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = gctx
    gctx.imageInterpolation = .low
    NSImage(cgImage: img, size: NSSize(width: N, height: N)).draw(
        in: NSRect(x: 0, y: 0, width: N, height: N))
    NSGraphicsContext.restoreGraphicsState()
    guard let px = rep.bitmapData else { return ("", 0) }
    var gray = [Int](repeating: 0, count: npx)
    var sum = 0
    for i in 0..<npx {
        gray[i] = (Int(px[i * 4]) + Int(px[i * 4 + 1]) + Int(px[i * 4 + 2])) / 3
        sum += gray[i]
    }
    let avg = Double(sum) / Double(npx)
    var nibbles: [UInt8] = []
    var nib: UInt8 = 0; var bit = 0
    for i in 0..<npx {
        if Double(gray[i]) >= avg { nib |= UInt8(1 << (3 - bit)) }
        bit += 1
        if bit == 4 { nibbles.append(nib); nib = 0; bit = 0 }
    }
    return (nibbles.map { String(format: "%x", $0) }.joined(), (avg * 10).rounded() / 10)
}

// ── Actions (CGEvent) ───────────────────────────────────────────────────────
func doClick(_ x: Double, _ y: Double, button: String, dbl: Bool) -> Bool {
    let pt = CGPoint(x: x, y: y)
    let btn: CGMouseButton = button == "right" ? .right : .left
    let dn: CGEventType = button == "right" ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = button == "right" ? .rightMouseUp : .leftMouseUp
    guard let e1 = CGEvent(mouseEventSource: nil, mouseType: dn, mouseCursorPosition: pt, mouseButton: btn),
          let e2 = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: pt, mouseButton: btn) else { return false }
    e1.post(tap: .cghidEventTap); e2.post(tap: .cghidEventTap)
    if dbl {
        guard let e3 = CGEvent(mouseEventSource: nil, mouseType: dn, mouseCursorPosition: pt, mouseButton: btn),
              let e4 = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: pt, mouseButton: btn) else { return false }
        e3.setIntegerValueField(.mouseEventClickState, value: 2)
        e4.setIntegerValueField(.mouseEventClickState, value: 2)
        e3.post(tap: .cghidEventTap); e4.post(tap: .cghidEventTap)
    }
    return true
}

// char -> (keyCode, needsShift) for US layout — real key events, since
// Chromium-based apps ignore unicode-only keyboard events (virtualKey 0)
let CHARMAP: [Character: (CGKeyCode, Bool)] = [
    "a": (0,false), "b": (11,false), "c": (8,false), "d": (2,false), "e": (14,false),
    "f": (3,false), "g": (5,false), "h": (4,false), "i": (34,false), "j": (38,false),
    "k": (40,false), "l": (37,false), "m": (46,false), "n": (45,false), "o": (31,false),
    "p": (35,false), "q": (12,false), "r": (15,false), "s": (1,false), "t": (17,false),
    "u": (32,false), "v": (9,false), "w": (13,false), "x": (7,false), "y": (16,false),
    "z": (6,false),
    "A": (0,true), "B": (11,true), "C": (8,true), "D": (2,true), "E": (14,true),
    "F": (3,true), "G": (5,true), "H": (4,true), "I": (34,true), "J": (38,true),
    "K": (40,true), "L": (37,true), "M": (46,true), "N": (45,true), "O": (31,true),
    "P": (35,true), "Q": (12,true), "R": (15,true), "S": (1,true), "T": (17,true),
    "U": (32,true), "V": (9,true), "W": (13,true), "X": (7,true), "Y": (16,true),
    "Z": (6,true),
    "0": (29,false), "1": (18,false), "2": (19,false), "3": (20,false), "4": (21,false),
    "5": (23,false), "6": (22,false), "7": (26,false), "8": (28,false), "9": (25,false),
    ")": (29,true), "!": (18,true), "@": (19,true), "#": (20,true), "$": (21,true),
    "%": (23,true), "^": (22,true), "&": (26,true), "*": (28,true), "(": (25,true),
    " ": (49,false), "\n": (36,false), "\t": (48,false),
    "-": (27,false), "_": (27,true), "=": (24,false), "+": (24,true),
    "[": (33,false), "{": (33,true), "]": (30,false), "}": (30,true),
    "\\": (42,false), "|": (42,true), ";": (41,false), ":": (41,true),
    "'": (39,false), "\"": (39,true), ",": (43,false), "<": (43,true),
    ".": (47,false), ">": (47,true), "/": (44,false), "?": (44,true),
    "`": (50,false), "~": (50,true),
]

func doType(_ text: String) -> Bool {
    for ch in text {
        if cancelRequested { return false }
        if let (code, shift) = CHARMAP[ch] {
            guard let dn = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { return false }
            // Explicit flag state every event — a flag left over from a shifted
            // char latches into the NEXT keystrokes (@ → .com became >COM).
            dn.flags = shift ? .maskShift : []
            up.flags = []
            dn.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
            if shift {
                // release shift at HID level so the next char can't inherit it
                if let rel = CGEvent(keyboardEventSource: nil, virtualKey: 56, keyDown: false) {
                    rel.flags = []
                    rel.post(tap: .cghidEventTap)
                }
            }
        } else {
            // unicode fallback for chars outside the US-layout map
            guard let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else { return false }
            var u = Array(String(ch).utf16)
            e.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
            e.post(tap: .cghidEventTap)
            if let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
                up.post(tap: .cghidEventTap)
            }
        }
        usleep(25000)  // 25ms — Gmail autocomplete re-render eats trailing chars at 8ms
    }
    return true
}

let KEYMAP: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
    "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34,
    "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12,
    "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26,
    "8": 28, "9": 25,
    "-": 27, "=": 24, "[": 33, "]": 30, "'": 39, ";": 41, "\\": 42,
    ",": 43, "/": 44, ".": 47, "`": 50,
]

func doKey(_ key: String, _ mods: [String]) -> Bool {
    guard let code = KEYMAP[key.lowercased()] else { return false }
    var flags = CGEventFlags()
    for m in mods {
        switch m.lowercased() {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        default: break
        }
    }
    guard let dn = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { return false }
    dn.flags = flags; up.flags = flags
    dn.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
    return true
}

// ── Cursor localization (human-style hover verify) ─────────────────────────
// Two captures ~30ms apart — cursor hidden vs shown — differ ONLY at the
// cursor blob. Gives the cursor's true position in IMAGE px, which is the same
// space as element bboxes → enables measure→drift→click without trusting the
// point-space transform. Each call also yields a (sentPt → observedPx) sample
// used to fit the real px/pt transform empirically.
var measPt: [(Double, Double)] = []     // CGEvent pts sent (mouseLocation read)
var measPx: [(Double, Double)] = []     // observed cursor px in last capture
var dispPt: [(Double, Double)] = []     // subset: display-capture samples (offset-valid)
var dispPx: [(Double, Double)] = []
var fitScale: (Double, Double)? = nil   // fitted px/pt — overrides NSScreen guess
var fitOffPx: (Double, Double)? = nil   // fitted x-intercept (px): px = pt*scale + off

func pixelAt(_ img: CGImage, _ x: Int, _ y: Int) -> (Int, Int, Int) {
    guard let d = img.dataProvider?.data as Data? else { return (0,0,0) }
    let o = y * img.bytesPerRow + x * img.bitsPerPixel / 8
    guard o + 2 < d.count else { return (0,0,0) }
    return (Int(d[o]), Int(d[o+1]), Int(d[o+2]))
}

// Largest diff cluster between two same-size images, biased near `near` (px).
// Returns cluster bbox in image px.
func cursorBlob(_ a: CGImage, _ b: CGImage, near: CGPoint?) -> CGRect? {
    let w = min(a.width, b.width), h = min(a.height, b.height)
    var xs: [Int] = []; var ys: [Int] = []
    for y in stride(from: 0, to: h, by: 2) {
        for x in stride(from: 0, to: w, by: 2) {
            let p = pixelAt(a, x, y), q = pixelAt(b, x, y)
            if abs(p.0 - q.0) + abs(p.1 - q.1) + abs(p.2 - q.2) > 80 {
                xs.append(x); ys.append(y)
            }
        }
    }
    guard !xs.isEmpty else { return nil }
    // Seed = diff pt closest to `near` (the predicted cursor px); cluster =
    // all diff pts within 45px of the seed. The cursor is a ~20-30px compact
    // shape; scattered animation diffs don't seed unless they're closest —
    // and then the size guard in the caller rejects them.
    var best: [(Int, Int)] = []
    if let n = near {
        var seed = (xs[0], ys[0]), bestD = Double.greatestFiniteMagnitude
        for i in 0..<xs.count {
            let dx = Double(xs[i]) - Double(n.x), dy = Double(ys[i]) - Double(n.y)
            let d = dx * dx + dy * dy
            if d < bestD { bestD = d; seed = (xs[i], ys[i]) }
        }
        let R = 45.0
        for i in 0..<xs.count {
            let dx = Double(xs[i] - seed.0), dy = Double(ys[i] - seed.1)
            if dx * dx + dy * dy <= R * R { best.append((xs[i], ys[i])) }
        }
    } else {
        best = zip(xs, ys).map { $0 }
    }
    guard !best.isEmpty else { return nil }
    var minx = w, miny = h, maxx = 0, maxy = 0
    for (x, y) in best {
        minx = min(minx, x); maxx = max(maxx, x)
        miny = min(miny, y); maxy = max(maxy, y)
    }
    return CGRect(x: minx, y: miny, width: max(1, maxx - minx), height: max(1, maxy - miny))
}

func frontCapture(_ cursor: Bool) async throws -> CGImage {
    let c = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard !c.displays.isEmpty else { throw NSError(domain: "td", code: 5) }
    // same auto-pick as captureDisplay(-1): the frontmost window's display
    var d = c.displays[0]
    let (_, _, frontWin) = frontAppInfo()
    if let w = frontWin {
        let ctr = CGPoint(x: w.midX, y: w.midY)
        if let hit = c.displays.first(where: { $0.frame.contains(ctr) }) { d = hit }
    }
    let f = SCContentFilter(display: d, excludingApplications: [],
                            exceptingWindows: thinkDropWindows(c))
    let cfg = SCStreamConfiguration(); cfg.showsCursor = cursor
    return try await SCScreenshotManager.captureImage(contentFilter: f, configuration: cfg)
}

// True cursor pt (top-left origin) via AppKit — reads the real pointer, not
// what we last sent.
func mousePoint() -> CGPoint {
    let m = NSEvent.mouseLocation
    let ph = NSScreen.screens.first?.frame.height ?? 0
    return CGPoint(x: m.x, y: ph - m.y)
}

func doCursorFind(_ req: [String: Any]) async -> [String: Any] {
    let windowOnly = req["windowOnly"] as? Bool ?? false
    do {
        let pt = mousePoint()
        let gs = fitScale ?? (1.3333, 1.2)
        let go = fitOffPx ?? (0, 0)
        let near = CGPoint(x: Double(pt.x) * gs.0 + go.0, y: Double(pt.y) * gs.1 + go.1)
        var a: CGImage; var b: CGImage
        if windowOnly {
            a = try await captureFrontWindow(cursor: false).0
            b = try await captureFrontWindow(cursor: true).0
        } else {
            a = try await frontCapture(false)
            b = try await frontCapture(true)
        }
        guard let blob = cursorBlob(b, a, near: near) else {
            return ["ok": false, "error": "cursor-not-found"]
        }
        // Arrow/hand hotspot ≈ top-left of the shape (+few px inset).
        let cx = blob.minX + 4, cy = blob.minY + 4
        // A cursor blob is ~20-40px; a bigger "cluster" is page animation,
        // not the cursor — don't poison the fit with it.
        guard blob.width < 90, blob.height < 90 else {
            return ["ok": false, "error": "cursor-blob-implausible"]
        }
        measPt.append((Double(pt.x), Double(pt.y)))
        measPx.append((Double(cx), Double(cy)))
        if !windowOnly { dispPt.append((Double(pt.x), Double(pt.y))); dispPx.append((Double(cx), Double(cy))) }
        if measPt.count > 14 { measPt.removeFirst(); measPx.removeFirst() }
        if dispPt.count > 14 { dispPt.removeFirst(); dispPx.removeFirst() }
        refitScale()
        return ["ok": true, "cursor_px": [cx, cy], "cursor_pt": [pt.x, pt.y],
                "img": [a.width, a.height],
                "fit_scale": fitScale.map { [$0.0, $0.1] } ?? NSNull()]
    } catch {
        return ["ok": false, "error": error.localizedDescription]
    }
}

// Robust scale fit: median of pairwise slopes over well-separated samples
// (>150pt). Median ignores single-sample blob noise; bounds reject garbage.
// Offset-free (slope only) — safe across display + window-crop captures.
func refitScale() {
    guard measPt.count >= 2 else { return }
    var sxv: [Double] = [], syv: [Double] = []
    for i in 0..<measPt.count {
        for j in i + 1..<measPt.count {
            let dx = measPt[j].0 - measPt[i].0, dy = measPt[j].1 - measPt[i].1
            if abs(dx) > 150 { sxv.append((measPx[j].0 - measPx[i].0) / dx) }
            if abs(dy) > 150 { syv.append((measPx[j].1 - measPx[i].1) / dy) }
        }
    }
    func med(_ a: [Double]) -> Double? {
        guard !a.isEmpty else { return nil }
        let s = a.sorted(); return s[s.count / 2]
    }
    guard let fx = med(sxv) ?? fitScale?.0, let fy = med(syv) ?? fitScale?.1,
          (0.7...2.5).contains(fx), (0.7...2.5).contains(fy) else { return }
    // affine intercept (px) from DISPLAY-capture samples only — window-crop
    // px lives in window-local space and must not pollute the global offset.
    var oxv: [Double] = [], oyv: [Double] = []
    for i in 0..<dispPt.count {
        oxv.append(dispPx[i].0 - dispPt[i].0 * fx)
        oyv.append(dispPx[i].1 - dispPt[i].1 * fy)
    }
    if let ox = med(oxv), let oy = med(oyv), abs(ox) < 400, abs(oy) < 400 {
        fitOffPx = (ox, oy)
    }
    if fitScale == nil || abs(fitScale!.0 - fx) > 0.02 || abs(fitScale!.1 - fy) > 0.02 {
        fitScale = (fx, fy)
        log("fit-scale", "x=\(fx) y=\(fy) off=\(fitOffPx ?? (0,0)) samples=\(measPt.count)")
    }
}

// Deliberate 2-point calibration: park cursor at two far interior points,
// measure each → exact per-axis scale. Intrusive (moves the real cursor) —
// run on demand, then restore the cursor position.
func doCalibrate() async -> [String: Any] {
    let restore = mousePoint()
    let probes: [(Double, Double)] = [(250, 200), (1000, 650)]
    var got: [(Double, Double, Double, Double)] = []  // ptX,ptY,px,py
    for p in probes {
        _ = doMove(p.0, p.1)
        try? await Task.sleep(nanoseconds: 180_000_000)
        // capture pair at this point
        do {
            let pt = mousePoint()
            let gs = fitScale ?? (1.21, 1.21)
            let go = fitOffPx ?? (0, 0)
            let near = CGPoint(x: Double(pt.x) * gs.0 + go.0, y: Double(pt.y) * gs.1 + go.1)
            let a = try await frontCapture(false)
            let b = try await frontCapture(true)
            if let blob = cursorBlob(b, a, near: near) {
                if blob.width < 90, blob.height < 90 {
                    got.append((Double(pt.x), Double(pt.y), Double(blob.minX + 4), Double(blob.minY + 4)))
                } else {
                    log("calibrate-probe", "blob too big \(blob) at pt(\(pt.x),\(pt.y)) near(\(near.x),\(near.y))")
                }
            } else {
                log("calibrate-probe", "no blob at pt(\(pt.x),\(pt.y)) near(\(near.x),\(near.y)) img \(a.width)x\(a.height)")
            }
        } catch {
            log("calibrate-probe", "capture error: \(error.localizedDescription)")
        }
    }
    _ = doMove(restore.x, restore.y)
    guard got.count == 2 else {
        return ["ok": false, "error": "calibrate-probes-failed", "probes": got.count]
    }
    let sx = (got[1].2 - got[0].2) / (got[1].0 - got[0].0)
    let sy = (got[1].3 - got[0].3) / (got[1].1 - got[0].1)
    guard (0.7...2.5).contains(sx), (0.7...2.5).contains(sy) else {
        return ["ok": false, "error": "calibrate-implausible", "sx": sx, "sy": sy]
    }
    fitScale = (sx, sy)
    fitOffPx = ((got[0].2 - got[0].0 * sx + got[1].2 - got[1].0 * sx) / 2,
                (got[0].3 - got[0].1 * sy + got[1].3 - got[1].1 * sy) / 2)
    // absorb into the sample buffers so opportunistic refits don't diverge
    measPt = [(got[0].0, got[0].1), (got[1].0, got[1].1)]
    measPx = [(got[0].2, got[0].3), (got[1].2, got[1].3)]
    dispPt = measPt; dispPx = measPx
    log("calibrated", "scale=(\(sx),\(sy)) offPx=\(fitOffPx!)")
    return ["ok": true, "scale": [sx, sy], "offset_px": [fitOffPx!.0, fitOffPx!.1],
            "probes": got.map { ["pt": [$0.0, $0.1], "px": [$0.2, $0.3]] }]
}

func doMove(_ x: Double, _ y: Double) -> Bool {
    guard let mv = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                           mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) else { return false }
    mv.post(tap: .cghidEventTap)
    return true
}

func doScroll(_ x: Double, _ y: Double, _ dx: Int, _ dy: Int) -> Bool {
    let pt = CGPoint(x: x, y: y)
    if let mv = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                        mouseCursorPosition: pt, mouseButton: .left) {
        mv.post(tap: .cghidEventTap)
    }
    guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                          wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else { return false }
    e.post(tap: .cghidEventTap)
    return true
}

func doFocus(bundle: String?, appName: String?) -> Bool {
    for app in NSWorkspace.shared.runningApplications {
        let hit = (bundle != nil && app.bundleIdentifier == bundle) ||
                  (appName != nil && (app.localizedName == appName || app.executableURL?.lastPathComponent == appName))
        if hit {
            if app.activate() { return true }
            if app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]) { return true }
            // background daemons can't always activate directly — use LaunchServices
            if let b = app.bundleIdentifier, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: b) {
                let cfg = NSWorkspace.OpenConfiguration()
                cfg.activates = true
                var ok = false
                let sem = DispatchSemaphore(value: 0)
                NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, err in
                    ok = (err == nil); sem.signal()
                }
                _ = sem.wait(timeout: .now() + 3)
                if ok { return true }
            }
        }
    }
    return false
}

// ── Menubar AX read — shortcuts live here as REAL key equivalents. ──────────
// Scope is deliberately menubar-only: deep window AX fails on Electron/Chrome,
// but the menubar responded everywhere (see docs/screen-parse-spike-results.md).
// NEVER set AXEnhancedUserInterface — it mutates app behavior + prompts the user.

func axVal(_ el: AXUIElement, _ attr: CFString) -> CFTypeRef? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr, &v) == .success else { return nil }
    return v
}
func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    (axVal(el, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}
func axTitle(_ el: AXUIElement) -> String {
    (axVal(el, kAXTitleAttribute as CFString) as? String) ?? ""
}

// AXMenuItemCmdModifiers bits (HIServices): 1=shift 2=option 4=ctrl 8=noCommand
func doMenubar() -> [String: Any] {
    var (name, pid, _) = frontAppInfo()
    if pid == 0, let front = NSWorkspace.shared.frontmostApplication {
        pid = front.processIdentifier; name = front.localizedName ?? name
    }
    guard pid != 0 else { return ["ok": false, "error": "no-frontmost-app"] }
    let app = AXUIElementCreateApplication(pid)
    guard let mbRaw = axVal(app, kAXMenuBarAttribute as CFString) else {
        return ["ok": false, "error": "no-menubar", "app": name]
    }
    let mb = mbRaw as! AXUIElement
    var items: [[String: Any]] = []

    // Walk an AXMenu's children; menuPath accumulates "File > New Tab".
    func walkMenu(_ menu: AXUIElement, _ menuPath: String, _ depth: Int) {
        guard depth < 5, items.count < 400 else { return }
        for item in axChildren(menu) {
            let title = axTitle(item)
            let nextPath = title.isEmpty ? menuPath
                : (menuPath.isEmpty ? title : menuPath + " > " + title)
            // submenu? AXMenuItem children include an AXMenu — recurse into it
            for sub in axChildren(item)
                where (axVal(sub, kAXRoleAttribute as CFString) as? String) == "AXMenu" {
                walkMenu(sub, nextPath, depth + 1)
            }
            let cmdChar = (axVal(item, "AXMenuItemCmdChar" as CFString) as? String) ?? ""
            let vk = (axVal(item, "AXMenuItemCmdVirtualKey" as CFString) as? NSNumber)?.intValue
            let modBits = (axVal(item, "AXMenuItemCmdModifiers" as CFString) as? NSNumber)?.intValue ?? 0
            if cmdChar.isEmpty && vk == nil { continue }   // plain menu item, no shortcut
            var mods: [String] = []
            if modBits & 1 != 0 { mods.append("shift") }
            if modBits & 2 != 0 { mods.append("alt") }
            if modBits & 4 != 0 { mods.append("ctrl") }
            if modBits & 8 == 0 { mods.append("cmd") }     // cmd implied unless noCommand bit
            var entry: [String: Any] = [
                "path": nextPath,
                "title": title,
                "menu": menuPath,
                "key": cmdChar,
                "mods": mods,
            ]
            if let v = vk { entry["vkey"] = v }
            entry["enabled"] = (axVal(item, kAXEnabledAttribute as CFString) as? Bool) ?? true
            items.append(entry)
        }
    }

    // AXMenuBar → AXMenuBarItem (top-level menus like "File") → AXMenu → items
    for barItem in axChildren(mb) {
        let menuName = axTitle(barItem)
        for menu in axChildren(barItem) {
            let role = axVal(menu, kAXRoleAttribute as CFString) as? String
            if role == "AXMenu" { walkMenu(menu, menuName, 0) }
        }
    }
    return ["ok": true, "app": name, "pid": Int(pid), "items": items]
}

// ── Parse command ───────────────────────────────────────────────────────────
var frameCounter = 0
func runParse(_ req: [String: Any]) async -> [String: Any] {
    let display = req["display"] as? Int ?? -1   // absent → auto (frontmost window's display)
    let windowOnly = req["windowOnly"] as? Bool ?? false
    let annotatePath = req["annotate"] as? String
    // rect:[x,y,w,h] points (screen space — same as element bbox) → crop the
    // capture BEFORE detect+ocr. Small crops run .accurate OCR for free.
    let rectPt = (req["rect"] as? [Any])?.compactMap { ($0 as? NSNumber)?.doubleValue }
    let wantImage = req["wantImage"] as? Bool ?? false
    let cursor = req["cursor"] as? Bool ?? true
    guard let m = model else {
        return ["ok": false, "error": "model-not-loaded"]
    }
    let t0 = Date()
    do {
        var img: CGImage
        var scaleX: Double
        var scaleY: Double
        var offX: Double
        var offY: Double

        if windowOnly {
            // Crop to frontmost app's window. box-in-crop → screen point =
            // window.origin + px/scale (same transform as display path).
            // Per-axis scale: SCK can return a squished capture (1920x1080 of a
            // 1440x900-pt window) — a single scalar corrupts every y.
            let (wimg, wrect) = try await captureFrontWindow(cursor: cursor)
            img = wimg
            if let fs = fitScale {
                // SCWindow.frame vs CGEvent space has proven unreliable; use
                // the fitted px/pt scale — the wrect origin still maps back.
                scaleX = fs.0; scaleY = fs.1
            } else {
                scaleX = Double(wimg.width) / Double(wrect.width)
                scaleY = Double(wimg.height) / Double(wrect.height)
            }
            offX = Double(wrect.minX)
            offY = Double(wrect.minY)
        } else {
            let (cimg, disp) = try await captureDisplay(display, cursor: cursor)
            img = cimg
            // SCK returns PIXELS; CGEvent + element coords must be screen POINTS.
            // Prefer the empirically fitted transform (cursor-diff samples) —
            // NSScreen/SCDisplay geometry has proven unreliable on this setup
            // (NSScreen claims 1440x900 while CGEvent space measures 1600x900
            // with a -80pt x-origin — nothing but the cursor tells the truth).
            let screen = nsScreenFor(disp) ?? NSScreen.main
            if let fs = fitScale {
                scaleX = fs.0; scaleY = fs.1
                if let fo = fitOffPx {
                    // px = (pt - offPt)*scale + offPx → pt = (px - offPx)/scale + offPt.
                    // offPt for this display = 0 (fitted offset already absorbs it).
                    offX = -fo.0 / fs.0
                    offY = -fo.1 / fs.1
                } else { offX = 0; offY = 0 }
            } else {
                scaleX = screen != nil ? Double(img.width) / Double(screen!.frame.width) : 1.0
                scaleY = screen != nil ? Double(img.height) / Double(screen!.frame.height) : 1.0
                let origin = screen?.frame.origin ?? .zero
                // NSScreen y-origin is bottom-left of primary; CGEvent wants top-left.
                let primaryH = NSScreen.screens.first?.frame.height ?? 0
                offX = Double(origin.x)
                offY = Double(primaryH - origin.y - (screen?.frame.height ?? 0))
            }
        }
        let capMs = Date().timeIntervalSince(t0)

        // rect crop — element coords stay in full-frame px via cropOffPx, so
        // the pt conversion below needs no special-casing.
        var procImg = img
        var cropOffPx = CGPoint.zero
        var appliedRect: [Double]? = nil
        if let r = rectPt, r.count == 4, r[2] > 0, r[3] > 0 {
            let cropRect = CGRect(x: (r[0] - offX) * scaleX, y: (r[1] - offY) * scaleY,
                                  width: r[2] * scaleX, height: r[3] * scaleY).integral
                .intersection(CGRect(x: 0, y: 0, width: img.width, height: img.height))
            if !cropRect.isEmpty, let c = img.cropping(to: cropRect) {
                procImg = c; cropOffPx = cropRect.origin; appliedRect = r
            }
        }

        var t = Date()
        let dets = detect(procImg, m)
        let detMs = Date().timeIntervalSince(t)

        t = Date()
        let ocrBoxes = ocr(procImg, accurate: appliedRect != nil)
        let ocrMs = Date().timeIntervalSince(t)

        let pxEls = buildElements(dets: dets, ocrBoxes: ocrBoxes,
                                  sw: Double(procImg.width), sh: Double(procImg.height))
        if let p = annotatePath { annotate(procImg, pxEls, p) }

        // Convert to point space for output + tag regions
        let (frontName, _, frontWin) = frontAppInfo()
        let (menubars, docks) = screenRegions()
        var els: [[String: Any]] = []
        for e in pxEls {
            var el = e
            if let bb = e["bbox"] as? [Any], bb.count == 4 {
                let v = bb.compactMap { (($0 as? NSNumber)?.doubleValue ?? 0) }
                if v.count == 4 { el["bbox"] = [(v[0] + cropOffPx.x) / scaleX + offX, (v[1] + cropOffPx.y) / scaleY + offY, v[2] / scaleX, v[3] / scaleY] }
            }
            if let c = e["center"] as? [Any], c.count == 2 {
                let v = c.compactMap { (($0 as? NSNumber)?.doubleValue ?? 0) }
                if v.count == 2 {
                    let cx = (v[0] + cropOffPx.x) / scaleX + offX, cy = (v[1] + cropOffPx.y) / scaleY + offY
                    el["center"] = [cx, cy]
                    el["region"] = regionOf(CGPoint(x: cx, y: cy),
                                            frontWin, menubars, docks)
                }
            }
            els.append(el)
        }

        frameCounter += 1
        var frontBundle = ""
        for app in NSWorkspace.shared.runningApplications where app.localizedName == frontName {
            frontBundle = app.bundleIdentifier ?? ""; break
        }
        var imgB64: String? = nil
        if wantImage {
            let rep = NSBitmapImageRep(cgImage: procImg)
            if let png = rep.representation(using: .png, properties: [:]) {
                imgB64 = png.base64EncodedString()
            }
        }
        // fingerprint the processed (possibly cropped) frame — always on rect
        // parses so verify/probe paths get a free diff key.
        var phash: String? = nil; var lum: Double? = nil
        if appliedRect != nil {
            let f = cropFingerprint(procImg)
            phash = f.phash; lum = f.lum
        }
        return [
            "ok": true,
            "frame_id": "f-\(frameCounter)",
            "display": display,
            "front_app": frontName,
            "front_bundle": frontBundle,
            "size_px": [img.width, img.height],
            "coord_space": "points",
            "scale": [scaleX, scaleY],
            "offset": [offX, offY],
            "windowOnly": windowOnly,
            "rect": appliedRect as Any,
            "phash": phash as Any,
            "lum": lum as Any,
            "image_png_b64": imgB64 as Any,
            "layers": popupLayers(),
            "timing_ms": ["capture": Int(capMs * 1000), "detect": Int(detMs * 1000),
                          "ocr": Int(ocrMs * 1000), "total": Int(Date().timeIntervalSince(t0) * 1000)],
            "elements": els,
        ]
    } catch {
        return ["ok": false, "error": error.localizedDescription]
    }
}

// ── Main loop ───────────────────────────────────────────────────────────────
log("starting")
if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
if !CGPreflightScreenCaptureAccess() {
    log("denied", "Screen Recording not granted — enable for this helper in System Settings → Privacy & Security → Screen Recording")
}
let modelOk = loadModel()
log("ready", "model=\(modelOk)")

// CGEvent actions need Accessibility permission
if !AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) {
    log("ax-not-granted", "Accessibility permission needed for click/type/key — grant in System Settings → Privacy & Security → Accessibility")
}

// ── Cancel + serial act queue ────────────────────────────────────────────────
// Physical acts run on a dedicated serial queue so the stdin reader stays
// responsive during long ops (doType is 25ms/char — seconds for long text).
// {"cmd":"cancel"} flips cancelRequested; doType checks it per character and
// bail early. cancel deliberately writes NO reply — the JS side treats it as
// fire-and-forget, keeping the reply-per-request FIFO pairing intact.
let actQueue = DispatchQueue(label: "td.acts")
var cancelRequested = false

let stdinSource = DispatchSource.makeReadSource(fileDescriptor: FileHandle.standardInput.fileDescriptor,
                                                queue: DispatchQueue.global())
var lineBuf = Data()
stdinSource.setEventHandler {
    var chunk = Data(count: 1 << 15)
    let n = chunk.withUnsafeMutableBytes { read(FileHandle.standardInput.fileDescriptor, $0.baseAddress, $0.count) }
    if n <= 0 { stdinSource.cancel(); exit(0) }
    lineBuf.append(chunk.prefix(n))
    while let nl = lineBuf.firstIndex(of: 0x0A) {
        let line = lineBuf.prefix(nl); lineBuf = lineBuf.suffix(from: lineBuf.index(after: nl))
        guard let req = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let cmd = req["cmd"] as? String else {
            out(["ok": false, "error": "bad-request"]); continue
        }
        switch cmd {
        case "ping":
            out(["ok": true, "model": modelOk, "side": modelSide])
        case "quit":
            out(["ok": true]); exit(0)
        case "cancel":
            cancelRequested = true
        case "parse":
            Task {
                let res = await runParse(req)
                out(res)
            }
        case "click":
            let x = req["x"] as? Double ?? 0, y = req["y"] as? Double ?? 0
            actQueue.async { cancelRequested = false
                out(["ok": doClick(x, y, button: req["button"] as? String ?? "left",
                                   dbl: req["double"] as? Bool ?? false)]) }
        case "type":
            let text = req["text"] as? String ?? ""
            actQueue.async { cancelRequested = false
                let r = doType(text)
                out(["ok": r, "cancelled": cancelRequested]) }
        case "key":
            actQueue.async { cancelRequested = false
                out(["ok": doKey(req["key"] as? String ?? "", req["mods"] as? [String] ?? [])]) }
        case "scroll":
            actQueue.async { cancelRequested = false
                out(["ok": doScroll(req["x"] as? Double ?? 0, req["y"] as? Double ?? 0,
                                    req["dx"] as? Int ?? 0, req["dy"] as? Int ?? 0)]) }
        case "move":
            actQueue.async { cancelRequested = false
                out(["ok": doMove(req["x"] as? Double ?? 0, req["y"] as? Double ?? 0)]) }
        case "cursorfind":
            Task { out(await doCursorFind(req)) }
        case "calibrate":
            Task { out(await doCalibrate()) }
        case "focus":
            actQueue.async { cancelRequested = false
                out(["ok": doFocus(bundle: req["bundle"] as? String, appName: req["app"] as? String)]) }
        case "menubar":
            out(doMenubar())
        default:
            out(["ok": false, "error": "unknown-cmd:\(cmd)"])
        }
    }
}
stdinSource.resume()
dispatchMain()
