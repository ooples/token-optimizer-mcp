import { brotliCompressSync, brotliDecompressSync, constants } from 'zlib';

export interface CompressionResult {
  compressed: Buffer;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  percentSaved: number;
}

export interface CompressionOptions {
  quality?: number; // 0-11, default 11 (max compression)
  mode?: 'text' | 'font' | 'generic';
}

export class CompressionEngine {
  private readonly DEFAULT_QUALITY = 11;

  /**
   * Compress text using Brotli
   */
  compress(text: string, options?: CompressionOptions): CompressionResult {
    const buffer = Buffer.from(text, 'utf-8');
    const quality = options?.quality ?? this.DEFAULT_QUALITY;
    const mode = this.getModeConstant(options?.mode);

    const compressed = brotliCompressSync(buffer, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: quality,
        [constants.BROTLI_PARAM_MODE]: mode,
      },
    });

    const originalSize = buffer.length;
    const compressedSize = compressed.length;
    const ratio = originalSize > 0 ? compressedSize / originalSize : 0;
    const percentSaved =
      originalSize > 0
        ? ((originalSize - compressedSize) / originalSize) * 100
        : 0;

    return {
      compressed,
      originalSize,
      compressedSize,
      ratio,
      percentSaved,
    };
  }

  /**
   * Decompress Brotli-compressed data
   */
  decompress(compressed: Buffer): string {
    const decompressed = brotliDecompressSync(compressed);
    return decompressed.toString('utf-8');
  }

  /**
   * Compress to base64 string (for easier storage)
   */
  compressToBase64(
    text: string,
    options?: CompressionOptions
  ): {
    compressed: string;
    originalSize: number;
    compressedSize: number;
    ratio: number;
    percentSaved: number;
  } {
    const result = this.compress(text, options);

    return {
      compressed: result.compressed.toString('base64'),
      originalSize: result.originalSize,
      compressedSize: result.compressedSize,
      ratio: result.ratio,
      percentSaved: result.percentSaved,
    };
  }

  /**
   * Decompress from base64 string
   */
  decompressFromBase64(compressed: string): string {
    const buffer = Buffer.from(compressed, 'base64');
    return this.decompress(buffer);
  }

  /**
   * Check if compression would be beneficial
   */
  shouldCompress(text: string, minSize: number = 1000): boolean {
    // Don't compress small texts - overhead not worth it
    if (text.length < minSize) {
      return false;
    }

    // Quick sample compression to check ratio
    const sample = text.slice(0, Math.min(text.length, 5000));
    const result = this.compress(sample, { quality: 4 }); // Use lower quality for quick test

    // Only compress if we get at least 20% reduction
    return result.percentSaved >= 20;
  }

  /**
   * Batch compress multiple texts
   */
  compressBatch(
    texts: string[],
    options?: CompressionOptions
  ): Array<{
    index: number;
    compressed: Buffer;
    originalSize: number;
    compressedSize: number;
    ratio: number;
  }> {
    return texts.map((text, index) => {
      const result = this.compress(text, options);
      return {
        index,
        compressed: result.compressed,
        originalSize: result.originalSize,
        compressedSize: result.compressedSize,
        ratio: result.ratio,
      };
    });
  }

  /**
   * Get compression statistics for text
   */
  getCompressionStats(text: string): {
    uncompressed: number;
    compressed: number;
    ratio: number;
    percentSaved: number;
    recommended: boolean;
  } {
    const result = this.compress(text);

    return {
      uncompressed: result.originalSize,
      compressed: result.compressedSize,
      ratio: result.ratio,
      percentSaved: result.percentSaved,
      recommended: this.shouldCompress(text),
    };
  }

  /**
   * Convert mode string to Brotli constant
   */
  private getModeConstant(mode?: 'text' | 'font' | 'generic'): number {
    switch (mode) {
      case 'text':
        return constants.BROTLI_MODE_TEXT;
      case 'font':
        return constants.BROTLI_MODE_FONT;
      default:
        return constants.BROTLI_MODE_GENERIC;
    }
  }
}
