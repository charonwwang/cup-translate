fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&["probe"]);
    let attributes = tauri_build::Attributes::new().app_manifest(manifest);
    tauri_build::try_build(attributes).expect("build the Tauri 2 smoke context");
}
