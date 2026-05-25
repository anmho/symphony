#!/usr/bin/env swift
import AppKit
import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments[0])
    .deletingLastPathComponent()
    .deletingLastPathComponent()
let resources = root.appendingPathComponent("Resources")
let iconset = resources.appendingPathComponent("AppIcon.iconset")
let output = resources.appendingPathComponent("AppIcon.icns")

try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

func drawIcon(size: CGFloat) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()

    let rect = NSRect(x: 0, y: 0, width: size, height: size)
    let background = NSColor(calibratedRed: 0.08, green: 0.10, blue: 0.18, alpha: 1)
    background.setFill()
    NSBezierPath(roundedRect: rect, xRadius: size * 0.18, yRadius: size * 0.18).fill()

    let accent = NSColor(calibratedRed: 0.35, green: 0.72, blue: 1.0, alpha: 1)
    accent.setStroke()

    let wave = NSBezierPath()
    wave.lineWidth = max(size * 0.05, 2)
    wave.lineCapStyle = .round
    let midY = size * 0.52
    wave.move(to: NSPoint(x: size * 0.22, y: midY))
    wave.curve(
        to: NSPoint(x: size * 0.42, y: midY),
        controlPoint1: NSPoint(x: size * 0.28, y: midY + size * 0.18),
        controlPoint2: NSPoint(x: size * 0.36, y: midY - size * 0.18)
    )
    wave.curve(
        to: NSPoint(x: size * 0.62, y: midY),
        controlPoint1: NSPoint(x: size * 0.48, y: midY + size * 0.18),
        controlPoint2: NSPoint(x: size * 0.56, y: midY - size * 0.18)
    )
    wave.curve(
        to: NSPoint(x: size * 0.78, y: midY),
        controlPoint1: NSPoint(x: size * 0.68, y: midY + size * 0.12),
        controlPoint2: NSPoint(x: size * 0.74, y: midY - size * 0.12)
    )
    wave.stroke()

  let note = NSBezierPath()
    note.lineWidth = max(size * 0.045, 2)
    note.move(to: NSPoint(x: size * 0.30, y: size * 0.30))
    note.line(to: NSPoint(x: size * 0.30, y: size * 0.58))
    note.line(to: NSPoint(x: size * 0.48, y: size * 0.52))
    note.line(to: NSPoint(x: size * 0.48, y: size * 0.24))
    note.stroke()
    NSBezierPath(ovalIn: NSRect(x: size * 0.22, y: size * 0.22, width: size * 0.12, height: size * 0.10)).fill()

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

let task = Process()
task.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
task.arguments = ["-c", "icns", iconset.path, "-o", output.path]
try task.run()
task.waitUntilExit()
guard task.terminationStatus == 0 else {
    fputs("iconutil failed\n", stderr)
    exit(1)
}

try FileManager.default.removeItem(at: iconset)
print(output.path)
