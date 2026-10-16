// SPDX-License-Identifier: AGPL-3.0-only
// The first-run window: a new owner types their name, picks a folder and (optionally) a notes file,
// and gets a brain, a running hub and what to paste into their first assistant, with no terminal.
// One CLI call does the work: `pocketbrain menubar setup` (src/menubar.ts setupBrain).
import SwiftUI
import AppKit

struct SetupView: View {
    let runner: Runner
    var onDone: () -> Void

    @State private var name = ""
    @State private var agent = "claude"
    @State private var folder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("my-brain").path
    @State private var notesFile: String?
    @State private var working = false
    @State private var problem: String?
    @State private var result: SetupResult?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let r = result { done(r) } else { form }
        }
        .padding(20)
        .frame(width: 520)
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Set up pocketBrain").font(.title2)
            Text("Your brain is a folder of notes on this Mac. Nothing leaves it unless you connect an assistant.")
                .foregroundStyle(.secondary)
            TextField("Your name", text: $name)
            TextField("Your first assistant (lowercase, e.g. claude)", text: $agent)
            HStack {
                Text(folder).lineLimit(1).truncationMode(.middle)
                Spacer()
                Button("Change…") { pickFolder() }
            }
            HStack {
                Text(notesFile.map { "Notes to start from: \(($0 as NSString).lastPathComponent)" } ?? "No notes file (optional)")
                Spacer()
                Button("Choose…") { pickNotes() }
            }
            if let p = problem { Text(p).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button(working ? "Setting up…" : "Set up") { setUp() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(working || name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func done(_ r: SetupResult) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Your brain is ready").font(.title2)
            Text("\(r.notes) notes in \(r.brain). \(r.installed.isEmpty ? "Start the hub from the menu." : "The hub is running and starts with your Mac.")")
            Text("Connect \(r.agent): add a custom MCP connector with this address and header. The token is shown only once; save it in your password manager.")
            copyRow("Address", r.mcpUrl)
            copyRow("Header", "Authorization: Bearer \(r.token)")
            Text("Then paste this once into \(r.agent)'s own instructions, so it checks your brain without being asked:")
            ScrollView { Text(r.standing).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                .frame(height: 120)
            HStack {
                Button("Copy instruction") { copy(r.standing) }
                Spacer()
                Button("Done") { onDone() }.keyboardShortcut(.defaultAction)
            }
        }
    }

    private func copyRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).frame(width: 60, alignment: .leading)
            Text(value).font(.system(.body, design: .monospaced)).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            Spacer()
            Button("Copy") { copy(value) }
        }
    }

    private func copy(_ s: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }

    private func pickFolder() {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.canCreateDirectories = true
        p.prompt = "Use this folder"
        if p.runModal() == .OK, let u = p.url { folder = u.path }
    }

    private func pickNotes() {
        let p = NSOpenPanel()
        p.canChooseFiles = true
        p.canChooseDirectories = true
        p.prompt = "Start from these notes"
        if p.runModal() == .OK, let u = p.url { notesFile = u.path }
    }

    private func setUp() {
        working = true
        problem = nil
        var args = ["menubar", "setup", "--name", name.trimmingCharacters(in: .whitespaces), "--agent", agent.trimmingCharacters(in: .whitespaces).lowercased(), "--dir", folder]
        if let n = notesFile { args += ["--from-text", n] }
        let runner = self.runner
        Task.detached {
            let r = runner.run(args)
            // The JSON is the last line that is an object; other lines are init's own notes.
            let last = r.out.split(separator: "\n").last { $0.hasPrefix("{") }.map(String.init) ?? ""
            let decoded = r.code == 0 ? try? JSONDecoder().decode(SetupResult.self, from: Data(last.utf8)) : nil
            await MainActor.run {
                working = false
                if let d = decoded { result = d } else { problem = String(r.out.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300)) }
            }
        }
    }
}
