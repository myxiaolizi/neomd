// 发布版隐藏控制台窗口，仅保留 GUI
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mdnote_lib::run()
}
