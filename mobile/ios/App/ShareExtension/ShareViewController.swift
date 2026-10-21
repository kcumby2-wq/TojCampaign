import UIKit
import Social
import UniformTypeIdentifiers
import ImageIO
import AVFoundation
import PDFKit
import UserNotifications

/// "Share to TOJ" in the share sheet: photos, videos, web links, PDFs and text.
///
/// Everything is prepared here, on the phone, the same way the New idea screen
/// prepares it: photos shrunk to 1280 px, a video turned into 3 or 6 stills
/// (no sound), a PDF turned into its words. File names are never kept. The
/// result waits in the TOJ inbox until the app opens it; nothing is uploaded
/// from here.
@objc(ShareViewController)
class ShareViewController: SLComposeServiceViewController {
    private static let limits: [String: Int] = ["image": 12, "video": 4, "file": 3, "link": 10]
    private static let gold = UIColor(red: 0.831, green: 0.635, blue: 0.298, alpha: 1)

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "TOJ"
        placeholder = "Your idea, or what it should notice"
        navigationController?.navigationBar.tintColor = Self.gold
    }

    override func isContentValid() -> Bool {
        TOJInbox.groupID != nil
    }

    override func configurationItems() -> [Any]! {
        []
    }

    override func didSelectPost() {
        let note = (contentText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        let context = extensionContext
        DispatchQueue.global(qos: .userInitiated).async {
            let saved = Self.collect(providers, note: note)
            Self.tellTheApp(saved: saved) {
                context?.completeRequest(returningItems: [], completionHandler: nil)
            }
        }
    }

    // MARK: - Reading what was shared (runs off the main thread)

    private static func collect(_ providers: [NSItemProvider], note: String) -> Int {
        guard let folder = TOJInbox.newShareFolder() else { return 0 }
        var items: [TOJShareItem] = []
        var counts: [String: Int] = [:]
        var itemNo = 0
        func room(_ kind: String) -> Bool { (counts[kind] ?? 0) < (Self.limits[kind] ?? 0) }
        func nextPrefix() -> String { itemNo += 1; return "\(itemNo)" }
        func add(_ item: TOJShareItem?) {
            guard let item = item else { return }
            items.append(item)
            counts[item.kind, default: 0] += 1
        }

        for p in providers {
            if p.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                if room("video") { add(Self.video(p, folder: folder, prefix: nextPrefix())) }
            } else if p.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                if room("image") { add(Self.image(p, folder: folder, name: nextPrefix() + ".jpg")) }
            } else if p.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
                if room("file") { add(Self.pdf(p)) }
            } else if p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                if room("link") { add(Self.link(p)) }
            } else if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                add(Self.text(p, linkRoom: room("link"), fileRoom: room("file")))
            }
        }

        if items.isEmpty && note.isEmpty {
            try? FileManager.default.removeItem(at: folder)
            return 0
        }
        let ok = TOJInbox.save(TOJShare(createdAt: Date(), note: String(note.prefix(4000)), items: items), in: folder)
        if !ok { try? FileManager.default.removeItem(at: folder) }
        return ok ? max(items.count, 1) : 0
    }

    /// Waits for an item provider callback (they arrive on a background queue).
    private static func wait<T>(_ body: (@escaping (T?) -> Void) -> Void) -> T? {
        let done = DispatchSemaphore(value: 0)
        var result: T?
        body { value in
            result = value
            done.signal()
        }
        _ = done.wait(timeout: .now() + 60)
        return result
    }

    private static func image(_ p: NSItemProvider, folder: URL, name: String) -> TOJShareItem? {
        // A file first (Photos, Files); otherwise whatever object the app handed over.
        let fromFile: Data? = Self.wait { done in
            p.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
                done(url.flatMap { Self.shrink(source: CGImageSourceCreateWithURL($0 as CFURL, nil), max: 1280, quality: 0.82) })
            }
        }
        let data: Data? = fromFile ?? Self.wait { done in
            p.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { obj, _ in
                if let img = obj as? UIImage, let raw = img.jpegData(compressionQuality: 0.95) {
                    done(Self.shrink(source: CGImageSourceCreateWithData(raw as CFData, nil), max: 1280, quality: 0.82))
                } else if let raw = obj as? Data {
                    done(Self.shrink(source: CGImageSourceCreateWithData(raw as CFData, nil), max: 1280, quality: 0.82))
                } else if let url = obj as? URL {
                    done(Self.shrink(source: CGImageSourceCreateWithURL(url as CFURL, nil), max: 1280, quality: 0.82))
                } else {
                    done(nil)
                }
            }
        }
        guard let jpeg = data, (try? jpeg.write(to: folder.appendingPathComponent(name))) != nil else { return nil }
        return TOJShareItem(kind: "image", files: [name])
    }

    private static func video(_ p: NSItemProvider, folder: URL, prefix: String) -> TOJShareItem? {
        // The file only exists inside the callback, so the stills are made there.
        let made: (files: [String], at: [Double], duration: Double)? = Self.wait { done in
            p.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier) { url, _ in
                guard let url = url else { return done(nil) }
                let asset = AVURLAsset(url: url)
                let duration = CMTimeGetSeconds(asset.duration)
                guard duration.isFinite, duration > 0 else { return done(nil) }
                let gen = AVAssetImageGenerator(asset: asset)
                gen.appliesPreferredTrackTransform = true
                gen.maximumSize = CGSize(width: 768, height: 768)
                let tolerance = CMTime(seconds: min(0.5, duration / 20), preferredTimescale: 600)
                gen.requestedTimeToleranceBefore = tolerance
                gen.requestedTimeToleranceAfter = tolerance
                let n = duration < 6 ? 3 : 6
                var files: [String] = []
                var at: [Double] = []
                for i in 0..<n {
                    let t = duration * (Double(i) + 0.5) / Double(n)
                    guard let cg = try? gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil),
                          let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.72) else { continue }
                    let file = "\(prefix)-\(i).jpg"
                    if (try? jpeg.write(to: folder.appendingPathComponent(file))) != nil {
                        files.append(file)
                        at.append(t)
                    }
                }
                done(files.isEmpty ? nil : (files: files, at: at, duration: duration))
            }
        }
        guard let m = made else { return nil }
        return TOJShareItem(kind: "video", files: m.files, at: m.at, duration: m.duration)
    }

    private static func pdf(_ p: NSItemProvider) -> TOJShareItem? {
        let words: String? = Self.wait { done in
            p.loadFileRepresentation(forTypeIdentifier: UTType.pdf.identifier) { url, _ in
                done(url.flatMap { PDFDocument(url: $0)?.string })
            }
        }
        guard let text = words?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return TOJShareItem(kind: "file", text: String(text.prefix(60000)))
    }

    private static func link(_ p: NSItemProvider) -> TOJShareItem? {
        let url: URL? = Self.wait { done in
            p.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { obj, _ in
                if let u = obj as? URL { done(u) } else if let s = obj as? String { done(URL(string: s)) } else { done(nil) }
            }
        }
        guard let u = url, let scheme = u.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
        return TOJShareItem(kind: "link", url: String(u.absoluteString.prefix(2000)))
    }

    private static func text(_ p: NSItemProvider, linkRoom: Bool, fileRoom: Bool) -> TOJShareItem? {
        let s: String? = Self.wait { done in
            p.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { obj, _ in
                done((obj as? String) ?? (obj as? Data).flatMap { String(data: $0, encoding: .utf8) })
            }
        }
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        if linkRoom, !t.contains(" "), let u = URL(string: t), let scheme = u.scheme?.lowercased(), scheme == "https" || scheme == "http" {
            return TOJShareItem(kind: "link", url: String(t.prefix(2000)))
        }
        // Long pasted text reads as a file; a line or two goes into the idea.
        if t.count > 600 {
            return fileRoom ? TOJShareItem(kind: "file", text: String(t.prefix(60000))) : nil
        }
        return TOJShareItem(kind: "text", text: t)
    }

    /// Shrinks an image with ImageIO (low memory, keeps the right way up) and makes a JPEG.
    private static func shrink(source: CGImageSource?, max: Int, quality: CGFloat) -> Data? {
        guard let src = source else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return UIImage(cgImage: cg).jpegData(compressionQuality: quality)
    }

    // MARK: - Letting the person know

    /// If TOJ may send notifications, one that says the share is waiting.
    /// Opening TOJ shows it in New idea either way.
    private static func tellTheApp(saved: Int, then finish: @escaping () -> Void) {
        guard saved > 0 else { return finish() }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return finish() }
            let content = UNMutableNotificationContent()
            content.title = "Saved to TOJ"
            content.body = "Open TOJ to turn it into a brief."
            content.threadIdentifier = "shared"
            content.userInfo = ["url": "/app/#new/shared"]
            let request = UNNotificationRequest(identifier: "toj-shared", content: content, trigger: nil)
            center.add(request) { _ in finish() }
        }
    }
}
