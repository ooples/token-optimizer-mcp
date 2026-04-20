import { brotliCompressSync, brotliDecompressSync, constants } from 'zlib';

export interface CompressionResult {
    compressed: Buffer;
    originalSize: number;
    compressedSize: number;
    ratio: number;
    percentSaved: number;
}

export class CompressionEngine {
    public compress(text: string, options?: { quality?: number; mode?: string; }): CompressionResult {
        const originalSize = Buffer.byteLength(text, 'utf8');
        if (originalSize === 0) {
            return {
                compressed: Buffer.alloc(0),
                originalSize: 0,
                compressedSize: 0,
                ratio: 0,
                percentSaved: 0,
            };
        }

        const params = {
            [constants.BROTLI_PARAM_QUALITY]: options?.quality ?? constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_MODE]: options?.mode === 'text' ? constants.BROTLI_MODE_TEXT : constants.BROTLI_MODE_GENERIC,
        };

        const compressed = brotliCompressSync(text, { params });
        const compressedSize = compressed.length;
        const ratio = compressedSize / originalSize;
        const percentSaved = (1 - ratio) * 100;

        return {
            compressed,
            originalSize,
            compressedSize,
            ratio,
            percentSaved,
        };
    }

    public decompress(buffer: Buffer): string {
        if (!buffer || buffer.length === 0) {
            return '';
        }
        return brotliDecompressSync(buffer).toString('utf8');
    }

    public compressToBase64(text: string, options?: { quality?: number; mode?: string; }): Omit<CompressionResult, 'compressed'> & { compressed: string } {
        const result = this.compress(text, options);
        return {
            originalSize: result.originalSize,
            compressedSize: result.compressedSize,
            ratio: result.ratio,
            percentSaved: result.percentSaved,
            compressed: result.compressed.toString('base64'),
        };
    }

    public decompressFromBase64(base64: string): string {
        const buffer = Buffer.from(base64, 'base64');
        return this.decompress(buffer);
    }

    public compressBatch(texts: string[]): (CompressionResult & { index: number; })[] {
        return texts.map((text, index) => ({
            ...this.compress(text),
            index,
        }));
    }

    public shouldCompress(text: string, minSize: number = 500): boolean {
        if (Buffer.byteLength(text, 'utf8') < minSize) {
            return false;
        }
        const stats = this.getCompressionStats(text);
        return stats.percentSaved >= 20;
    }

    public getCompressionStats(text: string): { uncompressed: number; compressed: number; ratio: number; percentSaved: number; recommended: boolean; } {
        const result = this.compress(text);
        const recommended = result.originalSize >= 500 && result.percentSaved >= 20;
        return {
            uncompressed: result.originalSize,
            compressed: result.compressedSize,
            ratio: result.ratio,
            percentSaved: result.percentSaved,
            recommended: recommended,
        };
    }
}
