fn main() {
    tauri_build::build();

    println!("cargo:rerun-if-changed=resources/portable-git/.version");
    println!("cargo:rerun-if-changed=../scripts/portable-git-version.json");
    if std::env::var("PROFILE").unwrap_or_default() == "release" && cfg!(target_os = "windows") {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("portable-git");
        let git = root.join("cmd").join("git.exe");
        let bash = root.join("bin").join("bash.exe");
        if !git.is_file() || !bash.is_file() {
            panic!("FolioMind release build requires bundled PortableGit. Run `npm run fetch:bash` before building. Missing: {} or {}", git.display(), bash.display());
        }
    }
}
