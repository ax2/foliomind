use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, Emitter, Manager, Runtime, Window,
};

pub const RECONCILE_EVENT: &str = "foliomind://background-reconcile";

#[derive(Default)]
pub struct DesktopLifecycle {
    exiting: AtomicBool,
    hidden_to_tray: AtomicBool,
    cleanup_started: AtomicBool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    Hide,
    Close,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLifecycleStatus {
    pub resident_mode: bool,
    pub hidden_to_tray: bool,
    pub exiting: bool,
}

impl DesktopLifecycle {
    pub fn close_action(&self) -> CloseAction {
        if self.exiting.load(Ordering::SeqCst) {
            CloseAction::Close
        } else {
            CloseAction::Hide
        }
    }

    pub fn mark_hidden(&self, hidden: bool) {
        self.hidden_to_tray.store(hidden, Ordering::SeqCst);
    }

    pub fn request_exit(&self) {
        self.exiting.store(true, Ordering::SeqCst);
    }

    pub fn status(&self) -> DesktopLifecycleStatus {
        DesktopLifecycleStatus {
            resident_mode: true,
            hidden_to_tray: self.hidden_to_tray.load(Ordering::SeqCst),
            exiting: self.exiting.load(Ordering::SeqCst),
        }
    }

    pub fn begin_cleanup(&self) -> bool {
        !self.cleanup_started.swap(true, Ordering::SeqCst)
    }
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        app.state::<DesktopLifecycle>().mark_hidden(false);
    }
}

fn request_reconcile<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(RECONCILE_EVENT, ());
}

pub fn install<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "foliomind_show", "显示 FolioMind", true, None::<&str>)?;
    let reconcile = MenuItem::with_id(
        app,
        "foliomind_reconcile",
        "立即检查盘后复盘",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "foliomind_quit", "退出 FolioMind", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &reconcile, &quit])?;
    let mut tray = TrayIconBuilder::with_id("foliomind-main")
        .menu(&menu)
        .tooltip("FolioMind · 金融研究 Agent")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "foliomind_show" => show_main(app),
            "foliomind_reconcile" => request_reconcile(app),
            "foliomind_quit" => {
                app.state::<DesktopLifecycle>().request_exit();
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

pub fn hide_on_close<R: Runtime>(window: &Window<R>, api: &tauri::CloseRequestApi) {
    let lifecycle = window.state::<DesktopLifecycle>();
    if lifecycle.close_action() == CloseAction::Hide {
        api.prevent_close();
        if window.hide().is_ok() {
            lifecycle.mark_hidden(true);
        }
    }
}

pub fn show(app: &AppHandle) -> DesktopLifecycleStatus {
    show_main(app);
    app.state::<DesktopLifecycle>().status()
}

pub fn quit(app: &AppHandle) {
    app.state::<DesktopLifecycle>().request_exit();
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_close_hides_but_explicit_exit_closes() {
        let lifecycle = DesktopLifecycle::default();
        assert_eq!(lifecycle.close_action(), CloseAction::Hide);
        lifecycle.mark_hidden(true);
        assert!(lifecycle.status().hidden_to_tray);
        lifecycle.request_exit();
        assert_eq!(lifecycle.close_action(), CloseAction::Close);
        assert!(lifecycle.status().exiting);
        assert!(lifecycle.begin_cleanup());
        assert!(!lifecycle.begin_cleanup());
    }
}
