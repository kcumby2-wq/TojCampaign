import Foundation
import Capacitor

/// Hands things shared to TOJ (from Photos, Safari, Files...) to the web app.
///
///   SharedInbox.count()  → { count }
///   SharedInbox.take()   → { shares: [{ note, createdAt, items: [...] }] }
///
/// take() removes what it returns from the phone, so each share is opened once.
/// Images come back as base64 JPEG for the New idea screen to show and send.
@objc(SharedInboxPlugin)
public class SharedInboxPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SharedInboxPlugin"
    public let jsName = "SharedInbox"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "count", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise)
    ]

    @objc func count(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            call.resolve(["count": TOJInbox.pending().count])
        }
    }

    @objc func take(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            let iso = ISO8601DateFormatter()
            var shares: [[String: Any]] = []
            for (folder, share) in TOJInbox.pending() {
                var items: [[String: Any]] = []
                for item in share.items {
                    var out: [String: Any] = ["kind": item.kind]
                    if let files = item.files {
                        out["images"] = files.filter(TOJInbox.safeName).compactMap { name -> String? in
                            (try? Data(contentsOf: folder.appendingPathComponent(name)))?.base64EncodedString()
                        }
                    }
                    if let at = item.at { out["at"] = at }
                    if let duration = item.duration { out["duration"] = duration }
                    if let text = item.text { out["text"] = text }
                    if let url = item.url { out["url"] = url }
                    items.append(out)
                }
                shares.append(["note": share.note, "createdAt": iso.string(from: share.createdAt), "items": items])
                try? FileManager.default.removeItem(at: folder)
            }
            call.resolve(["shares": shares])
        }
    }
}
