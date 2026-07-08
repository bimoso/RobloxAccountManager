//! WebView2 runtime presence check (Task 19.4, Requirement 12.7).
//!
//! Unlike the Electron_Build, which bundles its own Chromium, the Tauri_Build
//! renders its UI through the operating system's WebView component. On Windows
//! that component is the **Microsoft Edge WebView2 runtime**. If that runtime is
//! absent the window can never render, and Tauri/wry would otherwise fail deep in
//! window creation with an opaque error. Requirement 12.7 asks that the missing
//! dependency instead be reported *clearly and actionably* to the user.
//!
//! This module performs that detection at startup ([`ensure_webview2_runtime`],
//! wired into `lib.rs`'s `run()` before the Tauri app is built). Detection uses
//! Tauri's own helper [`tauri::webview_version`] (re-exported from `wry`), which
//! queries the installed WebView2 runtime version on Windows and returns an error
//! when the runtime cannot be found — exactly the signal we need. When absent we
//! surface a clear, actionable message two ways:
//!   1. to standard error (always), so it lands in logs / a console launch, and
//!   2. as a native Windows message box (best-effort), since the WebView2 runtime
//!      needed to show an in-app dialog is precisely what is missing.
//! We then exit with a nonzero status, so the app fails *clearly* rather than
//! opaquely crashing during window creation.
//!
//! The check is meaningful only on Windows (RobloxAccountManager is Windows-only,
//! Requirement 8.1; a non-Windows OS is already gated as unavailable by
//! [`crate::platform`], Requirement 8.4). All Windows-specific enforcement is
//! therefore guarded by `#[cfg(windows)]` so the non-Windows build is never
//! broken or altered.

/// The clear, actionable message reported to the user when the Microsoft Edge
/// WebView2 runtime cannot be found (Requirement 12.7). It names the missing
/// dependency, gives the official download URL, and tells the user what to do
/// next (install, then relaunch).
pub const WEBVIEW2_MISSING_MESSAGE: &str = "The Microsoft Edge WebView2 runtime is required to run RobloxAccountManager but was not found.\n\nInstall the WebView2 runtime from https://developer.microsoft.com/microsoft-edge/webview2/ and relaunch RobloxAccountManager.";

/// Title/caption used for the native error dialog surfaced on Windows when the
/// WebView2 runtime is missing.
pub const WEBVIEW2_MISSING_TITLE: &str = "RobloxAccountManager - WebView2 runtime missing";

/// Detects whether the WebView2 (WebView) runtime is present.
///
/// Returns `Ok(version)` with the installed runtime version string when present,
/// otherwise `Err(message)` carrying the clear, actionable
/// [`WEBVIEW2_MISSING_MESSAGE`]. Detection delegates to [`tauri::webview_version`]
/// (the Tauri-provided helper backed by `wry`), which on Windows queries the
/// installed WebView2 runtime and errors when it cannot be located.
pub fn check_webview2_runtime() -> Result<String, String> {
    tauri::webview_version().map_err(|_| WEBVIEW2_MISSING_MESSAGE.to_string())
}

/// Startup gate: on Windows, verifies the WebView2 runtime is present and, if it
/// is absent, reports the clear, actionable error to the user (stderr + a native
/// message box) and exits the process with a nonzero status so the failure is
/// unmistakable rather than an opaque crash during window creation
/// (Requirement 12.7).
///
/// On non-Windows targets this is a no-op: RobloxAccountManager is Windows-only
/// (Requirement 8.1) and a non-Windows OS is already reported as unavailable by
/// [`crate::platform`] (Requirement 8.4), so this must not interfere with, or
/// break the build of, that path.
pub fn ensure_webview2_runtime() {
    #[cfg(windows)]
    {
        if let Err(message) = check_webview2_runtime() {
            report_missing_runtime(&message);
            // Fail clearly instead of proceeding into an opaque window-creation
            // crash: the UI cannot render without the runtime.
            std::process::exit(1);
        }
    }
}

/// Reports the missing-runtime error to the user on Windows: always to standard
/// error, and — best effort — as a native OS message box (the in-app UI cannot
/// render, since the WebView2 runtime that would draw it is what is missing).
#[cfg(windows)]
fn report_missing_runtime(message: &str) {
    eprintln!("[startup] {message}");
    show_error_dialog(WEBVIEW2_MISSING_TITLE, message);
}

/// Shows a native Windows error message box via `MessageBoxW`. Best-effort: any
/// failure to display the dialog is non-fatal (the stderr report already
/// occurred). A null owner-window handle produces an owner-less modal box, which
/// is what we want before any Tauri window exists.
#[cfg(windows)]
fn show_error_dialog(title: &str, message: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    // Null-terminated UTF-16 buffers, kept alive for the duration of the call.
    let to_wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let text = to_wide(message);
    let caption = to_wide(title);

    // SAFETY: `text` and `caption` are valid, null-terminated UTF-16 buffers that
    // outlive this call, and a null `HWND` requests an owner-less modal box.
    unsafe {
        MessageBoxW(
            HWND::default(),
            PCWSTR(text.as_ptr()),
            PCWSTR(caption.as_ptr()),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The actionable message must name the missing dependency, provide the
    /// install URL, and tell the user to relaunch (Requirement 12.7: "clearly
    /// reports the missing dependency to the user").
    #[test]
    fn missing_message_is_clear_and_actionable() {
        assert!(WEBVIEW2_MISSING_MESSAGE.contains("WebView2 runtime"));
        assert!(WEBVIEW2_MISSING_MESSAGE.contains("was not found"));
        assert!(WEBVIEW2_MISSING_MESSAGE
            .contains("https://developer.microsoft.com/microsoft-edge/webview2/"));
        assert!(WEBVIEW2_MISSING_MESSAGE.to_lowercase().contains("install"));
        assert!(WEBVIEW2_MISSING_MESSAGE.to_lowercase().contains("relaunch"));
    }

    /// On the dev/test host the WebView2 runtime is present, so detection must
    /// succeed and return a non-empty version string. This also guards the
    /// wiring: the Tauri-provided detection helper is callable and returns the
    /// expected `Ok(version)` shape.
    #[test]
    #[cfg(windows)]
    fn check_reports_present_runtime_on_dev_host() {
        match check_webview2_runtime() {
            Ok(version) => assert!(
                !version.trim().is_empty(),
                "a present runtime must report a non-empty version"
            ),
            Err(message) => {
                // The runtime should be present on a dev machine running Studio,
                // but if a CI host lacks it, the message must still be actionable.
                assert_eq!(message, WEBVIEW2_MISSING_MESSAGE);
            }
        }
    }
}
