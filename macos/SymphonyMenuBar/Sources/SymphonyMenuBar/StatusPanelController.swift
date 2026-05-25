import AppKit
import SwiftUI

@MainActor
final class StatusPanelController {
    static let shared = StatusPanelController()

    private var panel: NSPanel?
    private let launchService = StatusService()
    private weak var service: StatusService?

    private init() {}

    func show() {
        show(statusService: launchService)
    }

    func show(statusService: StatusService) {
        service = statusService
        statusService.start()

        if let panel {
            panel.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let content = NSHostingView(rootView: SymphonyPanelView(service: statusService))
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 500),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "Symphony"
        panel.isFloatingPanel = false
        panel.level = .normal
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.contentView = content
        panel.isReleasedWhenClosed = false
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.panel = panel
    }
}
