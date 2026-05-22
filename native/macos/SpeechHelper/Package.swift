// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "COTWSpeechHelper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "cotw-speech-helper", targets: ["COTWSpeechHelper"]),
    ],
    targets: [
        .executableTarget(
            name: "COTWSpeechHelper",
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Info.plist",
                ])
            ]
        ),
    ]
)
