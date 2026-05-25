#!/usr/bin/env swift
import AppKit
import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments[0])
    .deletingLastPathComponent()
    .deletingLastPathComponent()
let resources = root.appendingPathComponent("Resources")
let iconset = resources.appendingPathComponent("AppIcon.iconset")
let output = resources.appendingPathComponent("AppIcon.icns")

if FileManager.default.fileExists(atPath: iconset.path) {
    try FileManager.default.removeItem(at: iconset)
}
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

func drawIcon(size: CGFloat) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()

    let rect = NSRect(x: 0, y: 0, width: size, height: size)
    let background = NSColor(calibratedRed: 0.094, green: 0.125, blue: 0.122, alpha: 1)
    background.setFill()
    NSBezierPath(roundedRect: rect, xRadius: size * 0.164, yRadius: size * 0.164).fill()

    let ring = NSColor(calibratedRed: 0.91, green: 0.925, blue: 0.895, alpha: 0.17)
    let point = NSColor(calibratedRed: 0.482, green: 0.561, blue: 0.639, alpha: 1)

    func rectOnGrid(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat) -> NSRect {
        NSRect(x: size * x, y: size * y, width: size * w, height: size * h)
    }

    ring.setStroke()
    let orbit = NSBezierPath(ovalIn: rectOnGrid(x: 48 / 256, y: 48 / 256, w: 160 / 256, h: 160 / 256))
    orbit.lineWidth = max(size * (1.5 / 256), 1)
    orbit.stroke()

    let pointRect = rectOnGrid(x: 112 / 256, y: 112 / 256, w: 48 / 256, h: 48 / 256)
    point.setFill()
    NSBezierPath(ovalIn: pointRect).fill()

    image.unlockFocus()
    return image
}

func writePNG(_ image: NSImage, to url: URL) throws {
    guard
        let tiff = image.tiffRepresentation,
        let rep = NSBitmapImageRep(data: tiff),
        let png = rep.representation(using: .png, properties: [:])
    else {
        throw NSError(domain: "GenerateIcon", code: 1)
    }
    try png.write(to: url)
}

let sizes: [(Int, String)] = [
    (16, "icon_16x16.png"),
    (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"),
    (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"),
    (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"),
    (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"),
    (1024, "icon_512x512@2x.png")
]

for (size, name) in sizes {
    let image = drawIcon(size: CGFloat(size))
    try writePNG(image, to: iconset.appendingPathComponent(name))
}

func appendUInt32BE(_ value: UInt32, to data: inout Data) {
    var bigEndian = value.bigEndian
    withUnsafeBytes(of: &bigEndian) { data.append(contentsOf: $0) }
}

func appendOSType(_ value: String, to data: inout Data) {
    data.append(contentsOf: value.utf8)
}

func writeICNSFallback(from iconset: URL, to output: URL) throws {
    let entries: [(type: String, name: String)] = [
        ("ic11", "icon_16x16@2x.png"),
        ("ic12", "icon_32x32@2x.png"),
        ("ic07", "icon_128x128.png"),
        ("ic08", "icon_256x256.png"),
        ("ic09", "icon_512x512.png"),
        ("ic10", "icon_512x512@2x.png"),
        ("ic13", "icon_128x128@2x.png"),
        ("ic14", "icon_256x256@2x.png")
    ]

    var chunks: [(type: String, data: Data)] = []
    for entry in entries {
        let png = try Data(contentsOf: iconset.appendingPathComponent(entry.name))
        chunks.append((entry.type, png))
    }

    let totalLength = chunks.reduce(UInt32(8)) { total, chunk in
        total + UInt32(8 + chunk.data.count)
    }

    var icns = Data()
    appendOSType("icns", to: &icns)
    appendUInt32BE(totalLength, to: &icns)
    for chunk in chunks {
        appendOSType(chunk.type, to: &icns)
        appendUInt32BE(UInt32(8 + chunk.data.count), to: &icns)
        icns.append(chunk.data)
    }

    try icns.write(to: output)
}

let task = Process()
task.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
task.arguments = ["-c", "icns", iconset.path, "-o", output.path]
try task.run()
task.waitUntilExit()
if task.terminationStatus != 0 {
    fputs("iconutil failed; writing fallback icns container\n", stderr)
    try writeICNSFallback(from: iconset, to: output)
}

try FileManager.default.removeItem(at: iconset)
print(output.path)
