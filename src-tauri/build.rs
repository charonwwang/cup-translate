fn main() {
    println!("cargo::rustc-check-cfg=cfg(updater)");
    let target = std::env::var("TARGET").unwrap();
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("resources/piper-runtime.json")).unwrap();
    if let Some(asset) = manifest.get(&target) {
        embed_piper_data();
        embed_onnx_runtime(asset);
    }
    embed_sherpa_runtime();
    tauri_build::build()
}

// The phonemizer is statically linked; embed its compiled dictionaries as well,
// so packaged speech never depends on the build machine or an installed Python.
fn embed_piper_data() {
    use std::{fs, path::Path};
    fn walk(root: &Path, dir: &Path, output: &mut String) {
        let mut entries: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                walk(root, &path, output);
            } else {
                let relative = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .replace('\\', "/");
                output.push_str(&format!(
                    "({:?}, include_bytes!({:?})),\n",
                    relative,
                    path.to_str().unwrap()
                ));
            }
        }
    }
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let mut roots = vec![out.ancestors().nth(2).unwrap().to_path_buf()];
    if let Some(target) = out.ancestors().nth(5) {
        roots.push(target.join(std::env::var("PROFILE").unwrap()).join("build"));
    }
    let mut candidates = Vec::new();
    for root in roots {
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                if entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("espeak-rs-sys-")
                {
                    let data = entry.path().join("out/share/espeak-ng-data");
                    if data.join("phontab").is_file() {
                        candidates.push(data);
                    }
                }
            }
        }
    }
    candidates.sort_by_key(|p| fs::metadata(p.join("phontab")).unwrap().modified().unwrap());
    let data = candidates
        .last()
        .expect("Compiled eSpeak dictionaries missing; build espeak-rs-sys first");
    // The crate omits the large Mandarin extension; compile the pinned source
    // with the host build dependency, rather than shipping a partial dictionary.
    let host = std::env::var("HOST").unwrap();
    let target = std::env::var("TARGET").unwrap();
    let host_data = if host == target {
        data.clone()
    } else {
        let host_build = out
            .ancestors()
            .nth(5)
            .unwrap()
            .join(std::env::var("PROFILE").unwrap())
            .join("build");
        fs::read_dir(host_build)
            .unwrap()
            .flatten()
            .map(|e| e.path().join("out/share/espeak-ng-data"))
            .find(|p| p.join("phontab").is_file())
            .expect("Host eSpeak data missing")
    };
    let host_out = host_data.parent().unwrap().parent().unwrap();
    let compiled = out.join("piper-complete/espeak-ng-data");
    fn copy_tree(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap().flatten() {
            let p = entry.path();
            let dest = to.join(entry.file_name());
            if p.is_dir() {
                copy_tree(&p, &dest);
            } else {
                fs::copy(p, dest).unwrap();
            }
        }
    }
    copy_tree(data, &compiled);
    let dict = out.join("piper-dictsource");
    fs::create_dir_all(&dict).unwrap();
    for name in ["cmn_list", "cmn_rules", "cmn_emoji"] {
        fs::copy(
            host_out.join("espeak-ng/dictsource").join(name),
            dict.join(name),
        )
        .unwrap();
    }
    let extra = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/espeak-extra/cmn_listx");
    fs::copy(&extra, dict.join("cmn_listx")).unwrap();
    let exe = host_out.join(if cfg!(windows) {
        "bin/espeak-ng.exe"
    } else {
        "bin/espeak-ng"
    });
    let status = std::process::Command::new(exe)
        .arg(format!("--path={}", compiled.parent().unwrap().display()))
        .arg("--compile=cmn")
        .current_dir(dict)
        .status()
        .expect("Mandarin dictionary compiler unavailable");
    assert!(status.success(), "Mandarin dictionary compilation failed");
    assert!(
        fs::metadata(compiled.join("cmn_dict")).unwrap().len() > 1_000_000,
        "Mandarin dictionary incomplete"
    );
    let mut code = String::from("const ESPEAK_DATA: &[(&str, &[u8])] = &[\n");
    walk(&compiled, &compiled, &mut code);
    code.push_str("];\n");
    fs::write(out.join("piper_data.rs"), code).unwrap();
}

fn embed_onnx_runtime(asset: &serde_json::Value) {
    use sha2::{Digest, Sha256};
    use std::{fs, io::Read, path::PathBuf};
    let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let archive = out.join("onnxruntime-1.24.2.whl");
    let expected = asset["sha256"].as_str().unwrap();
    let valid = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes)) == expected;
    let bytes = match fs::read(&archive) {
        Ok(bytes) if valid(&bytes) => bytes,
        _ => {
            let bytes = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(600))
                .build()
                .unwrap()
                .get(asset["url"].as_str().unwrap())
                .send()
                .expect("Download pinned ONNX Runtime")
                .error_for_status()
                .unwrap()
                .bytes()
                .unwrap()
                .to_vec();
            assert!(valid(&bytes), "ONNX Runtime wheel checksum mismatch");
            fs::write(&archive, &bytes).unwrap();
            bytes
        }
    };
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut code = String::from("const ORT_LIBS: &[(&str, &[u8])] = &[\n");
    let mut count = 0;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).unwrap();
        let name = file.name().rsplit('/').next().unwrap().to_string();
        if !file.name().starts_with("onnxruntime/capi/")
            || !(name.starts_with("libonnxruntime")
                || name == "onnxruntime.dll"
                || name == "onnxruntime_providers_shared.dll")
        {
            continue;
        }
        let path = out.join(&name);
        let mut data = Vec::new();
        file.read_to_end(&mut data).unwrap();
        fs::write(&path, data).unwrap();
        code.push_str(&format!("({:?}, include_bytes!({:?})),\n", name, path));
        count += 1;
    }
    assert!(count > 0, "ONNX Runtime shared library missing");
    code.push_str("];\n");
    fs::write(out.join("piper_runtime.rs"), code).unwrap();
}

fn embed_sherpa_runtime() {
    use sha2::{Digest, Sha256};
    use std::{fs, io::Read, path::PathBuf};
    let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("resources/sherpa-runtime.json")).unwrap();
    let mut code = String::from("const KOKORO_LIBS: &[(&str, &[u8])] = &[\n");
    if let Some(asset) = manifest.get(std::env::var("TARGET").unwrap()) {
        let path = out.join("sherpa-onnx-1.13.8.tar.bz2");
        let expected = asset["sha256"].as_str().unwrap();
        let valid = |b: &[u8]| format!("{:x}", Sha256::digest(b)) == expected;
        let bytes = match fs::read(&path) {
            Ok(b) if valid(&b) => b,
            _ => {
                let b = if let Ok(local) = std::env::var("CUP_SHERPA_ARCHIVE") {
                    fs::read(local).unwrap()
                } else {
                    reqwest::blocking::Client::builder()
                        .timeout(std::time::Duration::from_secs(600))
                        .build()
                        .unwrap()
                        .get(asset["url"].as_str().unwrap())
                        .send()
                        .unwrap()
                        .error_for_status()
                        .unwrap()
                        .bytes()
                        .unwrap()
                        .to_vec()
                };
                assert!(valid(&b), "Sherpa runtime checksum mismatch");
                fs::write(&path, &b).unwrap();
                b
            }
        };
        let mut archive = tar::Archive::new(bzip2::read::BzDecoder::new(bytes.as_slice()));
        let mut libraries = std::collections::BTreeMap::new();
        let mut aliases = Vec::new();
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let path = entry.path().unwrap().into_owned();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !(name.contains("sherpa-onnx-c-api")
                || name.starts_with("libonnxruntime")
                || name == "onnxruntime.dll"
                || name == "onnxruntime_providers_shared.dll")
                || !(name.contains(".dylib") || name.contains(".so") || name.ends_with(".dll"))
            {
                continue;
            }
            if entry.header().entry_type().is_symlink()
                || entry.header().entry_type().is_hard_link()
            {
                let link = entry.link_name().unwrap().expect("Runtime alias target");
                aliases.push((
                    name.to_owned(),
                    link.file_name().unwrap().to_str().unwrap().to_owned(),
                ));
                continue;
            }
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let mut data = Vec::new();
            entry.read_to_end(&mut data).unwrap();
            libraries.insert(name.to_owned(), data);
        }
        for _ in 0..3 {
            for (alias, target) in &aliases {
                if !libraries.contains_key(alias) {
                    if let Some(bytes) = libraries.get(target).cloned() {
                        libraries.insert(alias.clone(), bytes);
                    }
                }
            }
        }
        for (alias, _) in &aliases {
            assert!(
                libraries.contains_key(alias),
                "Unresolved runtime library alias"
            );
        }
        let count = libraries.len();
        for (name, data) in libraries {
            let file = out.join(format!("sherpa-{name}"));
            fs::write(&file, data).unwrap();
            code.push_str(&format!("({:?},include_bytes!({:?})),\n", name, file));
        }
        assert!(count >= 2, "Sherpa C API or ONNX Runtime missing");
    }
    code.push_str("];\n");
    fs::write(out.join("kokoro_runtime.rs"), code).unwrap();
}
