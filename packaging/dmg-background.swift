import AppKit

// Deterministic 2× artwork and a review composite. Run from the repository root:
// swift packaging/dmg-background.swift [--preview]
// Coordinates below are in Finder points, with a top-left origin.
let width = 800.0, height = 480.0, scale = 2.0
func color(_ hex: String, _ alpha: CGFloat = 1) -> NSColor {
    let n = UInt32(hex, radix: 16)!
    return NSColor(calibratedRed: CGFloat((n >> 16) & 255)/255,
                   green: CGFloat((n >> 8) & 255)/255,
                   blue: CGFloat(n & 255)/255, alpha: alpha)
}
let cream = color("f4f0e6"), ink = color("1d4539"), muted = color("7b8175")
func rect(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> NSRect {
    NSRect(x: x, y: height-y-h, width: w, height: h)
}
func text(_ value: String, _ x: Double, _ y: Double, _ font: NSFont, _ foreground: NSColor, tracking: Double = 0) {
    let style = NSMutableParagraphStyle(); style.lineSpacing = 3
    let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: foreground, .kern: tracking, .paragraphStyle: style]
    let s = NSAttributedString(string: value, attributes: attrs)
    let size = s.size()
    s.draw(at: NSPoint(x:x,y:height-y-size.height))
}
func line(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ c: NSColor, _ weight: Double = 1) {
    c.setStroke(); let p = NSBezierPath(); p.lineWidth = weight
    p.move(to: NSPoint(x:x1,y:height-y1)); p.line(to:NSPoint(x:x2,y:height-y2)); p.stroke()
}
func pill(_ x: Double, _ y: Double, _ w: Double, _ h: Double, _ c: NSColor) {
    c.setFill(); NSBezierPath(roundedRect:rect(x,y,w,h),xRadius:h/2,yRadius:h/2).fill()
}
func drawBackground() {
    cream.setFill(); rect(0,0,width,height).fill()
    NSGradient(starting:color("235c49"),ending:color("103b30"))!.draw(in:rect(0,0,232,height),angle:-90)
    // A typographic language study, rather than a stock illustration.
    text("CUP  /  TRANSLATE",25,31,.systemFont(ofSize:10,weight:.medium),color("e8e9cd"),tracking:2.1)
    line(25,63,207,63,color("e0e6cf",0.28))
    text("Aa",12,84,NSFont(name:"Georgia-Italic",size:133)!,color("f4f0df"))
    text("译",105,196,.systemFont(ofSize:94,weight:.ultraLight),color("c4d7b6",0.65))
    line(29,245,93,245,color("d8bc82"),1.5)
    line(85,239,93,245,color("d8bc82"),1.5)
    line(85,251,93,245,color("d8bc82"),1.5)
    line(94,258,30,258,color("d8bc82"),1.5)
    line(38,252,30,258,color("d8bc82"),1.5)
    line(38,264,30,258,color("d8bc82"),1.5)
    text("A little cup.\nA wider world.",25,345,NSFont(name:"Georgia",size:23)!,color("f4f0df"))
    text("让每一种语言，都更亲近。",26,433,.systemFont(ofSize:10),color("d8e0c9",0.7),tracking:1)
    // Right side: heading, native Finder drop targets, then quiet instructions.
    pill(276,35,59,20,color("e4e8da"))
    text("macOS",286,38,.systemFont(ofSize:10,weight:.medium),ink,tracking:0.4)
    text("Cup Translate",274,71,.systemFont(ofSize:34,weight:.semibold),ink,tracking:-1.1)
    text("让理解，自然发生。",277,120,.systemFont(ofSize:14,weight:.regular),color("626e60"),tracking:1.1)
    line(277,161,755,161,color("d4d6c7"))
    // The actual app and Applications icons are supplied by Finder at these centers:
    // (382, 254), (650, 254). Do not bake fake drop targets into the background.
    pill(484,237,65,28,color("e4e8da"))
    line(501,251,532,251,ink,1.7)
    line(526,245,532,251,ink,1.7)
    line(526,257,532,251,ink,1.7)
    line(277,369,755,369,color("d4d6c7"))
    text("01",278,394,.monospacedSystemFont(ofSize:11,weight:.medium),color("9a855e"))
    text("拖入 Applications，即可安装",309,389,.systemFont(ofSize:15,weight:.medium),ink)
    text("Drag into Applications to install",309,414,.systemFont(ofSize:11),muted)
    text("CUP TRANSLATE  /  DESKTOP",278,453,.monospacedSystemFont(ofSize:8,weight:.regular),color("919582"),tracking:1.1)
}
func render(_ output: String, preview: Bool) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:Int(width*scale),pixelsHigh:Int(height*scale),bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
    bitmap.size = NSSize(width:width,height:height)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep:bitmap)
    drawBackground()
    if preview {
        let app = NSImage(contentsOfFile:"app-icon.png")!
        // Match Finder's 112 pt icon area, including the master's optical padding.
        app.draw(in:rect(326,198,112,112))
        let folder = NSWorkspace.shared.icon(forFile:"/Applications")
        folder.draw(in:rect(594,198,112,112))
        // Finder labels are deliberately only in the review composite.
        let labels = [("cup-translate",382.0),("Applications",650.0)]
        for (label,x) in labels {
            let font=NSFont.systemFont(ofSize:13)
            let w=(label as NSString).size(withAttributes:[.font:font]).width
            text(label,x-w/2,320,font,color("263b32"))
        }
    }
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:output))
    print("Rendered \(output) (1600 × 960; 800 × 480 Finder points)")
}
try render("packaging/dmg-background.png",preview:false)
if CommandLine.arguments.contains("--preview") {
    try FileManager.default.createDirectory(atPath:"docs/design/macos-brand",withIntermediateDirectories:true)
    try render("docs/design/macos-brand/installer-preview.png",preview:true)
}
