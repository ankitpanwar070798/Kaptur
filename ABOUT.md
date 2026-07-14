# About Pixaan

> Pixaan — every pixel, marked and remembered.

Pixaan is a lightweight, privacy-first desktop application designed to act as a searchable, secure memory bank for your screen. It automatically organizes your screenshots, makes the text inside them instantly searchable, proactively protects your sensitive information, and lets you annotate images before sharing them.

---

## Why We Created Pixaan

We take screenshots every day to remember things: a zoom meeting slide, a funny tweet, an error message, an invoice, or a recipe. But those screenshots end up in a massive, unorganized folder named with useless timestamps like `Screenshot 2026-07-11 150727.png`.

**The Problem:** When you actually need that information a week later, you can't find it. You can't `Ctrl+F` an image. You end up scrolling through hundreds of thumbnails trying to visually recognize a piece of data. 

**The Solution:** Pixaan fixes this by watching your screenshot folder and instantly reading the text inside every image you capture using Windows Native OCR. It turns your folder of "dumb" images into a fully searchable, private database.

### Example Scenario: The Lost Invoice
Imagine you bought software last month and took a quick screenshot of the confirmation page containing the License Key and Order Number.

- **Without Pixaan:** You need the license key today. You open your Screenshots folder and scroll through 300 images manually, opening each one to see if it's the right receipt.
- **With Pixaan:** You press `Ctrl+Shift+F` anywhere on your computer to open the Pixaan overlay. You type *"Order Number"* or the name of the software. Pixaan instantly shows you the exact screenshot. You click "Copy Image" and you're done in 3 seconds.

---

## Core Philosophy

1. **Zero-Cloud Privacy:** Pixaan is entirely offline. Your screenshots, the extracted text, and your settings never leave your machine. There are no telemetry servers, no cloud backups, and no external API calls required.
2. **Frictionless Capture:** You don't need to learn a new screenshot tool. Pixaan works quietly in the background, letting you use your OS's built-in Snipping Tool exactly as you do today.
3. **Instant Recall:** By automatically extracting text from your images, Pixaan turns a messy folder of nameless images into a searchable database.

---

## The A-to-Z Flow: How Pixaan Works

Pixaan is designed to be invisible until you need it. Here is the complete end-to-end lifecycle of a screenshot inside Pixaan.

### 1. Setup & Folder Watching
Upon launching Pixaan, you select a local folder where your screenshots are saved (e.g., your default Windows Snipping Tool output folder). Pixaan's Rust backend immediately attaches a low-level OS file system watcher (`notify` crate) to this directory, remaining dormant until a file changes. You can add additional watched folders from the Settings panel at any time.

### 2. Capture & Ingestion
When you take a screenshot, the OS saves the `.png` or `.jpg` file to the folder. Pixaan instantly detects the file creation event and kicks off a background indexing task:
- **Deduplication:** A SHA-256 cryptographic hash of the image is calculated. If the exact same image has already been indexed, Pixaan safely ignores it to save space.
- **Thumbnail Generation:** A lightweight WebP thumbnail is generated so the main UI gallery can scroll at 60 FPS without loading massive raw image files.

### 3. OCR (Optical Character Recognition)
The image is passed to the **Windows native OCR API** built into your operating system. It scans the image natively (without requiring external binaries or cloud services), reads every word, and records the exact (X, Y) coordinates of where that word appears on the screen. 

### 4. Privacy & Manual Protection
While Pixaan makes your screenshots searchable, you remain in complete control of your privacy. When you view a screenshot, click **Edit** to enter edit mode, which gives you a full set of annotation and privacy tools:

- **Blur:** Click and drag anywhere on the image to draw a true pixel-blur region over sensitive data (passwords, API keys, personal messages). You can drag to move regions, grab handles to resize them, or hover and click "Delete" to remove them.
- **Arrow:** Draw a directional arrow to point at a specific element in the image.
- **Box:** Draw a rectangle to highlight or frame an area of interest.
- **Highlight:** Paint a semi-transparent color fill over any area to draw attention to it.

A **color picker** (preset swatches + custom color wheel) lets you choose any color for annotation tools. Press **Ctrl+Z** to undo the last annotation step by step.

All annotations and blur regions are saved locally and applied dynamically whenever you view the image in Pixaan.

### 5. Sharing
When you are happy with your annotations:
- **Drag-and-Drop:** Drag any thumbnail from the grid or the open preview directly onto another application (chat window, email client, browser upload field). The dropped image is automatically baked with all your blur regions and annotations — the raw file is never shared.
- **Save Protected Copy:** Exports a permanent `.png` with all protection and annotations baked into the pixels.

### 6. Local Storage
The file path, the extracted OCR text string, sensitive bounding boxes, and annotation data are all stored in a lightning-fast local SQLite database (`pixaan.db`). The heavy lifting is complete — usually within milliseconds of you taking the screenshot.

### 7. Search & Retrieval
When you need to find an old screenshot, you don't have to scroll through folders. You summon Pixaan through two methods:
- **The Main App:** A beautiful, native desktop gallery.
- **The Global Overlay:** You press `Ctrl+Shift+F` anywhere in the OS to instantly pull up a transparent search bar over your current active window.

As you type, Pixaan executes a full-text search query against the SQLite database, returning exact matches for the text *inside* your images.

### 8. Action
Once you find the screenshot, you can interact with it instantly:
- Click the **Open** button to view it in full size.
- Click the **Copy** button to place the image onto your clipboard for pasting into an email or chat.
- Click **Save Protected Copy** to export a permanent `.png` copy of the image with blur regions and annotations baked in.
- Click **Reveal in Explorer** to open the actual file location.
- Click the **Heart Icon** on any card to add it to Favorites.
- Click the **Wishlist** button in the toolbar to instantly filter the gallery to show only your favorited screenshots.
- **Bulk Export:** Export your entire database into a single `.zip` file containing both the original images and a `manifest.json` preserving all your searchable OCR data — available from the Settings panel.

---

## Technology Stack

Pixaan is built for speed and privacy, leveraging a modern, native-first stack:
- **Frontend Core:** React 19, TypeScript, and Vite.
- **Styling:** Pure Vanilla CSS with CSS custom properties, achieving a lightweight, tailored glassmorphism UI without heavy frameworks.
- **Backend & IPC:** Rust and Tauri v2 for secure, memory-safe OS integration.
- **Database:** Local SQLite (via `rusqlite`) utilizing FTS5 (Full-Text Search) for millisecond query responses.
- **OCR Engine:** Windows Native OCR API (`Windows.Media.Ocr`) invoked directly via the `windows` crate — meaning no external binaries, DLLs, or third-party cloud services are required.
- **File System:** `notify` crate for instant, zero-polling file system event watching.
- **Drag & Drop:** `@crabnebula/tauri-plugin-drag` for native OS-level drag-and-drop of protected image files.
