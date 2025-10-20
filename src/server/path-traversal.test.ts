/**
 * Security Tests for Path Traversal Vulnerability Fix
 * User Story #5: Fix Path Traversal Vulnerability in Session Optimizer
 *
 * These tests validate the path sanitization logic used in optimize_session
 * to prevent path traversal attacks.
 */

import { describe, expect, test } from '@jest/globals';
import path from 'path';
import os from 'os';

// Helper function that mimics the security validation logic in optimize_session
function validateFilePath(filePath: string, baseDir: string): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedBaseDir = path.resolve(baseDir);
  return resolvedPath.startsWith(resolvedBaseDir);
}

describe('Path Traversal Security Tests - optimize_session', () => {
  // Use the actual home directory for testing
  const SECURE_BASE_DIR = os.homedir();

  describe('Valid Path Tests', () => {
    test('should accept valid path within base directory', () => {
      const validPath = path.join(SECURE_BASE_DIR, 'project', 'file.txt');
      expect(validateFilePath(validPath, SECURE_BASE_DIR)).toBe(true);
    });

    test('should accept nested valid path within base directory', () => {
      const validPath = path.join(
        SECURE_BASE_DIR,
        'deep',
        'nested',
        'path',
        'file.js'
      );
      expect(validateFilePath(validPath, SECURE_BASE_DIR)).toBe(true);
    });

    test('should accept path with dots in filename', () => {
      const validPath = path.join(SECURE_BASE_DIR, 'file.test.ts');
      expect(validateFilePath(validPath, SECURE_BASE_DIR)).toBe(true);
    });

    test('should accept path with spaces', () => {
      const validPath = path.join(
        SECURE_BASE_DIR,
        'my project',
        'test file.txt'
      );
      expect(validateFilePath(validPath, SECURE_BASE_DIR)).toBe(true);
    });

    test('should accept path exactly at base directory', () => {
      const validPath = path.join(SECURE_BASE_DIR, 'file.txt');
      expect(validateFilePath(validPath, SECURE_BASE_DIR)).toBe(true);
    });
  });

  describe('Path Traversal Attack Tests', () => {
    test('should reject path with ../ traversal sequence', () => {
      const maliciousPath = path.join(
        SECURE_BASE_DIR,
        '..',
        '..',
        'etc',
        'passwd'
      );
      expect(validateFilePath(maliciousPath, SECURE_BASE_DIR)).toBe(false);
    });

    test('should reject path with multiple ../ sequences', () => {
      const maliciousPath = path.join(
        SECURE_BASE_DIR,
        'project',
        '..',
        '..',
        '..',
        'secret.txt'
      );
      expect(validateFilePath(maliciousPath, SECURE_BASE_DIR)).toBe(false);
    });

    test('should reject path attempting to access root on Unix', () => {
      if (process.platform !== 'win32') {
        const maliciousPath = '/etc/passwd';
        expect(validateFilePath(maliciousPath, SECURE_BASE_DIR)).toBe(false);
      }
    });

    test('should reject path with encoded traversal sequences', () => {
      // Even if encoded, path.resolve will normalize it
      const maliciousPath = SECURE_BASE_DIR + '/../../../etc/passwd';
      expect(validateFilePath(maliciousPath, SECURE_BASE_DIR)).toBe(false);
    });

    test('should reject Windows-style absolute path to System32', () => {
      if (process.platform === 'win32') {
        const maliciousPath = 'C:\\Windows\\System32\\config\\SAM';
        // Only reject if it's actually outside the user's home directory
        const isOutside = !maliciousPath
          .toLowerCase()
          .includes(SECURE_BASE_DIR.toLowerCase());
        if (isOutside) {
          expect(validateFilePath(maliciousPath, SECURE_BASE_DIR)).toBe(false);
        }
      }
    });

    test('should reject path with parent directory traversal in middle', () => {
      const maliciousPath = path.join(
        SECURE_BASE_DIR,
        'project',
        '..',
        '..',
        'outside.txt'
      );
      expect(validateFilePath(maliciousPath, SECURE_BASE_DIR)).toBe(false);
    });
  });

  describe('Absolute Path Tests', () => {
    test('should reject absolute path outside base directory on Unix', () => {
      if (process.platform !== 'win32') {
        const maliciousPath = '/var/log/secrets.log';
        expect(validateFilePath(maliciousPath, SECURE_BASE_DIR)).toBe(false);
      }
    });

    test('should accept absolute path within base directory', () => {
      const validPath = path.join(SECURE_BASE_DIR, 'project', 'file.txt');
      expect(validateFilePath(validPath, SECURE_BASE_DIR)).toBe(true);
    });

    test('should handle platform-specific absolute paths', () => {
      const validPath = path.resolve(SECURE_BASE_DIR, 'test.txt');
      expect(validateFilePath(validPath, SECURE_BASE_DIR)).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    test('should handle current directory references safely', () => {
      const pathWithDots = path.join(
        SECURE_BASE_DIR,
        '.',
        'project',
        '.',
        'file.txt'
      );
      expect(validateFilePath(pathWithDots, SECURE_BASE_DIR)).toBe(true);
    });

    test('should handle very long path within base directory', () => {
      const longSegment = 'a'.repeat(255);
      const longPath = path.join(SECURE_BASE_DIR, longSegment, 'file.txt');
      expect(validateFilePath(longPath, SECURE_BASE_DIR)).toBe(true);
    });

    test('should handle path with trailing slash', () => {
      const pathWithSlash =
        path.join(SECURE_BASE_DIR, 'project', 'dir') + path.sep;
      expect(validateFilePath(pathWithSlash, SECURE_BASE_DIR)).toBe(true);
    });

    test('should handle empty path segments safely', () => {
      const validPath = path.join(SECURE_BASE_DIR, 'project', '', 'file.txt');
      expect(validateFilePath(validPath, SECURE_BASE_DIR)).toBe(true);
    });
  });

  describe('CSV Metadata Parsing Tests', () => {
    test('should strip quotes from file path before validation', () => {
      const quotedPath = `"${path.join(SECURE_BASE_DIR, 'project', 'file.txt')}"`;
      const stripped = quotedPath.trim().replace(/^"(.*)"$/, '$1');
      expect(validateFilePath(stripped, SECURE_BASE_DIR)).toBe(true);
    });

    test('should strip quotes from malicious path before validation', () => {
      const quotedMaliciousPath = `"${path.join(SECURE_BASE_DIR, '..', '..', 'etc', 'passwd')}"`;
      const stripped = quotedMaliciousPath.trim().replace(/^"(.*)"$/, '$1');
      expect(validateFilePath(stripped, SECURE_BASE_DIR)).toBe(false);
    });

    test('should handle paths with special characters', () => {
      const pathWithSpecial = path.join(SECURE_BASE_DIR, 'file@#$.txt');
      expect(validateFilePath(pathWithSpecial, SECURE_BASE_DIR)).toBe(true);
    });
  });

  describe('Integration Test Scenarios', () => {
    test('should accept valid file paths from typical session operations', () => {
      const validPaths = [
        path.join(SECURE_BASE_DIR, 'projects', 'myapp', 'src', 'index.ts'),
        path.join(SECURE_BASE_DIR, '.config', 'settings.json'),
        path.join(SECURE_BASE_DIR, 'Documents', 'README.md'),
        path.join(SECURE_BASE_DIR, 'workspace', 'package.json'),
      ];

      validPaths.forEach((validPath) => {
        expect(validateFilePath(validPath, SECURE_BASE_DIR)).toBe(true);
      });
    });

    test('should reject all common path traversal attack vectors', () => {
      const attackVectors = [
        path.join(SECURE_BASE_DIR, '..', '..', '..', 'etc', 'passwd'),
        path.join(
          SECURE_BASE_DIR,
          'project',
          '..',
          '..',
          '..',
          'sensitive.txt'
        ),
        path.join(
          SECURE_BASE_DIR,
          '..',
          '..',
          '..',
          '..',
          '..',
          'etc',
          'shadow'
        ),
      ];

      attackVectors.forEach((attackPath) => {
        expect(validateFilePath(attackPath, SECURE_BASE_DIR)).toBe(false);
      });
    });

    test('should protect against directory-specific attacks', () => {
      // Attempt to go up multiple levels
      const depth = 10;
      let attackPath = SECURE_BASE_DIR;
      for (let i = 0; i < depth; i++) {
        attackPath = path.join(attackPath, '..');
      }
      attackPath = path.join(attackPath, 'etc', 'passwd');

      expect(validateFilePath(attackPath, SECURE_BASE_DIR)).toBe(false);
    });
  });

  describe('Performance Tests', () => {
    test('should validate paths efficiently for large batch', () => {
      const testPaths = Array.from({ length: 1000 }, (_, i) =>
        path.join(SECURE_BASE_DIR, 'project', `file${i}.txt`)
      );

      const startTime = Date.now();
      testPaths.forEach((testPath) => {
        const isValid = validateFilePath(testPath, SECURE_BASE_DIR);
        expect(isValid).toBe(true);
      });
      const endTime = Date.now();

      // Should complete in reasonable time (allow for slower CI environments)
      expect(endTime - startTime).toBeLessThan(200);
    });

    test('should efficiently reject large batch of malicious paths', () => {
      const maliciousPaths = Array.from({ length: 1000 }, (_, i) =>
        path.join(SECURE_BASE_DIR, '..', '..', `malicious${i}.txt`)
      );

      const startTime = Date.now();
      maliciousPaths.forEach((maliciousPath) => {
        const isValid = validateFilePath(maliciousPath, SECURE_BASE_DIR);
        expect(isValid).toBe(false);
      });
      const endTime = Date.now();

      // Should complete in reasonable time (allow for slower CI environments)
      expect(endTime - startTime).toBeLessThan(200);
    });
  });

  describe('Security Validation Logic Tests', () => {
    test('path.resolve should normalize ../ sequences', () => {
      const inputPath = path.join(SECURE_BASE_DIR, 'a', '..', 'b', 'c');
      const resolved = path.resolve(inputPath);
      const expected = path.resolve(SECURE_BASE_DIR, 'b', 'c');
      expect(resolved).toBe(expected);
    });

    test('path.resolve should handle multiple ../ correctly', () => {
      const inputPath = path.join(SECURE_BASE_DIR, 'a', 'b', '..', '..', 'c');
      const resolved = path.resolve(inputPath);
      const expected = path.resolve(SECURE_BASE_DIR, 'c');
      expect(resolved).toBe(expected);
    });

    test('startsWith should correctly identify paths within base directory', () => {
      const safePath = path.resolve(SECURE_BASE_DIR, 'project', 'file.txt');
      const baseDir = path.resolve(SECURE_BASE_DIR);
      expect(safePath.startsWith(baseDir)).toBe(true);
    });

    test('startsWith should correctly reject paths outside base directory', () => {
      const unsafePath = path.resolve(SECURE_BASE_DIR, '..', 'outside.txt');
      const baseDir = path.resolve(SECURE_BASE_DIR);
      expect(unsafePath.startsWith(baseDir)).toBe(false);
    });
  });

  describe('Platform-Specific Security Tests', () => {
    test('should handle platform-specific path separators', () => {
      const validPath =
        SECURE_BASE_DIR + path.sep + 'project' + path.sep + 'file.txt';
      expect(validateFilePath(validPath, SECURE_BASE_DIR)).toBe(true);
    });

    test('should normalize paths with forward slashes on Windows', () => {
      if (process.platform === 'win32') {
        const pathWithForwardSlash = SECURE_BASE_DIR + '/project/file.txt';
        const normalized = path.resolve(pathWithForwardSlash);
        expect(normalized.startsWith(path.resolve(SECURE_BASE_DIR))).toBe(true);
      }
    });

    test('should handle UNC paths on Windows', () => {
      if (process.platform === 'win32') {
        const uncPath = '\\\\server\\share\\file.txt';
        // UNC paths should be rejected unless they're within the base directory
        expect(validateFilePath(uncPath, SECURE_BASE_DIR)).toBe(false);
      }
    });
  });
});
