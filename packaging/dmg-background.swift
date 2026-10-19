import AppKit

// Regenerate with: swift packaging/dmg-background.swift
let width = 660.0
let height = 400.0
let image = NSImage(size: NSSize(width: width, height: height))
image.lockFocus()

let rect = NSRect(x: 0, y: 0, width: width, height: height)
let gradient = NSGradient(colors: [
    NSColor(calibratedRed: 0.975, green: 0.995, blue: 0.985, alpha: 1),
    NSColor(calibratedRed: 0.865, green: 0.965, blue: 0.930, alpha: 1),
])!
gradient.draw(in: rect, angle: 0)

NSColor.white.withAlphaComponent(0.38).setFill()
NSBezierPath(ovalIn: NSRect(x: -90, y: 210, width: 260, height: 260)).fill()
NSColor.white.withAlphaComponent(0.20).setFill()
NSBezierPath(ovalIn: NSRect(x: 500, y: -70, width: 230, height: 230)).fill()

let title = "拖动 cup-translate 到 Applications"
let attributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 16, weight: .medium),
    .foregroundColor: NSColor(calibratedWhite: 0.34, alpha: 1),
]
let titleSize = title.size(withAttributes: attributes)
title.draw(
    at: NSPoint(x: (width - titleSize.width) / 2, y: 345),
    withAttributes: attributes
)

let arrowColor = NSColor(calibratedRed: 0.10, green: 0.62, blue: 0.48, alpha: 0.92)
arrowColor.setStroke()
let shaft = NSBezierPath()
shaft.lineWidth = 10
shaft.lineCapStyle = .round
shaft.move(to: NSPoint(x: 292, y: 200))
shaft.line(to: NSPoint(x: 366, y: 200))
shaft.stroke()

let head = NSBezierPath()
head.move(to: NSPoint(x: 355, y: 224))
head.line(to: NSPoint(x: 392, y: 200))
head.line(to: NSPoint(x: 355, y: 176))
head.close()
arrowColor.setFill()
head.fill()

image.unlockFocus()
let tiff = image.tiffRepresentation!
let bitmap = NSBitmapImageRep(data: tiff)!
let png = bitmap.representation(using: .png, properties: [:])!
try png.write(to: URL(fileURLWithPath: "packaging/dmg-background.png"))
