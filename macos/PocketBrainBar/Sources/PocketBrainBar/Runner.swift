// SPDX-License-Identifier: AGPL-3.0-only
// Runs the pocketbrain CLI. All the logic lives there (src/menubar.ts); this file only finds bun
// and the app folder and passes arguments through, never through a shell.
//
// Neither path comes from a setting another program could write (user defaults, the environment):
// that would let it run its own code with the owner's switches (red team rt-menubar-rce). bun is
// one of two fixed Homebrew paths; the app folder is the one build.sh baked into Info.plist.
// Both must be owned by the user or root and writable by no one else.
import Foundation

struct Runner {
    let bun: String
    let app: String

    static let bunPaths = ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"]

    // A file or folder only its owner (the user, or root) can change.
    static func isTrusted(_ path: String) -> Bool {
        let fm = FileManager.default
        guard let real = try? fm.destinationOfSymbolicLink(atPath: path) else { return isTrustedFile(path) }
        let target = real.hasPrefix("/") ? real : (path as NSString).deletingLastPathComponent + "/" + real
        return isTrustedFile(path) && isTrustedFile(target)
    }

    private static func isTrustedFile(_ path: String) -> Bool {
        guard let a = try? FileManager.default.attributesOfItem(atPath: path),
              let owner = a[.ownerAccountID] as? NSNumber,
              let perms = a[.posixPermissions] as? NSNumber else { return false }
        let mine = owner.uint32Value == getuid() || owner.uint32Value == 0
        let othersCanWrite = perms.uint16Value & 0o022 != 0
        return mine && !othersCanWrite
    }

    // nil when bun or the app folder is missing or not trusted; the menu then says what to fix.
    static func fromBuild() -> Runner? {
        guard let bun = bunPaths.first(where: { FileManager.default.isExecutableFile(atPath: $0) && isTrusted($0) }),
              let app = Bundle.main.object(forInfoDictionaryKey: "PocketBrainApp") as? String,
              isTrusted(app), isTrusted("\(app)/src"), isTrusted("\(app)/src/cli.ts") else { return nil }
        return Runner(bun: bun, app: app)
    }

    struct Result { let code: Int32; let out: String }

    func run(_ args: [String]) -> Result {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bun)
        p.arguments = ["\(app)/src/cli.ts"] + args
        p.currentDirectoryURL = URL(fileURLWithPath: app)
        // An app opened from Finder gets a bare PATH; git and cloudflared live in Homebrew's.
        p.environment = ["PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                         "HOME": FileManager.default.homeDirectoryForCurrentUser.path]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return Result(code: -1, out: "can't run \(bun): \(error.localizedDescription)") }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return Result(code: p.terminationStatus, out: String(decoding: data, as: UTF8.self))
    }

    func state() -> Result { run(["menubar", "--json"]) }
}
