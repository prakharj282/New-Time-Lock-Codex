import { useEffect, useRef, useCallback } from 'react';

interface CanvasContentViewerProps {
  content: string;
}

const FONT_SIZE = 16;
const LINE_HEIGHT = 1.6;
const PADDING = 16;
const FONT_FAMILY = "'Inter', system-ui, -apple-system, sans-serif";
const TEXT_COLOR = '#f8fafc';
const BG_COLOR = 'rgba(0, 0, 0, 0.2)';
const BADGE_BG = 'rgba(59, 130, 246, 0.1)';
const BADGE_BORDER = 'rgba(59, 130, 246, 0.2)';
const BADGE_TEXT = '#60a5fa';
const BADGE_HEIGHT = 36;
const BADGE_MARGIN_TOP = 12;

function splitLongWord(ctx: CanvasRenderingContext2D, word: string, maxWidth: number): string[] {
  const segments: string[] = [];
  let current = '';
  for (let i = 0; i < word.length; i++) {
    const test = current + word[i];
    if (ctx.measureText(test).width > maxWidth && current.length > 0) {
      segments.push(current);
      current = word[i];
    } else {
      current = test;
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const paragraphs = text.split('\n');
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }

    const words = paragraph.split(/(\s+)/);
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine + word;
      const metrics = ctx.measureText(testLine);

      if (metrics.width > maxWidth && currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = word.trimStart();
      } else {
        currentLine = testLine;
      }

      if (currentLine.length > 0 && ctx.measureText(currentLine).width > maxWidth) {
        const parts = splitLongWord(ctx, currentLine, maxWidth);
        for (let i = 0; i < parts.length - 1; i++) {
          lines.push(parts[i]);
        }
        currentLine = parts[parts.length - 1];
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
    }
  }

  return lines;
}

export function CanvasContentViewer({ content }: CanvasContentViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const containerWidth = container.clientWidth;
    const drawWidth = containerWidth;
    const textAreaWidth = drawWidth - PADDING * 2;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.font = `400 ${FONT_SIZE}px ${FONT_FAMILY}`;
    const lines = wrapText(ctx, content, textAreaWidth);

    const lineHeightPx = FONT_SIZE * LINE_HEIGHT;
    const textBlockHeight = lines.length * lineHeightPx;
    const totalHeight = PADDING + textBlockHeight + BADGE_MARGIN_TOP + BADGE_HEIGHT + PADDING;

    canvas.width = drawWidth * dpr;
    canvas.height = totalHeight * dpr;
    canvas.style.width = `${drawWidth}px`;
    canvas.style.height = `${totalHeight}px`;

    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, drawWidth, totalHeight);

    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, drawWidth, totalHeight);

    ctx.font = `400 ${FONT_SIZE}px ${FONT_FAMILY}`;
    ctx.fillStyle = TEXT_COLOR;
    ctx.textBaseline = 'top';

    let y = PADDING;
    for (const line of lines) {
      ctx.fillText(line, PADDING, y + (lineHeightPx - FONT_SIZE) / 2);
      y += lineHeightPx;
    }

    const badgeY = PADDING + textBlockHeight + BADGE_MARGIN_TOP;
    const badgeText = '🔒 Content is view-only and copy-protected';
    const badgeFontSize = 12;
    ctx.font = `400 ${badgeFontSize}px ${FONT_FAMILY}`;
    const badgeTextWidth = ctx.measureText(badgeText).width;
    const badgePadH = 12;
    const rawBadgeW = badgeTextWidth + badgePadH * 2;
    const maxBadgeW = drawWidth - PADDING * 2;
    const badgeW = Math.min(rawBadgeW, maxBadgeW);
    const badgeX = Math.max(PADDING, (drawWidth - badgeW) / 2);

    ctx.fillStyle = BADGE_BG;
    ctx.strokeStyle = BADGE_BORDER;
    ctx.lineWidth = 1;
    roundRect(ctx, badgeX, badgeY, badgeW, BADGE_HEIGHT, 6);

    ctx.fillStyle = BADGE_TEXT;
    ctx.textBaseline = 'middle';
    ctx.fillText(badgeText, badgeX + badgePadH, badgeY + BADGE_HEIGHT / 2);
  }, [content]);

  useEffect(() => {
    draw();

    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver(() => {
      draw();
    });
    ro.observe(container);

    document.fonts?.ready.then(() => {
      draw();
    });

    return () => {
      ro.disconnect();
    };
  }, [draw]);

  const preventActions = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
  }, []);

  return (
    <div
      ref={containerRef}
      className="canvas-content-viewer"
      onContextMenu={preventActions}
      onDragStart={preventActions}
    >
      <canvas
        ref={canvasRef}
        className="canvas-content-canvas"
        onContextMenu={preventActions}
        onDragStart={preventActions}
      />
    </div>
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}
