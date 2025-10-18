/**
 * Compression utilities for cache storage
 */

import {
  gzipSync,
  gunzipSync,
  brotliCompressSync,
  brotliDecompressSync,
} from 'zlib';

export type CompressionType = 'none' | 'gzip' | 'brotli';

export interface CompressionResult {
  compressed: Buffer;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  type: CompressionType;
}

/**
 * Compress content using the specified algorithm
 */
export function compress(
  content: string | Buffer,
  type: CompressionType = 'gzip'
): CompressionResult {
  const buffer = typeof content === 'string' ? Buffer.from(content) : content;
  const originalSize = buffer.length;

  let compressed: Buffer;

  switch (type) {
    case 'gzip':
      compressed = gzipSync(buffer);
      break;
    case 'brotli':
      compressed = brotliCompressSync(buffer);
      break;
    case 'none':
      compressed = buffer;
      break;
    default:
      throw new Error(`Unknown compression type: ${type}`);
  }

  const compressedSize = compressed.length;
  const ratio = compressedSize / originalSize;

  return {
    compressed,
    originalSize,
    compressedSize,
    ratio,
    type,
  };
}

/**
 * Decompress content
 */
export function decompress(
  compressed: Buffer,
  type: CompressionType = 'gzip'
): Buffer {
  switch (type) {
    case 'gzip':
      return gunzipSync(compressed);
    case 'brotli':
      return brotliDecompressSync(compressed);
    case 'none':
      return compressed;
    default:
      throw new Error(`Unknown compression type: ${type}`);
  }
}

/**
 * Automatically select the best compression based on content
 */
export function compressAuto(content: string | Buffer): CompressionResult {
  const buffer = typeof content === 'string' ? Buffer.from(content) : content;

  // Try both and pick the better one
  const gzipResult = compress(buffer, 'gzip');
  const brotliResult = compress(buffer, 'brotli');

  // Return the one with better compression
  return gzipResult.ratio < brotliResult.ratio ? gzipResult : brotliResult;
}

/**
 * Compress only if it results in meaningful size reduction
 */
export function compressIfWorthwhile(
  content: string | Buffer,
  threshold: number = 0.9 // Only compress if we get at least 10% reduction
): CompressionResult {
  const result = compressAuto(content);

  if (result.ratio < threshold) {
    return result;
  }

  // Not worth compressing, return as-is
  const buffer = typeof content === 'string' ? Buffer.from(content) : content;
  return {
    compressed: buffer,
    originalSize: buffer.length,
    compressedSize: buffer.length,
    ratio: 1,
    type: 'none',
  };
}
