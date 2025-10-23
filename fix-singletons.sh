#!/bin/bash

FILES=(
  "src/tools/intelligence/intelligent-assistant.ts"
  "src/tools/intelligence/natural-language-query.ts"
  "src/tools/intelligence/pattern-recognition.ts"
  "src/tools/intelligence/predictive-analytics.ts"
  "src/tools/intelligence/recommendation-engine.ts"
  "src/tools/intelligence/smart-summarization.ts"
)

for file in "${FILES[@]}"; do
  # Extract the function name pattern
  basename=$(basename "$file" .ts)
  # Convert kebab-case to PascalCase for class name
  classname=$(echo "$basename" | sed -r 's/(^|-)([a-z])/\U\2/g')
  # Convert kebab-case to camelCase for function name
  funcname=$(echo "$basename" | sed -r 's/-([a-z])/\U\1/g')
  funcname="run${funcname^}"
  
  # Use awk to insert the singleton pattern before the export async function
  awk -v funcname="$funcname" -v classname="$classname" '
    /^export async function/ {
      print "// Shared instances for caching and metrics"
      print "const sharedCache = new CacheEngine();"
      print "const sharedTokenCounter = new TokenCounter();"
      print "const sharedMetricsCollector = new MetricsCollector();"
      print ""
    }
    {
      if (/const cache = new CacheEngine/) {
        next
      } else if (/const tokenCounter = new TokenCounter/) {
        next
      } else if (/const metricsCollector = new MetricsCollector/) {
        next
      } else if (/const tool = new/) {
        print "  const tool = new " classname "(sharedCache, sharedTokenCounter, sharedMetricsCollector);"
        next
      }
      print
    }
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  
  echo "Fixed singleton pattern in $file"
done
