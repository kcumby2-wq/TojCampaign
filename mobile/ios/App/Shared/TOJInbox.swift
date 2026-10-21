import Foundation

/// Things shared to TOJ from other apps wait here, on the phone, until the
/// TOJ app opens them and puts them into a new idea. Nothing in the inbox is
/// uploaded by the Share extension; the app sends it to the Brief Writer only
/// when the person taps "Write the brief", the same as photos picked in the app.
///
/// Layout, inside the App Group container both targets can read:
///   Inbox/<created ms>-<uuid>/share.json    written last, so a half-written share is never read
///   Inbox/<created ms>-<uuid>/<n>.jpg       photos (max 1280 px) and video stills (max 768 px)
enum TOJInbox {
    /// Shares nobody opened within a week are deleted.
    static let maxAge: TimeInterval = 7 * 24 * 3600
    /// A folder with no share.json after an hour was abandoned mid-write.
    static let abandonAfter: TimeInterval = 3600

    static var groupID: String? {
        let id = Bundle.main.object(forInfoDictionaryKey: "TOJAppGroup") as? String
        return (id?.isEmpty == false) ? id : nil
    }

    static func root() -> URL? {
        guard let id = groupID,
              let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id) else { return nil }
        let url = base.appendingPathComponent("Inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func newShareFolder() -> URL? {
        guard let root = root() else { return nil }
        let ms = Int64(Date().timeIntervalSince1970 * 1000)
        let url = root.appendingPathComponent("\(ms)-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            return url
        } catch {
            return nil
        }
    }

    static func save(_ share: TOJShare, in folder: URL) -> Bool {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        guard let data = try? enc.encode(share) else { return false }
        return (try? data.write(to: folder.appendingPathComponent("share.json"), options: .atomic)) != nil
    }

    /// Shares waiting to be opened, oldest first. Clears out expired and abandoned folders.
    static func pending() -> [(folder: URL, share: TOJShare)] {
        guard let root = root(),
              let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return [] }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        let now = Date()
        var out: [(URL, TOJShare)] = []
        for name in names {
            let folder = root.appendingPathComponent(name, isDirectory: true)
            let made = Double(name.split(separator: "-").first ?? "").map { Date(timeIntervalSince1970: $0 / 1000) }
            guard let data = try? Data(contentsOf: folder.appendingPathComponent("share.json")),
                  let share = try? dec.decode(TOJShare.self, from: data) else {
                if let made = made, now.timeIntervalSince(made) > abandonAfter { try? FileManager.default.removeItem(at: folder) }
                continue
            }
            if now.timeIntervalSince(share.createdAt) > maxAge {
                try? FileManager.default.removeItem(at: folder)
                continue
            }
            out.append((folder, share))
        }
        return out.sorted { $0.1.createdAt < $1.1.createdAt }
    }

    /// A file name we wrote ourselves: no folders, no dots at the front.
    static func safeName(_ name: String) -> Bool {
        !name.isEmpty && !name.hasPrefix(".") && !name.contains("/") && !name.contains("\\")
    }
}

struct TOJShare: Codable {
    var createdAt: Date
    var note: String
    var items: [TOJShareItem]
}

/// One thing that was shared. The kinds match the New idea screen:
///   image  files: [one jpg]
///   video  files: the stills, at: when each was taken (seconds), duration
///   file   text: the words in a PDF or text file (never the file name)
///   link   url
///   text   text (added to the idea)
struct TOJShareItem: Codable {
    var kind: String
    var files: [String]?
    var at: [Double]?
    var duration: Double?
    var text: String?
    var url: String?
}
