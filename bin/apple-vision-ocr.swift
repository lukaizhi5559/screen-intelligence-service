#!/usr/bin/env swift

import Foundation
import Vision
import AppKit

/// Apple Vision Framework OCR
/// Extracts text with bounding boxes from images
/// Output: JSON with words array

// Check command line arguments
guard CommandLine.arguments.count > 1 else {
    let error = ["error": "Usage: apple-vision-ocr <image-path>"]
    if let jsonData = try? JSONSerialization.data(withJSONObject: error),
       let jsonString = String(data: jsonData, encoding: .utf8) {
        print(jsonString)
    }
    exit(1)
}

let imagePath = CommandLine.arguments[1]

// Load image
guard let image = NSImage(contentsOfFile: imagePath) else {
    let error = ["error": "Failed to load image: \(imagePath)"]
    if let jsonData = try? JSONSerialization.data(withJSONObject: error),
       let jsonString = String(data: jsonData, encoding: .utf8) {
        print(jsonString)
    }
    exit(1)
}

guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    let error = ["error": "Failed to convert image to CGImage"]
    if let jsonData = try? JSONSerialization.data(withJSONObject: error),
       let jsonString = String(data: jsonData, encoding: .utf8) {
        print(jsonString)
    }
    exit(1)
}

// Create OCR request with FAST settings for real-time performance
let request = VNRecognizeTextRequest()
request.recognitionLevel = .fast  // Use fast mode instead of accurate (3-5x faster)
request.usesLanguageCorrection = false  // Disable language correction for speed
request.recognitionLanguages = ["en-US"]
request.minimumTextHeight = 0.03  // Skip very small text for speed

// Perform OCR
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
    try handler.perform([request])
} catch {
    let errorDict = ["error": "OCR failed: \(error.localizedDescription)"]
    if let jsonData = try? JSONSerialization.data(withJSONObject: errorDict),
       let jsonString = String(data: jsonData, encoding: .utf8) {
        print(jsonString)
    }
    exit(1)
}

// Extract results with bounding boxes
var words: [[String: Any]] = []

if let observations = request.results {
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        
        let text = candidate.string
        let bbox = observation.boundingBox
        let confidence = candidate.confidence
        
        // Convert normalized bbox (0-1) to pixel coordinates
        let imageWidth = Double(cgImage.width)
        let imageHeight = Double(cgImage.height)
        
        // Vision uses bottom-left origin, we need top-left
        let x1 = Int(bbox.minX * imageWidth)
        let y1 = Int((1.0 - bbox.maxY) * imageHeight)
        let x2 = Int(bbox.maxX * imageWidth)
        let y2 = Int((1.0 - bbox.minY) * imageHeight)
        
        words.append([
            "text": text,
            "bbox": [x1, y1, x2, y2],
            "confidence": Double(confidence)
        ])
    }
}

// Output JSON
let result: [String: Any] = [
    "success": true,
    "words": words,
    "count": words.count,
    "imageSize": [cgImage.width, cgImage.height],
    "source": "apple_vision"
]

if let jsonData = try? JSONSerialization.data(withJSONObject: result, options: .prettyPrinted),
   let jsonString = String(data: jsonData, encoding: .utf8) {
    print(jsonString)
} else {
    let error = ["error": "Failed to serialize JSON"]
    if let jsonData = try? JSONSerialization.data(withJSONObject: error),
       let jsonString = String(data: jsonData, encoding: .utf8) {
        print(jsonString)
    }
    exit(1)
}

exit(0)
