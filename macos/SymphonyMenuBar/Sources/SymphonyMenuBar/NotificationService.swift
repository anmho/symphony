import Foundation
import SymphonyMenuBarCore
import UserNotifications

@MainActor
final class NotificationService: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationService()

    private override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    func requestAuthorizationIfNeeded() {
        guard AppSettings.load().notificationsEnabled else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func post(_ notification: StatusNotification) {
        guard AppSettings.load().notificationsEnabled else { return }

        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: "\(notification.identifier).\(Int(Date().timeIntervalSince1970))",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
