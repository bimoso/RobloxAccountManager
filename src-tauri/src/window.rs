//! Window-control and external-open command layer, ported from `main.js`'s
//! window-chrome / shell section (the frameless-window title-bar buttons and the
//! "open in default handler" action). These are the direct counterparts of the
//! Electron IPC handlers registered near the end of `main.js`:
//!
//! | Electron IPC (`preload.js` → `main.js`)                                   | command             |
//! |---------------------------------------------------------------------------|---------------------|
//! | `send('window-minimize')` → `win.minimize()`                              | [`window_minimize`] |
//! | `send('window-maximize')` → `win.isMaximized() ? unmaximize() : maximize()` | [`window_maximize`] |
//! | `send('window-close')`    → `win.close()`                                 | [`window_close`]    |
//! | `send('open-external', url)` → `shell.openExternal(url)`                   | [`open_external`]   |
//!
//! `main.js` operated on the single main `BrowserWindow` (`win`); the Tauri_Build
//! has a single `"main"` window (`tauri.conf.json`), so the window-control
//! commands act on the window that invoked them (the injected
//! [`tauri::WebviewWindow`]), which is that same main window. `open_external`
//! delegates to `tauri-plugin-opener` — the official Tauri v2 replacement for
//! Electron's `shell.openExternal` — opening the URL in the OS default handler
//! (Requirement 10.1: same user-observable result for the same input).
//!
//! Unlike the Electron `ipcMain.on` fire-and-forget handlers, these return
//! `Result<(), String>` so a failure surfaces to the caller rather than being
//! swallowed, consistent with the rest of the Tauri command surface.

use tauri::WebviewWindow;
use tauri_plugin_opener::OpenerExt;

/// `window-minimize`: minimize the main window (`win.minimize()`).
#[tauri::command]
pub fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    crate::logging::log_command_result(
        "window_minimize",
        window.minimize().map_err(|e| e.to_string()),
    )
}

/// `window-maximize`: toggle the main window between maximized and restored,
/// mirroring `win.isMaximized() ? win.unmaximize() : win.maximize()`.
#[tauri::command]
pub fn window_maximize(window: WebviewWindow) -> Result<(), String> {
    crate::logging::log_command_result("window_maximize", (|| {
        if window.is_maximized().map_err(|e| e.to_string())? {
            window.unmaximize().map_err(|e| e.to_string())
        } else {
            window.maximize().map_err(|e| e.to_string())
        }
    })())
}

/// `window-close`: close the main window (`win.close()`).
#[tauri::command]
pub fn window_close(window: WebviewWindow) -> Result<(), String> {
    crate::logging::log_command_result(
        "window_close",
        window.close().map_err(|e| e.to_string()),
    )
}

/// `open-external`: open `url` in the OS default external handler, the
/// `shell.openExternal(url)` equivalent. `None::<&str>` selects the default
/// application rather than a specific one.
#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    crate::logging::log_command_result(
        "open_external",
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| e.to_string()),
    )
}
