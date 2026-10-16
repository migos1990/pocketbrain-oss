// SPDX-License-Identifier: AGPL-3.0-only
// pocketBrain in the Mac menu bar: is the hub up, which day of the real-use bar, open the
// dashboard, pause or cut off an agent, install or restart the hub. docs/menubar.md.
import SwiftUI
import AppKit

@MainActor
final class Store: ObservableObject {
    @Published var state: MenuState?
    @Published var problem: String?
    @Published var lastResult: String?
    // nil when bun or the app folder can't be trusted (Runner.swift); the menu says so.
    let runner = Runner.fromBuild()
    private var timer: Timer?

    init() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh() {
        guard let runner = self.runner else {
            state = nil
            problem = "Can't find a trusted bun (\(Runner.bunPaths.joined(separator: " or "))) or the pocketBrain folder this app was built from. Rebuild it with macos/PocketBrainBar/build.sh."
            return
        }
        Task.detached {
            let r = runner.state()
            let decoded = r.code == 0 ? try? JSONDecoder().decode(MenuState.self, from: Data(r.out.utf8)) : nil
            await MainActor.run {
                self.state = decoded
                self.problem = decoded == nil ? String(r.out.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200)) : nil
            }
        }
    }

    func act(_ args: [String]) {
        guard let runner = self.runner else { return }
        Task.detached {
            let r = runner.run(args)
            await MainActor.run {
                self.lastResult = String(r.out.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
                self.refresh()
            }
        }
    }

    // Revoking can't be undone from the menu (the agent needs a new token), so ask first.
    func confirmRevoke(_ agent: String, brain: String) {
        let a = NSAlert()
        a.messageText = "Cut \(agent) off?"
        a.informativeText = "Its tokens stop working now and its sign-in connections are removed. To let it back in you connect it again."
        a.addButton(withTitle: "Cut off")
        a.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        if a.runModal() == .alertFirstButtonReturn { act(["agent", "revoke", agent, "--brain", brain]) }
    }
}

@main
struct PocketBrainBar: App {
    @StateObject private var store = Store()

    var body: some Scene {
        MenuBarExtra(store.state?.title ?? "○ pocketBrain") {
            MenuContent(store: store)
        }
        Window("Set up pocketBrain", id: "setup") {
            if let runner = store.runner {
                SetupView(runner: runner) {
                    store.refresh()
                    NSApp.keyWindow?.close()
                }
            }
        }
        .windowResizability(.contentSize)
    }
}

struct MenuContent: View {
    @ObservedObject var store: Store
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if let s = store.state, !s.brainReady {
            Text("No brain on this Mac yet")
            Button("Set up pocketBrain…") {
                openWindow(id: "setup")
                NSApp.activate(ignoringOtherApps: true)
            }
        } else if let s = store.state {
            Text(s.hubUp ? "Hub running" : (s.installed ? "Hub not answering" : "Hub not installed"))
            Text(s.barLine).lineLimit(3)
            Divider()
            // The CLI opens it: the signed-in link never passes through this app.
            if s.dashboard {
                Button("Open dashboard") { store.act(["menubar", "open-dashboard"]) }
            } else {
                Text(s.hubUp ? "Dashboard link not in the hub's log yet" : "Dashboard needs the hub")
            }
            if s.installed {
                Button("Restart hub") { store.act(["menubar", "restart"]) }
            } else {
                Button("Install hub") { store.act(["menubar", "install", "--brain", s.brain]) }
            }
            if !s.agents.isEmpty {
                Divider()
                Text("Assistants")
                ForEach(s.agents) { a in
                    Menu("\(a.name): \(a.status)") {
                        // The menu only tightens a switch; resuming is on the dashboard, behind your login.
                        if a.status == "active" { Button("Read-only") { store.act(["agent", "read-only", a.name, "--brain", s.brain]) } }
                        if a.status != "paused" { Button("Pause") { store.act(["agent", "pause", a.name, "--brain", s.brain]) } }
                        if a.status != "active" { Button("Resume on the dashboard…") { store.act(["menubar", "open-dashboard"]) } }
                        Divider()
                        Button("Cut off…") { store.confirmRevoke(a.name, brain: s.brain) }
                    }
                }
            }
        } else {
            Text("pocketBrain isn't answering")
            if let p = store.problem, !p.isEmpty { Text(p).lineLimit(4) }
        }
        if let r = store.lastResult, !r.isEmpty {
            Divider()
            Text(r).lineLimit(3)
        }
        Divider()
        Button("Refresh") { store.refresh() }
        Button("Quit") { NSApp.terminate(nil) }
    }
}
