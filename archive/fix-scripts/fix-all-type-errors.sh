#!/bin/bash

# Comprehensive type error fix script
# Fixes 166 type mismatch errors

PROJECT_DIR="C:/Users/yolan/source/repos/token-optimizer-mcp"

echo "Fixing 166 type mismatch errors..."

# Pattern 1: TokenCountResult to number - add .tokens
# Fix: const x = tokenCounter.count(...) where x is number type
# Need to add .tokens at the end

find "$PROJECT_DIR/src" -name "*.ts" -type f -exec sed -i 's/\(= \(this\.\)\?tokenCounter\.count([^)]*)\)$/\1.tokens/g' {} \;
find "$PROJECT_DIR/src" -name "*.ts" -type f -exec sed -i 's/\(= \(this\.\)\?tokenCounter\.count([^)]*)\);$/\1.tokens;/g' {} \;

echo "Pattern 1 complete: TokenCountResult -> number (.tokens added)"

# Pattern 2: Number to string in metrics.recordOperation
# Fix: metrics.recordOperation(name, duration, NUMBER) -> add .toString()

find "$PROJECT_DIR/src" -name "*.ts" -type f -exec sed -i 's/metrics\.recordOperation(\([^,]*\), \([^,]*\), \(inputTokens\|totalTokens\|tokenCount\))/metrics.recordOperation(\1, \2, \3.toString())/g' {} \;
find "$PROJECT_DIR/src" -name "*.ts" -type f -exec sed -i 's/this\.metrics\.recordOperation(\([^,]*\), \([^,]*\), \(inputTokens\|totalTokens\|tokenCount\))/this.metrics.recordOperation(\1, \2, \3.toString())/g' {} \;

echo "Pattern 2 complete: number -> string in metrics.recordOperation"

# Pattern 3: String to Buffer conversion
# Fix: cache.set(key, string) -> cache.set(key, Buffer.from(string, 'utf-8'))
# This is complex and needs manual fixing per file

# Pattern 4: Buffer to string conversion
# Fix: someFunc(buffer) -> someFunc(buffer.toString('utf-8'))
# This also needs manual fixing per file

echo "Basic automated fixes complete. Manual fixes needed for Buffer conversions."
echo "Run: npm run build 2>&1 | grep -c \"error TS\" to check progress"
