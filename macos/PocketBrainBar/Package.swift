// swift-tools-version:5.9
// SPDX-License-Identifier: AGPL-3.0-only
// The pocketBrain menu-bar app. Build: macos/PocketBrainBar/build.sh (docs/menubar.md).
import PackageDescription

let package = Package(
    name: "PocketBrainBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "PocketBrainBar", path: "Sources/PocketBrainBar")
    ]
)
