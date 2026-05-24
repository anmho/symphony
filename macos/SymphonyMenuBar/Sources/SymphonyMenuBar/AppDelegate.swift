import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var onboardingWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if terminateDuplicateInstance() {
            return
        }

        if !UserDefaults.standard.bool(forKey: "hasCompletedOnboarding") {
            showOnboarding()
        }
    }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if onboardingWindow == nil, !UserDefaults.standard.bool(forKey: "hasCompletedOnboarding") {
            showOnboarding()
        }
        return true
    }

    private func terminateDuplicateInstance() -> Bool {
        guard let bundleId = Bundle.main.bundleIdentifier else {
            return false
        }

        let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
            .filter { $0.processIdentifier != NSRunningApplication.current.processIdentifier }

        guard let existing = others.first else {
            return false
        }

        existing.activate(options: [.activateIgnoringOtherApps])
        NSApp.terminate(nil)
        return true
    }

    private func showOnboarding() {
        NSApp.activate(ignoringOtherApps: true)

        let content = NSHostingView(
            rootView: OnboardingView {
                UserDefaults.standard.set(true, forKey: "hasCompletedOnboarding")
                self.onboardingWindow?.close()
                self.onboardingWindow = nil
            }
        )

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 360),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Symphony"
        window.contentView = content
        window.isReleasedWhenClosed = false
        window.center()
        window.makeKeyAndOrderFront(nil)
        onboardingWindow = window
    }
}

struct OnboardingView: View {
    let onContinue: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Image(systemName: "waveform.circle.fill")
                    .font(.system(size: 36))
                    .foregroundStyle(.blue)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Symphony lives in your menu bar")
                        .font(.title3.weight(.semibold))
                    Text("There is no Dock icon or main window.")
                        .foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                onboardingStep(
                    number: 1,
                    title: "Find the icon",
                    detail: "Look for the blue waveform icon on the right side of the menu bar."
                )
                onboardingStep(
                    number: 2,
                    title: "Check the overflow menu",
                    detail: "On macOS 15+, new menu bar items may start hidden behind the Control Center chevron (›). Open System Settings → Menu Bar and set Symphony to Show in Menu Bar."
                )
                onboardingStep(
                    number: 3,
                    title: "Click to monitor agents",
                    detail: "The popover shows running Symphony agents and links to Linear tickets."
                )
            }

            HStack {
                Button("Open Menu Bar Settings") {
                    openMenuBarSettings()
                }
                Spacer()
                Button("Got it") {
                    onContinue()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func onboardingStep(number: Int, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(number)")
                .font(.caption.weight(.bold))
                .frame(width: 20, height: 20)
                .background(Color.accentColor.opacity(0.15))
                .clipShape(Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func openMenuBarSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.controlcenter-Settings.extension?MenuBar") {
            NSWorkspace.shared.open(url)
        }
    }
}
