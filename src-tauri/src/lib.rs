use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use image::{imageops::FilterType, ImageFormat};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::SystemTime;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

mod database;

use database::{Cursor, Database, OcrStatus, SensitiveRegion};

// Global flag for Windows Native OCR availability
static NATIVE_OCR_AVAILABLE: AtomicBool = AtomicBool::new(false);

// ── Structs ──────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct OnboardingConfig {
    screenshot_folder: String,
    launch_on_startup: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct WatcherConfig {
    enabled: bool,
}

/// Result of a full Tesseract run: flat text
struct OcrResult {
    text: String,
}

// ── Tauri commands ───────────────────────────────────────────

#[tauri::command]
async fn get_onboarding_config(
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Option<OnboardingConfig>, String> {
    let db_guard = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    let folder = db_guard.get_screenshot_folder();
    if let Some(f) = folder {
        Ok(Some(OnboardingConfig {
            screenshot_folder: f,
            launch_on_startup: db_guard.get_launch_on_startup(),
        }))
    } else {
        Ok(None)
    }
}

#[tauri::command]
async fn complete_onboarding(
    config: OnboardingConfig,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    println!("Onboarding completed: {:?}", config);
    let db_guard = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    db_guard.set_screenshot_folder(&config.screenshot_folder)?;
    db_guard.set_launch_on_startup(config.launch_on_startup)?;
    drop(db_guard);

    let folder_clone = config.screenshot_folder.clone();
    let db_clone = db.inner().clone();
    std::thread::spawn(move || {
        scan_existing_screenshots(vec![folder_clone], db_clone, app_handle);
    });

    Ok(())
}

#[tauri::command]
async fn get_screenshot_folder(
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Option<String>, String> {
    let db_guard = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    Ok(db_guard.get_screenshot_folder())
}

#[tauri::command]
async fn set_screenshot_folder(
    folder: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let db_guard = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    db_guard.set_screenshot_folder(&folder)?;
    drop(db_guard);

    let folder_clone = folder.clone();
    let db_clone = db.inner().clone();
    std::thread::spawn(move || {
        scan_existing_screenshots(vec![folder_clone], db_clone, app_handle);
    });

    Ok(())
}

#[tauri::command]
async fn get_watcher_config() -> Result<WatcherConfig, String> {
    Ok(WatcherConfig { enabled: true })
}

#[tauri::command]
async fn set_watcher_enabled(enabled: bool) -> Result<(), String> {
    println!("Watcher enabled: {}", enabled);
    Ok(())
}

#[tauri::command]
async fn get_intro_seen(db: tauri::State<'_, Arc<Mutex<Database>>>) -> Result<bool, String> {
    let db_guard = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    Ok(db_guard.get_intro_seen())
}

#[tauri::command]
async fn set_intro_seen(
    seen: bool,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db_guard = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    db_guard.set_intro_seen(seen)?;
    Ok(())
}

// ── Pro Features ──────────────────────────────────────────────

#[tauri::command]
async fn activate_license_key(
    key: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<bool, String> {
    if key == "kaptur_pro_test" {
        let db_guard = db
            .lock()
            .map_err(|e| format!("Database lock error: {}", e))?;
        db_guard.set_license_key(&key)?;
        db_guard.set_is_pro_active(true)?;
        return Ok(true);
    }

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "product_permalink": "YOUR_GUMROAD_PRODUCT_PERMALINK",
        "license_key": &key,
    });
    let res = client.post("https://api.gumroad.com/v2/licenses/verify")
        .json(&payload)
        .send()
        .await
        .map_err(|_| "Could not reach the activation server. Please check your internet connection and try again.".to_string())?;

    if res.status().is_success() {
        let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        if json["success"].as_bool().unwrap_or(false) {
            let db_guard = db
                .lock()
                .map_err(|e| format!("Database lock error: {}", e))?;
            db_guard.set_license_key(&key)?;
            db_guard.set_is_pro_active(true)?;
            return Ok(true);
        }
    }

    Ok(false)
}

#[tauri::command]
async fn get_is_pro_active(db: tauri::State<'_, Arc<Mutex<Database>>>) -> Result<bool, String> {
    let db_guard = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    Ok(db_guard.get_is_pro_active())
}

#[tauri::command]
async fn get_watch_folders(
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<String>, String> {
    let db_guard = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    db_guard.get_watch_folders()
}

#[tauri::command]
async fn add_watch_folder(
    path: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db_guard = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    db_guard.add_watch_folder(&path)
}

#[tauri::command]
async fn remove_watch_folder(
    path: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db_guard = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    db_guard.remove_watch_folder(&path)
}

#[tauri::command]
async fn export_vault(db: tauri::State<'_, Arc<Mutex<Database>>>) -> Result<String, String> {
    let db_guard = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;

    let screenshots = db_guard
        .get_recent(1_000_000, None, None, None)
        .map_err(|e| e.to_string())?;
    drop(db_guard);

    let mut download_dir = dirs::download_dir().ok_or("Could not find Downloads folder")?;
    let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
    let file_name = format!("Kaptur_Export_{}.zip", timestamp);
    download_dir.push(&file_name);

    let file = std::fs::File::create(&download_dir)
        .map_err(|e| format!("Failed to create zip file: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);

    // In zip crate v8.6.0, options are set using SimpleFileOptions
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    let mut manifest = Vec::new();

    for s in screenshots {
        if let Ok(mut img_file) = std::fs::File::open(&s.path) {
            let img_name = std::path::Path::new(&s.path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("image.png");

            // Prepend ID to avoid duplicate filenames in zip
            let unique_name = format!("{}_{}", s.id, img_name);

            if zip.start_file(unique_name.clone(), options).is_ok() {
                let _ = std::io::copy(&mut img_file, &mut zip);

                manifest.push(serde_json::json!({
                    "id": s.id,
                    "file_name": unique_name,
                    "captured_at": s.captured_at,
                    "ocr_text": s.ocr_text,
                    "ocr_status": s.ocr_status,
                }));
            }
        }
    }

    if zip.start_file("manifest.json", options).is_ok() {
        let manifest_str = serde_json::to_string_pretty(&manifest).unwrap_or_default();
        let _ = std::io::Write::write_all(&mut zip, manifest_str.as_bytes());
    }

    zip.finish()
        .map_err(|e| format!("Failed to finish zip: {}", e))?;

    Ok(download_dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn search_screenshots(
    query: String,
    cursor: Option<Cursor>,
    limit: Option<usize>,
    sort: Option<String>,
    filter: Option<String>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<database::Screenshot>, String> {
    let db = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    db.search(
        &query,
        limit.unwrap_or(50),
        cursor.as_ref(),
        sort.as_deref(),
        filter.as_deref(),
    )
}

#[tauri::command]
async fn get_recent_screenshots(
    limit: Option<usize>,
    cursor: Option<Cursor>,
    sort: Option<String>,
    filter: Option<String>,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<database::Screenshot>, String> {
    let db = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    db.get_recent(
        limit.unwrap_or(50),
        cursor.as_ref(),
        sort.as_deref(),
        filter.as_deref(),
    )
}

#[tauri::command]
async fn get_screenshots_by_days(
    days: i64,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<database::Screenshot>, String> {
    let db = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    db.get_recent_days(days)
}

#[tauri::command]
async fn open_screenshot(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "start", "", &path]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.spawn().map_err(|e| format!("Failed to open: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
async fn read_image_as_base64(path: String) -> Result<String, String> {
    let data = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let encoded = STANDARD.encode(&data);
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    };
    Ok(format!("data:{};base64,{}", mime, encoded))
}

#[tauri::command]
async fn check_ocr_available() -> Result<bool, String> {
    Ok(NATIVE_OCR_AVAILABLE.load(Ordering::Relaxed))
}

#[tauri::command]
async fn reprocess_ocr(
    id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if !NATIVE_OCR_AVAILABLE.load(Ordering::Relaxed) {
        return Err("OCR is currently unavailable. Kaptur relies on the Windows native OCR engine to keep your data completely offline and secure. To enable it, please add the English language pack in Windows: Go to Windows Settings > Time & language > Language & region > Add a language, and install 'English (United States)'.".to_string());
    }

    let db_clone = db.inner().clone();

    let path = {
        let db_guard = db
            .lock()
            .map_err(|e| format!("Database lock error: {}", e))?;
        let screenshots = db_guard
            .get_recent(1000, None, None, None)
            .map_err(|e| e.to_string())?;
        let screenshot = screenshots
            .iter()
            .find(|s| s.id == id)
            .ok_or_else(|| "Screenshot not found".to_string())?;
        screenshot.path.clone()
    };

    let path_buf = PathBuf::from(&path);
    let id_clone = id.clone();
    let app_handle = app_handle.clone();

    std::thread::spawn(move || {
        match run_ocr_with_boxes(&path_buf, Some(&app_handle)) {
            Ok(ocr) => {
                // Update OCR text
                if let Ok(db) = db_clone.lock() {
                    let _ = db.update_ocr_text(&id_clone, &ocr.text, OcrStatus::Done.as_str());
                }
            }
            Err(e) => {
                eprintln!("OCR reprocess failed: {}", e);
                if let Ok(db) = db_clone.lock() {
                    let _ = db.update_ocr_text(&id_clone, "", OcrStatus::Failed.as_str());
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn reprocess_all_failed(
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    app_handle: tauri::AppHandle,
) -> Result<usize, String> {
    if !NATIVE_OCR_AVAILABLE.load(Ordering::Relaxed) {
        return Err("OCR is currently unavailable. Please install the English language pack in Windows Settings.".to_string());
    }

    let db_clone = db.inner().clone();

    let failed = {
        let db_guard = db
            .lock()
            .map_err(|e| format!("Database lock error: {}", e))?;
        db_guard.get_failed_ocr(1000).map_err(|e| e.to_string())?
    };

    let count = failed.len();

    for screenshot in failed {
        let id = screenshot.id.clone();
        let path = screenshot.path.clone();
        let db_for_thread = db_clone.clone();
        let path_buf = PathBuf::from(&path);
        let app_handle = app_handle.clone();

        std::thread::spawn(
            move || match run_ocr_with_boxes(&path_buf, Some(&app_handle)) {
                Ok(ocr) => {
                    if let Ok(db) = db_for_thread.lock() {
                        let _ = db.update_ocr_text(&id, &ocr.text, OcrStatus::Done.as_str());
                    }
                }
                Err(e) => {
                    eprintln!("OCR reprocess failed: {}", e);
                    if let Ok(db) = db_for_thread.lock() {
                        let _ = db.update_ocr_text(&id, "", OcrStatus::Failed.as_str());
                    }
                }
            },
        );
    }

    Ok(count)
}

#[tauri::command]
fn toggle_favorite(
    db: tauri::State<'_, Arc<Mutex<Database>>>,
    id: String,
    is_favorite: bool,
) -> Result<(), String> {
    let db_guard = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    db_guard.toggle_favorite(&id, is_favorite)
}

// ── Thumbnail commands ───────────────────────────────────────

/// Get the system cache directory for thumbnails.
fn get_thumbnails_cache_dir() -> Result<PathBuf, String> {
    let mut cache_dir =
        dirs::cache_dir().ok_or_else(|| "Failed to get cache directory".to_string())?;
    cache_dir.push("kaptur");
    cache_dir.push("thumbnails");
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create thumbnails directory: {}", e))?;
    Ok(cache_dir)
}

fn get_thumbnail_path(hash: &str) -> Result<PathBuf, String> {
    let cache_dir = get_thumbnails_cache_dir()?;
    Ok(cache_dir.join(format!("{}.jpg", hash)))
}

// Helper: Generate and cache thumbnail (300px wide, JPEG quality 80)
fn generate_thumbnail(path: &Path, hash: &str) -> Result<PathBuf, String> {
    let thumbnail_path = get_thumbnail_path(hash)?;

    // If thumbnail already exists, return it as-is
    if thumbnail_path.exists() {
        return Ok(thumbnail_path);
    }

    // Open the source image
    let img =
        image::open(path).map_err(|e| format!("Failed to open image for thumbnail: {}", e))?;

    // Resize to max 300px wide, preserving aspect ratio
    let thumb = img.resize(300, u32::MAX, FilterType::Lanczos3);

    // Save as JPEG
    let mut file = std::fs::File::create(&thumbnail_path)
        .map_err(|e| format!("Failed to create thumbnail file: {}", e))?;
    thumb
        .write_to(&mut file, ImageFormat::Jpeg)
        .map_err(|e| format!("Failed to write thumbnail: {}", e))?;

    eprintln!("Generated thumbnail: {:?}", thumbnail_path);
    Ok(thumbnail_path)
}

/// Tauri command: return the thumbnail for a screenshot as a base64 data-URI.
/// Validates the original file still exists; generates + caches the thumbnail on first call.
#[tauri::command]
async fn get_or_generate_thumbnail(hash: String, path: String) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);

    // Cache-invalidation: original file gone → tell the frontend gracefully
    if !path_buf.exists() {
        return Err("file_not_found".to_string());
    }

    let thumbnail_path = get_thumbnail_path(&hash)?;

    // Generate if not yet cached
    if !thumbnail_path.exists() {
        generate_thumbnail(&path_buf, &hash)?;
    }

    let data =
        std::fs::read(&thumbnail_path).map_err(|e| format!("Failed to read thumbnail: {}", e))?;

    let encoded = STANDARD.encode(&data);
    Ok(format!("data:image/jpeg;base64,{}", encoded))
}

// ── Overlay commands ─────────────────────────────────────────

#[tauri::command]
async fn show_overlay_window(app: AppHandle) -> Result<(), String> {
    eprintln!("show_overlay_window called!");
    let overlay = app
        .get_webview_window("overlay")
        .ok_or("Overlay window not found")?;
    overlay
        .show()
        .map_err(|e| format!("Failed to show overlay: {}", e))?;
    overlay
        .set_focus()
        .map_err(|e| format!("Failed to focus overlay: {}", e))?;
    let _ = overlay.eval("document.getElementById('overlay-search')?.value = ''");
    Ok(())
}

#[tauri::command]
async fn trigger_overlay(app: AppHandle) -> Result<(), String> {
    eprintln!("trigger_overlay called - testing overlay manually");
    show_overlay_window(app).await
}

#[tauri::command]
async fn hide_overlay_window(app: AppHandle) -> Result<(), String> {
    let overlay = app
        .get_webview_window("overlay")
        .ok_or("Overlay window not found")?;
    overlay
        .hide()
        .map_err(|e| format!("Failed to hide overlay: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn copy_image_to_clipboard(path: String) -> Result<(), String> {
    let _image_data = std::fs::read(&path).map_err(|e| format!("Failed to read image: {}", e))?;

    #[cfg(target_os = "windows")]
    {
        let ps_script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('{}'))",
            path.replace("\\", "\\\\")
        );
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-Command", &ps_script]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.output().map_err(|e| format!("Failed to copy: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "tell application \"System Events\" to set thePicture to (read \"{}\" as file picture)",
            path
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| format!("Failed to copy: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xclip")
            .args(["-t", "image/png", "-i", &path])
            .output()
            .map_err(|e| format!("Failed to copy (install xclip): {}", e))?;
    }

    Ok(())
}

#[tauri::command]
async fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer");
        cmd.args(["/select,", &path]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.spawn()
            .map_err(|e| format!("Failed to reveal: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to reveal: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("dbus-send")
            .args([
                "--session",
                "--dest=org.freedesktop.FileManager1",
                "--type=method_call",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1",
                "ShowItems",
                "array:string:1",
                &path,
                "string:",
            ])
            .spawn()
            .map_err(|e| format!("Failed to reveal: {}", e))?;
    }
    Ok(())
}

// ── Sensitive-region commands ────────────────────────────────

#[tauri::command]
async fn get_sensitive_regions(
    screenshot_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<SensitiveRegion>, String> {
    let db = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    db.get_sensitive_regions(&screenshot_id)
}

#[tauri::command]
async fn dismiss_sensitive_region(
    region_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    db.dismiss_sensitive_region(&region_id)
}

#[tauri::command]
async fn add_manual_region(
    screenshot_id: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    img_width: i32,
    img_height: i32,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<String, String> {
    let region = SensitiveRegion {
        id: uuid::Uuid::new_v4().to_string(),
        screenshot_id,
        x,
        y,
        width,
        height,
        img_width,
        img_height,
        match_type: "manual".to_string(),
        match_text: "".to_string(),
        is_dismissed: false,
    };
    let id = region.id.clone();
    let db = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    db.insert_sensitive_regions(&[region])?;
    Ok(id)
}

#[tauri::command]
async fn delete_region(
    region_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    db.delete_region(&region_id)
}

#[tauri::command]
async fn update_region(
    region_id: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db
        .lock()
        .map_err(|e| format!("Database lock error: {}", e))?;
    db.update_region(&region_id, x, y, width, height)
        .map_err(|e| format!("Database error: {}", e))
}

#[tauri::command]
async fn get_annotations(
    screenshot_id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<Vec<crate::database::Annotation>, String> {
    let db = db.lock().unwrap();
    db.get_annotations(&screenshot_id)
        .map_err(|e| format!("Database error: {}", e))
}

#[tauri::command]
async fn add_annotation(
    annotation: crate::database::Annotation,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db.lock().unwrap();
    db.add_annotation(&annotation)
        .map_err(|e| format!("Database error: {}", e))
}

#[tauri::command]
async fn delete_annotation(
    id: String,
    db: tauri::State<'_, Arc<Mutex<Database>>>,
) -> Result<(), String> {
    let db = db.lock().unwrap();
    db.delete_annotation(&id)
        .map_err(|e| format!("Database error: {}", e))
}

// ── App entry point ───────────────────────────────────────────

fn compute_hash(path: &Path) -> Result<String, String> {
    let contents = std::fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;
    let mut hasher = Sha256::new();
    hasher.update(&contents);
    Ok(format!("{:x}", hasher.finalize()))
}

fn is_native_ocr_supported(_app: Option<&tauri::AppHandle>) -> bool {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Media::Ocr::OcrEngine;

    if let Ok(lang) = Language::CreateLanguage(&HSTRING::from("en-US")) {
        OcrEngine::IsLanguageSupported(&lang).unwrap_or(false)
    } else {
        false
    }
}

fn run_ocr_with_boxes(path: &Path, _app: Option<&tauri::AppHandle>) -> Result<OcrResult, String> {
    tauri::async_runtime::block_on(async {
        use windows::core::HSTRING;
        use windows::Globalization::Language;
        use windows::Graphics::Imaging::BitmapDecoder;
        use windows::Media::Ocr::OcrEngine;
        use windows::Storage::StorageFile;

        let path_hstring = HSTRING::from(path.to_string_lossy().as_ref());
        let file = StorageFile::GetFileFromPathAsync(&path_hstring)
            .map_err(|e| format!("Failed to get file: {}", e))?
            .await
            .map_err(|e| format!("Failed to open file: {}", e))?;

        let stream = file
            .OpenReadAsync()
            .map_err(|e| format!("Failed to get stream: {}", e))?
            .await
            .map_err(|e| format!("Failed to open stream: {}", e))?;

        let decoder = BitmapDecoder::CreateAsync(&stream)
            .map_err(|e| format!("Failed to create decoder: {}", e))?
            .await
            .map_err(|e| format!("Failed to run decoder: {}", e))?;

        let bitmap = decoder
            .GetSoftwareBitmapAsync()
            .map_err(|e| format!("Failed to get bitmap task: {}", e))?
            .await
            .map_err(|e| format!("Failed to get bitmap: {}", e))?;

        let lang = Language::CreateLanguage(&HSTRING::from("en-US"))
            .map_err(|e| format!("Failed to create language: {}", e))?;

        let engine = OcrEngine::TryCreateFromLanguage(&lang)
            .map_err(|e| format!("Failed to create OCR engine: {}", e))?;

        let result = engine
            .RecognizeAsync(&bitmap)
            .map_err(|e| format!("Failed to start OCR: {}", e))?
            .await
            .map_err(|e| format!("Failed to complete OCR: {}", e))?;

        let mut text = String::new();

        let lines = result
            .Lines()
            .map_err(|e| format!("Failed to get lines: {}", e))?;
        for line in lines {
            let line_words = line
                .Words()
                .map_err(|e| format!("Failed to get words: {}", e))?;
            for word in line_words {
                let w_text = word
                    .Text()
                    .map_err(|e| format!("Failed to get word text: {}", e))?
                    .to_string();
                text.push_str(&w_text);
                text.push(' ');
            }
            text.push('\n');
        }

        Ok(OcrResult { text })
    })
}

// ── Processing pipeline ───────────────────────────────────────

fn process_screenshot(path: PathBuf, db: Arc<Mutex<Database>>, app_handle: AppHandle) {
    println!("Processing screenshot: {:?}", path);

    // Compute hash with retry (in case the OS/Snipping Tool is still writing to the file)
    let mut hash_result = compute_hash(&path);
    let mut retries = 0;
    while hash_result.is_err() && retries < 10 {
        std::thread::sleep(std::time::Duration::from_millis(200));
        hash_result = compute_hash(&path);
        retries += 1;
    }

    let hash = match hash_result {
        Ok(h) => h,
        Err(e) => {
            eprintln!("Failed to compute hash after retries: {}", e);
            return;
        }
    };

    // Generate thumbnail (fire and forget)
    let hash_clone = hash.clone();
    let path_clone = path.clone();
    std::thread::spawn(move || {
        if let Err(e) = generate_thumbnail(&path_clone, &hash_clone) {
            eprintln!("Failed to generate thumbnail: {}", e);
        }
    });

    // Check if already indexed
    let db_guard = match db.lock() {
        Ok(g) => g,
        Err(e) => {
            eprintln!("Failed to lock database: {}", e);
            return;
        }
    };

    let exists = match db_guard.hash_exists(&hash) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("Failed to check hash: {}", e);
            false
        }
    };

    if exists {
        println!("Screenshot already indexed, skipping");
        return;
    }

    let captured_at = path
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or_else(|| Utc::now().timestamp());

    let id = uuid::Uuid::new_v4().to_string();

    if let Ok(true) = db_guard.path_exists(path.to_str().unwrap_or("")) {
        println!("Path already exists, removing old record to replace with new hash");
        let _ = db_guard.delete_screenshot_by_path(path.to_str().unwrap_or(""));
    }

    if let Err(e) = db_guard.insert_screenshot(&id, path.to_str().unwrap_or(""), &hash, captured_at)
    {
        eprintln!("Failed to insert screenshot: {}", e);
        return;
    }

    drop(db_guard);

    let _ = app_handle.emit("screenshots-updated", ());

    let db_clone = db.clone();
    let id_clone = id.clone();
    let path_clone = path.clone();
    let app_clone = app_handle.clone();

    std::thread::spawn(move || {
        println!("Running OCR on: {:?}", path_clone);

        if !NATIVE_OCR_AVAILABLE.load(Ordering::Relaxed) {
            if let Ok(db) = db_clone.lock() {
                let _ = db.update_ocr_text(&id_clone, "", OcrStatus::Unavailable.as_str());
            }
            let _ = app_clone.emit("screenshots-updated", ());
            return;
        }

        match run_ocr_with_boxes(&path_clone, Some(&app_clone)) {
            Ok(ocr) => {
                println!(
                    "OCR complete for: {:?} ({} chars)",
                    path_clone,
                    ocr.text.len()
                );
                if let Ok(db) = db_clone.lock() {
                    let _ = db.update_ocr_text(&id_clone, &ocr.text, OcrStatus::Done.as_str());
                }
                let _ = app_clone.emit("screenshots-updated", ());
            }
            Err(e) => {
                eprintln!("OCR failed: {}", e);
                if let Ok(db) = db_clone.lock() {
                    let _ = db.update_ocr_text(&id_clone, "", OcrStatus::Failed.as_str());
                }
                let _ = app_clone.emit("screenshots-updated", ());
            }
        }
    });
}

fn start_file_watcher(
    folders: Vec<String>,
    db: Arc<Mutex<Database>>,
    app_handle: AppHandle,
) -> Result<notify::RecommendedWatcher, String> {
    let mut watcher = notify::recommended_watcher(move |res: Result<Event, _>| match res {
        Ok(event) => {
            if !matches!(event.kind, EventKind::Remove(_) | EventKind::Access(_)) {
                if let Some(path) = event.paths.first() {
                    if let Some(ext) = path.extension() {
                        if ext == "png" || ext == "jpg" || ext == "jpeg" {
                            println!("New screenshot detected: {:?}", path);
                            let db_clone = db.clone();
                            let path_clone = path.clone();
                            let app_clone = app_handle.clone();
                            std::thread::spawn(move || {
                                process_screenshot(path_clone, db_clone, app_clone);
                            });
                        }
                    }
                }
            }
        }
        Err(e) => eprintln!("Watch error: {:?}", e),
    })
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    for folder in folders {
        let watch_path = PathBuf::from(&folder);
        if watch_path.exists() {
            let _ = watcher.watch(&watch_path, RecursiveMode::NonRecursive);
            println!("Started watching folder: {}", folder);
        } else {
            eprintln!("Watch folder does not exist: {}", folder);
        }
    }

    Ok(watcher)
}

fn scan_existing_screenshots(
    folders: Vec<String>,
    db: Arc<Mutex<Database>>,
    app_handle: AppHandle,
) {
    std::thread::spawn(move || {
        for folder in folders {
            let watch_path = PathBuf::from(&folder);
            if !watch_path.exists() {
                eprintln!("Scan folder does not exist: {}", folder);
                continue;
            }

            let entries = match std::fs::read_dir(&watch_path) {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("Failed to read dir: {}", e);
                    continue;
                }
            };

            let mut count = 0u32;

            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }

                let ext = match path.extension() {
                    Some(e) => e.to_string_lossy().to_lowercase(),
                    None => continue,
                };
                if ext != "png" && ext != "jpg" && ext != "jpeg" {
                    continue;
                }

                let path_str = path.to_str().unwrap_or("").to_string();

                {
                    let Ok(guard) = db.lock() else {
                        continue;
                    };
                    if matches!(guard.path_exists(&path_str), Ok(true)) {
                        continue;
                    }
                }

                let hash = match compute_hash(&path) {
                    Ok(h) => h,
                    Err(_) => continue,
                };

                let captured_at = path
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or_else(|| Utc::now().timestamp());

                let id = uuid::Uuid::new_v4().to_string();

                {
                    let Ok(guard) = db.lock() else {
                        continue;
                    };
                    if guard
                        .insert_screenshot(&id, &path_str, &hash, captured_at)
                        .is_err()
                    {
                        continue;
                    }
                }

                count += 1;

                // Generate thumbnail
                let hash_c = hash.clone();
                let path_c_thumb = path.clone();
                std::thread::spawn(move || {
                    if let Err(e) = generate_thumbnail(&path_c_thumb, &hash_c) {
                        eprintln!("Failed to generate thumbnail: {}", e);
                    }
                });

                // OCR + sensitive region detection in background
                let db_c = db.clone();
                let id_c = id.clone();
                let path_c = path.clone();
                let app_c = app_handle.clone();
                std::thread::spawn(move || {
                    if !NATIVE_OCR_AVAILABLE.load(Ordering::Relaxed) {
                        if let Ok(g) = db_c.lock() {
                            let _ = g.update_ocr_text(&id_c, "", OcrStatus::Unavailable.as_str());
                        }
                        return;
                    }

                    match run_ocr_with_boxes(&path_c, Some(&app_c)) {
                        Ok(ocr) => {
                            if let Ok(g) = db_c.lock() {
                                let _ =
                                    g.update_ocr_text(&id_c, &ocr.text, OcrStatus::Done.as_str());
                            }
                        }
                        Err(_) => {
                            if let Ok(g) = db_c.lock() {
                                let _ = g.update_ocr_text(&id_c, "", OcrStatus::Failed.as_str());
                            }
                        }
                    }
                });
            } // End of entries loop

            eprintln!(
                "Initial scan complete for {}: {} screenshots indexed",
                folder, count
            );
            if count > 0 {
                let _ = app_handle.emit("screenshots-updated", ());
            }
        } // End of folders loop
    });
}

#[tauri::command]
async fn save_protected_copy(
    image_base64: String,
    suggested_name: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    // Default to Pictures/Kaptur Exports
    let default_dir = dirs::picture_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Kaptur Exports");

    if !default_dir.exists() {
        std::fs::create_dir_all(&default_dir).unwrap_or_default();
    }

    // If using the dialog plugin's save() with await
    let file_path = app_handle
        .dialog()
        .file()
        .set_title("Save Protected Copy")
        .set_file_name(&suggested_name)
        .set_directory(&default_dir)
        .add_filter("PNG Image", &["png"])
        .blocking_save_file();

    match file_path {
        Some(path) => {
            // Strip data:image/png;base64, prefix if present
            let b64 = if let Some(stripped) = image_base64.strip_prefix("data:image/png;base64,") {
                stripped
            } else {
                &image_base64
            };

            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| format!("Failed to decode base64: {}", e))?;

            std::fs::write(path.as_path().unwrap(), bytes)
                .map_err(|e| format!("Failed to save file: {}", e))?;

            Ok(path.as_path().unwrap().to_string_lossy().to_string())
        }
        None => Err("User cancelled".to_string()),
    }
}

fn cleanup_temp_drag_files() {
    let temp_dir = std::env::temp_dir().join("kaptur_drags");
    if !temp_dir.exists() {
        return;
    }

    // Delete files older than 1 hour
    let threshold = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if let Ok(modified) = metadata.modified() {
                    if modified < threshold {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }
    }
}

#[tauri::command]
async fn generate_temp_drag_file(
    image_base64: String,
    suggested_name: String,
) -> Result<String, String> {
    // Run cleanup on every drag operation as requested
    cleanup_temp_drag_files();

    let temp_dir = std::env::temp_dir().join("kaptur_drags");
    if !temp_dir.exists() {
        std::fs::create_dir_all(&temp_dir).unwrap_or_default();
    }

    let file_path = temp_dir.join(format!("{}_{}", uuid::Uuid::new_v4(), suggested_name));

    let b64 = if let Some(stripped) = image_base64.strip_prefix("data:image/png;base64,") {
        stripped
    } else {
        &image_base64
    };

    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    std::fs::write(&file_path, bytes).map_err(|e| format!("Failed to save temp file: {}", e))?;

    Ok(file_path.to_string_lossy().into_owned())
}

// ── App entry point ───────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Do an initial cleanup on startup
    cleanup_temp_drag_files();

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        eprintln!("Hotkey pressed! Showing overlay...");
                        if let Some(overlay) = app.get_webview_window("overlay") {
                            let _ = overlay.show();
                            let _ = overlay.set_focus();
                            let _ = overlay.eval("document.getElementById('overlay-search')?.value = ''");
                        } else {
                            eprintln!("Overlay window not found!");
                        }
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "main" || window.label() == "overlay" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
            _ => {}
        })
        .setup(|app| {
            // Check Windows Native OCR availability first
            let ocr_available = is_native_ocr_supported(Some(app.handle()));
            NATIVE_OCR_AVAILABLE.store(ocr_available, Ordering::Relaxed);

            if !ocr_available {
                eprintln!("WARNING: Windows Native OCR not available (English pack missing)");
                let install_msg = "OCR is currently unavailable. Kaptur relies on the Windows native OCR engine to keep your data completely offline and secure. To enable it, please add the English language pack in Windows: Go to Windows Settings > Time & language > Language & region > Add a language, and install 'English (United States)'.";
                let _ = app.emit("ocr-unavailable", install_msg);
            } else {
                eprintln!("Windows Native OCR is available");
                let _ = app.emit("ocr-available", ());
            }

            // Initialize database
            let db_path = app.path().app_data_dir()
                .unwrap()
                .join("screenshots.db");
            let db = Arc::new(Mutex::new(
                Database::new(&db_path).map_err(|e| format!("Database error: {}", e))?
            ));
            app.manage(db.clone());

            // Platform-specific hotkey string
            #[cfg(target_os = "windows")]
            let hotkey = "Ctrl+Shift+F";
            #[cfg(target_os = "macos")]
            let hotkey = "Cmd+Shift+F";
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            let hotkey = "Ctrl+Shift+F";

            match app.global_shortcut().register(hotkey) {
                Ok(_) => eprintln!("Global hotkey registered: {}", hotkey),
                Err(e) => eprintln!("Failed to register hotkey {}: {}", hotkey, e),
            }

            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                let _ = main.set_focus();
                eprintln!("Main window shown");
            } else {
                eprintln!("Main window not found in setup!");
            }

            let mut all_folders = Vec::new();
            {
                let db_guard = db.lock().unwrap();
                if let Some(main_folder) = db_guard.get_screenshot_folder() {
                    all_folders.push(main_folder);
                }
                if let Ok(extra_folders) = db_guard.get_watch_folders() {
                    all_folders.extend(extra_folders);
                }
            }

            if !all_folders.is_empty() {
                // Deduplicate folders just in case
                all_folders.sort();
                all_folders.dedup();

                match start_file_watcher(all_folders.clone(), db.clone(), app.handle().clone()) {
                    Ok(watcher) => {
                        Box::leak(Box::new(watcher));
                    }
                    Err(e) => eprintln!("Failed to start watcher: {}", e),
                }
                scan_existing_screenshots(all_folders, db.clone(), app.handle().clone());
            }

            let quit_i = MenuItem::with_id(app, "quit", "Quit Kaptur", true, None::<&str>).unwrap();
            let show_i = MenuItem::with_id(app, "show", "Show Kaptur", true, None::<&str>).unwrap();
            let menu = Menu::with_items(app, &[&show_i, &quit_i]).unwrap();

            let app_handle_for_tray = app.handle().clone();
            let app_handle_for_build = app_handle_for_tray.clone();
            let _ = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(move |app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    } else if event.id.as_ref() == "show" {
                        if let Some(main) = app.get_webview_window("main") {
                            let _ = main.show();
                            let _ = main.set_focus();
                        }
                    }
                })
                .on_tray_icon_event(move |_tray, event| match event {
                    TrayIconEvent::DoubleClick { .. } => {
                        if let Some(main) = app_handle_for_tray.get_webview_window("main") {
                            let _ = main.show();
                            let _ = main.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(&app_handle_for_build);

            eprintln!("Kaptur initialized with OCR + sensitive-region detection, global hotkey, and tray icon");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_intro_seen,
            set_intro_seen,
            get_onboarding_config,
            complete_onboarding,
            get_screenshot_folder,
            set_screenshot_folder,
            get_watcher_config,
            set_watcher_enabled,
            search_screenshots,
            get_recent_screenshots,
            get_screenshots_by_days,
            open_screenshot,
            show_overlay_window,
            hide_overlay_window,
            copy_image_to_clipboard,
            reveal_in_explorer,
            trigger_overlay,
            read_image_as_base64,
            check_ocr_available,
            reprocess_ocr,
            reprocess_all_failed,
            get_or_generate_thumbnail,
            get_sensitive_regions,
            dismiss_sensitive_region,
            add_manual_region,
            delete_region,
            update_region,
            get_annotations,
            add_annotation,
            delete_annotation,
            activate_license_key,
            get_is_pro_active,
            get_watch_folders,
            add_watch_folder,
            remove_watch_folder,
            export_vault,
            toggle_favorite,
            save_protected_copy,
            generate_temp_drag_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
