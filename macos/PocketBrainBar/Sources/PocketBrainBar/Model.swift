// SPDX-License-Identifier: AGPL-3.0-only
// The JSON `pocketbrain menubar --json` prints. Keep in step with `MenuState` in src/menubar.ts
// (test/menubar.test.ts checks that every field here is one the CLI sends).
import Foundation

struct MenuAgent: Decodable, Identifiable {
    let name: String
    let status: String
    var id: String { name }
}

struct MenuState: Decodable {
    let brain: String
    let brainReady: Bool
    let hubUp: Bool
    let hubUrl: String
    let installed: Bool
    let tunnelInstalled: Bool
    let barDays: Int
    let barTarget: Int
    let barMet: Bool
    let barLine: String
    let agents: [MenuAgent]
    let dashboard: Bool
    let problems: [String]

    // Same words as menuTitle() in src/menubar.ts.
    var title: String {
        "\(problems.isEmpty ? "" : "⚠ ")\(hubUp ? "●" : "○") \(barMet ? "bar met" : "day \(barDays)/\(barTarget)")"
    }
}

// What `pocketbrain menubar setup --json` prints. Keep in step with `SetupResult` in src/menubar.ts.
struct SetupResult: Decodable {
    let brain: String
    let agent: String
    let notes: Int
    let token: String
    let mcpUrl: String
    let standing: String
    let installed: [String]
}
