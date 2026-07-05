import { describe, expect, test, vi } from 'vitest';
import {
  compressPhotoFile,
  getImageJsonByteLength,
  getResizedDimensions,
  PHOTO_MAX_DIMENSION,
  PHOTO_TARGET_BYTES,
} from '../../src/utils/photo';

function imageFile(size = 1024, type = 'image/jpeg') {
  return new File([new Uint8Array(size)], 'photo.jpg', { type });
}

describe('photo compression helpers', () => {
  test('calculates resized dimensions within the max side length', () => {
    expect(getResizedDimensions(4000, 3000)).toEqual({ width: PHOTO_MAX_DIMENSION, height: 1200 });
    expect(getResizedDimensions(900, 600)).toEqual({ width: 900, height: 600 });
  });

  test('compresses an image file and reports payload size', async () => {
    const dataUrl = `data:image/jpeg;base64,${'a'.repeat(10_000)}`;
    const result = await compressPhotoFile(imageFile(5_000), {
      decodeImage: vi.fn(async () => ({ width: 4000, height: 3000, source: {} as CanvasImageSource })),
      encodeImage: vi.fn(async (_image, width, height, quality) => {
        expect(width).toBe(1600);
        expect(height).toBe(1200);
        expect(quality).toBe(0.75);
        return dataUrl;
      }),
    });

    expect(result.dataUrl).toBe(dataUrl);
    expect(result.originalBytes).toBe(5_000);
    expect(result.compressedBytes).toBe(getImageJsonByteLength(dataUrl));
    expect(result.compressedBytes).toBeLessThan(PHOTO_TARGET_BYTES);
  });

  test('rejects non-image files', async () => {
    await expect(
      compressPhotoFile(new File(['not an image'], 'note.txt', { type: 'text/plain' }), {
        decodeImage: vi.fn(),
        encodeImage: vi.fn(),
      })
    ).rejects.toThrow('Please choose an image file.');
  });

  test('rejects compressed images that still exceed the Vercel-safe target', async () => {
    await expect(
      compressPhotoFile(imageFile(10_000), {
        decodeImage: vi.fn(async () => ({ width: 3000, height: 2000, source: {} as CanvasImageSource })),
        encodeImage: vi.fn(async () => `data:image/jpeg;base64,${'a'.repeat(PHOTO_TARGET_BYTES + 1)}`),
      })
    ).rejects.toThrow('Photo is too large for Vercel');
  });

  test('returns a clear error when an image cannot be decoded', async () => {
    await expect(
      compressPhotoFile(imageFile(10_000), {
        decodeImage: vi.fn(async () => {
          throw new Error('Could not read image file.');
        }),
        encodeImage: vi.fn(),
      })
    ).rejects.toThrow('Could not read image file.');
  });
});
