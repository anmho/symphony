// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SymphonyMenuBar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "SymphonyMenuBar", targets: ["SymphonyMenuBar"]),
        .library(name: "SymphonyMenuBarCore", targets: ["SymphonyMenuBarCore"])
    ],
    targets: [
        .target(
            name: "SymphonyMenuBarCore",
            path: "Sources/SymphonyMenuBarCore"
        ),
        .executableTarget(
            name: "SymphonyMenuBar",
            dependencies: ["SymphonyMenuBarCore"],
            path: "Sources/SymphonyMenuBar"
        ),
        .testTarget(
            name: "SymphonyMenuBarTests",
            dependencies: ["SymphonyMenuBarCore"],
            path: "Tests/SymphonyMenuBarTests",
            resources: [.process("Fixtures")]
        )
    ]
)
