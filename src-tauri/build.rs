fn main() {
    println!("cargo::rustc-check-cfg=cfg(updater)");
    tauri_build::build()
}
