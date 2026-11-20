import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
// Original Flashback mark: two tilted snapshots with a lens. Opaque, full-bleed
// 1024 px art; iOS applies the icon mask. Run: swift scripts/make-icon.swift
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let c = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 4096, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGColor { CGColor(colorSpace: space, components: [r, g, b, 1])! }
c.setFillColor(color(0.106, 0.063, 0.2)); c.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
func card(_ angle: CGFloat, _ center: CGPoint, _ fill: CGColor) {
    c.saveGState(); c.translateBy(x: center.x, y: center.y); c.rotate(by: angle * .pi / 180)
    c.addPath(CGPath(roundedRect: CGRect(x: -290, y: -250, width: 580, height: 500), cornerWidth: 80, cornerHeight: 80, transform: nil))
    c.setFillColor(fill); c.fillPath(); c.restoreGState()
}
card(8, CGPoint(x: 470, y: 500), color(1, 0.81, 0.29))
card(-7, CGPoint(x: 560, y: 520), color(1, 0.365, 0.561))
c.setFillColor(color(0.106, 0.063, 0.2)); c.fillEllipse(in: CGRect(x: 440, y: 400, width: 240, height: 240))
c.setFillColor(color(0.486, 0.906, 1)); c.fillEllipse(in: CGRect(x: 510, y: 470, width: 100, height: 100))
let url = URL(fileURLWithPath: "Flashback/Resources/Assets.xcassets/AppIcon.appiconset/icon.png")
let d = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(d, c.makeImage()!, nil); precondition(CGImageDestinationFinalize(d))
