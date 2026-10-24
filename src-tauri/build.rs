fn main() {
    let mut attrs = tauri_build::Attributes::new();

    // Windows 目标：关闭默认清单，改用项目自带的 app.manifest。
    // GNU 工具链下默认清单会与 Tauri 生成的资源冲突
    // （ld: .rsrc merge failure: multiple non-default manifests）。
    #[cfg(windows)]
    {
        attrs = attrs.windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(include_str!("app.manifest")),
        );
    }

    tauri_build::try_build(attrs).expect("tauri-build 失败");
}
