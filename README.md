# Kaptur

> **Website:** [https://ankitpanwar070798.github.io/Kaptur/](https://ankitpanwar070798.github.io/Kaptur/)
>
> Kaptur — every pixel, marked and remembered.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [How It Works](#how-it-works)
- [Setup & Running](#setup--running)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Database Schema](#database-schema)
- [License](#license)

---

## Overview

Kaptur is a **Tauri 2** desktop application for Windows that watches your screenshot folders, indexes every image into a local SQLite database with full-text OCR, and exposes a clean, searchable UI. Everything runs 100% locally on your machine — no cloud storage, no subscriptions, and absolute privacy.

---

## Features

| Feature | Details |
|---|---|
| Auto-indexing | Watches your configured folder for new screenshots in real-time |
| Native OCR Search | Uses Windows Native OCR for extracting text; fully searchable via SQLite FTS5 |
| Instant Overlay | Press `Ctrl+Shift+F` to open a quick-search overlay anywhere in your OS |
| Manual Blur Control | Draw, move, resize, or delete blur regions to protect sensitive content |
| Annotation Tools | Arrow, Box, and Highlight tools with a full color picker to mark up images before sharing |
| Undo Support | Step-by-step undo (`Ctrl+Z`) for annotations in edit mode |
| Drag-and-Drop Sharing | Drag thumbnails or full previews directly into chat apps, email clients, or browser upload fields — the protected (blurred + annotated) version is always sent |
| Export & Copy | Copy images or Save a Protected Copy as a permanent PNG with all protections baked in |
| Wishlist (Favorites) | Heart any screenshot to add it to your Wishlist; one-click filter button to view only favorited screenshots |
| Multi-Folder Watch | Add multiple folders to watch from Settings |
| Bulk Export | Export your entire vault as a ZIP file from Settings |
| Context Menu | Right-click to Reprocess OCR, Copy Image, or Reveal in Explorer |
| Local SQLite DB | Zero-dependency, bundled SQLite via rusqlite with persisted settings |
| Fully Offline | No network calls, no accounts, no subscriptions |
| Dark Premium UI | Glassmorphism, tailored color palettes, smooth animations |

---

## Tech Stack

### Frontend

| Technology | Version | Purpose |
|---|---|---|
| **React** | 19 | UI framework |
| **TypeScript** | 5.8 | Type safety |
| **Vite** | 7 | Dev server & bundler |
| **@tauri-apps/api** | 2 | Tauri IPC bridge (invoke, listen, convertFileSrc) |
| **@crabnebula/tauri-plugin-drag** | 2 | Native OS-level drag-and-drop of temp protected files |
| **Vanilla CSS** | — | Styling (Inter font, CSS custom properties, glassmorphism) |

### Backend (Rust)

| Crate | Version | Purpose |
|---|---|---|
| **tauri** | 2 | Desktop app shell, WebView2 integration |
| **tauri-plugin-drag** | 2 | Drag-and-drop plugin companion |
| **windows** | 0.58 | WinRT bindings for Windows.Media.Ocr (Native OCR API) |
| **rusqlite** | 0.32 | Local SQLite database (FTS5 enabled) |
| **notify** | 7.0 | File system watcher for new screenshots |
| **sha2** | 0.10 | SHA-256 hashing for deduplication |
| **uuid** | 1.0 | Unique IDs for each screenshot record |
| **tokio** | 1 | Async runtime |

---

## Architecture

```text
+-------------------------------------------------------------+
|                     Tauri Desktop App                       |
|                                                             |
|  +------------------+           +-----------------------+   |
|  |  WebView2 (UI)   |<--------->|   Rust Backend        |   |
|  |                  |    IPC    |                       |   |
|  |  React + TS      |           |  +----------------+   |   |
|  |  Vite dev server |           |  | Tauri Commands |   |   |
|  |  localhost:1420  |           |  | (invoke calls) |   |   |
|  |                  |           |  +-------+--------+   |   |
|  |  convertFileSrc  |           |          |            |   |
|  |  -> asset://     |           |  +-------v--------+   |   |
|  +------------------+           |  |  SQLite DB     |   |   |
|                                 |  |  (FTS5 search) |   |   |
|  +------------------+           |  +-------+--------+   |   |
|  |  Overlay Window  |           |          |            |   |
|  |  (hidden by      |           |  +-------v--------+   |   |
|  |   default)       |           |  | File Watcher   |   |   |
|  +------------------+           |  | (notify crate) |   |   |
|                                 |  +-------+--------+   |   |
|  +------------------+           |          |            |   |
|  |  System Tray     |           |  +-------v--------+   |   |
|  |  (click to show) |           |  | Windows.Media  |   |   |
|  +------------------+           |  | Native OCR API |   |   |
|                                 |  +----------------+   |   |
|                                 +-----------------------+   |
+-------------------------------------------------------------+
              ^
              | watches
       User-Configured Folder
```

### Data Flow

```text
New screenshot saved to disk
        |
        v
notify crate detects file creation
        |
        v
compute SHA-256 hash (deduplication check)
        |
        v
INSERT into screenshots table (path, hash, captured_at, status='pending')
emit "screenshots-updated" Tauri event
        |
        v
spawn tokio background task --> run Windows Native OCR API
        |
        v
UPDATE screenshots SET ocr_text = '...', ocr_status = 'done'
        |
        v
emit "screenshots-updated" Tauri event
        |
        v
React frontend re-fetches and renders grid (with pixel-blur and annotation overlays)

─── User opens screenshot ───────────────────────────────────────────────────────

User clicks Edit --> enters Edit Mode
        |
        ├── Blur tool  --> draws blur region --> saved to sensitive_regions table
        ├── Arrow tool --> draws arrow       ─┐
        ├── Box tool   --> draws box          ├─> saved to annotations table
        └── Highlight  --> draws highlight   ─┘

User drags image out (or clicks Save Protected Copy)
        |
        v
Canvas renders image + blur regions + annotations
        |
        v
Protected PNG written to OS temp dir (drag) or user-chosen path (save)
```

---

## Setup & Running

### Prerequisites

| Requirement | How to Install |
|---|---|
| **Node.js** >= 18 | https://nodejs.org |
| **Rust + Cargo** | https://rustup.rs |
| **Windows SDK** | Required for Windows Native OCR bindings (via VS Installer) |
| **English Language Pack**| Required in Windows Settings for English OCR to function |

### Run in Development

```powershell
# Navigate to the project
cd C:\Users\AnkitPanwar\Desktop\poc\Kaptur

# Install npm dependencies
npm install

# Start the app
npm run tauri dev
```

---

## Development & Deployment Workflow

Kaptur uses GitHub Actions for continuous integration and deployment. The entire release and distribution process is fully automated.

### 1. Landing Page Deployment (GitHub Pages)

The landing page (`landing.html`) is automatically deployed to GitHub Pages whenever changes are pushed to the `main` branch.

- **Workflow File:** `.github/workflows/pages.yml`
- **Trigger:** Push to `main` branch (specifically modifying `landing.html` or the `public/` folder).
- **Process:** The workflow copies the necessary files into a `_site` directory and uses the official GitHub Pages actions to publish it.

### 2. Automated App Releases (Tauri)

Building the Windows installer (`.msi` and `.exe`) is handled automatically via GitHub Actions whenever you push a new version tag.

- **Workflow File:** `.github/workflows/release.yml`
- **Trigger:** Push a Git tag that starts with `v` (e.g., `v1.0.0`).
- **Process:**
  1. Sets up Node.js and Rust environments.
  2. Runs `npm run build` and `tauri build`.
  3. Automatically drafts a new GitHub Release titled with the tag version.
  4. Uploads the generated Windows installers to the release assets.
  5. Automatically generates a changelog based on the commit history since the last tag.

**How to trigger a new release:**
```bash
git tag v1.0.0
git push origin v1.0.0
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+F` | Open / close the search overlay |
| `Escape` | Close the overlay / preview modal |
| `Ctrl+Z` | Undo last annotation in edit mode |

---

## Database Schema

**Location:** `%APPDATA%\com.kaptur.app\screenshots.db`

```sql
-- Main table
CREATE TABLE screenshots (
  id          TEXT    PRIMARY KEY,       -- UUID v4
  path        TEXT    NOT NULL,          -- Absolute file path on disk
  hash        TEXT    NOT NULL UNIQUE,   -- SHA-256 of file content (deduplication)
  ocr_text    TEXT,                      -- Native OCR output string
  captured_at INTEGER NOT NULL,          -- Unix timestamp in seconds
  ocr_status  TEXT DEFAULT 'pending',    -- 'pending', 'done', 'failed', 'unavailable'
  is_favorite BOOLEAN DEFAULT 0          -- 1 if favorited, 0 otherwise
);

-- Config table (for persisting user settings)
CREATE TABLE config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Full-text search virtual table (FTS5)
CREATE VIRTUAL TABLE screenshots_fts USING fts5(
  ocr_text,
  content='screenshots',
  content_rowid='rowid'
);

-- Sensitive blur regions
CREATE TABLE sensitive_regions (
  id            TEXT PRIMARY KEY,   -- UUID v4
  screenshot_id TEXT NOT NULL,
  x INTEGER, y INTEGER,
  width INTEGER, height INTEGER,
  img_width INTEGER, img_height INTEGER,
  match_type TEXT,                   -- 'manual', 'email', 'otp', etc.
  match_text TEXT,
  is_dismissed BOOLEAN DEFAULT 0,
  FOREIGN KEY (screenshot_id) REFERENCES screenshots(id) ON DELETE CASCADE
);

-- Annotation marks (arrows, boxes, highlights)
CREATE TABLE annotations (
  id            TEXT PRIMARY KEY,   -- UUID v4
  screenshot_id TEXT NOT NULL,
  tool          TEXT NOT NULL,      -- 'arrow', 'box', 'highlight'
  start_x INTEGER, start_y INTEGER,
  end_x   INTEGER, end_y   INTEGER,
  color         TEXT NOT NULL,      -- hex color string
  img_width INTEGER, img_height INTEGER,
  FOREIGN KEY (screenshot_id) REFERENCES screenshots(id) ON DELETE CASCADE
);
```

---

## License

Copyright © Kaptur. All Rights Reserved.
