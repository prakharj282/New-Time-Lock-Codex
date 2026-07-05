export const PHOTO_MAX_DIMENSION = 1600;
export const PHOTO_JPEG_QUALITY = 0.75;
export const PHOTO_TARGET_BYTES = 2.5 * 1024 * 1024;
export const PHOTO_MAX_INPUT_BYTES = 25 * 1024 * 1024;

export interface CompressedPhoto {
  dataUrl: string;
  originalBytes: number;
  compressedBytes: number;
  width: number;
  height: number;
}

interface ImageInfo {
  width: number;
  height: number;
  source: CanvasImageSource;
  close?: () => void;
}

interface CompressionDeps {
  decodeImage: (file: File) => Promise<ImageInfo>;
  encodeImage: (image: ImageInfo, width: number, height: number, quality: number) => Promise<string>;
}

export function isSupportedImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

export function getUtf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).byteLength;
  }
  return unescape(encodeURIComponent(value)).length;
}

export function getImageJsonByteLength(dataUrl: string): number {
  return getUtf8ByteLength(JSON.stringify({ type: 'image', data: dataUrl }));
}

export function getResizedDimensions(width: number, height: number, maxDimension = PHOTO_MAX_DIMENSION) {
  if (width <= 0 || height <= 0) {
    throw new Error('Invalid image dimensions.');
  }
  const largestSide = Math.max(width, height);
  if (largestSide <= maxDimension) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const scale = maxDimension / largestSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function decodeImage(file: File): Promise<ImageInfo> {
  if ('createImageBitmap' in window) {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        width: bitmap.width,
        height: bitmap.height,
        source: bitmap,
        close: () => bitmap.close(),
      };
    } catch {
      // Fall back for image formats the browser can show but createImageBitmap cannot decode.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read image file.'));
      img.src = objectUrl;
    });
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      source: image,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function encodeImage(image: ImageInfo, width: number, height: number, quality: number): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not prepare image compression.');
  }
  context.drawImage(image.source, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

export async function compressPhotoFile(
  file: File,
  deps: CompressionDeps = { decodeImage, encodeImage }
): Promise<CompressedPhoto> {
  if (!isSupportedImageFile(file)) {
    throw new Error('Please choose an image file.');
  }
  if (file.size > PHOTO_MAX_INPUT_BYTES) {
    throw new Error('Photo is too large. Please retake it at a lower resolution.');
  }

  let image: ImageInfo | null = null;
  try {
    image = await deps.decodeImage(file);
    const dimensions = getResizedDimensions(image.width, image.height);
    const dataUrl = await deps.encodeImage(image, dimensions.width, dimensions.height, PHOTO_JPEG_QUALITY);
    const compressedBytes = getImageJsonByteLength(dataUrl);

    if (compressedBytes > PHOTO_TARGET_BYTES) {
      throw new Error('Photo is too large for Vercel. Retake or choose a smaller image.');
    }

    return {
      dataUrl,
      originalBytes: file.size,
      compressedBytes,
      ...dimensions,
    };
  } catch (err) {
    if (err instanceof Error) {
      throw err;
    }
    throw new Error('Could not compress photo. Please try another image.');
  } finally {
    image?.close?.();
  }
}
