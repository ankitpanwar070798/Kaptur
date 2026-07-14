use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Screenshot {
    pub id: String,
    pub path: String,
    pub hash: String,
    pub ocr_text: Option<String>,
    pub captured_at: i64,
    pub ocr_status: String,
    pub is_favorite: bool,
}

// Pagination cursor: (captured_at, id)
#[derive(Debug, Serialize, Deserialize)]
pub struct Cursor {
    pub captured_at: i64,
    pub id: String,
}

#[derive(Debug, Clone, Copy)]
pub enum OcrStatus {
    #[allow(dead_code)] // State is set via SQL DEFAULT 'pending'; never constructed from Rust
    Pending,
    Done,
    Failed,
    Unavailable,
}

impl OcrStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            OcrStatus::Pending => "pending",
            OcrStatus::Done => "done",
            OcrStatus::Failed => "failed",
            OcrStatus::Unavailable => "unavailable",
        }
    }
}

/// A detected sensitive text region in a screenshot.
/// Coordinates are in original-image pixels; scale by
/// (display_width / img_width) before rendering overlays.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SensitiveRegion {
    pub id: String,
    pub screenshot_id: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// Original image dimensions — used by the UI to scale to thumbnail display size.
    pub img_width: i32,
    pub img_height: i32,
    /// One of: card_number | email | phone | otp | id_number | multiple
    pub match_type: String,
    /// Truncated / masked value for UI labelling only (never the full sensitive string).
    /// Empty for otp matches.
    pub match_text: String,
    /// true = user dismissed this region ("not sensitive")
    pub is_dismissed: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Annotation {
    pub id: String,
    pub screenshot_id: String,
    pub tool: String, // "arrow", "box", "highlight"
    pub start_x: i32,
    pub start_y: i32,
    pub end_x: i32,
    pub end_y: i32,
    pub color: String, // hex color
    pub img_width: i32,
    pub img_height: i32,
}

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new(db_path: &Path) -> Result<Self, String> {
        // Create parent directory if it doesn't exist
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        let conn =
            Connection::open(db_path).map_err(|e| format!("Failed to open database: {}", e))?;

        // Create main table first
        conn.execute(
            "CREATE TABLE IF NOT EXISTS screenshots (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL,
                hash TEXT NOT NULL UNIQUE,
                ocr_text TEXT,
                captured_at INTEGER NOT NULL,
                ocr_status TEXT DEFAULT 'pending'
            )",
            [],
        )
        .map_err(|e| format!("Failed to create screenshots table: {}", e))?;

        // Migration: add ocr_status column if it doesn't exist
        let has_ocr_status = conn
            .prepare("SELECT ocr_status FROM screenshots LIMIT 1")
            .is_ok();

        if !has_ocr_status {
            eprintln!("Migrating database: adding ocr_status column");
            conn.execute(
                "ALTER TABLE screenshots ADD COLUMN ocr_status TEXT DEFAULT 'pending'",
                [],
            )
            .map_err(|e| format!("Failed to add ocr_status column: {}", e))?;
        }

        // Migration: add is_favorite column if it doesn't exist
        let has_is_favorite = conn
            .prepare("SELECT is_favorite FROM screenshots LIMIT 1")
            .is_ok();

        if !has_is_favorite {
            eprintln!("Migrating database: adding is_favorite column");
            conn.execute(
                "ALTER TABLE screenshots ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|e| format!("Failed to add is_favorite column: {}", e))?;
        }

        // Create FTS5 table
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS screenshots_fts USING fts5(
                ocr_text,
                content='screenshots',
                content_rowid='rowid'
            )",
            [],
        )
        .map_err(|e| format!("Failed to create FTS5 table: {}", e))?;

        // Create index on captured_at
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_screenshots_captured_at ON screenshots(captured_at DESC)",
            [],
        ).map_err(|e| format!("Failed to create index: {}", e))?;

        // Create config table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
            [],
        )
        .map_err(|e| format!("Failed to create config table: {}", e))?;

        // Create sensitive_regions table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sensitive_regions (
                id            TEXT PRIMARY KEY,
                screenshot_id TEXT NOT NULL,
                x             INTEGER NOT NULL,
                y             INTEGER NOT NULL,
                width         INTEGER NOT NULL,
                height        INTEGER NOT NULL,
                img_width     INTEGER NOT NULL,
                img_height    INTEGER NOT NULL,
                match_type    TEXT NOT NULL,
                match_text    TEXT NOT NULL DEFAULT '',
                is_dismissed  INTEGER NOT NULL DEFAULT 0
            )",
            [],
        )
        .map_err(|e| format!("Failed to create sensitive_regions table: {}", e))?;

        // Create watch_folders table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS watch_folders (
                path TEXT PRIMARY KEY
            )",
            [],
        )
        .map_err(|e| format!("Failed to create watch_folders table: {}", e))?;

        // Index for fast per-screenshot lookup
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sensitive_regions_screenshot \
             ON sensitive_regions(screenshot_id)",
            [],
        )
        .map_err(|e| format!("Failed to create sensitive_regions table: {}", e))?;

        // Create annotations table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS annotations (
                id            TEXT PRIMARY KEY,
                screenshot_id TEXT NOT NULL,
                tool          TEXT NOT NULL,
                start_x       INTEGER NOT NULL,
                start_y       INTEGER NOT NULL,
                end_x         INTEGER NOT NULL,
                end_y         INTEGER NOT NULL,
                color         TEXT NOT NULL,
                img_width     INTEGER NOT NULL,
                img_height    INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| format!("Failed to create annotations table: {}", e))?;

        Ok(Database { conn })
    }

    pub fn insert_screenshot(
        &self,
        id: &str,
        path: &str,
        hash: &str,
        captured_at: i64,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO screenshots (id, path, hash, captured_at) VALUES (?1, ?2, ?3, ?4)",
                [id, path, hash, &captured_at.to_string()],
            )
            .map_err(|e| format!("Failed to insert screenshot: {}", e))?;
        Ok(())
    }

    pub fn update_ocr_text(&self, id: &str, ocr_text: &str, status: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE screenshots SET ocr_text = ?1, ocr_status = ?2 WHERE id = ?3",
                [ocr_text, status, id],
            )
            .map_err(|e| format!("Failed to update OCR text: {}", e))?;
        Ok(())
    }

    pub fn hash_exists(&self, hash: &str) -> Result<bool, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT COUNT(*) FROM screenshots WHERE hash = ?1")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let count: i64 = stmt
            .query_row([hash], |row| row.get(0))
            .map_err(|e| format!("Failed to execute query: {}", e))?;
        Ok(count > 0)
    }

    fn build_where_clause(base_where: &str, filter: Option<&str>) -> String {
        let filter_str = filter.unwrap_or("all");
        let extra = match filter_str {
            "has_text" => " AND ocr_status = 'done' AND ocr_text IS NOT NULL AND ocr_text != ''",
            "no_text" => " AND (ocr_status != 'done' OR ocr_text IS NULL OR ocr_text = '')",
            "favorites" => " AND is_favorite = 1",
            _ => "",
        };
        format!("{}{}", base_where, extra)
    }

    pub fn search(
        &self,
        query: &str,
        limit: usize,
        cursor: Option<&Cursor>,
        sort: Option<&str>,
        filter: Option<&str>,
    ) -> Result<Vec<Screenshot>, String> {
        if query.trim().is_empty() {
            return self.get_recent(limit, cursor, sort, filter);
        }

        let like_query = format!("%{}%", query.to_lowercase());
        let is_oldest = sort.unwrap_or("newest") == "oldest";
        let order_sql = if is_oldest {
            "ORDER BY captured_at ASC, id ASC"
        } else {
            "ORDER BY captured_at DESC, id DESC"
        };
        let base_where = "WHERE (LOWER(path) LIKE ?1 OR LOWER(COALESCE(ocr_text, '')) LIKE ?1)";

        let sql = if let Some(_c) = cursor {
            let op = if is_oldest { ">" } else { "<" };
            let cursor_where = format!(
                " AND (captured_at {} ?2 OR (captured_at = ?2 AND id {} ?3))",
                op, op
            );
            let full_where =
                Self::build_where_clause(&format!("{}{}", base_where, cursor_where), filter);
            format!("SELECT id, path, hash, ocr_text, captured_at, ocr_status, is_favorite FROM screenshots {} {} LIMIT ?4", full_where, order_sql)
        } else {
            let full_where = Self::build_where_clause(base_where, filter);
            format!("SELECT id, path, hash, ocr_text, captured_at, ocr_status, is_favorite FROM screenshots {} {} LIMIT ?2", full_where, order_sql)
        };

        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|e| format!("Query prepare error: {}", e))?;

        let screenshots = if let Some(c) = cursor {
            stmt.query_map(
                rusqlite::params![like_query, c.captured_at, c.id, limit],
                |row| {
                    Ok(Screenshot {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        hash: row.get(2)?,
                        ocr_text: row.get(3)?,
                        captured_at: row.get(4)?,
                        ocr_status: row.get(5)?,
                        is_favorite: row.get(6).unwrap_or(false),
                    })
                },
            )
            .map_err(|e| format!("Query execution error: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Result collection error: {}", e))?
        } else {
            stmt.query_map(rusqlite::params![like_query, limit], |row| {
                Ok(Screenshot {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    hash: row.get(2)?,
                    ocr_text: row.get(3)?,
                    captured_at: row.get(4)?,
                    ocr_status: row.get(5)?,
                    is_favorite: row.get(6).unwrap_or(false),
                })
            })
            .map_err(|e| format!("Query execution error: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Result collection error: {}", e))?
        };

        Ok(screenshots)
    }

    pub fn get_recent(
        &self,
        limit: usize,
        cursor: Option<&Cursor>,
        sort: Option<&str>,
        filter: Option<&str>,
    ) -> Result<Vec<Screenshot>, String> {
        let is_oldest = sort.unwrap_or("newest") == "oldest";
        let order_sql = if is_oldest {
            "ORDER BY captured_at ASC, id ASC"
        } else {
            "ORDER BY captured_at DESC, id DESC"
        };

        let sql = if let Some(_c) = cursor {
            let op = if is_oldest { ">" } else { "<" };
            let base_where = format!(
                "WHERE (captured_at {} ?1 OR (captured_at = ?1 AND id {} ?2))",
                op, op
            );
            let full_where = Self::build_where_clause(&base_where, filter);
            format!("SELECT id, path, hash, ocr_text, captured_at, ocr_status, is_favorite FROM screenshots {} {} LIMIT ?3", full_where, order_sql)
        } else {
            let base_where = "WHERE 1=1";
            let full_where = Self::build_where_clause(base_where, filter);
            format!("SELECT id, path, hash, ocr_text, captured_at, ocr_status, is_favorite FROM screenshots {} {} LIMIT ?1", full_where, order_sql)
        };

        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;

        let screenshots = if let Some(c) = cursor {
            stmt.query_map(rusqlite::params![c.captured_at, c.id, limit], |row| {
                Ok(Screenshot {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    hash: row.get(2)?,
                    ocr_text: row.get(3)?,
                    captured_at: row.get(4)?,
                    ocr_status: row.get(5)?,
                    is_favorite: row.get(6).unwrap_or(false),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
        } else {
            stmt.query_map(rusqlite::params![limit], |row| {
                Ok(Screenshot {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    hash: row.get(2)?,
                    ocr_text: row.get(3)?,
                    captured_at: row.get(4)?,
                    ocr_status: row.get(5)?,
                    is_favorite: row.get(6).unwrap_or(false),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
        };

        Ok(screenshots)
    }

    pub fn toggle_favorite(&self, id: &str, is_favorite: bool) -> Result<(), String> {
        let val = if is_favorite { 1 } else { 0 };
        self.conn
            .execute(
                "UPDATE screenshots SET is_favorite = ?1 WHERE id = ?2",
                rusqlite::params![val, id],
            )
            .map_err(|e| format!("Failed to toggle favorite: {}", e))?;
        Ok(())
    }

    pub fn get_recent_days(&self, days: i64) -> Result<Vec<Screenshot>, String> {
        let cutoff = chrono::Utc::now().timestamp() - (days * 24 * 60 * 60);
        let sql = "SELECT id, path, hash, ocr_text, captured_at, ocr_status, is_favorite
                   FROM screenshots
                   WHERE captured_at >= ?1
                   ORDER BY captured_at DESC";

        let mut stmt = self.conn.prepare(sql).map_err(|e| e.to_string())?;

        let screenshots = stmt
            .query_map([cutoff], |row| {
                Ok(Screenshot {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    hash: row.get(2)?,
                    ocr_text: row.get(3)?,
                    captured_at: row.get(4)?,
                    ocr_status: row.get(5)?,
                    is_favorite: row.get(6).unwrap_or(false),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        Ok(screenshots)
    }

    pub fn path_exists(&self, path: &str) -> Result<bool, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT COUNT(*) FROM screenshots WHERE path = ?1")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let count: i64 = stmt
            .query_row([path], |row| row.get(0))
            .map_err(|e| format!("Failed to execute query: {}", e))?;
        Ok(count > 0)
    }

    pub fn delete_screenshot_by_path(&self, path: &str) -> Result<(), String> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM screenshots WHERE path = ?1")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let ids: Vec<String> = stmt
            .query_map([path], |row| row.get(0))
            .map_err(|e| format!("Failed to execute query: {}", e))?
            .filter_map(Result::ok)
            .collect();

        for id in ids {
            let _ = self.delete_regions_for_screenshot(&id);
            self.conn
                .execute("DELETE FROM screenshots WHERE id = ?1", [&id])
                .map_err(|e| format!("Failed to delete screenshot: {}", e))?;
        }
        Ok(())
    }

    pub fn get_failed_ocr(&self, limit: usize) -> Result<Vec<Screenshot>, String> {
        let sql = "SELECT id, path, hash, ocr_text, captured_at, ocr_status, is_favorite
                   FROM screenshots
                   WHERE ocr_status IN ('failed', 'pending')
                   ORDER BY captured_at DESC
                   LIMIT ?1";

        let mut stmt = self.conn.prepare(sql).map_err(|e| e.to_string())?;

        let screenshots = stmt
            .query_map([limit], |row| {
                Ok(Screenshot {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    hash: row.get(2)?,
                    ocr_text: row.get(3)?,
                    captured_at: row.get(4)?,
                    ocr_status: row.get(5)?,
                    is_favorite: row.get(6).unwrap_or(false),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        Ok(screenshots)
    }

    // ── Sensitive regions ────────────────────────────────────

    /// Insert a batch of sensitive regions. Silently skips on conflict (idempotent).
    pub fn insert_sensitive_regions(&self, regions: &[SensitiveRegion]) -> Result<(), String> {
        for r in regions {
            self.conn
                .execute(
                    "INSERT OR IGNORE INTO sensitive_regions
                 (id, screenshot_id, x, y, width, height, img_width, img_height,
                  match_type, match_text, is_dismissed)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)",
                    rusqlite::params![
                        r.id,
                        r.screenshot_id,
                        r.x,
                        r.y,
                        r.width,
                        r.height,
                        r.img_width,
                        r.img_height,
                        r.match_type,
                        r.match_text,
                    ],
                )
                .map_err(|e| format!("Failed to insert sensitive region: {}", e))?;
        }
        Ok(())
    }

    pub fn get_sensitive_regions(
        &self,
        screenshot_id: &str,
    ) -> Result<Vec<SensitiveRegion>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, screenshot_id, x, y, width, height, img_width, img_height,
                    match_type, match_text, is_dismissed
             FROM sensitive_regions
             WHERE screenshot_id = ?1
             ORDER BY y, x",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let regions = stmt
            .query_map([screenshot_id], |row| {
                Ok(SensitiveRegion {
                    id: row.get(0)?,
                    screenshot_id: row.get(1)?,
                    x: row.get(2)?,
                    y: row.get(3)?,
                    width: row.get(4)?,
                    height: row.get(5)?,
                    img_width: row.get(6)?,
                    img_height: row.get(7)?,
                    match_type: row.get(8)?,
                    match_text: row.get(9)?,
                    is_dismissed: {
                        let v: i32 = row.get(10)?;
                        v != 0
                    },
                })
            })
            .map_err(|e| format!("Failed to query sensitive regions: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect sensitive regions: {}", e))?;

        Ok(regions)
    }

    /// Mark a region as dismissed ("not sensitive") — survives reprocessing.
    pub fn dismiss_sensitive_region(&self, region_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE sensitive_regions SET is_dismissed = 1 WHERE id = ?1",
                [region_id],
            )
            .map_err(|e| format!("Failed to dismiss region: {}", e))?;
        Ok(())
    }

    /// Delete all auto-detected (non-dismissed) regions for a screenshot so they
    /// can be re-inserted after a reprocess. Dismissed regions are preserved.
    pub fn delete_regions_for_screenshot(&self, screenshot_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM sensitive_regions WHERE screenshot_id = ?1 AND is_dismissed = 0",
                [screenshot_id],
            )
            .map_err(|e| format!("Failed to delete regions: {}", e))?;
        Ok(())
    }

    pub fn delete_region(&self, region_id: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM sensitive_regions WHERE id = ?1", [region_id])
            .map_err(|e| format!("Failed to delete region: {}", e))?;
        Ok(())
    }

    /// Update coordinates and size of an existing region
    pub fn update_region(
        &self,
        region_id: &str,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE sensitive_regions SET x=?1, y=?2, width=?3, height=?4 WHERE id=?5",
                rusqlite::params![x, y, width, height, region_id],
            )
            .map_err(|e| format!("Failed to update region: {}", e))?;
        Ok(())
    }

    // ── Config methods ────────────────────────────────────────

    pub fn get_config_value(&self, key: &str) -> Result<Option<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM config WHERE key = ?1")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let result: Option<String> = stmt.query_row([key], |row| row.get(0)).ok();
        Ok(result)
    }

    pub fn set_config_value(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)",
                [key, value],
            )
            .map_err(|e| format!("Failed to set config: {}", e))?;
        Ok(())
    }

    pub fn get_screenshot_folder(&self) -> Option<String> {
        self.get_config_value("screenshot_folder").ok().flatten()
    }

    pub fn set_screenshot_folder(&self, folder: &str) -> Result<(), String> {
        self.set_config_value("screenshot_folder", folder)
    }

    pub fn get_launch_on_startup(&self) -> bool {
        self.get_config_value("launch_on_startup")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<bool>().ok())
            .unwrap_or(false)
    }

    pub fn set_launch_on_startup(&self, value: bool) -> Result<(), String> {
        self.set_config_value("launch_on_startup", &value.to_string())
    }

    pub fn get_intro_seen(&self) -> bool {
        self.get_config_value("intro_seen")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<bool>().ok())
            .unwrap_or(false)
    }

    pub fn set_intro_seen(&self, value: bool) -> Result<(), String> {
        self.set_config_value("intro_seen", &value.to_string())
    }

    // ── Pro Features: Licensing ────────────────────────────────

    #[allow(dead_code)]
    pub fn get_license_key(&self) -> Option<String> {
        self.get_config_value("license_key").ok().flatten()
    }

    pub fn set_license_key(&self, key: &str) -> Result<(), String> {
        self.set_config_value("license_key", key)
    }

    pub fn get_is_pro_active(&self) -> bool {
        self.get_config_value("is_pro_active")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<bool>().ok())
            .unwrap_or(false)
    }

    pub fn set_is_pro_active(&self, value: bool) -> Result<(), String> {
        self.set_config_value("is_pro_active", &value.to_string())
    }

    // ── Pro Features: Watch Folders ────────────────────────────

    pub fn get_watch_folders(&self) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT path FROM watch_folders")
            .map_err(|e| format!("Failed to prepare watch_folders query: {}", e))?;
        let folders = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| format!("Failed to execute watch_folders query: {}", e))?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| format!("Failed to collect watch_folders: {}", e))?;
        Ok(folders)
    }

    pub fn add_watch_folder(&self, path: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO watch_folders (path) VALUES (?1)",
                [path],
            )
            .map_err(|e| format!("Failed to add watch folder: {}", e))?;
        Ok(())
    }

    pub fn remove_watch_folder(&self, path: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM watch_folders WHERE path = ?1", [path])
            .map_err(|e| format!("Failed to remove watch folder: {}", e))?;
        Ok(())
    }

    /* ── Annotations ────────────────────────────────────────── */

    pub fn get_annotations(&self, screenshot_id: &str) -> Result<Vec<Annotation>, String> {
        let mut stmt = self.conn
            .prepare("SELECT id, screenshot_id, tool, start_x, start_y, end_x, end_y, color, img_width, img_height FROM annotations WHERE screenshot_id = ?")
            .map_err(|e| e.to_string())?;

        let iter = stmt
            .query_map([screenshot_id], |row| {
                Ok(Annotation {
                    id: row.get(0)?,
                    screenshot_id: row.get(1)?,
                    tool: row.get(2)?,
                    start_x: row.get(3)?,
                    start_y: row.get(4)?,
                    end_x: row.get(5)?,
                    end_y: row.get(6)?,
                    color: row.get(7)?,
                    img_width: row.get(8)?,
                    img_height: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut annots = Vec::new();
        for ann in iter {
            if let Ok(a) = ann {
                annots.push(a);
            }
        }
        Ok(annots)
    }

    pub fn add_annotation(&self, ann: &Annotation) -> Result<(), String> {
        self.conn.execute(
            "INSERT OR REPLACE INTO annotations 
             (id, screenshot_id, tool, start_x, start_y, end_x, end_y, color, img_width, img_height) 
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            (
                &ann.id,
                &ann.screenshot_id,
                &ann.tool,
                ann.start_x,
                ann.start_y,
                ann.end_x,
                ann.end_y,
                &ann.color,
                ann.img_width,
                ann.img_height,
            ),
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_annotation(&self, id: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM annotations WHERE id = ?", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
