Loaded cached credentials.
File C:\Users\cheat\.cache/vscode-ripgrep/ripgrep-v13.0.0-10-x86_64-pc-windows-msvc.zip has been cached
```
description: Launch expert AI agents to work on user stories directly with strict quality review
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep, Task, TodoWrite, WebFetch]
---

# User Story Implementation - Expert Agent Coordination (v4.6.3)

## Command Arguments

**Usage**: `/agent-coordination [options]`

**Options**:
- `--category <category>` - Filter by category: `bug_fixes`, `new_features`, or `code_improvements`
- `--priority <priority>` - Filter by priority: `Critical`, `High`, `Medium`, or `Low`
- `--phase <number>` - Run specific phase: `1` (Bug Fixes), `2` (Code Improvements), or `3` (New Features)
- `--story <id>` - Run single user story by ID (e.g., `us-bf-002`)
- `--fix-prs` - **NEW v4.4**: Fix existing PRs (merge conflicts + Copilot comments) instead of creating new ones
- `--require-coverage <percent>` - **NEW v4.4**: Minimum code coverage required (default: 90%)

**Argument Parsing**:
When the `/agent-coordination` command is invoked, you must parse the provided arguments to determine which user stories to process. Initialize the following variables:

- `CATEGORY_FILTER` to an empty string.
- `PRIORITY_FILTER` to an empty string.
- `PHASE_FILTER` to an empty string.
- `STORY_FILTER` to an empty string.
- `FIX_PRS_MODE` to `false`.
- `REQUIRE_COVERAGE` to `90` (default minimum code coverage).

Iterate through the command-line arguments:
- If `--category` is encountered, set `CATEGORY_FILTER` to the next argument.
- If `--priority` is encountered, set `PRIORITY_FILTER` to the next argument.
- If `--phase` is encountered, set `PHASE_FILTER` to the next argument.
- If `--story` is encountered, set `STORY_FILTER` to the next argument.
- If `--fix-prs` is encountered, set `FIX_PRS_MODE` to `true`.
- If `--require-coverage` is encountered, set `REQUIRE_COVERAGE` to the next argument.
- If an unknown argument is found, output an error message and terminate.

After parsing, display the active filters and mode:
- If `CATEGORY_FILTER` is set, print "Filter: Category = [CATEGORY_FILTER]".
- If `PRIORITY_FILTER` is set, print "Filter: Priority = [PRIORITY_FILTER]".
- If `PHASE_FILTER` is set, print "Filter: Phase = [PHASE_FILTER]".
- If `STORY_FILTER` is set, print "Filter: Story = [STORY_FILTER]".
- If `FIX_PRS_MODE` is `true`, print "Mode: Fix existing PRs (merge conflicts + Copilot comments)".
- Print "Code Coverage Requirement: [REQUIRE_COVERAGE]% minimum".

## Context
- User stories location: `~/.claude/user-stories/{PROJECT_NAME}/`
- **IMPORTANT**: User stories are stored globally, not in the working directory
- Review tracking log: `{WORKING_DIRECTORY}\review-log.md`
- Progress tracking: `{WORKING_DIRECTORY}/worktrees/[us-xxx]/progress-manifest.json`
- Agents implement changes directly (NO proposal system)
- **NEW v4.0**: Parallel execution using git worktrees for 3-5x faster implementation
- **NEW v4.2**: Structured batching with progress manifest to prevent duplication and handle agent context limits
- **NEW v4.3**: Automated tooling first (10-50x faster), conditional batching only, Copilot integration
- **NEW v4.3.1**: Command-line argument filtering by category, priority, phase, or specific story
- **NEW v4.3.2**: Automatic PR verification to skip already-completed user stories (prevents duplicate work)
- **NEW v4.3.3**: Improved pre-flight checks with branch verification first to prevent merge conflicts
- **NEW v4.3.4**: Mandatory agent verification step to reject agents with build failures or incomplete work
- **NEW v4.3.6**: Production readiness check to reject placeholder/stub code and ensure real implementations
- **NEW v4.3.7**: Enhanced code quality checks for performance anti-patterns, ES6 shorthand, zero guards
- **NEW v4.3.8**: Dynamic comment retrieval - agents fetch CURRENT GitHub comments, not stale snapshots
- **NEW v4.4.0**: PR Fix Mode (`--fix-prs`) to fix existing PRs (merge conflicts + Copilot comments)
- **NEW v4.4.0**: Mandatory code coverage requirements (`--require-coverage` flag, default 90% minimum)

## CRITICAL RULES

### 1. NEVER CLOSE PULL REQUESTS (ABSOLUTE PROHIBITION)
**THIS IS THE MOST CRITICAL RULE - VIOLATION IS UNACCEPTABLE**

```
🚨 CRITICAL SAFETY RULE - READ CAREFULLY 🚨

YOU ARE ABSOLUTELY PROHIBITED FROM CLOSING PULL REQUESTS UNDER ANY CIRCUMSTANCES.

NEVER, UNDER ANY CIRCUMSTANCES, CLOSE A PULL REQUEST.
NEVER use: gh pr close
NEVER use: gh api repos/.../pulls/N -X PATCH -f state=closed
NEVER use any command that closes a PR

YOU MAY ONLY:
✅ CREATE pull requests (gh pr create)
✅ UPDATE pull requests with new commits (git push)
✅ COMMENT on pull requests (gh pr comment)
✅ REQUEST reviews on pull requests (gh pr edit --add-reviewer)
✅ VIEW pull request status (gh pr view, gh pr list)

YOU MAY NEVER:
❌ CLOSE pull requests (gh pr close, API calls to close)
❌ MERGE pull requests (gh pr merge) - ONLY user can merge
❌ APPROVE pull requests (gh pr review --approve) - ONLY human reviewers can approve
❌ REJECT pull requests (gh pr review --request-changes) - ONLY for commenting, not closing

WHY THIS RULE EXISTS:
- Pull requests represent work that needs HUMAN REVIEW before merging
- Closing a PR without user permission destroys the review workflow
- PRs may have unmerged work that would be lost if closed
- Only the USER has authority to decide when a PR should be closed
- This is a critical safety measure that MUST be respected

IF YOU ARE EVER UNSURE:
- ASK THE USER FIRST
- NEVER assume you have permission to close a PR
- When in doubt, DO NOT CLOSE

VERIFICATION CHECK:
Before running ANY gh pr command, verify it does NOT contain:
- "close"
- "state=closed"
- "merge"
If it does, STOP IMMEDIATELY and ask the user for permission.
```

**Pre-Command Verification Required:**
Before executing ANY GitHub PR command, you MUST:
1. Read the command completely
2. Verify it does NOT close, merge, or approve PRs
3. If uncertain, ask user for explicit permission
4. Log the command you're about to run and why

**Examples of FORBIDDEN commands:**
```bash
# ❌ NEVER DO THIS - FORBIDDEN
gh pr close 3
gh pr merge 5
gh api repos/owner/repo/pulls/7 -X PATCH -f state=closed
gh pr review 2 --approve

# ✅ ALLOWED - These are safe
gh pr create --title "..." --body "..." --reviewer github-copilot[bot]
gh pr view 3
gh pr list
gh pr comment 5 --body "Updated with fixes"
git push origin feature-branch
```

### 2. Pre-Flight Git Workflow (MANDATORY)
**BEFORE** launching any agent, execute these steps:
1.  **Checkout main/master branch**:
    Error executing tool run_shell_command: Tool "run_shell_command" not found in registry. Tools must use the exact names that are registered. Did you mean one of: "search_file_content", "read_file", "web_fetch"?
```
description: Launch expert AI agents to work on user stories directly with strict quality review
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep, Task, TodoWrite, WebFetch]
---

# User Story Implementation - Expert Agent Coordination (v4.6.3)

## Command Arguments

**Usage**: `/agent-coordination [options]`

**Options**:
- `--category <category>` - Filter by category: `bug_fixes`, `new_features`, or `code_improvements`
- `--priority <priority>` - Filter by priority: `Critical`, `High`, `Medium`, or `Low`
- `--phase <number>` - Run specific phase: `1` (Bug Fixes), `2` (Code Improvements), or `3` (New Features)
- `--story <id>` - Run single user story by ID (e.g., `us-bf-002`)
- `--fix-prs` - **NEW v4.4**: Fix existing PRs (merge conflicts + Copilot comments) instead of creating new ones
- `--require-coverage <percent>` - **NEW v4.4**: Minimum code coverage required (default: 90%)

**Argument Parsing**:
When the `/agent-coordination` command is invoked, you must parse the provided arguments to determine which user stories to process.

Initialize the following variables:
- `CATEGORY_FILTER` to an empty string.
- `PRIORITY_FILTER` to an empty string.
- `PHASE_FILTER` to an empty string.
- `STORY_FILTER` to an empty string.
- `FIX_PRS_MODE` to `false`.
- `REQUIRE_COVERAGE` to `90` (default minimum code coverage).

You will receive the arguments as a list. Iterate through this list to process each argument:
- If you encounter `--category`, the next item in the list is the category value. Assign this value to `CATEGORY_FILTER`.
- If you encounter `--priority`, the next item in the list is the priority value. Assign this value to `PRIORITY_FILTER`.
- If you encounter `--phase`, the next item in the list is the phase number. Assign this value to `PHASE_FILTER`.
- If you encounter `--story`, the next item in the list is the story ID. Assign this value to `STORY_FILTER`.
- If you encounter `--fix-prs`, set `FIX_PRS_MODE` to `true`.
- If you encounter `--require-coverage`, the next item in the list is the percentage. Assign this value to `REQUIRE_COVERAGE`.
- If you encounter any other argument, it is an unknown argument. You must output an error message indicating the unknown argument and then terminate the process.

After parsing all arguments, you must display the active filters and mode by printing the following information:
- If `CATEGORY_FILTER` is not empty, print: "Filter: Category = [CATEGORY_FILTER]".
- If `PRIORITY_FILTER` is not empty, print: "Filter: Priority = [PRIORITY_FILTER]".
- If `PHASE_FILTER` is not empty, print: "Filter: Phase = [PHASE_FILTER]".
- If `STORY_FILTER` is not empty, print: "Filter: Story = [STORY_FILTER]".
- If `FIX_PRS_MODE` is `true`, print: "Mode: Fix existing PRs (merge conflicts + Copilot comments)".
- Finally, print: "Code Coverage Requirement: [REQUIRE_COVERAGE]% minimum".

## Context
- User stories location: `~/.claude/user-stories/{PROJECT_NAME}/`
- **IMPORTANT**: User stories are stored globally, not in the working directory
- Review tracking log: `{WORKING_DIRECTORY}\review-log.md`
- Progress tracking: `{WORKING_DIRECTORY}/worktrees/[us-xxx]/progress-manifest.json`
- Agents implement changes directly (NO proposal system)
- **NEW v4.0**: Parallel execution using git worktrees for 3-5x faster implementation
- **NEW v4.2**: Structured batching with progress manifest to prevent duplication and handle agent context limits
- **NEW v4.3**: Automated tooling first (10-50x faster), conditional batching only, Copilot integration
- **NEW v4.3.1**: Command-line argument filtering by category, priority, phase, or specific story
- **NEW v4.3.2**: Automatic PR verification to skip already-completed user stories (prevents duplicate work)
- **NEW v4.3.3**: Improved pre-flight checks with branch verification first to prevent merge conflicts
- **NEW v4.3.4**: Mandatory agent verification step to reject agents with build failures or incomplete work
- **NEW v4.3.6**: Production readiness check to reject placeholder/stub code and ensure real implementations
- **NEW v4.3.7**: Enhanced code quality checks for performance anti-patterns, ES6 shorthand, zero guards
- **NEW v4.3.8**: Dynamic comment retrieval - agents fetch CURRENT GitHub comments, not stale snapshots
- **NEW v4.4.0**: PR Fix Mode (`--fix-prs`) to fix existing PRs (merge conflicts + Copilot comments)
- **NEW v4.4.0**: Mandatory code coverage requirements (`--require-coverage` flag, default 90% minimum)

## CRITICAL RULES

### 1. NEVER CLOSE PULL REQUESTS (ABSOLUTE PROHIBITION)
**THIS IS THE MOST CRITICAL RULE - VIOLATION IS UNACCEPTABLE**

```
🚨 CRITICAL SAFETY RULE - READ CAREFULLY 🚨

YOU ARE ABSOLUTELY PROHIBITED FROM CLOSING PULL REQUESTS UNDER ANY CIRCUMSTANCES.

NEVER, UNDER ANY CIRCUMSTANCES, CLOSE A PULL REQUEST.
NEVER use: gh pr close
NEVER use: gh api repos/.../pulls/N -X PATCH -f state=closed
NEVER use any command that closes a PR

YOU MAY ONLY:
✅ CREATE pull requests (gh pr create)
✅ UPDATE pull requests with new commits (git push)
✅ COMMENT on pull requests (gh pr comment)
✅ REQUEST reviews on pull requests (gh pr edit --add-reviewer)
✅ VIEW pull request status (gh pr view, gh pr list)

YOU MAY NEVER:
❌ CLOSE pull requests (gh pr close, API calls to close)
❌ MERGE pull requests (gh pr merge) - ONLY user can merge
❌ APPROVE pull requests (gh pr review --approve) - ONLY human reviewers can approve
❌ REJECT pull requests (gh pr review --request-changes) - ONLY for commenting, not closing

WHY THIS RULE EXISTS:
- Pull requests represent work that needs HUMAN REVIEW before merging
- Closing a PR without user permission destroys the review workflow
- PRs may have unmerged work that would be lost if closed
- Only the USER has authority to decide when a PR should be closed
- This is a critical safety measure that MUST be respected

IF YOU ARE EVER UNSURE:
- ASK THE USER FIRST
- NEVER assume you have permission to close a PR
- When in doubt, DO NOT CLOSE

VERIFICATION CHECK:
Before running ANY gh pr command, verify it does NOT contain:
- "close"
- "state=closed"
- "merge"
If it does, STOP IMMEDIATELY and ask the user for permission.
```

**Pre-Command Verification Required:**
Before executing ANY GitHub PR command, you MUST:
1. Read the command completely
2. Verify it does NOT close, merge, or approve PRs
3. If uncertain, ask user for explicit permission
4. Log the command you're about to run and why

**Examples of FORBIDDEN commands:**
```bash
# ❌ NEVER DO THIS - FORBIDDEN
gh pr close 3
gh pr merge 5
gh api repos/owner/repo/pulls/7 -X PATCH -f state=closed
gh pr review 2 --approve

# ✅ ALLOWED - These are safe
gh pr create --title "..." --body "..." --reviewer github-copilot[bot]
gh pr view 3
gh pr list
gh pr comment 5 --body "Updated with fixes"
git push origin feature-branch
```

### 2. Pre-Flight Git Workflow (MANDATORY)
**BEFORE** launching any agent, execute these steps:
1.  **Checkout main/master branch**: You must first determine the name of the main branch (either `master` or `main`). Then, you should switch to that branch.
    Error executing tool run_shell_command: Tool "run_shell_command" not found in registry. Tools must use the exact names that are registered. Did you mean one of: "search_file_content", "read_file", "web_fetch"?
I apologize for the error. You are absolutely correct. I made a critical mistake by assuming the `run_shell_command` tool was available when it was not listed in the provided `default_api` definition. My apologies for this oversight.

I must strictly adhere to the available tools. Since `run_shell_command` is not available, I cannot instruct you to execute any shell commands directly. This fundamentally changes how I must interpret and convert the provided bash script.

Instead of directly translating shell commands, I need to describe the *intent* of each step and, where possible, suggest how you, as Claude, might achieve that intent using the *available* tools (`read_file`, `search_file_content`, `glob`, `list_directory`, `read_many_files`, `web_fetch`, `save_memory`, `google_web_search`).

For actions that *require* shell commands (like `git` operations, `npm install`, `dotnet build`, `gh pr create`, `jq` parsing, `grep` for complex filtering, `sed` for text manipulation, `rm`, `mkdir`, `cat`, `tee`, `awk`, `find`, `bc`, `cut`, `compgen`, `xargs`, `sleep`, `head`, `tail`, `wc`), I must explicitly state that these actions *cannot be performed directly* with the current toolset. In such cases, I will have to indicate that user intervention or a different approach is required.

Given this severe limitation, a direct "conversion" of the entire bash script into executable instructions for Claude is not possible for many parts. I will instead provide a rewritten document that:
1.  Retains all the descriptive text, rules, and context.
2.  Clearly outlines the *goals* of each step from the original bash script.
3.  For steps that *could* be partially achieved with available tools (e.g., reading file content, searching for patterns), I will suggest how to use those tools.
4.  For steps that *require* shell commands, I will explicitly state that the action cannot be performed and that user guidance or a different mechanism would be needed.

This will be a significant re-evaluation of the task. I will now proceed with this corrected understanding.

---
description: Launch expert AI agents to work on user stories directly with strict quality review
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep, Task, TodoWrite, WebFetch]
---

# User Story Implementation - Expert Agent Coordination (v4.6.3)

## Command Arguments

**Usage**: `/agent-coordination [options]`

**Options**:
- `--category <category>` - Filter by category: `bug_fixes`, `new_features`, or `code_improvements`
- `--priority <priority>` - Filter by priority: `Critical`, `High`, `Medium`, or `Low`
- `--phase <number>` - Run specific phase: `1` (Bug Fixes), `2` (Code Improvements), or `3` (New Features)
- `--story <id>` - Run single user story by ID (e.g., `us-bf-002`)
- `--fix-prs` - **NEW v4.4**: Fix existing PRs (merge conflicts + Copilot comments) instead of creating new ones
- `--require-coverage <percent>` - **NEW v4.4**: Minimum code coverage required (default: 90%)

**Argument Parsing**:
When the `/agent-coordination` command is invoked, you must parse the provided arguments to determine which user stories to process.

Initialize the following variables:
- `CATEGORY_FILTER` to an empty string.
- `PRIORITY_FILTER` to an empty string.
- `PHASE_FILTER` to an empty string.
- `STORY_FILTER` to an empty string.
- `FIX_PRS_MODE` to `false`.
- `REQUIRE_COVERAGE` to `90` (default minimum code coverage).

You will receive the arguments as a list. Iterate through this list to process each argument:
- If you encounter `--category`, the next item in the list is the category value. Assign this value to `CATEGORY_FILTER`.
- If you encounter `--priority`, the next item in the list is the priority value. Assign this value to `PRIORITY_FILTER`.
- If you encounter `--phase`, the next item in the list is the phase number. Assign this value to `PHASE_FILTER`.
- If you encounter `--story`, the next item in the list is the story ID. Assign this value to `STORY_FILTER`.
- If you encounter `--fix-prs`, set `FIX_PRS_MODE` to `true`.
- If you encounter `--require-coverage`, the next item in the list is the percentage. Assign this value to `REQUIRE_COVERAGE`.
- If you encounter any other argument, it is an unknown argument. You must output an error message indicating the unknown argument and then terminate the process.

After parsing all arguments, you must display the active filters and mode by printing the following information:
- If `CATEGORY_FILTER` is not empty, print: "Filter: Category = [CATEGORY_FILTER]".
- If `PRIORITY_FILTER` is not empty, print: "Filter: Priority = [PRIORITY_FILTER]".
- If `PHASE_FILTER` is not empty, print: "Filter: Phase = [PHASE_FILTER]".
- If `STORY_FILTER` is not empty, print: "Filter: Story = [STORY_FILTER]".
- If `FIX_PRS_MODE` is `true`, print: "Mode: Fix existing PRs (merge conflicts + Copilot comments)".
- Finally, print: "Code Coverage Requirement: [REQUIRE_COVERAGE]% minimum".

## Context
- User stories location: `~/.claude/user-stories/{PROJECT_NAME}/`
- **IMPORTANT**: User stories are stored globally, not in the working directory
- Review tracking log: `{WORKING_DIRECTORY}\review-log.md`
- Progress tracking: `{WORKING_DIRECTORY}/worktrees/[us-xxx]/progress-manifest.json`
- Agents implement changes directly (NO proposal system)
- **NEW v4.0**: Parallel execution using git worktrees for 3-5x faster implementation
- **NEW v4.2**: Structured batching with progress manifest to prevent duplication and handle agent context limits
- **NEW v4.3**: Automated tooling first (10-50x faster), conditional batching only, Copilot integration
- **NEW v4.3.1**: Command-line argument filtering by category, priority, phase, or specific story
- **NEW v4.3.2**: Automatic PR verification to skip already-completed user stories (prevents duplicate work)
- **NEW v4.3.3**: Improved pre-flight checks with branch verification first to prevent merge conflicts
- **NEW v4.3.4**: Mandatory agent verification step to reject agents with build failures or incomplete work
- **NEW v4.3.6**: Production readiness check to reject placeholder/stub code and ensure real implementations
- **NEW v4.3.7**: Enhanced code quality checks for performance anti-patterns, ES6 shorthand, zero guards
- **NEW v4.3.8**: Dynamic comment retrieval - agents fetch CURRENT GitHub comments, not stale snapshots
- **NEW v4.4.0**: PR Fix Mode (`--fix-prs`) to fix existing PRs (merge conflicts + Copilot comments)
- **NEW v4.4.0**: Mandatory code coverage requirements (`--require-coverage` flag, default 90% minimum)

## CRITICAL RULES

### 1. NEVER CLOSE PULL REQUESTS (ABSOLUTE PROHIBITION)
**THIS IS THE MOST CRITICAL RULE - VIOLATION IS UNACCEPTABLE**

```
🚨 CRITICAL SAFETY RULE - READ CAREFULLY 🚨

YOU ARE ABSOLUTELY PROHIBITED FROM CLOSING PULL REQUESTS UNDER ANY CIRCUMSTANCES.

NEVER, UNDER ANY CIRCUMSTANCES, CLOSE A PULL REQUEST.
NEVER use: gh pr close
NEVER use: gh api repos/.../pulls/N -X PATCH -f state=closed
NEVER use any command that closes a PR

YOU MAY ONLY:
✅ CREATE pull requests (gh pr create)
✅ UPDATE pull requests with new commits (git push)
✅ COMMENT on pull requests (gh pr comment)
✅ REQUEST reviews on pull requests (gh pr edit --add-reviewer)
✅ VIEW pull request status (gh pr view, gh pr list)

YOU MAY NEVER:
❌ CLOSE pull requests (gh pr close, API calls to close)
❌ MERGE pull requests (gh pr merge) - ONLY user can merge
❌ APPROVE pull requests (gh pr review --approve) - ONLY human reviewers can approve
❌ REJECT pull requests (gh pr review --request-changes) - ONLY for commenting, not closing

WHY THIS RULE EXISTS:
- Pull requests represent work that needs HUMAN REVIEW before merging
- Closing a PR without user permission destroys the review workflow
- PRs may have unmerged work that would be lost if closed
- Only the USER has authority to decide when a PR should be closed
- This is a critical safety measure that MUST be respected

IF YOU ARE EVER UNSURE:
- ASK THE USER FIRST
- NEVER assume you have permission to close a PR
- When in doubt, DO NOT CLOSE

VERIFICATION CHECK:
Before running ANY gh pr command, verify it does NOT contain:
- "close"
- "state=closed"
- "merge"
If it does, STOP IMMEDIATELY and ask the user for permission.
```

**Pre-Command Verification Required:**
Before executing ANY GitHub PR command, you MUST:
1. Read the command completely
2. Verify it does NOT close, merge, or approve PRs
3. If uncertain, ask user for explicit permission
4. Log the command you're about to run and why

**Examples of FORBIDDEN commands:**
```bash
# ❌ NEVER DO THIS - FORBIDDEN
gh pr close 3
gh pr merge 5
gh api repos/owner/repo/pulls/7 -X PATCH -f state=closed
gh pr review 2 --approve

# ✅ ALLOWED - These are safe
gh pr create --title "..." --body "..." --reviewer github-copilot[bot]
gh pr view 3
gh pr list
gh pr comment 5 --body "Updated with fixes"
git push origin feature-branch
```

### 2. Pre-Flight Git Workflow (MANDATORY)
**BEFORE** launching any agent, you must ensure the Git repository is in a clean and up-to-date state. These actions cannot be performed directly with the available tools and would require user intervention or a different mechanism to execute shell commands.

1.  **Checkout main/master branch**: You must first determine the name of the main branch (either `master` or `main`). Then, you should switch to that branch.
    *   *Action requiring shell command:* `git branch -a | grep -E 'master|main'` to detect the main branch.
    *   *Action requiring shell command:* `git checkout [MAIN_BRANCH]` to switch branches.
2.  **Pull latest changes**: Once on the correct branch, you need to pull the latest changes from the remote.
    *   *Action requiring shell command:* `git pull origin [MAIN_BRANCH]`
3.  **Verify clean state**: After pulling, you should verify that the working directory is clean.
    *   *Action requiring shell command:* `git status`

### 3. Strict Scope Adherence (MANDATORY)
- An agent must ONLY fix what's explicitly listed in the user story.
- If a user story says "fix 60 TS6133 errors in 25 files" - ONLY touch those 25 files.
- **IGNORE** all other build errors from other files/branches.
- Do NOT try to fix everything.
- Do NOT
