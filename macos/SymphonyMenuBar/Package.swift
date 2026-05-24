// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SymphonyMenuBar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "SymphonyMenuBar", targets: ["SymphonyMenuBar"])
    ],
    targets: [
        .executableTarget(
            name: "SymphonyMenuBar",
            path: "Sources/SymphonyMenuBar"
        )
    ]
)
