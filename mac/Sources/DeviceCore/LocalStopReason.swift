import Foundation

/// Fixed diagnostic codes only. Never stores notification payloads or user content.
public enum LocalStopReason: String, Codable, CaseIterable {
  case explicitLocalStop = "explicit_local_stop"
  case screenParametersChanged = "screen_parameters_changed"
  case screenParametersUnavailable = "screen_parameters_unavailable"
  case workspaceWillSleep = "workspace_will_sleep"
  case sessionResignedActive = "session_resigned_active"
  case screensDidSleep = "screens_did_sleep"
  case screenLocked = "screen_locked"
  case workspaceDidWake = "workspace_did_wake"
  case sessionBecameActive = "session_became_active"
  case screensDidWake = "screens_did_wake"
  case screenUnlocked = "screen_unlocked"
  case unavailableNotification = "unavailable_notification"
  case restoredNotification = "restored_notification"
  case policyUpdated = "policy_updated"
  case sessionUnavailable = "session_unavailable"
  case timerSessionUnavailable = "timer_session_unavailable"
  case timerHelperConflict = "timer_helper_conflict"
  case listenerUnavailable = "listener_unavailable"
  case helperQuit = "helper_quit"
}
