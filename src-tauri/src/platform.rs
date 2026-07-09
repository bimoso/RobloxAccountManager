//! Shared Windows-platform gate for the Tauri_Backend (Task 16.5,
//! Requirement 8.4).
//!
//! RobloxAccountManager is a Windows-only application (Requirement 8.1): the mutex hold,
//! Roblox process launch/enumeration/termination, the Native_Helper
//! (`RobloxNative.exe`) invocation, and the Donut Browser "Open in Browser"
//! flow all depend on Windows-specific mechanisms. The legacy JS build guards
//! each of these entry points with `if (process.platform !== 'win32') ...`,
//! reporting a graceful `{ ok: false, error: 'Windows only' }` (or the
//! feature-specific variant) rather than exhibiting undefined behavior on a
//! non-Windows OS.
//!
//! This module centralizes that gate so every platform-dependent entry point
//! reports the same graceful, consistent "unavailable on this platform" result
//! instead of each site hand-rolling its own `cfg!(windows)` check and message.
//! Callers short-circuit at the top of a Windows-only operation:
//!
//! ```ignore
//! if let Err(e) = crate::platform::ensure_windows() {
//!     return SomeResult::fail(e); // graceful report, no side effects
//! }
//! ```
//!
//! The gate is compiled from `cfg!(windows)`, so on the primary Windows build
//! target [`ensure_windows`] is always `Ok(())` and the Windows code path is
//! left completely unchanged; only a non-Windows target ever takes the
//! short-circuit.

/// The user-facing message reported when a Windows-only feature is invoked on a
/// non-Windows operating system.
///
/// Matches the legacy JS build's wording, which reports Windows-only backend
/// operations as `{ ok: false, error: 'Windows only' }` (Requirement 8.4:
/// "report that it is unavailable on that operating system gracefully,
/// consistent with how the legacy JS build already handles this"). Kept as a
/// single shared constant so every entry point reports identical wording.
pub const WINDOWS_ONLY: &str = "Windows only";

/// Whether the backend is running on Windows, its only supported operating
/// system (Requirement 8.1). A thin, intention-revealing wrapper over
/// `cfg!(windows)` so platform-dependent entry points read declaratively.
#[inline]
pub fn is_windows() -> bool {
    cfg!(windows)
}

/// Gate a Windows-only operation: `Ok(())` on Windows, otherwise `Err` carrying
/// the [`WINDOWS_ONLY`] message so the caller can report it gracefully rather
/// than proceeding into undefined behavior (Requirement 8.4).
///
/// On the Windows build target this is always `Ok(())`, so guarding an entry
/// point with it is a no-op on Windows and never changes existing behavior.
pub fn ensure_windows() -> Result<(), String> {
    gate(is_windows())
}

/// Pure gate logic decoupled from the compile target: `Ok(())` when running on
/// Windows, otherwise `Err(WINDOWS_ONLY)`. Factored out of [`ensure_windows`] so
/// the "unavailable on this platform" report can be exercised directly for both
/// platforms regardless of the host the test suite compiles on (Requirement
/// 8.4). [`ensure_windows`] is simply `gate(is_windows())`.
#[inline]
fn gate(is_windows: bool) -> Result<(), String> {
    if is_windows {
        Ok(())
    } else {
        Err(WINDOWS_ONLY.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_windows_matches_compile_target() {
        assert_eq!(is_windows(), cfg!(windows));
    }

    #[test]
    fn ensure_windows_gate_follows_platform() {
        let result = ensure_windows();
        if cfg!(windows) {
            assert!(result.is_ok(), "Windows must never be gated");
        } else {
            // Non-Windows reports the graceful message rather than proceeding.
            assert_eq!(result.err().as_deref(), Some(WINDOWS_ONLY));
        }
    }

    /// Directly exercises the non-Windows path regardless of the host the suite
    /// compiles on: the pure gate reports the graceful "unavailable on this
    /// platform" message (`WINDOWS_ONLY`) instead of proceeding, mirroring the
    /// legacy JS build's `{ ok: false, error: 'Windows only' }` (Requirement 8.4).
    #[test]
    fn gate_on_non_windows_reports_unavailable() {
        let result = gate(false);
        assert!(
            result.is_err(),
            "a non-Windows target must not proceed into a Windows-only operation"
        );
        assert_eq!(
            result.err().as_deref(),
            Some(WINDOWS_ONLY),
            "non-Windows must report the graceful, legacy JS runtime-consistent message"
        );
    }

    /// Directly exercises the Windows path regardless of host: the gate is a
    /// no-op (`Ok`) so guarding an entry point never alters Windows behavior
    /// (Requirement 8.4).
    #[test]
    fn gate_on_windows_is_ok_noop() {
        assert!(
            gate(true).is_ok(),
            "Windows must never be gated; the guard is a no-op on Windows"
        );
    }

    /// `ensure_windows` must be exactly the pure gate applied to the compile
    /// target, so the public entry point and the directly-tested logic can
    /// never diverge (Requirement 8.4).
    #[test]
    fn ensure_windows_delegates_to_gate() {
        assert_eq!(ensure_windows(), gate(is_windows()));
    }
}
