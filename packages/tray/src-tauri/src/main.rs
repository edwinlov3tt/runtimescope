// Hide the console window on Windows release builds (the standard incantation).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    runtimescope_tray_lib::run()
}
