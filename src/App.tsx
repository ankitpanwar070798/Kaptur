import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, Event as TauriEvent } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";
import kapturLogo from "./assets/kaptur-logo.png";
import { enable, isEnabled, disable } from '@tauri-apps/plugin-autostart';
import { openUrl } from '@tauri-apps/plugin-opener';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

/* ── Types ──────────────────────────────────────────────── */
import { generateProtectedBase64, startImageDrag } from "./utils/imageExport";

export interface Annotation {
  id: string;
  screenshot_id: string;
  tool: string; // 'arrow' | 'box' | 'highlight'
  start_x: number;
  start_y: number;
  end_x: number;
  end_y: number;
  color: string;
  img_width: number;
  img_height: number;
}

export type ToolType = 'blur' | 'arrow' | 'box' | 'highlight';

interface Screenshot {
  id: string;
  path: string;
  hash: string;
  ocr_text: string | null;
  captured_at: number;
  ocr_status: string;
  is_favorite?: boolean;
}

interface SensitiveRegion {
  id: string;
  screenshot_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  img_width: number;
  img_height: number;
  match_type: string;
  match_text: string;
  is_dismissed: boolean;
}

interface Cursor {
  captured_at: number;
  id: string;
}

interface OnboardingConfig {
  screenshot_folder: string;
  launch_on_startup: boolean;
}

/* ── Time grouping ───────────────────────────────────────── */
function groupScreenshotsByTime(
  screenshots: Screenshot[]
): Record<string, Screenshot[]> {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const lastWeek = new Date(today);
  lastWeek.setDate(lastWeek.getDate() - 7);
  const lastMonth = new Date(today);
  lastMonth.setMonth(lastMonth.getMonth() - 1);

  const groups: Record<string, Screenshot[]> = {
    Today: [],
    Yesterday: [],
    "Last 7 Days": [],
    "Last Month": [],
    Older: [],
  };

  screenshots.forEach((s) => {
    const d = new Date(s.captured_at * 1000);
    if (d >= today) groups.Today.push(s);
    else if (d >= yesterday) groups.Yesterday.push(s);
    else if (d >= lastWeek) groups["Last 7 Days"].push(s);
    else if (d >= lastMonth) groups["Last Month"].push(s);
    else groups.Older.push(s);
  });

  return groups;
}

/* ── Debounce hook ──────────────────────────────────────── */
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debouncedValue;
}

/* ── Image cache (module-level, persistent) ─────────────── */
const imgCache = new Map<string, string>();

/* ── ScreenshotImage: loads thumbnail via Tauri IPC ─────── */
function ScreenshotImage({
  hash,
  path,
  onSrcReady,
}: {
  hash: string;
  path: string;
  onSrcReady?: (src: string) => void;
}) {
  const cached = imgCache.get(path);
  const [src, setSrc] = useState<string>(cached ?? "");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (imgCache.has(path)) {
      const cached = imgCache.get(path)!;
      setSrc(cached);
      onSrcReady?.(cached);
      return;
    }
    let cancelled = false;
    invoke<string>("get_or_generate_thumbnail", { hash, path })
      .then((data) => {
        if (cancelled) return;
        imgCache.set(path, data);
        setSrc(data);
        onSrcReady?.(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn("Thumbnail unavailable:", path, err);
        setFailed(true);
      });
    return () => { cancelled = true; };
  }, [hash, path]);

  if (failed) {
    return (
      <div className="img-placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
        <span>No preview</span>
      </div>
    );
  }

  if (!src) return <div className="img-skeleton" />;

  return <img src={src} alt="Screenshot" />;
}

/* ── Helper: extract filename without extension ─────────── */
function basename(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.[^.]+$/, "");
}

/* Helper: format date nicely */
function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    + " \u00b7 "
    + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/* ── ThumbnailBlurOverlay ──────────────────────────────── */
interface ThumbnailBlurOverlayProps {
  regions: SensitiveRegion[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  imageSrc?: string; // thumbnail src for pixel-level blur
}

function ThumbnailBlurOverlay({ regions, containerRef, imageSrc }: ThumbnailBlurOverlayProps) {
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Read display size immediately — thumbnails are fixed-size grid cells
    setDisplaySize({ w: el.clientWidth, h: el.clientHeight });
  }, [containerRef]);

  const activeRegions = regions.filter(r => !r.is_dismissed);
  if (activeRegions.length === 0 || !displaySize) return null;

  return (
    <>
      {activeRegions.map(region => {
        // Map region from original-image space directly to display (thumbnail) space
        const scaleX = displaySize.w / region.img_width;
        const scaleY = displaySize.h / region.img_height;
        const left   = region.x      * scaleX;
        const top    = region.y      * scaleY;
        const width  = region.width  * scaleX;
        const height = region.height * scaleY;

        return (
          <div
            key={region.id}
            className="sensitive-overlay thumbnail-overlay"
            style={{
              left:   `${left}px`,
              top:    `${top}px`,
              width:  `${width}px`,
              height: `${height}px`,
              background: imageSrc ? 'transparent' : undefined,
            }}
          >
            {/* Same pixel-blur technique as the full preview overlay */}
            {imageSrc && (
              <img
                src={imageSrc}
                alt=""
                draggable={false}
                className="region-blur-img"
                style={{
                  position: 'absolute',
                  left:   `-${left}px`,
                  top:    `-${top}px`,
                  width:  `${displaySize.w}px`,
                  height: `${displaySize.h}px`,
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/* ── ThumbnailAnnotationLayer ──────────────────────────── */
interface ThumbnailAnnotationLayerProps {
  annotations: Annotation[];
  containerRef: React.RefObject<HTMLDivElement | null>;
}

function ThumbnailAnnotationLayer({ annotations, containerRef }: ThumbnailAnnotationLayerProps) {
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setDisplaySize({ w: el.clientWidth, h: el.clientHeight });
  }, [containerRef]);

  if (annotations.length === 0 || !displaySize) return null;

  return (
    <AnnotationLayer
      annotations={annotations}
      imgWidth={displaySize.w}
      imgHeight={displaySize.h}
      activeInteraction={null}
      selectedTool="blur"
      selectedColor="#1F7A5C"
    />
  );
}


/* ── ScreenshotCard ─────────────────────────────────────── */
function ScreenshotCard({
  screenshot,
  onOpen,
  onCopy,
  onReveal,
  onContextMenu,
  onToggleFavorite,
  regionRefreshTrigger,
}: {
  screenshot: Screenshot;
  onOpen: () => void;
  onCopy: () => void;
  onReveal: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onToggleFavorite?: (e: React.MouseEvent) => void;
  regionRefreshTrigger?: number;
}) {
  const needsIndicator = screenshot.ocr_status === "pending" ||
    screenshot.ocr_status === "failed" ||
    screenshot.ocr_status === "unavailable";

  const previewRef = useRef<HTMLDivElement>(null);
  const [regions, setRegions] = useState<SensitiveRegion[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [thumbnailSrc, setThumbnailSrc] = useState<string>('');

  // Re-fetch regions and annotations whenever regionRefreshTrigger increments
  useEffect(() => {
    Promise.all([
      invoke<SensitiveRegion[]>("get_sensitive_regions", { screenshotId: screenshot.id }),
      invoke<Annotation[]>("get_annotations", { screenshotId: screenshot.id })
    ]).then(([r, a]) => {
      setRegions(r);
      setAnnotations(a);
    }).catch(() => {
      setRegions([]);
      setAnnotations([]);
    });
  }, [screenshot.id, regionRefreshTrigger]);

  return (
    <div
      className="screenshot-card"
      onClick={onOpen}
      onContextMenu={onContextMenu}
      draggable={true}
      onDragStart={(e) => {
        e.preventDefault();
        startImageDrag(screenshot.path, `Protected_${basename(screenshot.path)}.png`, regions, annotations);
      }}
    >
      {/* Quick action buttons that appear on hover */}
      <div className="quick-actions" onClick={(e) => e.stopPropagation()}>
        <button className="quick-btn" onClick={onOpen} title="Open">Open</button>
        <button className="quick-btn" onClick={onCopy} title="Copy">Copy</button>
        <button className="quick-btn" onClick={onReveal} title="Show in Explorer">Show</button>
      </div>

      {/* OCR status indicator */}
      {needsIndicator && (
        <div className="ocr-status-indicator" title={
          screenshot.ocr_status === "pending" ? "OCR processing…" :
          screenshot.ocr_status === "failed" ? "OCR failed - right-click to reprocess" :
          "OCR not available - install Tesseract"
        }>
          <span className="status-dot" />
        </div>
      )}

      {/* Favorite Toggle Button */}
      {onToggleFavorite && (
        <button
          className={`favorite-btn ${screenshot.is_favorite ? 'active' : ''}`}
          onClick={onToggleFavorite}
          title={screenshot.is_favorite ? "Remove from Favorites" : "Add to Favorites"}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill={screenshot.is_favorite ? "currentColor" : "none"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
          </svg>
        </button>
      )}

      <div className="screenshot-preview" ref={previewRef}>
        <ScreenshotImage
          hash={screenshot.hash}
          path={screenshot.path}
          onSrcReady={(src) => setThumbnailSrc(src)}
        />
        {regions.length > 0 && (
          <ThumbnailBlurOverlay
            regions={regions}
            containerRef={previewRef}
            imageSrc={thumbnailSrc || undefined}
          />
        )}
        {annotations.length > 0 && (
          <ThumbnailAnnotationLayer
            annotations={annotations}
            containerRef={previewRef}
          />
        )}
      </div>

      <div className="screenshot-info">
        <p className="screenshot-name">{basename(screenshot.path)}</p>
        <p className="screenshot-date">{fmtDate(screenshot.captured_at)}</p>
        {screenshot.ocr_text && (
          <p className="screenshot-text">
            {screenshot.ocr_text.slice(0, 100)}
            {screenshot.ocr_text.length > 100 ? "…" : ""}
          </p>
        )}
      </div>
    </div>
  );
}

/* ── SensitiveBlurOverlay ───────────────────────────────── */
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface SensitiveBlurOverlayProps {
  regions: SensitiveRegion[];
  imgWidth: number;
  imgHeight: number;
  onDismissRegion?: (regionId: string) => void;
  onRegionMouseDown?: (e: React.MouseEvent, regionId: string, handle?: ResizeHandle) => void;
  isEditable?: boolean;
  fadingRegions?: Set<string>;
  imageSrc?: string | null; // full-size image src — used for pixel-level blur inside each region
}

function SensitiveBlurOverlay({
  regions,
  imgWidth,
  imgHeight,
  onDismissRegion,
  onRegionMouseDown,
  isEditable = false,
  fadingRegions,
  imageSrc,
}: SensitiveBlurOverlayProps) {
  const [hoveredRegion, setHoveredRegion] = useState<string | null>(null);

  // Filter out dismissed regions and currently fading regions
  const activeRegions = regions.filter(r => !r.is_dismissed && !fadingRegions?.has(r.id));

  if (activeRegions.length === 0 && (!fadingRegions || fadingRegions.size === 0)) return null;

  // Get fading regions for animation
  const fadingRegionList = fadingRegions
    ? regions.filter(r => fadingRegions.has(r.id) && !r.is_dismissed)
    : [];

  return (
    <>
      {activeRegions.map(region => {
        // Scale region coordinates to display size
        const scaleX = imgWidth / region.img_width;
        const scaleY = imgHeight / region.img_height;
        const left = region.x * scaleX;
        const top = region.y * scaleY;
        const width = region.width * scaleX;
        const height = region.height * scaleY;

        return (
          <div
            key={region.id}
            className={`sensitive-overlay ${hoveredRegion === region.id ? 'hovered' : ''} ${isEditable ? 'editable' : ''}`}
            style={{
              left: `${left}px`,
              top: `${top}px`,
              width: `${width}px`,
              height: `${height}px`,
              // Clear the solid fill when we're rendering blurred image content inside
              background: imageSrc ? 'transparent' : undefined,
            }}
            onMouseEnter={() => setHoveredRegion(region.id)}
            onMouseLeave={() => setHoveredRegion(null)}
            onMouseDown={(e) => {
              if (isEditable && onRegionMouseDown) {
                // If they didn't click a handle or delete button, they clicked the body -> move
                if (!(e.target as HTMLElement).classList.contains('region-delete-label') &&
                    !(e.target as HTMLElement).classList.contains('region-handle')) {
                  e.stopPropagation();
                  onRegionMouseDown(e, region.id);
                }
              }
            }}
            onDoubleClick={(e) => {
              if (isEditable && onDismissRegion) {
                e.stopPropagation();
                onDismissRegion(region.id);
              }
            }}
            title={isEditable ? 'Double-click to remove' : (region.match_type === 'manual' ? 'Manual blur region' : `Detected: ${region.match_type}`)}
          >
            {/* Pixel-level image blur: duplicate the full image, offset it so the correct
                 crop is visible, clip via overflow:hidden on the parent, then apply blur.
                 scale(1.12) hides the transparent halo filter:blur adds at element edges. */}
            {imageSrc && (
              <img
                src={imageSrc}
                alt=""
                draggable={false}
                className="region-blur-img"
                style={{
                  position: 'absolute',
                  left: `-${left}px`,
                  top: `-${top}px`,
                  width: `${imgWidth}px`,
                  height: `${imgHeight}px`,
                }}
              />
            )}

            {/* Resize Handles — edit mode only */}
            {isEditable && (
              <>
                {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as ResizeHandle[]).map(handle => (
                  <div
                    key={handle}
                    className="region-handle"
                    data-handle={handle}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      onRegionMouseDown?.(e, region.id, handle);
                    }}
                  />
                ))}
              </>
            )}
            {/* Type label on hover — view mode only */}
            {!isEditable && (
              <span className="sensitive-label">
                {region.match_type === 'otp' ? '•••' : region.match_text || 'Sensitive'}
              </span>
            )}
          </div>
        );
      })}
      {/* Render fading regions with animation */}
      {fadingRegionList.map(region => {
        const scaleX = imgWidth / region.img_width;
        const scaleY = imgHeight / region.img_height;
        const left = region.x * scaleX;
        const top = region.y * scaleY;
        const width = region.width * scaleX;
        const height = region.height * scaleY;

        return (
          <div
            key={region.id}
            className={`sensitive-overlay editable fading-out`}
            style={{
              left: `${left}px`,
              top: `${top}px`,
              width: `${width}px`,
              height: `${height}px`,
              background: imageSrc ? 'transparent' : undefined,
            }}
          >
            {imageSrc && (
              <img
                src={imageSrc}
                alt=""
                draggable={false}
                className="region-blur-img"
                style={{
                  position: 'absolute',
                  left: `-${left}px`,
                  top: `-${top}px`,
                  width: `${imgWidth}px`,
                  height: `${imgHeight}px`,
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/* ── AnnotationLayer ──────────────────────────────────────── */
function AnnotationLayer({
  annotations,
  imgWidth,
  imgHeight,
  activeInteraction,
  selectedTool,
  selectedColor,
}: {
  annotations: Annotation[];
  imgWidth: number;
  imgHeight: number;
  activeInteraction: InteractionState;
  selectedTool: ToolType;
  selectedColor: string;
}) {
  const renderAnnotation = (ann: any, isTemp = false) => {
    const scaleX = isTemp ? 1 : imgWidth / ann.img_width;
    const scaleY = isTemp ? 1 : imgHeight / ann.img_height;
    const startX = ann.start_x * scaleX;
    const startY = ann.start_y * scaleY;
    const endX = ann.end_x * scaleX;
    const endY = ann.end_y * scaleY;
    const color = ann.color;

    if (ann.tool === 'arrow') {
      const dx = endX - startX;
      const dy = endY - startY;
      const angle = Math.atan2(dy, dx);
      const headLen = 14;
      return (
        <g key={ann.id || 'temp'}>
          <line x1={startX} y1={startY} x2={endX} y2={endY} stroke={color} strokeWidth="3" strokeLinecap="round" />
          <polygon
            points={`0,0 -${headLen},${headLen/2} -${headLen},-${headLen/2}`}
            fill={color}
            transform={`translate(${endX},${endY}) rotate(${(angle * 180) / Math.PI})`}
          />
        </g>
      );
    } else if (ann.tool === 'box') {
      const left = Math.min(startX, endX);
      const top = Math.min(startY, endY);
      const width = Math.abs(endX - startX);
      const height = Math.abs(endY - startY);
      return <rect key={ann.id || 'temp'} x={left} y={top} width={width} height={height} stroke={color} strokeWidth="3" fill="none" />;
    } else if (ann.tool === 'highlight') {
      const left = Math.min(startX, endX);
      const top = Math.min(startY, endY);
      const width = Math.abs(endX - startX);
      const height = Math.abs(endY - startY);
      return <rect key={ann.id || 'temp'} x={left} y={top} width={width} height={height} fill={color} style={{ mixBlendMode: 'multiply', opacity: 0.5 }} />;
    }
    return null;
  };

  return (
    <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', display: 'block' }}>
      {annotations.map(ann => renderAnnotation(ann))}
      {activeInteraction?.type === 'draw' && selectedTool !== 'blur' && renderAnnotation({
        tool: selectedTool,
        start_x: activeInteraction.dispStart.x,
        start_y: activeInteraction.dispStart.y,
        end_x: activeInteraction.dispCurrent.x,
        end_y: activeInteraction.dispCurrent.y,
        color: selectedColor,
      }, true)}
    </svg>
  );
}

/* ── PreviewModal ─────────────────────────────────────────── */
type InteractionState =
  | { type: 'draw'; dispStart: { x: number; y: number }; dispCurrent: { x: number; y: number } }
  | { type: 'move'; regionId: string; origRegion: SensitiveRegion; mouseStartDisp: { x: number; y: number }; mousePtDisp: { x: number; y: number } }
  | { type: 'resize'; regionId: string; handle: ResizeHandle; origRegion: SensitiveRegion; mouseStartDisp: { x: number; y: number }; mousePtDisp: { x: number; y: number } }
  | null;

interface PreviewModalProps {
  screenshot: Screenshot | null;
  regions: SensitiveRegion[];
  imageSrc: string | null;
  onClose: () => void;
  onDismissRegion: (regionId: string) => void;
  onDeleteRegion: (regionId: string) => void;
  onAddRegion: (x: number, y: number, width: number, height: number, imgWidth: number, imgHeight: number) => void;
  onUpdateRegion: (regionId: string, x: number, y: number, width: number, height: number) => void;

  onOpenInDefaultViewer: (path: string) => void;
  onRevealInExplorer: (path: string) => void;
  onCopy: (path: string, protectedCopy: boolean) => void;
  showWarning: () => void;
  warningShown: boolean;
  fadingRegions?: Set<string>;
}

function PreviewModal({
  screenshot,
  regions,
  annotations,
  imageSrc,
  onClose,
  onDeleteRegion,
  onAddRegion,
  onUpdateRegion,
  onOpenInDefaultViewer,
  onRevealInExplorer,
  onCopy,
  showWarning,
  warningShown,
  fadingRegions,
  selectedTool,
  setSelectedTool,
  selectedColor,
  setSelectedColor,
  undoStack,
  onUndo,
  onAddAnnotation,
}: PreviewModalProps & {
  annotations: Annotation[],
  selectedTool: ToolType,
  setSelectedTool: (t: ToolType) => void,
  selectedColor: string,
  setSelectedColor: (c: string) => void,
  undoStack: string[],
  onUndo: () => void,
  onAddAnnotation: (tool: string, sx: number, sy: number, ex: number, ey: number, color: string, w: number, h: number) => Promise<void>,
}) {
  const [imgDimensions, setImgDimensions] = useState<{ width: number; height: number } | null>(null);
  // displayDimensions = rendered pixel size of the <img> element in the DOM
  const [displayDimensions, setDisplayDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isEditMode, setIsEditMode] = useState(false);
  const [activeInteraction, setActiveInteraction] = useState<InteractionState>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset edit mode when screenshot changes
  useEffect(() => {
    setIsEditMode(false);
    setActiveInteraction(null);
  }, [screenshot]);

  // Track image natural dimensions + display dimensions when imageSrc changes
  useEffect(() => {
    if (imgRef.current && imgRef.current.complete) {
      setImgDimensions({
        width: imgRef.current.naturalWidth,
        height: imgRef.current.naturalHeight,
      });
    }
  }, [imageSrc]);

  // Keep displayDimensions perfectly in sync (handles modal animations, window resizes, etc.)
  useEffect(() => {
    if (!imgRef.current) return;
    const observer = new ResizeObserver(() => {
      if (imgRef.current) {
        const r = imgRef.current.getBoundingClientRect();
        if (r.width > 0) setDisplayDimensions({ width: r.width, height: r.height });
      }
    });
    observer.observe(imgRef.current);
    return () => observer.disconnect();
  }, [imageSrc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        onUndo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onUndo]);

  // ── Shared coordinate helpers ────────────────────────────────
  // All drag state is in DISPLAY-SPACE (pixels relative to the rendered image element).
  // Image-space conversion (for DB storage) happens only in handleMouseUp.

  const getImgRect = () => imgRef.current?.getBoundingClientRect() ?? null;

  // Handle mouse events for drawing new regions in edit mode
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isEditMode || !imgRef.current || !imgDimensions) return;
    const rect = getImgRect();
    if (!rect) return;
    const dispX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const dispY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    setActiveInteraction({ type: 'draw', dispStart: { x: dispX, y: dispY }, dispCurrent: { x: dispX, y: dispY } });
  };

  const handleRegionMouseDown = (e: React.MouseEvent, regionId: string, handle?: ResizeHandle) => {
    if (!isEditMode || !imgRef.current) return;
    const rect = getImgRect();
    if (!rect) return;
    const origRegion = regions.find(r => r.id === regionId);
    if (!origRegion) return;

    const dispX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const dispY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    if (handle) {
      setActiveInteraction({ type: 'resize', regionId, handle, origRegion, mouseStartDisp: { x: dispX, y: dispY }, mousePtDisp: { x: dispX, y: dispY } });
    } else {
      setActiveInteraction({ type: 'move', regionId, origRegion, mouseStartDisp: { x: dispX, y: dispY }, mousePtDisp: { x: dispX, y: dispY } });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!activeInteraction || !imgRef.current) return;
    const rect = getImgRect();
    if (!rect) return;
    
    const dispX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const dispY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));

    if (activeInteraction.type === 'draw') {
      setActiveInteraction({ ...activeInteraction, dispCurrent: { x: dispX, y: dispY } });
    } else if (activeInteraction.type === 'move') {
      setActiveInteraction({ ...activeInteraction, mousePtDisp: { x: dispX, y: dispY } });
    } else if (activeInteraction.type === 'resize') {
      setActiveInteraction({ ...activeInteraction, mousePtDisp: { x: dispX, y: dispY } });
    }
  };

  const handleMouseUp = async (e: React.MouseEvent) => {
    if (!activeInteraction || !imgDimensions || !screenshot || !imgRef.current) return;

    const rect = getImgRect();
    if (!rect) { setActiveInteraction(null); return; }

    // Use the event's actual client position for the final coordinate to avoid React state closure lag
    const finalDispX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const finalDispY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));

    const scaleX = imgDimensions.width / rect.width;
    const scaleY = imgDimensions.height / rect.height;

    if (activeInteraction.type === 'draw') {
      const { dispStart } = activeInteraction;
      const dispX = Math.min(dispStart.x, finalDispX);
      const dispY = Math.min(dispStart.y, finalDispY);
      const dispW = Math.abs(finalDispX - dispStart.x);
      const dispH = Math.abs(finalDispY - dispStart.y);

      if (dispW >= 5 && dispH >= 5) {
        if (selectedTool === 'blur') {
          await onAddRegion(
            Math.round(dispX * scaleX),
            Math.round(dispY * scaleY),
            Math.round(dispW * scaleX),
            Math.round(dispH * scaleY),
            imgDimensions.width,
            imgDimensions.height,
          );
        } else {
          await onAddAnnotation(
            selectedTool,
            Math.round(dispStart.x * scaleX),
            Math.round(dispStart.y * scaleY),
            Math.round(finalDispX * scaleX),
            Math.round(finalDispY * scaleY),
            selectedColor,
            imgDimensions.width,
            imgDimensions.height,
          );
        }
      }
    } else if (activeInteraction.type === 'move' || activeInteraction.type === 'resize') {
      const tempRegion = computeInteractiveRegion({ ...activeInteraction, mousePtDisp: { x: finalDispX, y: finalDispY } }, imgRef.current);
      if (tempRegion) {
        await onUpdateRegion(
          activeInteraction.regionId,
          tempRegion.x,
          tempRegion.y,
          tempRegion.width,
          tempRegion.height
        );
      }
    }

    setActiveInteraction(null);
  };

  if (!screenshot || !imageSrc) return null;

  const handleImgLoad = () => {
    if (imgRef.current) {
      // Natural dimensions — used for image-space ↔ display-space conversion
      setImgDimensions({
        width: imgRef.current.naturalWidth,
        height: imgRef.current.naturalHeight,
      });
      // Display dimensions — used for overlay positioning CSS
      const r = imgRef.current.getBoundingClientRect();
      if (r.width > 0) setDisplayDimensions({ width: r.width, height: r.height });
    }
  };

  // Helper to compute a modified region during a move/resize drag, in original image-space coords
  const computeInteractiveRegion = (interaction: InteractionState, imgEl: HTMLImageElement): SensitiveRegion | null => {
    if (!interaction || interaction.type === 'draw') return null;
    const { origRegion, mouseStartDisp, mousePtDisp } = interaction;
    const rect = imgEl.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;

    const scaleX = imgDimensions!.width / rect.width;
    const scaleY = imgDimensions!.height / rect.height;

    const deltaImgX = (mousePtDisp.x - mouseStartDisp.x) * scaleX;
    const deltaImgY = (mousePtDisp.y - mouseStartDisp.y) * scaleY;

    let newX = origRegion.x;
    let newY = origRegion.y;
    let newW = origRegion.width;
    let newH = origRegion.height;

    if (interaction.type === 'move') {
      newX += deltaImgX;
      newY += deltaImgY;
    } else if (interaction.type === 'resize') {
      const h = interaction.handle;
      if (h.includes('w')) {
        newX += deltaImgX;
        newW -= deltaImgX;
      }
      if (h.includes('e')) {
        newW += deltaImgX;
      }
      if (h.includes('n')) {
        newY += deltaImgY;
        newH -= deltaImgY;
      }
      if (h.includes('s')) {
        newH += deltaImgY;
      }
    }

    // Min size 10px in image space
    if (newW < 10) {
      newX = interaction.type === 'resize' && interaction.handle.includes('w') ? origRegion.x + origRegion.width - 10 : newX;
      newW = 10;
    }
    if (newH < 10) {
      newY = interaction.type === 'resize' && interaction.handle.includes('n') ? origRegion.y + origRegion.height - 10 : newY;
      newH = 10;
    }

    // Clamp to image bounds
    newX = Math.max(0, Math.min(newX, imgDimensions!.width - newW));
    newY = Math.max(0, Math.min(newY, imgDimensions!.height - newH));

    return {
      ...origRegion,
      x: Math.round(newX),
      y: Math.round(newY),
      width: Math.round(newW),
      height: Math.round(newH),
    };
  };

  const handleSaveProtectedCopy = async () => {
    if (!imgRef.current || !imgDimensions || !screenshot) return;
    
    const base64 = generateProtectedBase64(imgRef.current, imgDimensions, regions, annotations, fadingRegions);
    if (!base64) return;
    try {
      await invoke('save_protected_copy', {
        imageBase64: base64,
        suggestedName: `Protected_${basename(screenshot.path)}.png`,
      });
    } catch (e) {
      if (e !== "User cancelled") {
        console.error("Failed to save copy:", e);
      }
    }
  };

  // Replace regions list with optimistic updates during drag
  const displayRegions = regions.map(r => {
    if (activeInteraction && (activeInteraction.type === 'move' || activeInteraction.type === 'resize') && activeInteraction.regionId === r.id) {
      const tempRegion = computeInteractiveRegion(activeInteraction, imgRef.current!);
      return tempRegion || r;
    }
    return r;
  });

  return (
    <div className="dialog-overlay" onClick={isEditMode ? undefined : onClose} style={{ zIndex: 10000 }}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-header">
          <h3 className="preview-title">{basename(screenshot.path)}</h3>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {isEditMode && (
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', background: 'rgba(0,0,0,0.1)', padding: '4px', borderRadius: '6px', marginRight: '8px' }}>
                <button style={{ padding: '4px 8px', borderRadius: '4px', border: selectedTool === 'blur' ? '1px solid var(--mark)' : '1px solid transparent', background: selectedTool === 'blur' ? 'var(--mark-soft)' : 'transparent', color: selectedTool === 'blur' ? 'var(--mark)' : 'var(--tx)', cursor: 'pointer', fontWeight: selectedTool === 'blur' ? 'bold' : 'normal' }} onClick={() => setSelectedTool('blur')} title="Blur">Blur</button>
                <button style={{ padding: '4px 8px', borderRadius: '4px', border: selectedTool === 'arrow' ? '1px solid var(--mark)' : '1px solid transparent', background: selectedTool === 'arrow' ? 'var(--mark-soft)' : 'transparent', color: selectedTool === 'arrow' ? 'var(--mark)' : 'var(--tx)', cursor: 'pointer', fontWeight: selectedTool === 'arrow' ? 'bold' : 'normal' }} onClick={() => setSelectedTool('arrow')} title="Arrow">↗</button>
                <button style={{ padding: '4px 8px', borderRadius: '4px', border: selectedTool === 'box' ? '1px solid var(--mark)' : '1px solid transparent', background: selectedTool === 'box' ? 'var(--mark-soft)' : 'transparent', color: selectedTool === 'box' ? 'var(--mark)' : 'var(--tx)', cursor: 'pointer', fontWeight: selectedTool === 'box' ? 'bold' : 'normal' }} onClick={() => setSelectedTool('box')} title="Box">□</button>
                <button style={{ padding: '4px 8px', borderRadius: '4px', border: selectedTool === 'highlight' ? '1px solid var(--mark)' : '1px solid transparent', background: selectedTool === 'highlight' ? 'var(--mark-soft)' : 'transparent', color: selectedTool === 'highlight' ? 'var(--mark)' : 'var(--tx)', cursor: 'pointer', fontWeight: selectedTool === 'highlight' ? 'bold' : 'normal' }} onClick={() => setSelectedTool('highlight')} title="Highlight">■</button>
                {selectedTool !== 'blur' && (
                  <div style={{ display: 'flex', gap: '6px', marginLeft: '6px', paddingLeft: '6px', borderLeft: '1px solid rgba(255,255,255,0.1)', alignItems: 'center' }}>
                    {['#1F7A5C', '#F5A623', '#7ED321', '#4A90E2'].map(c => (
                      <button key={c} onClick={() => setSelectedColor(c)} style={{ width: '16px', height: '16px', borderRadius: '50%', background: c, border: selectedColor === c ? '2px solid white' : '1px solid rgba(0,0,0,0.2)', cursor: 'pointer', padding: 0 }} />
                    ))}
                    <input type="color" value={selectedColor} onChange={(e) => setSelectedColor(e.target.value)} style={{ width: '20px', height: '20px', padding: 0, border: 'none', borderRadius: '4px', cursor: 'pointer', background: 'none' }} title="Custom Color" />
                  </div>
                )}
                {undoStack.length > 0 && (
                  <button style={{ marginLeft: '6px', padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: 'var(--tx)', cursor: 'pointer' }} onClick={onUndo} title="Undo (Ctrl+Z)">↶</button>
                )}
              </div>
            )}
            <button
              className={`edit-mode-toggle ${isEditMode ? 'active' : ''}`}
              onClick={() => setIsEditMode(!isEditMode)}
              title={isEditMode ? 'Exit edit mode' : 'Edit blur regions'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              {isEditMode ? 'Done' : 'Edit'}
            </button>
            <button className="dialog-close" onClick={isEditMode ? undefined : onClose} title={isEditMode ? 'Exit edit mode first' : 'Close (Esc)'} style={{ opacity: isEditMode ? 0.4 : 1, cursor: isEditMode ? 'not-allowed' : 'pointer' }}>✕</button>
          </div>
        </div>

        <div className="preview-content">
          <div
            ref={containerRef}
            className={`preview-image-container ${isEditMode ? 'edit-mode' : ''}`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {/* Inner wrapper sized exactly to the rendered image — ensures overlays align perfectly */}
            <div style={{ position: 'relative', display: 'inline-block', lineHeight: 0 }}>
              {imageSrc ? (
                <img
                  ref={imgRef}
                  src={imageSrc}
                  alt="Screenshot preview"
                  className="preview-full-image"
                  onLoad={handleImgLoad}
                  draggable={!isEditMode}
                  onDragStart={(e) => {
                    e.preventDefault();
                    if (!isEditMode) {
                      startImageDrag(screenshot.path, `Protected_${basename(screenshot.path)}.png`, regions, annotations);
                    }
                  }}
                />
              ) : (
                <div className="img-skeleton" style={{ width: '100%', height: '100%' }} />
              )}
              {displayDimensions && (
                <SensitiveBlurOverlay
                  regions={displayRegions}
                  imgWidth={displayDimensions.width}
                  imgHeight={displayDimensions.height}
                  isEditable={isEditMode}
                  onDismissRegion={onDeleteRegion}
                  onRegionMouseDown={handleRegionMouseDown}
                  fadingRegions={fadingRegions}
                  imageSrc={imageSrc}
                />
              )}
              {displayDimensions && (
                <AnnotationLayer
                  annotations={annotations}
                  imgWidth={displayDimensions.width}
                  imgHeight={displayDimensions.height}
                  activeInteraction={activeInteraction}
                  selectedTool={selectedTool}
                  selectedColor={selectedColor}
                />
              )}
              {/* Draw preview rectangle — dispStart/dispCurrent are in display-space */}
              {activeInteraction?.type === 'draw' && selectedTool === 'blur' && (
                <div
                  className="draw-preview-rect"
                  style={{
                    left: `${Math.min(activeInteraction.dispStart.x, activeInteraction.dispCurrent.x)}px`,
                    top: `${Math.min(activeInteraction.dispStart.y, activeInteraction.dispCurrent.y)}px`,
                    width: `${Math.abs(activeInteraction.dispCurrent.x - activeInteraction.dispStart.x)}px`,
                    height: `${Math.abs(activeInteraction.dispCurrent.y - activeInteraction.dispStart.y)}px`,
                  }}
                />
              )}
            </div>
          </div>
        </div>

        <div className="preview-actions">
          <button
            className="preview-action-btn primary"
            onClick={handleSaveProtectedCopy}
            title="Save a copy of the image with blur protection applied"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
              <polyline points="17 21 17 13 7 13 7 21"></polyline>
              <polyline points="7 3 7 8 15 8"></polyline>
            </svg>
            Save Protected Copy
          </button>

          <button
            className="preview-action-btn secondary"
            onClick={() => onCopy(screenshot.path, true)}
            title="Copy image with blur protection"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Copy
          </button>

          <button
            className="preview-action-btn secondary"
            onClick={() => onCopy(screenshot.path, false)}
            title="Copy original image (no blur)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Copy Original
          </button>

          <button
            className="preview-action-btn secondary"
            onClick={() => onRevealInExplorer(screenshot.path)}
            title="Show in Explorer"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            Show in Explorer
          </button>

          <button
            className="preview-action-btn secondary"
            onClick={() => {
              onOpenInDefaultViewer(screenshot.path);
              if (!warningShown) {
                showWarning();
              }
            }}
            title="Open in default image viewer"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            Open in Viewer
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── MarkGlyph ───────────────────────────────────────────── */
function MarkGlyph({ className = "", style }: { className?: string, style?: React.CSSProperties }) {
  return (
    <img 
      src={kapturLogo} 
      className={`mark-glyph ${className}`} 
      style={{ ...style, objectFit: 'contain' }} 
      alt="Kaptur Logo" 
    />
  );
}

/* ── SplashIntro ─────────────────────────────────────────── */
function SplashIntro({ onComplete }: { onComplete: () => void }) {
  const [slide, setSlide] = useState(0);

  const slides = [
    {
      title: "Never lose a screenshot again.",
      text: "Kaptur quietly keeps track of everything you capture, so you can find it later without digging through folders.",
      visual: <MarkGlyph className="splash-mark-large mark-glyph-anim" />
    },
    {
      title: "Just take a screenshot. That's it.",
      text: "Kaptur watches in the background. No new habits, no extra steps — keep using your normal screenshot shortcut.",
      visual: (
        <div className="splash-mock-thumb">
          <div style={{ position: 'absolute', top: '10px', left: '10px', right: '10px', bottom: '10px', background: 'var(--surface-raised)', borderRadius: '4px' }}></div>
          <MarkGlyph className="watermark-glyph mark-glyph-anim watermark-glyph-icon" />
        </div>
      )
    },
    {
      title: "Find it by what you remember.",
      text: "Press Ctrl+Shift+F from anywhere, type a word you remember seeing, and it's right there.",
      visual: (
        <div className="splash-mock-overlay">
          <div style={{ padding: '8px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--tx-muted)" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/></svg>
            <span style={{ fontSize: '13px', color: 'var(--tx)' }}>flight <span style={{ color: 'var(--tx-muted)' }}>|</span></span>
          </div>
          <div className="splash-mock-overlay-text">
            Booking confirmed. Your <span className="splash-mock-overlay-highlight">flight</span> departs at 08:00 AM...
          </div>
        </div>
      )
    },
    {
      title: "Everything stays on your device.",
      text: "No cloud, no accounts, no syncing. Your screenshots and indexed data never leave your local machine.",
      visual: (
        <div className="splash-mock-thumb" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '32px' }}>
          🔒
        </div>
      )
    }
  ];

  const nextSlide = () => {
    if (slide === slides.length - 1) onComplete();
    else setSlide(s => s + 1);
  };

  return (
    <main className="container onboarding">
      <div className="splash-container">
        <button className="splash-skip" onClick={onComplete}>Skip</button>
        
        <div className="splash-slides" style={{ transform: `translateX(-${slide * 100}%)` }}>
          {slides.map((s, i) => (
            <div key={i} className="splash-slide">
              <div className="splash-visual">{s.visual}</div>
              <h2>{s.title}</h2>
              <p>{s.text}</p>
            </div>
          ))}
        </div>

        <div className="splash-footer">
          <div className="splash-dots">
            {slides.map((_, i) => (
              <div key={i} className={`splash-dot ${i === slide ? "active" : ""}`} />
            ))}
          </div>
          <button className="primary" onClick={nextSlide}>
            {slide === slides.length - 1 ? "Get Started →" : "Next"}
          </button>
        </div>
      </div>
    </main>
  );
}
/* ── App ─────────────────────────────────────────────────── */
function App() {
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [onboardingDone, setOnboardingDone] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [folder, setFolder] = useState<string>("");
  const [autoStart, setAutoStart] = useState(true);
  const [isOverlay, setIsOverlay] = useState(false);
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [filterMode, setFilterMode] = useState<"all" | "has_text" | "no_text" | "favorites">("all");


  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; screenshot: Screenshot;
  } | null>(null);

  const [watchFolders, setWatchFolders] = useState<string[]>([]);
  const [watchFolderError, setWatchFolderError] = useState<string | null>(null);
  const [ocrAvailable, setOcrAvailable] = useState(true);
  const [ocrWarning, setOcrWarning] = useState<string | null>(null);
  const [reprocessingCount, setReprocessingCount] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsFolder, setSettingsFolder] = useState("");
  const [settingsAutoStart, setSettingsAutoStart] = useState(true);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [introSeen, setIntroSeen] = useState(false);

  // Preview modal state
  const [previewImage, setPreviewImage] = useState<Screenshot | null>(null);
  const [previewRegions, setPreviewRegions] = useState<SensitiveRegion[]>([]);
  const [previewAnnotations, setPreviewAnnotations] = useState<Annotation[]>([]);
  const [selectedTool, setSelectedTool] = useState<ToolType>('blur');
  const [selectedColor, setSelectedColor] = useState<string>('#1F7A5C'); // --mark color
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [openInDefaultViewerWarningShown, setOpenInDefaultViewerWarningShown] = useState(false);
  const [fadingRegions, setFadingRegions] = useState<Set<string>>(new Set());
  const [deletedRegionBuffer, setDeletedRegionBuffer] = useState<SensitiveRegion | null>(null);
  // Incrementing this triggers all visible ScreenshotCards to re-fetch their regions
  const [regionRefreshTrigger, setRegionRefreshTrigger] = useState(0);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('kaptur-theme');
    return (saved === 'dark' ? 'dark' : 'light') as 'light' | 'dark';
  });
  const ITEMS_PER_PAGE = 50;

  const debouncedQuery = useDebounce(searchQuery, 220);
  const searchInputRef = useRef<HTMLInputElement>(null);

  /* ── Theme ───────────────────────────────────────────── */
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('kaptur-theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === 'light' ? 'dark' : 'light');

  /* ── Detect overlay window ───────────────────────────── */
  useEffect(() => {
    try {
      const win = getCurrentWindow();
      setIsOverlay(win.label === "overlay");
    } catch { setIsOverlay(false); }
  }, []);

  /* ── Init: check onboarding ─────────────────────────── */
  useEffect(() => { checkOnboarding(); }, []);

  /* ── Init: check for updates ────────────────────────── */
  useEffect(() => {
    async function checkForUpdates() {
      try {
        const update = await check();
        if (update) {
          console.log(`found update ${update.version}`);
          await update.downloadAndInstall();
          await relaunch();
        }
      } catch (err) {
        console.error("Failed to check for updates:", err);
      }
    }
    if (onboardingDone && !isOverlay) {
      checkForUpdates();
    }
  }, [onboardingDone, isOverlay]);

  /* ── Listen: show-main-window ───────────────────────── */
  useEffect(() => {
    let cleanup: Promise<() => void> | null = null;
    try {
      cleanup = listen("show-main-window", () => {
        try { const w = getCurrentWindow(); w.show(); w.setFocus(); } catch {}
      });
    } catch {}
    return () => { if (cleanup) cleanup.then(f => f()); };
  }, []);

  /* ── Listen: screenshots-updated (after scan) ───────── */
  useEffect(() => {
    if (!onboardingDone) return;
    let cleanup: Promise<() => void> | null = null;
    try {
      cleanup = listen("screenshots-updated", () => {
        if (isOverlay && filterMode !== 'favorites') loadOverlayDays(2); else loadScreenshots();
      });
    } catch {}
    return () => { if (cleanup) cleanup.then(f => f()); };
  }, [onboardingDone, isOverlay]);

  /* ── Listen: OCR availability events ────────────────── */
  useEffect(() => {
    let cleanup1: Promise<() => void> | null = null;
    let cleanup2: Promise<() => void> | null = null;
    try {
      cleanup1 = listen<string>("ocr-unavailable", (msg: TauriEvent<string>) => {
        setOcrAvailable(false);
        setOcrWarning(msg.payload);
      });
      cleanup2 = listen("ocr-available", () => {
        setOcrAvailable(true);
        setOcrWarning(null);
      });
    } catch {}
    return () => {
      if (cleanup1) cleanup1.then(f => f());
      if (cleanup2) cleanup2.then(f => f());
    };
  }, []);



  /* ── Fetch when query changes ───────────────────────── */
  useEffect(() => {
    if (!onboardingDone) return;
    if (debouncedQuery.trim()) {
      handleSearch(debouncedQuery);
    } else {
      if (isOverlay && filterMode !== 'favorites') loadOverlayDays(2); else loadScreenshots(false);
    }
  }, [debouncedQuery, sortOrder, filterMode, onboardingDone, isOverlay]);

  /* ── Close context menu on outside click ────────────── */
  useEffect(() => {
    const close = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener("click", close);
      return () => document.removeEventListener("click", close);
    }
  }, [contextMenu]);

  /* ── Escape to close overlay ────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOverlay) {
        invoke("hide_overlay_window");
        setContextMenu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOverlay]);

  /* ── Data functions ──────────────────────────────────── */
  async function checkOnboarding() {
    try {
      const config = await invoke<OnboardingConfig | null>("get_onboarding_config");
      if (config) {
        setOnboardingDone(true);
        setFolder(config.screenshot_folder);
        setAutoStart(config.launch_on_startup);
        
        try {
          const currentlyEnabled = await isEnabled();
          if (config.launch_on_startup && !currentlyEnabled) {
            await enable();
          } else if (!config.launch_on_startup && currentlyEnabled) {
            await disable();
          }
        } catch (e) {
          console.error("Failed to sync autostart status", e);
        }
      }
    } catch (e) { console.error("Onboarding check failed:", e); }
    // Load intro seen
    try {
      const seen = await invoke<boolean>("get_intro_seen");
      setIntroSeen(seen);
    } catch { setIntroSeen(false); }
    setLoading(false);
  }

  function completeIntro() {
    invoke("set_intro_seen", { seen: true }).catch(console.error);
    setIntroSeen(true);
  }

  async function completeOnboarding() {
    try {
      await invoke("complete_onboarding", {
        config: { screenshot_folder: folder, launch_on_startup: autoStart },
      });
      try {
        if (autoStart) {
          await enable();
        } else {
          await disable();
        }
      } catch (e) {
        console.error("Failed to apply autostart", e);
      }
      setOnboardingDone(true);
    } catch (e) {
      console.error("Onboarding failed:", e);
      alert("Failed to complete setup");
    }
  }

  const loadScreenshots = useCallback(async (append: boolean = false) => {
    try {
      const currentCursor = append ? cursor : null;
      const results = await invoke<Screenshot[]>("get_recent_screenshots", {
        limit: ITEMS_PER_PAGE,
        cursor: currentCursor,
        sort: sortOrder,
        filter: filterMode
      });

      if (append) {
        setScreenshots(prev => [...prev, ...results]);
      } else {
        setScreenshots(results);
        setCursor(null);
        setHasMore(true);
      }

      // Update cursor and hasMore
      if (results.length < ITEMS_PER_PAGE) {
        setHasMore(false);
      } else if (results.length > 0) {
        const last = results[results.length - 1];
        setCursor({ captured_at: last.captured_at, id: last.id });
      }
    } catch (e) { console.error("Load failed:", e); }
  }, [cursor, ITEMS_PER_PAGE, sortOrder, filterMode]);

  const loadOverlayDays = useCallback(async (days: number) => {
    try {
      const results = await invoke<Screenshot[]>("get_screenshots_by_days", { days });
      setScreenshots(results);
      setCursor(null);
      setHasMore(false); // No pagination for overlay
    } catch (e) { console.error("Load by days failed:", e); }
  }, []);

  // ── Preview Modal Functions ───────────────────────────────────
  async function openPreviewModal(screenshot: Screenshot) {
    try {
      setPreviewImage(screenshot);
      setPreviewRegions([]);
      setPreviewAnnotations([]);
      setUndoStack([]);
      setSelectedTool('blur');
      setPreviewSrc(null);

      // Fetch full-size image, sensitive regions, and annotations in parallel
      const [imageBase64, regions, annots] = await Promise.all([
        invoke<string>("read_image_as_base64", { path: screenshot.path }),
        invoke<SensitiveRegion[]>("get_sensitive_regions", { screenshotId: screenshot.id }),
        invoke<Annotation[]>("get_annotations", { screenshotId: screenshot.id }),
      ]);

      setPreviewSrc(imageBase64);
      setPreviewRegions(regions);
      setPreviewAnnotations(annots);
    } catch (e) {
      console.error("Failed to load preview:", e);
      // Fallback: open in OS viewer
      invoke("open_screenshot", { path: screenshot.path });
    }
  }

  function closePreviewModal() {
    setPreviewImage(null);
    setPreviewRegions([]);
    setPreviewAnnotations([]);
    setPreviewSrc(null);
  }

  async function handleDeleteRegion(regionId: string) {
    const regionToDelete = previewRegions.find(r => r.id === regionId);
    if (!regionToDelete) return;

    // Store for undo
    setDeletedRegionBuffer(regionToDelete);

    // Start fade-out animation
    setFadingRegions(prev => new Set([...prev, regionId]));

    // Show toast
    showRegionUndoToast();

    // Actually delete after animation
    setTimeout(async () => {
      try {
        await invoke("delete_region", { regionId });
        setPreviewRegions(prev => prev.filter(r => r.id !== regionId));
        setFadingRegions(prev => {
          const next = new Set(prev);
          next.delete(regionId);
          return next;
        });
        // Refresh thumbnail cards so the deleted region disappears without a full reload
        setRegionRefreshTrigger(v => v + 1);
      } catch (e) {
        console.error("Failed to delete region:", e);
        // Revert state on error
        setFadingRegions(prev => {
          const next = new Set(prev);
          next.delete(regionId);
          return next;
        });
      }
    }, 150);
  }

  function handleUndoRegionDelete() {
    if (!deletedRegionBuffer) return;

    const region = deletedRegionBuffer;
    setDeletedRegionBuffer(null);

    // Re-add to local state immediately
    setPreviewRegions(prev => [...prev, region]);

    // Re-insert into database
    invoke("insert_sensitive_regions", {
      regions: [{
        ...region,
        is_dismissed: false,
      }]
    }).catch(e => console.error("Failed to undo delete:", e));
  }

  function showRegionUndoToast() {
    const toast = document.createElement('div');
    toast.className = 'toast-undo';
    toast.innerHTML = `
      <span>Region removed</span>
    `;
    toast.style.cssText = `
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: var(--surface); color: var(--tx);
      padding: 12px 16px; border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15); font-size: 13px;
      display: flex; align-items: center; gap: 8px; z-index: 10001;
      border: 1px solid var(--border); animation: toastSlide 0.3s ease-out;
    `;

    const undoBtn = toast.querySelector('.toast-undo-btn');
    if (undoBtn) {
      undoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleUndoRegionDelete();
        toast.remove();
      });
    }

    document.body.appendChild(toast);

    // Auto-dismiss after 4 seconds
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(8px)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  async function handleAddRegion(x: number, y: number, width: number, height: number, imgWidth: number, imgHeight: number) {
    if (!previewImage) return;
    try {
      const regionId = await invoke<string>("add_manual_region", {
        screenshotId: previewImage.id,
        x, y, width, height,
        imgWidth, imgHeight,
      });

      setPreviewRegions(prev => [...prev, {
        id: regionId,
        screenshot_id: previewImage.id,
        x, y, width, height,
        img_width: imgWidth,
        img_height: imgHeight,
        match_type: 'manual',
        match_text: '',
        is_dismissed: false,
      }]);
      // Refresh thumbnail cards so the new region appears without a full reload
      setRegionRefreshTrigger(v => v + 1);
    } catch (e) {
      console.error("Failed to add region:", e);
    }
  }

  async function handleAddAnnotation(tool: string, start_x: number, start_y: number, end_x: number, end_y: number, color: string, img_width: number, img_height: number) {
    if (!previewImage) return;
    const ann: Annotation = {
      id: crypto.randomUUID(),
      screenshot_id: previewImage.id,
      tool, start_x, start_y, end_x, end_y, color, img_width: img_width, img_height: img_height
    };
    try {
      await invoke("add_annotation", { annotation: ann });
      setPreviewAnnotations(prev => [...prev, ann]);
      setUndoStack(prev => [...prev, ann.id]);
      // Refresh thumbnail cards so annotations appear without a full reload
      setRegionRefreshTrigger(v => v + 1);
    } catch(e) { console.error("Failed to add annotation", e); }
  }

  async function handleUndoAnnotation() {
    if (undoStack.length === 0) return;
    const lastId = undoStack[undoStack.length - 1];
    try {
      await invoke("delete_annotation", { id: lastId });
      setPreviewAnnotations(prev => prev.filter(a => a.id !== lastId));
      setUndoStack(prev => prev.slice(0, -1));
      // Refresh thumbnail cards so the removed annotation disappears
      setRegionRefreshTrigger(v => v + 1);
    } catch(e) { console.error("Failed to undo annotation", e); }
  }

  async function handleUpdateRegion(regionId: string, x: number, y: number, width: number, height: number) {
    try {
      await invoke("update_region", {
        regionId, x, y, width, height
      });
      setPreviewRegions(prev => prev.map(r => 
        r.id === regionId ? { ...r, x, y, width, height } : r
      ));
      // Refresh thumbnail cards
      setRegionRefreshTrigger(v => v + 1);
    } catch (e) {
      console.error("Failed to update region:", e);
    }
  }

  function showDefaultViewerWarning() {
    // Show a one-time non-blocking toast/notification
    const toast = document.createElement('div');
    toast.className = 'toast-warning';
    toast.textContent = 'Opening original image in default viewer — auto-blur won\'t apply there.';
    toast.style.cssText = `
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: rgba(245, 158, 11, 0.95); color: white; padding: 12px 20px;
      border-radius: 8px; font-size: 13px; z-index: 10001;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15); animation: toastSlide 0.3s ease-out;
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(8px)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
    setOpenInDefaultViewerWarningShown(true);
  }

  // ── End Preview Modal Functions ─────────────────────────────

  async function handleSearch(q: string) {
    if (!q.trim()) {
      if (isOverlay && filterMode !== 'favorites') loadOverlayDays(2); else loadScreenshots(false);
      return;
    }
    try {
      const results = await invoke<Screenshot[]>("search_screenshots", {
        query: q,
        limit: ITEMS_PER_PAGE,
        cursor: null,
        sort: sortOrder,
        filter: filterMode
      });
      setScreenshots(results);
      setCursor(null);

      if (results.length < ITEMS_PER_PAGE) {
        setHasMore(false);
      } else if (results.length > 0) {
        const last = results[results.length - 1];
        setCursor({ captured_at: last.captured_at, id: last.id });
        setHasMore(true);
      }
    } catch (e) { console.error("Search failed:", e); }
  }

  async function openScreenshot(path: string) {
    try {
      await invoke("open_screenshot", { path });
      if (isOverlay) invoke("hide_overlay_window");
    } catch (e) { console.error("Open failed:", e); }
  }

  // Find the screenshot object by path and open preview modal
  async function openPreviewFromPath(path: string) {
    const screenshot = screenshots.find(s => s.path === path);
    if (screenshot) {
      await openPreviewModal(screenshot);
    }
  }

  async function copyToClipboard(path: string, protectedCopy: boolean = false) {
    try {
      if (protectedCopy) {
        // ponytail: Stage 3 will implement actual protected copy
        // For now, fall back to regular copy
        await invoke("copy_image_to_clipboard", { path });
      } else {
        await invoke("copy_image_to_clipboard", { path });
      }
      
      const toast = document.createElement('div');
      toast.className = 'toast-copy';
      toast.innerHTML = `<span>Copied to clipboard</span>`;
      toast.style.cssText = `
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: var(--surface); color: var(--tx);
        padding: 12px 16px; border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 10000; animation: fade-in-up 0.3s ease;
        font-size: 0.875rem; font-weight: 500;
        border: 1px solid var(--border);
      `;
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.style.animation = 'fade-out-down 0.3s ease';
        setTimeout(() => toast.remove(), 290);
      }, 2000);
    } catch (e) { console.error("Copy failed:", e); }
    setContextMenu(null);
  }

  async function revealInExplorer(path: string) {
    try { await invoke("reveal_in_explorer", { path }); }
    catch (e) { console.error("Reveal failed:", e); }
    setContextMenu(null);
  }

  const handleContextMenu = (e: React.MouseEvent, screenshot: Screenshot) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, screenshot });
  };

  async function reprocessScreenshot(id: string) {
    try {
      await invoke("reprocess_ocr", { id });
      setContextMenu(null);
      // Reload after a short delay to let OCR complete
      setTimeout(() => {
        if (isOverlay && filterMode !== 'favorites') loadOverlayDays(2); else loadScreenshots(false);
      }, 2000);
    } catch (e) {
      console.error("Reprocess failed:", e);
      alert("Failed to reprocess: " + (e as Error).message);
    }
  }

  async function reprocessAllFailed() {
    try {
      const count = await invoke<number>("reprocess_all_failed");
      setReprocessingCount(count);
      // Reload after a delay
      setTimeout(() => {
        if (isOverlay && filterMode !== 'favorites') loadOverlayDays(2); else loadScreenshots(false);
        setReprocessingCount(null);
      }, 3000);
    } catch (e) {
      console.error("Reprocess all failed:", e);
      alert("Failed to reprocess: " + (e as Error).message);
    }
  }

  async function loadMore() {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);

    try {
      if (debouncedQuery.trim()) {
        // Search with cursor
        const results = await invoke<Screenshot[]>("search_screenshots", {
          query: debouncedQuery,
          limit: ITEMS_PER_PAGE,
          cursor: cursor,
          sort: sortOrder,
          filter: filterMode
        });
        setScreenshots(prev => [...prev, ...results]);

        if (results.length < ITEMS_PER_PAGE) {
          setHasMore(false);
        } else if (results.length > 0) {
          const last = results[results.length - 1];
          setCursor({ captured_at: last.captured_at, id: last.id });
        }
      } else {
        // Load more recent
        await loadScreenshots(true);
      }
    } catch (e) {
      console.error("Load more failed:", e);
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleToggleFavorite(e: React.MouseEvent, s: Screenshot) {
    e.stopPropagation();
    try {
      const newFavoriteState = !s.is_favorite;
      await invoke("toggle_favorite", { id: s.id, isFavorite: newFavoriteState });
      
      // Optimistically update the UI
      setScreenshots(prev => prev.map(item => 
        item.id === s.id ? { ...item, is_favorite: newFavoriteState } : item
      ));
    } catch (error) {
      console.error("Failed to toggle favorite:", error);
    }
  }

  async function handleAddWatchFolder(path: string) {
    if (!path.trim()) return;
    setWatchFolderError(null);
    if (path.trim().startsWith("\\\\") || path.trim().startsWith("//")) {
      setWatchFolderError("Network drives aren't supported yet");
      return;
    }
    try {
      await invoke("add_watch_folder", { path: path.trim() });
      setWatchFolders(prev => [...prev, path.trim()]);
    } catch (e: any) {
      setWatchFolderError("Failed to add folder: " + e.toString());
    }
  }

  async function handleRemoveWatchFolder(path: string) {
    try {
      await invoke("remove_watch_folder", { path });
      setWatchFolders(prev => prev.filter(p => p !== path));
    } catch (e: any) {
      alert("Failed to remove folder: " + e.toString());
    }
  }
  async function openSettings() {
    try {
      const currentFolder = await invoke<string | null>("get_screenshot_folder");
      setSettingsFolder(currentFolder || "");
      setSettingsAutoStart(autoStart);

      const extraFolders = await invoke<string[]>("get_watch_folders").catch(() => []);
      setWatchFolders(extraFolders);

      setShowSettings(true);
    } catch (e) {
      console.error("Failed to get settings:", e);
    }
  }

  async function saveSettings() {
    if (!settingsFolder.trim()) {
      alert("Please enter a folder path");
      return;
    }
    try {
      await invoke("set_screenshot_folder", { folder: settingsFolder });
      setFolder(settingsFolder);
      setAutoStart(settingsAutoStart);
      await invoke("complete_onboarding", {
        config: { screenshot_folder: settingsFolder, launch_on_startup: settingsAutoStart },
      });
      try {
        if (settingsAutoStart) {
          await enable();
        } else {
          await disable();
        }
      } catch (e) {
        console.error("Failed to apply autostart", e);
      }
      setShowSettings(false);
      // Reload screenshots from new folder
      if (isOverlay && filterMode !== 'favorites') loadOverlayDays(2); else loadScreenshots();
    } catch (e) {
      console.error("Failed to save settings:", e);
      alert("Failed to save settings: " + (e as Error).message);
    }
  }

  /* ── Group for main view ─────────────────────────────── */
  const isSearching = !!debouncedQuery.trim();
  const grouped = !isOverlay && !isSearching
    ? groupScreenshotsByTime(screenshots)
    : null;

  /* ── Render ──────────────────────────────────────────── */
  let content;

  if (loading) {
    content = (
      <div className="splash-screen">
        <div className="splash-brand-icon">
          <img src={kapturLogo} width="96" height="96" alt="Kaptur Logo" style={{ objectFit: 'contain' }} />
        </div>
        <h1 className="splash-title">Kaptur</h1>
      </div>
    );
  } else if (!introSeen) {
    content = <SplashIntro onComplete={completeIntro} />;
  } else if (!onboardingDone) {
    content = (
      <main className="container onboarding">
        <div className="onboarding-card">
          <div style={{ margin: "0 auto 1.25rem", display: "flex", justifyContent: "center" }}>
            <MarkGlyph style={{ width: 80, height: 80, opacity: 0.2 }} />
          </div>
          <h1>Welcome to Kaptur</h1>
          <p>Set up your screenshot folder to get started.</p>

          <div className="form-group">
            <label>Screenshot Folder</label>
            <div className="input-row">
              <input
                type="text"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="C:\Users\...\Pictures\Screenshots"
              />
              <button
                type="button"
                onClick={() => setFolder("C:\\Users\\AnkitPanwar\\Pictures\\Screenshots")}
              >
                Browse
              </button>
            </div>
          </div>

          <div className="form-group checkbox">
            <label>
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(e) => setAutoStart(e.target.checked)}
              />
              Launch on startup
            </label>
          </div>

          <button onClick={completeOnboarding} disabled={!folder} className="primary">
            Get Started →
          </button>
        </div>
      </main>
    );
  } else {
    content = (
      <div className={`container ${isOverlay ? 'overlay-mode' : ''}`}
        onClick={isOverlay ? (e) => {
          if (e.target === e.currentTarget) invoke("hide_overlay_window");
        } : undefined}
      >
      
      {/* ── Header ── */}
      {!isOverlay && (
        <header className="app-header">
          <div className="app-brand">
            <MarkGlyph style={{ width: 32, height: 32, marginRight: 8 }} />
            <span className="brand-name">Kaptur</span>
          </div>

          <div className="header-search">
            <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by filename or text content…"
            />
            {searchQuery && (
              <button
                className="search-clear"
                onClick={() => setSearchQuery("")}
                title="Clear search"
              >✕</button>
            )}
          </div>

          <div className="header-actions">
            <span className="count-badge">
              {screenshots.length} screenshot{screenshots.length !== 1 ? "s" : ""}
            </span>

            {/* OCR status */}
            {!ocrAvailable && (
              <span className="ocr-warning-badge" title={ocrWarning || "OCR not available"}>
                ⚠ OCR Off
              </span>
            )}
            {ocrAvailable && (
              <button
                className="reprocess-all-btn"
                onClick={reprocessAllFailed}
                disabled={reprocessingCount !== null}
                title="Reprocess screenshots with failed or missing OCR"
              >
                {reprocessingCount !== null ? `Processing…` : "Reprocess All"}
              </button>
            )}

            {/* Theme toggle */}
            <button
              className="icon-btn theme-toggle"
              onClick={toggleTheme}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              id="theme-toggle-btn"
            >
              {theme === 'dark' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5"/>
                  <line x1="12" y1="1" x2="12" y2="3"/>
                  <line x1="12" y1="21" x2="12" y2="23"/>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                  <line x1="1" y1="12" x2="3" y2="12"/>
                  <line x1="21" y1="12" x2="23" y2="12"/>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                </svg>
              )}
            </button>

            {/* Settings */}
            <button
              className="icon-btn settings-btn"
              onClick={openSettings}
              title="Settings"
              id="settings-btn"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          </div>
        </header>
      )}

      {/* OCR warning banner */}
      {!isOverlay && !ocrAvailable && ocrWarning && (
        <div className="warning-banner">
          <span className="warning-icon">⚠</span>
          <span className="warning-text">{ocrWarning}</span>
          <button
            className="warning-dismiss"
            onClick={() => setOcrWarning(null)}
            title="Dismiss"
          >✕</button>
        </div>
      )}

      {/* ── Page content ── */}
      <div className="page-content">

        {/* Overlay search bar */}
        {isOverlay && (
          <div className="header-search" style={{ marginBottom: "1rem", maxWidth: "100%" }}>
            <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              autoFocus
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search screenshots…"
            />
            {searchQuery && (
              <button className="search-clear" onClick={() => setSearchQuery("")}>✕</button>
            )}
          </div>
        )}



        {/* ── Secondary Toolbar (Sort & Filter) ── */}
        <div className="view-controls">
          <div className="view-controls-left">
            {/* We could put title or stats here */}
          </div>
          <div className="view-controls-right">
            <div className="header-filters">
              <select
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as "newest" | "oldest")}
                className="filter-select"
              >
                <option value="newest">Newest First</option>
                <option value="oldest">Oldest First</option>
              </select>
              <select
                value={filterMode}
                onChange={(e) => setFilterMode(e.target.value as "all" | "has_text" | "no_text" | "favorites")}
                className="filter-select"
              >
                <option value="all">All Screenshots</option>
                <option value="has_text">Searchable (Has Text)</option>
                <option value="no_text">No Text / OCR Failed</option>
                <option value="favorites">Wishlist (Favorites)</option>
              </select>
              <button
                className={`wishlist-btn ${filterMode === 'favorites' ? 'active' : ''}`}
                onClick={() => setFilterMode(filterMode === 'favorites' ? 'all' : 'favorites')}
                title={filterMode === 'favorites' ? 'Show all screenshots' : 'Show Wishlist (Favorites)'}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill={filterMode === 'favorites' ? 'currentColor' : 'none'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                </svg>
                Wishlist
              </button>
            </div>
          </div>
        </div>

        {/* Search results header */}
        {isSearching && (
          <div className="results-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
            <span>
              <strong>{screenshots.length}</strong> result{screenshots.length !== 1 ? "s" : ""} for
              &nbsp;"<strong>{debouncedQuery}</strong>"
            </span>
          </div>
        )}

        {/* Empty state */}
        {screenshots.length === 0 && (
          <div className="screenshot-grid">
            <div className="empty-state">
              <div className="empty-icon-wrap">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </div>
              <p className="empty-title">
                {isSearching ? "No results found" : "No screenshots yet"}
              </p>
              <p className="empty-sub">
                {isSearching
                  ? `Nothing matched "${debouncedQuery}". Try a different term.`
                  : "Screenshots saved to your folder will appear here automatically."}
              </p>
            </div>
          </div>
        )}

        {/* Grouped main view */}
        {grouped && screenshots.length > 0 &&
          Object.entries(grouped).map(([group, items]) =>
            items.length > 0 ? (
              <div key={group} className="time-group">
                <div className="time-header">
                  <span className="time-label">{group}</span>
                  <div className="time-divider" />
                </div>
                <div className="screenshot-grid">
                  {items.map((s) => (
                    <ScreenshotCard
                      key={s.id}
                      screenshot={s}
                      onOpen={() => openPreviewFromPath(s.path)}
                      onCopy={() => copyToClipboard(s.path)}
                      onReveal={() => revealInExplorer(s.path)}
                      onContextMenu={(e) => handleContextMenu(e, s)}
                      onToggleFavorite={(e) => handleToggleFavorite(e, s)}
                      regionRefreshTrigger={regionRefreshTrigger}
                    />
                  ))}
                </div>
              </div>
            ) : null
          )
        }

        {/* Flat list (search results or overlay) */}
        {!grouped && screenshots.length > 0 && (
          <>
            <div className={isOverlay ? "screenshot-grid overlay-grid" : "screenshot-grid"}>
              {screenshots.map((s) => (
                <ScreenshotCard
                  key={s.id}
                  screenshot={s}
                  onOpen={() => invoke("open_screenshot", { path: s.path })}
                  onCopy={() => copyToClipboard(s.path)}
                  onReveal={() => invoke("reveal_in_explorer", { path: s.path })}
                  onContextMenu={(e) => handleContextMenu(e, s)}
                  onToggleFavorite={(e) => handleToggleFavorite(e, s)}
                  regionRefreshTrigger={regionRefreshTrigger}
                />
              ))}
            </div>

            {/* Load More button */}
            {hasMore && !isOverlay && (
              <div className="load-more-container">
                <button
                  className="load-more-btn"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Load More"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => openScreenshot(contextMenu.screenshot.path)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            Open
          </button>
          <button onClick={() => copyToClipboard(contextMenu.screenshot.path)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Copy Image
          </button>
          <button onClick={() => revealInExplorer(contextMenu.screenshot.path)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            Show in Explorer
          </button>
          {ocrAvailable && contextMenu.screenshot.ocr_status !== "done" && (
            <button onClick={() => reprocessScreenshot(contextMenu.screenshot.id)} className="reprocess-btn">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              Reprocess OCR
            </button>
          )}
        </div>
      )}

      {/* Settings Dialog */}
      {showSettings && (
        <div className="dialog-overlay" onClick={() => setShowSettings(false)}>
          <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h2>Settings</h2>
              <button className="dialog-close" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <div className="dialog-body">
              <div className="form-group">
                <label>Screenshot Folder</label>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={settingsFolder}
                    readOnly
                    placeholder="Select a folder..."
                    style={{ flex: 1, backgroundColor: 'var(--surface-raised)', cursor: 'not-allowed' }}
                  />
                  <button 
                    className="secondary"
                    onClick={async () => {
                      try {
                        const selected = await open({
                          directory: true,
                          multiple: false,
                        });
                        if (selected && typeof selected === 'string') {
                          setSettingsFolder(selected);
                        }
                      } catch (err) {
                        console.error("Failed to open dialog", err);
                      }
                    }}
                  >
                    Browse...
                  </button>
                </div>
                <p className="form-hint">
                  This folder will be watched for new screenshots.
                </p>
              </div>

              <div className="form-group">
                <label>Watched Folders</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem', background: 'var(--surface-raised)', borderRadius: 'var(--r-sm)' }}>
                    <span>{folder || "Not set"}</span>
                    <span style={{ color: 'var(--tx-muted)', fontSize: '0.875rem' }}>Primary</span>
                  </div>
                  {watchFolders.map(wf => (
                    <div key={wf} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem', background: 'var(--surface-raised)', borderRadius: 'var(--r-sm)' }}>
                      <span>{wf}</span>
                      <button 
                        onClick={() => handleRemoveWatchFolder(wf)}
                        style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer' }}
                      >Remove</button>
                    </div>
                  ))}
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <button 
                    className="secondary"
                    style={{ width: '100%' }}
                    onClick={async () => {
                      try {
                        const selected = await open({
                          directory: true,
                          multiple: false,
                        });
                        if (selected && typeof selected === 'string') {
                          handleAddWatchFolder(selected);
                        }
                      } catch (err) {
                        console.error("Failed to open dialog", err);
                      }
                    }}
                  >
                    + Add Watched Folder...
                  </button>
                  {watchFolderError && (
                    <div style={{ color: '#ef4444', fontSize: '0.875rem' }}>{watchFolderError}</div>
                  )}
                </div>
              </div>

              <div className="form-group checkbox" style={{ marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={settingsAutoStart}
                    onChange={(e) => setSettingsAutoStart(e.target.checked)}
                  />
                  Launch Kaptur on startup
                </label>
              </div>

              <div className="form-group" style={{ marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                <label>Bulk Export</label>
                <p className="form-hint" style={{ marginBottom: '1rem' }}>
                  Export your entire vault (original images + OCR text + metadata) as a ZIP file.
                </p>
                <button
                  className="primary"
                  style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem' }}
                  onClick={async (e) => {
                    const btn = e.currentTarget;
                    const originalText = btn.innerHTML;
                    btn.innerHTML = 'Exporting... (May take a while)';
                    btn.disabled = true;
                    try {
                      const path = await invoke<string>("export_vault");
                      alert(`Export successful! Saved to:\n${path}`);
                    } catch (err: any) {
                      alert(`Export failed: ${err.toString()}`);
                    } finally {
                      btn.innerHTML = originalText;
                      btn.disabled = false;
                    }
                  }}
                >
                  Export Vault to Downloads
                </button>
              </div>

              <div className="form-group" style={{ marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                <label>About & Feedback</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
                  <button
                    className="secondary"
                    style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem' }}
                    onClick={() => openUrl('https://github.com/ankitpanwar070798/Kaptur')}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                    </svg>
                    View Source on GitHub
                  </button>

                  <button
                    className="secondary"
                    style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem' }}
                    onClick={() => openUrl('https://github.com/ankitpanwar070798')}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                    </svg>
                    Leave Feedback on GitHub
                  </button>
                  
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.25rem', fontSize: '0.875rem', color: 'var(--tx-muted)' }}>
                    <span>Created by</span>
                    <a 
                      href="#" 
                      onClick={(e) => { e.preventDefault(); openUrl('https://ankitpanwar.dev'); }}
                      style={{ color: 'var(--mark)', textDecoration: 'none', fontWeight: 500 }}
                    >
                      Ankit Panwar
                    </a>
                  </div>
                </div>
              </div>
            </div>
            <div className="dialog-footer">
              <button className="secondary" onClick={() => setShowSettings(false)}>
                Cancel
              </button>
              <button className="primary" onClick={saveSettings}>
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}


      {/* Preview Modal */}
      <PreviewModal
        screenshot={previewImage}
        regions={previewRegions}
        annotations={previewAnnotations}
        imageSrc={previewSrc}
        onClose={closePreviewModal}
        onDismissRegion={handleDeleteRegion}
        onDeleteRegion={handleDeleteRegion}
        onAddRegion={handleAddRegion}
        onUpdateRegion={handleUpdateRegion}
        onOpenInDefaultViewer={(path) => invoke("open_screenshot", { path })}
        onRevealInExplorer={revealInExplorer}
        onCopy={(path, protectedCopy) => copyToClipboard(path, protectedCopy)}
        showWarning={showDefaultViewerWarning}
        warningShown={openInDefaultViewerWarningShown}
        fadingRegions={fadingRegions}
        selectedTool={selectedTool}
        setSelectedTool={setSelectedTool}
        selectedColor={selectedColor}
        setSelectedColor={setSelectedColor}
        undoStack={undoStack}
        onUndo={handleUndoAnnotation}
        onAddAnnotation={handleAddAnnotation}
      />
    </div>
    );
  } // end of else

  return (
    <>
      {content}
    </>
  );
}

export default App;

