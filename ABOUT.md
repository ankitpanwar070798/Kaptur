# About Kaptur

> **Website:** [https://ankitpanwar070798.github.io/Kaptur/](https://ankitpanwar070798.github.io/Kaptur/)
>
> Kaptur — every pixel, marked and remembered.

Kaptur is a lightweight, privacy-first desktop application designed to act as a searchable, secure memory bank for your screen. It automatically organizes your screenshots, makes the text inside them instantly searchable, proactively protects your sensitive information, and lets you annotate images before sharing them.

---

## Why We Created Kaptur

We take screenshots every day to remember things: a zoom meeting slide, a funny tweet, an error message, an invoice, or a recipe. But those screenshots end up in a massive, unorganized folder named with useless timestamps like `Screenshot 2026-07-11 150727.png`.

**The Problem:** When you actually need that information a week later, you can't find it. You can't `Ctrl+F` an image. You end up scrolling through hundreds of thumbnails trying to visually recognize a piece of data. 

**The Solution:** Kaptur fixes this by watching your screenshot folder and instantly reading the text inside every image you capture. It turns your folder of "dumb" images into a fully searchable, private database.

### Example Scenario: The Lost Invoice
Imagine you bought software last month and took a quick screenshot of the confirmation page containing the License Key and Order Number.

- **Without Kaptur:** You need the license key today. You open your Screenshots folder and scroll through 300 images manually, opening each one to see if it's the right receipt.
- **With Kaptur:** You press `Ctrl+Shift+F` anywhere on your computer to open the Kaptur overlay. You type *"Order Number"* or the name of the software. Kaptur instantly shows you the exact screenshot. You click "Copy Image" and you're done in 3 seconds.

---

## Core Philosophy

1. **Zero-Cloud Privacy:** Kaptur is entirely offline. Your screenshots, the extracted text, and your settings never leave your machine. We recently reinforced this by removing all analytics (e.g., GA4) from our landing page. There are no telemetry servers, no cloud backups, and no external API calls required.
2. **Frictionless Capture:** You don't need to learn a new screenshot tool. Kaptur works quietly in the background, letting you use your OS's built-in Snipping Tool exactly as you do today.
3. **Instant Recall:** By automatically extracting text from your images, Kaptur turns a messy folder of nameless images into a searchable database.

---

## The A-to-Z Flow: How Kaptur Works

Kaptur is designed to be invisible until you need it. Here is the complete end-to-end lifecycle of a screenshot inside Kaptur.

### 1. Setup & Folder Watching
Upon launching Kaptur, you select a local folder where your screenshots are saved. Kaptur monitors this directory quietly and remains dormant until a new file is added. You can add additional watched folders from the Settings panel at any time.

### 2. Capture & Ingestion
When you take a screenshot, the OS saves the file to the folder. Kaptur instantly detects the file and kicks off background processing:
- **Deduplication:** Identical images are safely ignored to save space.
- **Thumbnail Generation:** A lightweight thumbnail is generated so the main UI gallery scrolls smoothly.

### 3. Text Extraction (OCR)
The image is scanned natively on your machine, reading every word and recording exactly where it appears on the screen. 

### 4. Privacy & Manual Protection
When you view a screenshot, click **Edit** to enter edit mode, which gives you a full set of annotation and privacy tools:

- **Blur:** Click and drag anywhere on the image to draw a true pixel-blur region over sensitive data (passwords, API keys, personal messages). 
- **Arrow:** Draw a directional arrow to point at a specific element.
- **Box:** Draw a rectangle to highlight an area of interest.
- **Highlight:** Paint a semi-transparent color fill over any area.

All annotations and blur regions are saved locally and applied dynamically whenever you view the image.

### 5. Sharing
When you are happy with your annotations:
- **Drag-and-Drop:** Drag any thumbnail directly onto another application. The dropped image is automatically baked with all your blur regions and annotations — the raw file is never shared.
- **Save Protected Copy:** Exports a permanent `.png` with all protection and annotations baked in.

### 6. Local Storage
All data is stored securely in a lightning-fast local database. The heavy lifting is complete within milliseconds.

### 7. Search & Retrieval
When you need to find an old screenshot, you summon Kaptur through two methods:
- **The Main App:** A beautiful, native desktop gallery.
- **The Global Overlay:** Press `Ctrl+Shift+F` anywhere in the OS to instantly pull up a transparent search bar over your current active window.

As you type, Kaptur searches your database, returning exact matches for the text *inside* your images.

### 8. Action
Once you find the screenshot, you can interact with it instantly:
- Click the **Open** button to view it in full size.
- Click the **Copy** button to place the image onto your clipboard.
- Click **Save Protected Copy** to export a safe version of the image.
- Click **Reveal in Explorer** to open the actual file location.
- Click the **Heart Icon** on any card to add it to Favorites.
- **Bulk Export:** Export your entire database into a single `.zip` file from the Settings panel.

---

## Recent Updates

We've recently introduced a seamless, automated workflow and enhanced our online presence:
- **Automated Releases:** Kaptur now uses GitHub Actions to automatically build and publish Windows installers for every new release.
- **Auto-Updater:** Integrated Tauri's auto-updater plugin so Kaptur can silently check for, download, and install new versions directly from GitHub Releases.
- **Landing Page Enhancements:** The `landing.html` page has been updated with robust SEO/AEO metadata, semantic HTML, a new favicon, and a live GitHub downloads badge.
- **Strict Privacy Check:** All third-party tracking, including Google Analytics (GA4), has been completely removed to align with our strict privacy philosophy.
