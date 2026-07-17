//! Roblox game-window grid layout — the multi-instance "Window layout" feature.
//!
//! When several accounts run at once, their `RobloxPlayerBeta.exe` windows pile
//! on top of each other. This module arranges every visible Roblox game window
//! into a grid so each instance stays observable:
//!
//!   * **Auto layout** (`windowAutoLayout`): the grid is sized from the desktop
//!     work area — the squarest grid that fits the current instance count, each
//!     cell `work/cols` × `work/rows`, so the windows tile the whole desktop.
//!   * **Manual layout**: each window is `windowTargetWidth` ×
//!     `windowTargetHeight` pixels, placed `windowPerRow` per row from the
//!     work-area origin.
//!
//! The grid math ([`compute_layout`]) is pure and unit-tested; the Win32 side
//! (window enumeration via `EnumWindows` filtered to live Roblox PIDs, and
//! placement via `SetWindowPos`) is isolated in the `win` submodule. Window
//! handles cross async boundaries as raw `isize` values so nothing here holds a
//! non-`Send` `HWND` across an await point.
//!
//! Two entry points drive it:
//!   * [`roblox_arrange_windows`] — the "Arrange now" command; arranges
//!     immediately regardless of the enabled flag.
//!   * [`schedule_layout_pass`] — a debounced background maintenance pass
//!     (at most one runs at a time, guarded by `AppState::layout_pass_running`)
//!     that re-arranges only when the window set or the layout configuration
//!     actually changed since the last arrangement
//!     (`AppState::layout_last`), so it never fights the user's manual window
//!     moves. It is triggered after launches (windows can take a while to
//!     appear behind a bootstrapper), on close/kill events (to compact the
//!     grid), and on layout-settings changes.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager};

use crate::models::Settings;
use crate::AppState;

/// Default fixed grid-cell width when `windowTargetWidth` is absent (the
/// classic RAM default of 350×350).
pub const LAYOUT_DEFAULT_WIDTH: u32 = 350;

/// Default fixed grid-cell height when `windowTargetHeight` is absent.
pub const LAYOUT_DEFAULT_HEIGHT: u32 = 350;

/// Default windows-per-row when `windowPerRow` is absent.
pub const LAYOUT_DEFAULT_PER_ROW: u32 = 1;

/// Smallest cell dimension ever produced, so a garbage stored size (or a huge
/// instance count in auto mode) can never yield degenerate/invisible windows.
pub const LAYOUT_MIN_CELL: i32 = 100;

/// Cadence of the maintenance pass while it is watching for changes.
const PASS_TICK_MS: u64 = 3_000;

/// Maximum ticks per scheduled pass (~60 s), covering the slowest
/// bootstrapper-to-game-window hand-off after a launch.
const PASS_MAX_TICKS: u32 = 20;

/// Consecutive no-change ticks after which a pass winds down early.
const PASS_STABLE_TICKS: u32 = 3;

/// One screen-space rectangle: `x`/`y` top-left corner, `w`/`h` size in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// The window-layout configuration resolved from the Settings_Store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayoutConfig {
    /// `windowLayoutEnabled` — gates the automatic maintenance pass only; the
    /// manual "Arrange now" command works regardless.
    pub enabled: bool,
    /// `windowAutoLayout` — size the grid from the desktop work area.
    pub auto: bool,
    /// `windowTargetWidth` (manual mode cell width).
    pub target_w: i32,
    /// `windowTargetHeight` (manual mode cell height).
    pub target_h: i32,
    /// `windowPerRow` (manual mode columns), always at least 1.
    pub per_row: u32,
}

/// Resolve a [`LayoutConfig`] from stored [`Settings`], applying the defaults
/// for absent fields.
pub fn layout_config_from_settings(s: &Settings) -> LayoutConfig {
    LayoutConfig {
        enabled: s.window_layout_enabled == Some(true),
        auto: s.window_auto_layout == Some(true),
        target_w: s.window_target_width.unwrap_or(LAYOUT_DEFAULT_WIDTH) as i32,
        target_h: s.window_target_height.unwrap_or(LAYOUT_DEFAULT_HEIGHT) as i32,
        per_row: s.window_per_row.unwrap_or(LAYOUT_DEFAULT_PER_ROW).max(1),
    }
}

/// Read the layout configuration from the Settings_Store, quietly falling back
/// to the (disabled) defaults on any read failure — a layout pass must never
/// error a launch or kill flow.
fn load_layout_config(app: &AppHandle) -> LayoutConfig {
    crate::accounts::store_dir(app)
        .ok()
        .and_then(|dir| crate::settings::load_from_dir(&dir).ok())
        .map(|s| layout_config_from_settings(&s))
        .unwrap_or(LayoutConfig {
            enabled: false,
            auto: false,
            target_w: LAYOUT_DEFAULT_WIDTH as i32,
            target_h: LAYOUT_DEFAULT_HEIGHT as i32,
            per_row: LAYOUT_DEFAULT_PER_ROW,
        })
}

/// What the last arrangement was applied to: the sorted raw window handles and
/// the configuration used. The maintenance pass re-arranges only when the
/// current snapshot differs from this stamp, so untouched windows are never
/// re-placed (and the user's manual moves are never fought).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutStamp {
    pub hwnds: Vec<isize>,
    pub config: LayoutConfig,
}

/// Pure grid math: the target rectangle for each of `count` windows inside the
/// `work` area under `cfg`. Windows fill rows left-to-right, top-to-bottom.
///
/// Auto mode tiles the whole work area with the squarest grid that fits
/// `count`; manual mode uses the fixed target size, `per_row` per row (rows may
/// extend past the work area — that is the user's explicit sizing choice).
pub fn compute_layout(count: usize, work: Rect, cfg: &LayoutConfig) -> Vec<Rect> {
    if count == 0 {
        return Vec::new();
    }
    let (cols, w, h) = if cfg.auto {
        let cols = ((count as f64).sqrt().ceil() as usize).max(1);
        let rows = count.div_ceil(cols);
        (
            cols,
            (work.w / cols as i32).max(LAYOUT_MIN_CELL),
            (work.h / rows as i32).max(LAYOUT_MIN_CELL),
        )
    } else {
        (
            cfg.per_row.max(1) as usize,
            cfg.target_w.max(LAYOUT_MIN_CELL),
            cfg.target_h.max(LAYOUT_MIN_CELL),
        )
    };
    (0..count)
        .map(|i| Rect {
            x: work.x + (i % cols) as i32 * w,
            y: work.y + (i / cols) as i32 * h,
            w,
            h,
        })
        .collect()
}

// ── Win32 window enumeration / placement ─────────────────────────────────────

#[cfg(windows)]
mod win {
    use super::Rect;
    use std::collections::HashSet;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetSystemMetrics, GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic,
        IsWindowVisible, SetWindowPos, ShowWindow, SystemParametersInfoW, SM_CXSCREEN,
        SM_CYSCREEN, SPI_GETWORKAREA, SWP_NOACTIVATE, SWP_NOZORDER, SW_RESTORE,
        SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };

    /// State threaded through the `EnumWindows` callback via `LPARAM`.
    struct EnumState {
        pids: HashSet<u32>,
        found: Vec<(isize, u32)>,
    }

    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> windows::Win32::Foundation::BOOL {
        let state = &mut *(lparam.0 as *mut EnumState);
        if !IsWindowVisible(hwnd).as_bool() {
            return TRUE;
        }
        // The Roblox game window is titled; untitled surfaces from the same
        // process (IME/helper windows) are skipped.
        if GetWindowTextLengthW(hwnd) == 0 {
            return TRUE;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != 0 && state.pids.contains(&pid) {
            state.found.push((hwnd.0 as isize, pid));
        }
        TRUE
    }

    /// Every visible, titled top-level window belonging to one of `pids`, as
    /// `(raw hwnd, pid)` pairs.
    pub fn windows_for_pids(pids: &HashSet<u32>) -> Vec<(isize, u32)> {
        let mut state = EnumState { pids: pids.clone(), found: Vec::new() };
        unsafe {
            // EnumWindows only errors when the callback stops iteration; ours
            // never does, and a failed sweep simply yields what was collected.
            let _ = EnumWindows(Some(enum_cb), LPARAM(&mut state as *mut EnumState as isize));
        }
        state.found
    }

    /// The desktop work area (screen minus taskbar), falling back to the full
    /// primary-screen bounds when the query fails.
    pub fn work_area() -> Rect {
        let mut rect = RECT::default();
        let ok = unsafe {
            SystemParametersInfoW(
                SPI_GETWORKAREA,
                0,
                Some(&mut rect as *mut RECT as *mut core::ffi::c_void),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
        };
        if ok.is_ok() && rect.right > rect.left && rect.bottom > rect.top {
            Rect {
                x: rect.left,
                y: rect.top,
                w: rect.right - rect.left,
                h: rect.bottom - rect.top,
            }
        } else {
            Rect {
                x: 0,
                y: 0,
                w: unsafe { GetSystemMetrics(SM_CXSCREEN) }.max(800),
                h: unsafe { GetSystemMetrics(SM_CYSCREEN) }.max(600),
            }
        }
    }

    /// Restore a minimized window and move/resize it into `rect`, without
    /// stealing focus or changing z-order. Returns whether the placement stuck.
    pub fn place_window(hwnd_raw: isize, rect: Rect) -> bool {
        let hwnd = HWND(hwnd_raw as *mut core::ffi::c_void);
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            SetWindowPos(
                hwnd,
                HWND::default(),
                rect.x,
                rect.y,
                rect.w,
                rect.h,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
            .is_ok()
        }
    }
}

// ── Orchestration ────────────────────────────────────────────────────────────

/// Snapshot the current Roblox game windows as `(raw hwnd, pid)` pairs in a
/// deterministic order (by PID, then handle) so each window keeps its grid slot
/// between passes instead of shuffling. `Err` when the process enumeration
/// itself failed (skip, retry later).
#[cfg(windows)]
async fn snapshot_windows() -> Result<Vec<(isize, u32)>, String> {
    let pids = crate::roblox_process::enumerate_roblox_pids()
        .await
        .ok_or_else(|| "Could not enumerate Roblox processes".to_string())?;
    let mut wins = win::windows_for_pids(&pids);
    wins.sort_by_key(|&(hwnd, pid)| (pid, hwnd));
    Ok(wins)
}

/// Apply the grid to an already-taken snapshot and remember the resulting
/// [`LayoutStamp`]. Returns the number of windows placed.
#[cfg(windows)]
fn apply_layout(app: &AppHandle, cfg: &LayoutConfig, wins: &[(isize, u32)]) -> usize {
    let rects = compute_layout(wins.len(), win::work_area(), cfg);
    let mut placed = 0usize;
    for (&(hwnd, _), rect) in wins.iter().zip(rects.iter()) {
        if win::place_window(hwnd, *rect) {
            placed += 1;
        }
    }
    let stamp = LayoutStamp {
        hwnds: wins.iter().map(|&(h, _)| h).collect(),
        config: *cfg,
    };
    let state = app.state::<AppState>();
    *state
        .layout_last
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some(stamp);
    placed
}

/// Arrange every Roblox game window into the configured grid right now,
/// regardless of the enabled flag (the manual "Arrange now" path). Returns the
/// number of windows placed.
#[cfg(windows)]
pub async fn arrange_windows(app: &AppHandle) -> Result<usize, String> {
    let cfg = load_layout_config(app);
    let wins = snapshot_windows().await?;
    Ok(apply_layout(app, &cfg, &wins))
}

#[cfg(not(windows))]
pub async fn arrange_windows(_app: &AppHandle) -> Result<usize, String> {
    Err(crate::platform::WINDOWS_ONLY.to_string())
}

/// One maintenance tick: re-arrange only when the current window set or the
/// configuration differs from the last arrangement. Returns whether an
/// arrangement was applied.
#[cfg(windows)]
async fn arrange_if_changed(app: &AppHandle, cfg: &LayoutConfig) -> Result<bool, String> {
    let wins = snapshot_windows().await?;
    let hwnds: Vec<isize> = wins.iter().map(|&(h, _)| h).collect();
    let state = app.state::<AppState>();
    let unchanged = {
        let last = state
            .layout_last
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        matches!(last.as_ref(), Some(st) if st.hwnds == hwnds && st.config == *cfg)
    };
    if unchanged {
        return Ok(false);
    }
    if wins.is_empty() {
        // Nothing left to place; record the empty set so the next window that
        // appears registers as a change.
        *state
            .layout_last
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(LayoutStamp { hwnds, config: *cfg });
        return Ok(false);
    }
    apply_layout(app, cfg, &wins);
    Ok(true)
}

/// Schedule the debounced window-layout maintenance pass.
///
/// At most one pass runs at a time (`AppState::layout_pass_running`); a call
/// while one is running is a no-op — the running pass polls the window set
/// every tick, so it picks the new change up anyway. Each pass waits
/// `initial_delay_ms`, then re-checks the stored configuration every tick
/// (exiting as soon as the feature is disabled), arranges on change, and winds
/// down after [`PASS_STABLE_TICKS`] quiet ticks or [`PASS_MAX_TICKS`] total.
///
/// Safe to call from any flow: when the feature is disabled the pass exits on
/// its first tick without touching a window.
pub fn schedule_layout_pass(app: &AppHandle, initial_delay_ms: u64) {
    if !crate::platform::is_windows() {
        return;
    }
    {
        let state = app.state::<AppState>();
        if state.layout_pass_running.swap(true, Ordering::SeqCst) {
            return;
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(initial_delay_ms)).await;
        let mut stable = 0u32;
        for _ in 0..PASS_MAX_TICKS {
            let cfg = load_layout_config(&app);
            if !cfg.enabled {
                break;
            }
            match layout_tick(&app, &cfg).await {
                Ok(true) => stable = 0,
                _ => stable += 1,
            }
            if stable >= PASS_STABLE_TICKS {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(PASS_TICK_MS)).await;
        }
        app.state::<AppState>()
            .layout_pass_running
            .store(false, Ordering::SeqCst);
    });
}

#[cfg(windows)]
async fn layout_tick(app: &AppHandle, cfg: &LayoutConfig) -> Result<bool, String> {
    arrange_if_changed(app, cfg).await
}

#[cfg(not(windows))]
async fn layout_tick(_app: &AppHandle, _cfg: &LayoutConfig) -> Result<bool, String> {
    Ok(false)
}

/// `roblox_arrange_windows` — the "Arrange now" action: place every Roblox game
/// window into the configured grid immediately. Returns the number of windows
/// placed.
#[tauri::command]
pub async fn roblox_arrange_windows(app: AppHandle) -> Result<usize, String> {
    crate::platform::ensure_windows()?;
    let placed = arrange_windows(&app).await?;
    crate::logging::send_log(
        &app,
        "ok",
        "layout",
        &format!("Arranged {placed} Roblox window(s)"),
        serde_json::json!({ "count": placed }),
    );
    Ok(placed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(auto: bool, w: i32, h: i32, per_row: u32) -> LayoutConfig {
        LayoutConfig { enabled: true, auto, target_w: w, target_h: h, per_row }
    }

    const WORK: Rect = Rect { x: 10, y: 20, w: 1600, h: 900 };

    #[test]
    fn zero_windows_yields_no_rects() {
        assert!(compute_layout(0, WORK, &cfg(false, 350, 350, 2)).is_empty());
        assert!(compute_layout(0, WORK, &cfg(true, 350, 350, 2)).is_empty());
    }

    #[test]
    fn manual_layout_wraps_at_per_row_from_work_origin() {
        // 3 windows, 2 per row, 350x350: two on the first row, one on the second.
        let rects = compute_layout(3, WORK, &cfg(false, 350, 300, 2));
        assert_eq!(
            rects,
            vec![
                Rect { x: 10, y: 20, w: 350, h: 300 },
                Rect { x: 360, y: 20, w: 350, h: 300 },
                Rect { x: 10, y: 320, w: 350, h: 300 },
            ]
        );
    }

    #[test]
    fn manual_layout_clamps_degenerate_size_and_per_row() {
        // A stored 0x0 size / 0 per-row can never produce invisible windows or
        // a division by zero: the cell clamps to the minimum and one column.
        let rects = compute_layout(2, WORK, &cfg(false, 0, -5, 0));
        assert_eq!(rects[0].w, LAYOUT_MIN_CELL);
        assert_eq!(rects[0].h, LAYOUT_MIN_CELL);
        // per_row clamped to 1: the second window starts a new row.
        assert_eq!(rects[1].x, WORK.x);
        assert_eq!(rects[1].y, WORK.y + LAYOUT_MIN_CELL);
    }

    #[test]
    fn auto_layout_tiles_the_work_area() {
        // 4 windows auto: a 2x2 grid of half-work-area cells.
        let rects = compute_layout(4, WORK, &cfg(true, 350, 350, 3));
        assert_eq!(rects.len(), 4);
        assert_eq!(rects[0], Rect { x: 10, y: 20, w: 800, h: 450 });
        assert_eq!(rects[1], Rect { x: 810, y: 20, w: 800, h: 450 });
        assert_eq!(rects[2], Rect { x: 10, y: 470, w: 800, h: 450 });
        assert_eq!(rects[3], Rect { x: 810, y: 470, w: 800, h: 450 });
    }

    #[test]
    fn auto_layout_uses_squarest_grid_for_odd_counts() {
        // 5 windows: ceil(sqrt(5)) = 3 columns, 2 rows.
        let rects = compute_layout(5, WORK, &cfg(true, 350, 350, 1));
        let cols = rects
            .iter()
            .filter(|r| r.y == WORK.y)
            .count();
        assert_eq!(cols, 3);
        assert_eq!(rects[3].y, WORK.y + 450); // second row
        assert_eq!(rects[0].w, 1600 / 3);
        assert_eq!(rects[0].h, 450);
    }

    #[test]
    fn single_window_auto_fills_the_whole_work_area() {
        let rects = compute_layout(1, WORK, &cfg(true, 350, 350, 1));
        assert_eq!(rects, vec![Rect { x: 10, y: 20, w: 1600, h: 900 }]);
    }

    #[test]
    fn layout_config_from_settings_applies_defaults() {
        let s = Settings::default();
        let c = layout_config_from_settings(&s);
        assert!(!c.enabled);
        assert!(!c.auto);
        assert_eq!(c.target_w, LAYOUT_DEFAULT_WIDTH as i32);
        assert_eq!(c.target_h, LAYOUT_DEFAULT_HEIGHT as i32);
        assert_eq!(c.per_row, LAYOUT_DEFAULT_PER_ROW);
    }

    #[test]
    fn layout_config_from_settings_reads_stored_values() {
        let mut s = Settings::default();
        s.window_layout_enabled = Some(true);
        s.window_auto_layout = Some(true);
        s.window_target_width = Some(500);
        s.window_target_height = Some(400);
        s.window_per_row = Some(3);
        let c = layout_config_from_settings(&s);
        assert!(c.enabled);
        assert!(c.auto);
        assert_eq!(c.target_w, 500);
        assert_eq!(c.target_h, 400);
        assert_eq!(c.per_row, 3);
    }
}
