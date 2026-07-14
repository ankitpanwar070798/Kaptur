import { invoke } from "@tauri-apps/api/core";
import { startDrag } from "@crabnebula/tauri-plugin-drag";

export const generateProtectedBase64 = (
  imgElement: HTMLImageElement,
  imgDimensions: { width: number; height: number },
  regions: Array<{ id: string; x: number; y: number; width: number; height: number; is_dismissed?: boolean }>,
  annotations: Array<{ tool: string; start_x: number; start_y: number; end_x: number; end_y: number; color: string }> = [],
  fadingRegions?: Set<string>
): string => {
  const canvas = document.createElement('canvas');
  canvas.width = imgDimensions.width;
  canvas.height = imgDimensions.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.drawImage(imgElement, 0, 0, imgDimensions.width, imgDimensions.height);

  for (const region of regions) {
    if (region.is_dismissed || (fadingRegions && fadingRegions.has(region.id))) continue;

    ctx.save();
    ctx.beginPath();
    ctx.rect(region.x, region.y, region.width, region.height);
    ctx.clip();

    ctx.filter = 'blur(14px)';
    const cx = region.x + region.width / 2;
    const cy = region.y + region.height / 2;
    ctx.translate(cx, cy);
    ctx.scale(1.12, 1.12);
    ctx.translate(-cx, -cy);

    ctx.drawImage(imgElement, 0, 0, imgDimensions.width, imgDimensions.height);
    ctx.restore();
  }

  // Draw annotations
  for (const ann of annotations) {
    const sx = ann.start_x;
    const sy = ann.start_y;
    const ex = ann.end_x;
    const ey = ann.end_y;
    const color = ann.color;

    ctx.save();
    if (ann.tool === 'arrow') {
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();

      // Arrowhead
      const dx = ex - sx;
      const dy = ey - sy;
      const angle = Math.atan2(dy, dx);
      const headLen = 14;
      ctx.translate(ex, ey);
      ctx.rotate(angle);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-headLen, headLen / 2);
      ctx.lineTo(-headLen, -headLen / 2);
      ctx.fill();
    } else if (ann.tool === 'box') {
      const left = Math.min(sx, ex);
      const top = Math.min(sy, ey);
      const width = Math.abs(ex - sx);
      const height = Math.abs(ey - sy);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(left, top, width, height);
    } else if (ann.tool === 'highlight') {
      const left = Math.min(sx, ex);
      const top = Math.min(sy, ey);
      const width = Math.abs(ex - sx);
      const height = Math.abs(ey - sy);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(left, top, width, height);
    }
    ctx.restore();
  }

  return canvas.toDataURL('image/png');
};

export const startImageDrag = async (
  screenshotPath: string,
  suggestedName: string,
  regions: Array<any>,
  annotations: Array<any> = []
) => {
  try {
    // 1. Fetch full image base64
    const base64Data = await invoke<string>("read_image_as_base64", { path: screenshotPath });
    
    // 2. Load it into an HTMLImageElement to get intrinsic dimensions
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = base64Data;
    });

    // 3. Render the protected image
    const protectedBase64 = generateProtectedBase64(
      img,
      { width: img.naturalWidth, height: img.naturalHeight },
      regions,
      annotations
    );

    // 4. Send to backend to generate OS temp file
    const tempPath = await invoke<string>("generate_temp_drag_file", {
      imageBase64: protectedBase64,
      suggestedName,
    });

    // 5. Start native drag
    await startDrag({
      item: [tempPath],
      icon: tempPath
    });
  } catch (err) {
    console.error("Failed to start image drag:", err);
  }
};
