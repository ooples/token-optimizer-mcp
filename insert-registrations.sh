#!/bin/bash

# 1. Find the last import from '../tools/' and insert imports after it
LAST_IMPORT_LINE=$(grep -n "from '../tools/" src/server/index.ts | tail -1 | cut -d: -f1)
echo "Last import at line: $LAST_IMPORT_LINE"

# Insert imports
head -n $LAST_IMPORT_LINE src/server/index.ts > src/server/index.ts.new
cat generated-imports.txt >> src/server/index.ts.new
tail -n +$((LAST_IMPORT_LINE + 1)) src/server/index.ts >> src/server/index.ts.new
mv src/server/index.ts.new src/server/index.ts

echo "Inserted imports"

# 2. Find the location in tools array (after last TOOL_DEFINITION)
LAST_TOOL_DEF_LINE=$(grep -n "TOOL_DEFINITION," src/server/index.ts | tail -1 | cut -d: -f1)
echo "Last tool def at line: $LAST_TOOL_DEF_LINE"

# Insert definitions
head -n $LAST_TOOL_DEF_LINE src/server/index.ts > src/server/index.ts.new
cat generated-definitions.txt >> src/server/index.ts.new
tail -n +$((LAST_TOOL_DEF_LINE + 1)) src/server/index.ts >> src/server/index.ts.new
mv src/server/index.ts.new src/server/index.ts

echo "Inserted definitions"

# 3. Find 'default:' in the switch statement
DEFAULT_LINE=$(grep -n "^      default:" src/server/index.ts | tail -1 | cut -d: -f1)
echo "Default case at line: $DEFAULT_LINE"

# Insert cases before default
head -n $((DEFAULT_LINE - 1)) src/server/index.ts > src/server/index.ts.new
cat generated-cases.txt >> src/server/index.ts.new
tail -n +$DEFAULT_LINE src/server/index.ts >> src/server/index.ts.new
mv src/server/index.ts.new src/server/index.ts

echo "Inserted case statements"
echo "Done! All 34 tools registered."
