#!/usr/bin/env python3
"""
Auto-register all 38 missing tools in token-optimizer-mcp
"""

import re
from pathlib import Path

# Define all unregistered tools from Gemini analysis
UNREGISTERED_TOOLS = {
    "code-analysis": [
        "smart-ambiance", "smart-complexity", "smart-dependencies",
        "smart-exports", "smart-imports", "smart-refactor",
        "smart-security", "smart-symbols", "smart-typescript"
    ],
    "configuration": [
        "smart-config-read", "smart-env", "smart-package-json",
        "smart-tsconfig", "smart-workflow"
    ],
    "dashboard-monitoring": [
        "performance-tracker", "report-generator", "smart-dashboard"
    ],
    "file-operations": [
        "smart-edit", "smart-glob", "smart-grep", "smart-read", "smart-write"
    ],
    "intelligence": [
        "anomaly-explainer", "auto-remediation", "knowledge-graph", "sentiment-analysis"
    ],
    "output-formatting": [
        "smart-export", "smart-format", "smart-pretty", "smart-report", "smart-stream"
    ],
    "system-operations": [
        "smart-archive", "smart-process", "smart-service"
    ]
}

def kebab_to_pascal(name):
    """Convert kebab-case to PascalCase"""
    return ''.join(word.capitalize() for word in name.split('-'))

def kebab_to_camel(name):
    """Convert kebab-case to camelCase"""
    words = name.split('-')
    return words[0] + ''.join(word.capitalize() for word in words[1:])

def generate_imports(category, tools):
    """Generate import statements for a category"""
    imports = []
    for tool in tools:
        pascal_name = kebab_to_pascal(tool)
        const_name = tool.replace('-', '_').upper()

        # Read the tool file to find the actual export names
        tool_path = Path(f"src/tools/{category}/{tool}.ts")
        if not tool_path.exists():
            print(f"Warning: {tool_path} not found, skipping")
            continue

        content = tool_path.read_text(encoding='utf-8')

        # Try to find the actual export pattern
        # Look for patterns like: export const TOOL_DEFINITION, export { runTool, TOOL_DEF }
        tool_def_match = re.search(r'export const (\w+TOOL(?:_DEFINITION)?)\s*=', content)
        run_func_match = re.search(r'export (?:async )?function (run\w+)', content)

        if not tool_def_match:
            # Try alternate pattern
            tool_def_match = re.search(r'export const (\w+)\s*=\s*{\s*name:', content)

        if tool_def_match:
            actual_def_name = tool_def_match.group(1)
        else:
            actual_def_name = f"{const_name}_TOOL_DEFINITION"

        if run_func_match:
            actual_run_name = run_func_match.group(1)
        else:
            # Guess the run function name
            actual_run_name = f"run{pascal_name}"

        imports.append(
            f"import {{\n"
            f"  {actual_run_name},\n"
            f"  {actual_def_name},\n"
            f"}} from '../tools/{category}/{tool}.js';"
        )

    return "\n".join(imports)

def generate_case_statements(category, tools):
    """Generate case statements for a category"""
    cases = []
    tool_path_base = Path(f"src/tools/{category}")

    for tool in tools:
        tool_path = tool_path_base / f"{tool}.ts"
        if not tool_path.exists():
            continue

        content = tool_path.read_text(encoding='utf-8')

        # Find the tool name from the export
        name_match = re.search(r"name:\s*['\"]([^'\"]+)['\"]", content)
        if name_match:
            tool_name = name_match.group(1)
        else:
            tool_name = tool.replace('-', '_')

        # Find the run function name
        run_func_match = re.search(r'export (?:async )?function (run\w+)', content)
        if run_func_match:
            run_func = run_func_match.group(1)
        else:
            pascal_name = kebab_to_pascal(tool)
            run_func = f"run{pascal_name}"

        cases.append(
            f"      case '{tool_name}': {{\n"
            f"        const options = args as any;\n"
            f"        const result = await {run_func}(options);\n"
            f"        return {{\n"
            f"          content: [\n"
            f"            {{\n"
            f"              type: 'text',\n"
            f"              text: JSON.stringify(result, null, 2),\n"
            f"            }},\n"
            f"          ],\n"
            f"        }};\n"
            f"      }}\n"
        )

    return "\n".join(cases)

def generate_tool_definitions(category, tools):
    """Generate tool definition references for tools array"""
    defs = []
    tool_path_base = Path(f"src/tools/{category}")

    for tool in tools:
        tool_path = tool_path_base / f"{tool}.ts"
        if not tool_path.exists():
            continue

        content = tool_path.read_text(encoding='utf-8')

        # Find the actual tool definition constant name
        tool_def_match = re.search(r'export const (\w+TOOL(?:_DEFINITION)?)\s*=', content)
        if not tool_def_match:
            tool_def_match = re.search(r'export const (\w+)\s*=\s*{\s*name:', content)

        if tool_def_match:
            def_name = tool_def_match.group(1)
            defs.append(f"      {def_name},")

    return "\n".join(defs)

def main():
    server_file = Path("src/server/index.ts")
    content = server_file.read_text(encoding='utf-8')

    print("📝 Generating registration code for 38 tools...")

    # Find insertion points
    # 1. After last import from '../tools/...'
    # 2. In tools array
    # 3. In switch statement before default case

    all_imports = []
    all_defs = []
    all_cases = []

    for category, tools in UNREGISTERED_TOOLS.items():
        print(f"  Processing {category}: {len(tools)} tools")
        all_imports.append(f"\n// {category.replace('-', ' ').title()} tools")
        all_imports.append(generate_imports(category, tools))

        all_defs.append(f"      // {category.replace('-', ' ').title()} tools")
        all_defs.append(generate_tool_definitions(category, tools))

        all_cases.append(f"\n      // {category.replace('-', ' ').title()} tools")
        all_cases.append(generate_case_statements(category, tools))

    # Write the generated code to separate files for manual insertion
    Path("generated-imports.txt").write_text("\n".join(all_imports))
    Path("generated-definitions.txt").write_text("\n".join(all_defs))
    Path("generated-cases.txt").write_text("\n".join(all_cases))

    print("\n[OK] Generated registration code:")
    print("   - generated-imports.txt (add after existing imports)")
    print("   - generated-definitions.txt (add to tools array)")
    print("   - generated-cases.txt (add before 'default:' case)")
    print("\n📊 Stats:")
    print(f"   - {len(all_imports)} import blocks")
    print(f"   - {sum(len(tools) for tools in UNREGISTERED_TOOLS.values())} tools to register")

if __name__ == "__main__":
    main()
