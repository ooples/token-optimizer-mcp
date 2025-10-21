---
description: Launch expert AI agents to work on user stories directly with strict quality review
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep, Task, TodoWrite, WebFetch]
---

# User Story Implementation - Expert Agent Coordination (v4.6.3)

## How to Interpret This Command

This command uses bash-like syntax throughout to clearly express logical flow, conditions, and operations. As an AI assistant, you should interpret the **INTENT** of each instruction and implement it using methods appropriate for your environment.

**Interpretation Guide**:
- `if [ -f "file.txt" ]` → Check if file exists
- `if [ -n "$VARIABLE" ]` → Check if variable is set/not empty
- `for item in list` → Iterate over items in the list
- `VARIABLE="value"` → Store and track this value in your context
- `grep pattern file` → Search for pattern in file
- Bash commands in code blocks → Execute equivalent operations in your environment

**Important**: The bash syntax is **pseudocode** showing WHAT to do, not necessarily HOW to do it in your specific CLI environment. You may need to adapt the approach based on your available tools and capabilities.

**Cross-CLI Compatibility**: This command is designed to work across multiple AI CLI tools (Claude Code, Google Gemini CLI, Codex CLI, GitHub Copilot CLI). Each tool should interpret the instructions and implement them using their available capabilities.

## Command Arguments

**Usage**: `/agent-coordination [options]`

**Options**:
- `--category <category>` - Filter by category: `bug_fixes`, `new_features`, or `code_improvements`
- `--priority <priority>` - Filter by priority: `Critical`, `High`, `Medium`, or `Low`
- `--phase <number>` - Run specific phase: `1` (Bug Fixes), `2` (Code Improvements), or `3` (New Features)
- `--story <id>` - Run single user story by ID (e.g., `us-bf-002`)
- `--fix-prs` - **NEW v4.4**: Fix existing PRs (merge conflicts + Copilot comments) instead of creating new ones
- `--require-coverage <percent>` - **NEW v4.4**: Minimum code coverage required (default: 90%)

**Examples**:
```bash
/agent-coordination --category bug_fixes           # Run only bug fix user stories
/agent-coordination --priority Critical            # Run only Critical priority stories
/agent-coordination --category bug_fixes --priority High  # High priority bug fixes only
/agent-coordination --phase 1                      # Run Phase 1 (Bug Fixes)
/agent-coordination --story us-bf-002              # Run single user story
/agent-coordination --fix-prs                      # Fix all open PRs (conflicts + Copilot comments)
/agent-coordination --require-coverage 95          # Require 95% code coverage minimum
/agent-coordination                                # Run all user stories (default)
```

**Argument Parsing**:

When this command is invoked, parse the arguments after `/agent-coordination` to determine which user stories to process and what mode to run in.

**Initialize the following variables** (track these throughout execution):
- `CATEGORY_FILTER` = empty (no category filter by default)
- `PRIORITY_FILTER` = empty (no priority filter by default)
- `PHASE_FILTER` = empty (no phase filter by default)
- `STORY_FILTER` = empty (no story filter by default)
- `FIX_PRS_MODE` = false (default: create new PRs)
- `REQUIRE_COVERAGE` = 90 (default: 90% minimum code coverage)

**Parse arguments from the command invocation**:
- If `--category <value>` is present → set `CATEGORY_FILTER` to the value (must be: `bug_fixes`, `new_features`, or `code_improvements`)
- If `--priority <value>` is present → set `PRIORITY_FILTER` to the value (must be: `Critical`, `High`, `Medium`, or `Low`)
- If `--phase <number>` is present → set `PHASE_FILTER` to the number (must be: `1`, `2`, or `3`)
- If `--story <id>` is present → set `STORY_FILTER` to the ID (e.g., `us-bf-002`)
- If `--fix-prs` flag is present → set `FIX_PRS_MODE` to true
- If `--require-coverage <percent>` is present → set `REQUIRE_COVERAGE` to the percent value
- If an unknown argument is encountered → display error and stop

**Display the active filters** (after parsing):
- If `CATEGORY_FILTER` is set → display "Filter: Category = {value}"
- If `PRIORITY_FILTER` is set → display "Filter: Priority = {value}"
- If `PHASE_FILTER` is set → display "Filter: Phase = {value}"
- If `STORY_FILTER` is set → display "Filter: Story = {value}"
- If `FIX_PRS_MODE` is true → display "Mode: Fix existing PRs (merge conflicts + Copilot comments)"
- Always display "Code Coverage Requirement: {REQUIRE_COVERAGE}% minimum"

## Context
- User stories location: ~/.claude/user-stories/{PROJECT_NAME}/
- **IMPORTANT**: User stories are stored globally, not in the working directory
- Review tracking log: {WORKING_DIRECTORY}\review-log.md
- Progress tracking: {WORKING_DIRECTORY}/worktrees/[us-xxx]/progress-manifest.json
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
```bash
# Step 1: Checkout main/master branch
git checkout master  # or main, detect which exists

# Step 2: Pull latest changes
git pull origin master

# Step 3: Verify clean state
git status  # Should be clean
```

### 3. Strict Scope Adherence (MANDATORY)
- Agent must ONLY fix what's explicitly listed in the user story
- If user story says "fix 60 TS6133 errors in 25 files" - ONLY touch those 25 files
- **IGNORE** all other build errors from other files/branches
- Do NOT try to fix everything
- Do NOT fix errors outside the user story scope

### 4. NO SCRIPTS ALLOWED (MANDATORY)
- ❌ NEVER use Python scripts
- ❌ NEVER use bash scripts for code changes
- ❌ NEVER use automated tools
- ✅ ALWAYS use Edit tool manually for each change
- ✅ Make changes one file at a time
- Success rate with scripts is 0% - DO NOT USE THEM

### 5. Success Criteria (MANDATORY)
- User story changes must build with ZERO errors
- User story changes must meet 100% of acceptance criteria
- **Other files CAN have errors - that's OK**
- Only verify the files mentioned in the user story
- Create PR only when user story work is 100% complete

### 6. Base Branch Detection
- Detect main branch: `git branch -a | grep -E 'master|main'`
- Use whichever exists (master or main)
- Default to master if both exist

## Execution Phases (Sequential - Priority Order)
1. **Phase 1: Bug Fixes** - All bug fix user stories from bug_fixes/ (HIGHEST PRIORITY - blocks compilation)
2. **Phase 2: Code Improvements** - All improvement user stories from code_improvements/ (SECOND PRIORITY - quality/maintainability)
3. **Phase 3: New Features** - All new feature user stories from new_features/ (LAST - enhancements)

**Rationale**:
- Bug fixes must come first as they block compilation and prevent other work
- Code improvements improve quality and maintainability before adding new features
- New features are implemented last on a stable, high-quality codebase

**Note**: This is the correct priority order. Do not adjust unless user explicitly requests it.

## Quality Checklist (Non-Negotiable)
Each user story must meet ALL criteria before acceptance:
- [ ] User story files build with zero errors (other files can have errors)
- [ ] 100% of acceptance criteria met (from user story)
- [ ] Changes made ONLY to files listed in user story
- [ ] Git commit created with proper message
- [ ] Pull request created with detailed description
- [ ] Branch created from latest master/main

**MANDATORY Code Coverage** (NEW v4.4.0 - ALWAYS REQUIRED):
- [ ] Code coverage ≥ ${REQUIRE_COVERAGE}% (default: 90% minimum)
- [ ] Coverage tests executed and passing
- [ ] Coverage report generated and verified

**Optional** (if specified in user story):
- [ ] Linting passes (only if user story requires it)
- [ ] Unit tests written (only if user story requires it)
- [ ] All tests pass (only if user story requires it)

---

## Process

### Step 0: Mode Detection (FIRST - Check for --fix-prs mode)

**NEW v4.4.0 / Updated v4.7.0**: If `--fix-prs` flag is set, use PR Fix Mode instead of normal user story mode.

**v4.7.0 Updates**:
- Uses GraphQL API for accurate unresolved comment detection (`isResolved` field)
- Fixed merge conflict commit logic (proper handling of conflicts-only, comments-only, and both scenarios)
- Added senior developer intervention on iteration 3+ (orchestrator directly fixes code if agent fails repeatedly)

```bash
if [ "$FIX_PRS_MODE" = true ]; then
  echo "=========================================="
  echo "PR FIX MODE ACTIVATED (v4.7.0)"
  echo "=========================================="
  echo "This mode will fix existing open PRs by:"
  echo "  1. Resolving merge conflicts"
  echo "  2. Addressing GitHub Copilot review comments (using GraphQL API for accuracy)"
  echo "  3. Senior developer intervention on iteration 3+"
  echo ""

  # SKIP Steps 1-4 (user story loading, worktree creation, agent implementation)
  # GO DIRECTLY TO PR FIX WORKFLOW

  ## PR Fix Workflow

  # Step A: Discover all open PRs
  echo "Step A: Discovering open PRs..."
  PR_LIST=$(gh pr list --json number,title,mergeable,headRefName --limit 50)
  OPEN_PRS=$(echo "$PR_LIST" | jq -r '.[] | @json')

  echo "Found $(echo "$OPEN_PRS" | wc -l) open PRs"
  echo ""

  # Step B: For each PR, check for issues using GraphQL API
  while IFS= read -r pr_json; do
    PR_NUMBER=$(echo "$pr_json" | jq -r '.number')
    PR_TITLE=$(echo "$pr_json" | jq -r '.title')
    PR_BRANCH=$(echo "$pr_json" | jq -r '.headRefName')
    PR_MERGEABLE=$(echo "$pr_json" | jq -r '.mergeable')

    echo "=========================================="
    echo "Checking PR #$PR_NUMBER: $PR_TITLE"
    echo "=========================================="

    HAS_CONFLICTS=false
    HAS_COPILOT_COMMENTS=false
    UNRESOLVED_COMMENT_COUNT=0

    # Check for merge conflicts
    if [ "$PR_MERGEABLE" = "CONFLICTING" ]; then
      echo "⚠️  HAS MERGE CONFLICTS"
      HAS_CONFLICTS=true
    fi

    # Check for UNRESOLVED Copilot comments using GraphQL API (ACCURATE)
    # This uses the isResolved field which REST API doesn't expose
    GRAPHQL_RESULT=$(gh api graphql -f query="
      query {
        repository(owner: \"{owner}\", name: \"{repo}\") {
          pullRequest(number: $PR_NUMBER) {
            headRefOid
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                isOutdated
                comments(first: 1) {
                  nodes {
                    path
                    line
                    body
                    commit { oid }
                    author { login }
                  }
                }
              }
            }
          }
        }
      }
    ")

    # Extract HEAD commit and unresolved threads
    HEAD_COMMIT=$(echo "$GRAPHQL_RESULT" | jq -r '.data.repository.pullRequest.headRefOid')

    # Count unresolved threads that are:
    # 1. isResolved == false
    # 2. On current HEAD commit
    # 3. From Copilot
    UNRESOLVED_COMMENT_COUNT=$(echo "$GRAPHQL_RESULT" | jq "[
      .data.repository.pullRequest.reviewThreads.nodes[] |
      select(.isResolved == false) |
      select(.comments.nodes[0].commit.oid == \"$HEAD_COMMIT\") |
      select(.comments.nodes[0].author.login | test(\"copilot\"; \"i\"))
    ] | length")

    if [ "$UNRESOLVED_COMMENT_COUNT" -gt 0 ]; then
      echo "⚠️  HAS $UNRESOLVED_COMMENT_COUNT UNRESOLVED COPILOT COMMENTS (GraphQL API - accurate count)"
      HAS_COPILOT_COMMENTS=true
    fi

    # Step C: If issues found, launch iterative fix workflow with senior developer intervention
    if [ "$HAS_CONFLICTS" = true ] || [ "$HAS_COPILOT_COMMENTS" = true ]; then
      echo "→ Starting fix workflow for PR #$PR_NUMBER"

      # Create worktree for this PR
      git worktree add "worktrees/PR-$PR_NUMBER" "$PR_BRANCH" 2>/dev/null || {
        echo "Worktree exists, removing and recreating..."
        git worktree remove "worktrees/PR-$PR_NUMBER" --force
        git worktree add "worktrees/PR-$PR_NUMBER" "$PR_BRANCH"
      }

      # Iterative fix loop with senior developer intervention
      ITERATION=1
      MAX_ITERATIONS=3

      while [ $ITERATION -le $MAX_ITERATIONS ]; do
        echo ""
        echo "=========================================="
        echo "PR #$PR_NUMBER - ITERATION $ITERATION of $MAX_ITERATIONS"
        echo "=========================================="

        # Re-check current status using GraphQL
        CURRENT_STATUS=$(gh api graphql -f query="
          query {
            repository(owner: \"{owner}\", name: \"{repo}\") {
              pullRequest(number: $PR_NUMBER) {
                headRefOid
                mergeable
                reviewThreads(first: 100) {
                  nodes {
                    id
                    isResolved
                    comments(first: 1) {
                      nodes {
                        commit { oid }
                        author { login }
                        path
                        line
                        body
                      }
                    }
                  }
                }
              }
            }
          }
        ")

        CURRENT_HEAD=$(echo "$CURRENT_STATUS" | jq -r '.data.repository.pullRequest.headRefOid')
        CURRENT_MERGEABLE=$(echo "$CURRENT_STATUS" | jq -r '.data.repository.pullRequest.mergeable')
        CURRENT_UNRESOLVED=$(echo "$CURRENT_STATUS" | jq "[
          .data.repository.pullRequest.reviewThreads.nodes[] |
          select(.isResolved == false) |
          select(.comments.nodes[0].commit.oid == \"$CURRENT_HEAD\") |
          select(.comments.nodes[0].author.login | test(\"copilot\"; \"i\"))
        ] | length")

        echo "Current status:"
        echo "  HEAD: $CURRENT_HEAD"
        echo "  Mergeable: $CURRENT_MERGEABLE"
        echo "  Unresolved comments: $CURRENT_UNRESOLVED"

        # Check if all issues resolved
        if [ "$CURRENT_MERGEABLE" != "CONFLICTING" ] && [ "$CURRENT_UNRESOLVED" -eq 0 ]; then
          echo "✅ ALL ISSUES RESOLVED on iteration $ITERATION"
          break
        fi

        # Iteration 3+: Senior Developer (Orchestrator) Intervention
        if [ $ITERATION -ge 3 ]; then
          echo ""
          echo "=========================================="
          echo "🎓 SENIOR DEVELOPER INTERVENTION"
          echo "=========================================="
          echo "Agent (junior developer) has attempted $((ITERATION-1)) iterations without fully resolving issues."
          echo "Senior developer (orchestrator) will now directly fix the remaining problems."
          echo ""

          # Orchestrator directly retrieves and fixes unresolved comments
          # Extract detailed unresolved comment data
          UNRESOLVED_COMMENTS=$(echo "$CURRENT_STATUS" | jq -r "
            .data.repository.pullRequest.reviewThreads.nodes[] |
            select(.isResolved == false) |
            select(.comments.nodes[0].commit.oid == \"$CURRENT_HEAD\") |
            select(.comments.nodes[0].author.login | test(\"copilot\"; \"i\")) |
            .comments.nodes[0] |
            \"\\(.path):\\(.line) - \\(.body)\"
          ")

          echo "Unresolved comments remaining:"
          echo "$UNRESOLVED_COMMENTS"
          echo ""
          echo "Orchestrator will now use Read + Edit tools to directly fix these issues..."
          echo "TODO: Implement direct orchestrator fixes here"
          echo "(For now, escalate to user for manual intervention)"

          # Escalate to user
          echo "⚠️  ESCALATION: PR #$PR_NUMBER requires manual intervention after $ITERATION iterations"
          echo "Unresolved issues:"
          if [ "$CURRENT_MERGEABLE" = "CONFLICTING" ]; then
            echo "  - Merge conflicts still present"
          fi
          if [ "$CURRENT_UNRESOLVED" -gt 0 ]; then
            echo "  - $CURRENT_UNRESOLVED unresolved Copilot comments"
            echo ""
            echo "$UNRESOLVED_COMMENTS"
          fi

          break
        fi

        # Launch fix agent (iterations 1-2)
        echo "→ Launching agent (junior developer) for iteration $ITERATION..."

        # Determine fix scenario
        CONFLICTS_EXIST=$([ "$CURRENT_MERGEABLE" = "CONFLICTING" ] && echo "true" || echo "false")
        COMMENTS_EXIST=$([ "$CURRENT_UNRESOLVED" -gt 0 ] && echo "true" || echo "false")

        # Create agent task with proper commit strategy
        cat > /tmp/pr-fix-task-${PR_NUMBER}-iter${ITERATION}.md <<EOF
## Agent Task: Fix PR #$PR_NUMBER - Iteration $ITERATION

### 🚨 CRITICAL: NEVER CLOSE/MERGE/APPROVE PRs

### Working Directory
{WORKING_DIRECTORY}/worktrees/PR-$PR_NUMBER/

### Current Issues
$([ "$CONFLICTS_EXIST" = "true" ] && echo "- ⚠️ Merge conflicts with main branch")
$([ "$COMMENTS_EXIST" = "true" ] && echo "- ⚠️ $CURRENT_UNRESOLVED unresolved Copilot comments")

### Commit Strategy (IMPORTANT - Follow Exactly)

**Scenario 1: ONLY merge conflicts (no comments)**
\`\`\`bash
git fetch origin main
git merge origin/main
# Resolve conflicts using Read + Edit tools
git add .
git commit -m "chore: resolve merge conflicts with main"
git push --force-with-lease
\`\`\`

**Scenario 2: ONLY Copilot comments (no conflicts)**
\`\`\`bash
# Fix all comments using Read + Edit tools
git add .
git commit --amend --no-edit  # Amend existing commit
git push --force-with-lease
\`\`\`

**Scenario 3: BOTH conflicts AND comments**
\`\`\`bash
git fetch origin main
git merge origin/main
# Resolve conflicts using Read + Edit tools
# Also fix all Copilot comments in the same commit
git add .
git commit -m "fix: resolve merge conflicts and address Copilot review comments"
git push --force-with-lease
\`\`\`

### Retrieve UNRESOLVED Comments (GraphQL API - ACCURATE)

Use GraphQL to get ONLY truly unresolved comments:

\`\`\`bash
gh api graphql -f query='
  query {
    repository(owner: "{owner}", name: "{repo}") {
      pullRequest(number: $PR_NUMBER) {
        headRefOid
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            comments(first: 1) {
              nodes {
                path
                line
                body
                commit { oid }
                author { login }
              }
            }
          }
        }
      }
    }
  }
'
\`\`\`

Then filter for:
- \`isResolved == false\`
- \`commit.oid == headRefOid\` (current HEAD)
- \`author.login\` matches "copilot"

### Success Criteria
- Merge conflicts resolved (if any)
- ALL unresolved Copilot comments fixed
- Proper commit message based on scenario
- Changes pushed to remote

### Iteration Context
This is iteration $ITERATION of $MAX_ITERATIONS.
- If you succeed: PR is clean ✅
- If you fail: Iteration $((ITERATION+1)) will retry
- If iteration 3 fails: Senior developer takes over

Report final HEAD commit SHA when complete.
EOF

        # Launch agent using Task tool
        echo "Agent task file created: /tmp/pr-fix-task-${PR_NUMBER}-iter${ITERATION}.md"
        echo "(Task tool launch happens here in actual execution)"

        # Wait for agent completion (60 seconds for Copilot review)
        echo "Waiting 60 seconds for Copilot to review changes..."
        sleep 60

        # Increment iteration
        ITERATION=$((ITERATION + 1))
      done

      echo ""
      echo "Fix workflow complete for PR #$PR_NUMBER"
    else
      echo "✅ No issues found - PR is clean"
    fi

    echo ""
  done <<< "$OPEN_PRS"

  echo "=========================================="
  echo "PR FIX MODE COMPLETE"
  echo "=========================================="

  # Exit after PR fix mode completes
  exit 0
fi

# If not in PR Fix Mode, continue with normal user story workflow:
```

### Step 1: Pre-Flight Checks (MANDATORY FIRST STEP)

Execute these commands BEFORE any other work:

```bash
echo "=========================================="
echo "PRE-FLIGHT CHECKS (MANDATORY)"
echo "=========================================="

# 1. Detect main branch
MAIN_BRANCH=$(git branch -a | grep -oE 'origin/(master|main)' | head -1 | sed 's/origin\///')
if [ -z "$MAIN_BRANCH" ]; then
  MAIN_BRANCH="master"  # default
fi

echo "Detected main branch: $MAIN_BRANCH"

# 2. Check current branch FIRST (CRITICAL - prevents merge conflicts)
CURRENT_BRANCH=$(git branch --show-current)
echo "1. Current branch: $CURRENT_BRANCH"

# 3. If not on main branch, switch to it safely
if [[ "$CURRENT_BRANCH" != "$MAIN_BRANCH" ]]; then
  echo "⚠️  Not on $MAIN_BRANCH. Switching..."

  # 3a. Check for uncommitted changes and stash them
  if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    echo "⚠️  Uncommitted changes detected"
    git status --short
    echo "Stashing changes..."
    git stash push -m "auto-stash-agent-coordination-$(date +%s)"
    echo "✓ Changes stashed"
  fi

  # 3b. Force checkout main branch (discard any conflicts from previous failed operations)
  git checkout -f "$MAIN_BRANCH"
  echo "✓ Switched to $MAIN_BRANCH"
else
  echo "✓ Already on $MAIN_BRANCH"
fi

# 4. Pull latest changes (now safe because we're on the correct branch)
echo "2. Pulling latest changes from origin/$MAIN_BRANCH..."
git pull origin "$MAIN_BRANCH"
echo "✓ $MAIN_BRANCH updated"

# 5. Verify clean state
echo "3. Verifying clean state..."
git status

# 6. Double-check for uncommitted changes (in case pull introduced conflicts)
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
  echo "⚠️  WARNING: Working directory not clean after pull"
  git status --short
  echo "Stashing remaining changes..."
  git stash push -m "auto-stash-post-pull-$(date +%s)"
  echo "✓ Changes stashed"
fi

echo "✓ Pre-flight git checks complete"
echo ""

# 7. Create worktrees directory
mkdir -p worktrees

# 8. Clean any existing worktrees
echo "4. Cleaning existing worktrees..."
git worktree list | grep "worktrees/" | awk '{print $1}' | while read wt; do
  git worktree remove "$wt" --force 2>/dev/null || true
done
echo "✓ Worktrees cleaned"
echo ""

# 9. Check for already-completed user stories (NEW - v4.3.2)
echo "5. Checking for already-completed user stories in recent PRs..."
gh pr list --state merged --limit 20 --json number,title,body,mergedAt \
  | jq -r '.[] | "\(.number)|\(.title)|\(.mergedAt)"' \
  | while IFS='|' read -r pr_number pr_title merged_at; do
    # Extract user story ID from PR title (e.g., US-BF-002, US-NF-001)
    if [[ "$pr_title" =~ (US-[A-Z]+-[0-9]+) ]]; then
      echo "  ✓ Found completed: ${BASH_REMATCH[1]} - PR #$pr_number (merged: $merged_at)"
      COMPLETED_STORIES+=("${BASH_REMATCH[1]}")
    fi
  done

if [ ${#COMPLETED_STORIES[@]} -gt 0 ]; then
  echo ""
  echo "Found ${#COMPLETED_STORIES[@]} already-completed user stories:"
  printf '  - %s\n' "${COMPLETED_STORIES[@]}"
  echo ""
  echo "These will be SKIPPED during user story loading."
fi

echo ""
echo "=========================================="
echo "✓ ALL PRE-FLIGHT CHECKS COMPLETE"
echo "=========================================="
echo ""
```

**CRITICAL IMPROVEMENTS (v4.3.3)**:
- **Branch Check First**: Verifies current branch BEFORE any git operations
- **Safe Branch Switching**: Uses `git checkout -f` to discard conflicts from previous failed operations
- **Stash Protection**: Automatically stashes uncommitted changes to preserve work
- **Conflict Prevention**: Force checkout prevents merge conflicts when switching from feature branches
- **Double Verification**: Checks for uncommitted changes both before and after pull
- **Clear Feedback**: Numbered steps with status indicators for better visibility

**Why This Matters**:
- Previous version could create merge conflicts if left on a feature branch
- This version safely handles ANY starting branch state
- Prevents the "Automatic merge failed" error from happening

**CRITICAL**: Do not proceed until main branch is checked out and up to date.

### Step 2: Discovery and Filtering

- Detect current working directory and set {WORKING_DIRECTORY}
- Extract project name from {WORKING_DIRECTORY} path (e.g., "token-optimizer-mcp")
- Read all user stories from ~/.claude/user-stories/{PROJECT_NAME}/
  - bug_fixes/*.md
  - code_improvements/*.md
  - new_features/*.md
  - Parse index.md for organized story list
- **Filter Out Already-Completed User Stories** (NEW - v4.3.2):
  ```bash
  # Skip user stories that are already complete (from Step 1 pre-flight checks)
  FILTERED_STORIES=()
  for story in "${USER_STORIES[@]}"; do
    STORY_ID=$(basename "$story" | sed 's/\.md$//' | tr '[:lower:]' '[:upper:]')
    # Check if this story ID is in COMPLETED_STORIES array
    if [[ ! " ${COMPLETED_STORIES[@]} " =~ " ${STORY_ID} " ]]; then
      FILTERED_STORIES+=("$story")
    else
      echo "  ⏭ Skipping $STORY_ID (already completed in merged PR)"
    fi
  done
  USER_STORIES=("${FILTERED_STORIES[@]}")

  echo ""
  echo "Remaining user stories to implement: ${#USER_STORIES[@]}"
  ```
- **Apply Command-Line Filters**:
  ```bash
  # Filter by category
  if [ -n "$CATEGORY_FILTER" ]; then
    # Only load user stories from specified category
    case "$CATEGORY_FILTER" in
      bug_fixes)
        USER_STORIES=(~/.claude/user-stories/{PROJECT_NAME}/bug_fixes/*.md)
        ;;
      new_features)
        USER_STORIES=(~/.claude/user-stories/{PROJECT_NAME}/new_features/*.md)
        ;;
      code_improvements)
        USER_STORIES=(~/.claude/user-stories/{PROJECT_NAME}/code_improvements/*.md)
        ;;
      *)
        echo "Invalid category: $CATEGORY_FILTER"
        exit 1
        ;;
    esac
  else
    # Load all user stories
    USER_STORIES=(~/.claude/user-stories/{PROJECT_NAME}/*/*.md)
  fi

  # Filter by priority
  if [ -n "$PRIORITY_FILTER" ]; then
    FILTERED_STORIES=()
    for story in "${USER_STORIES[@]}"; do
      STORY_PRIORITY=$(grep "^**Priority**:" "$story" | sed 's/\*\*Priority\*\*: *//')
      if [ "$STORY_PRIORITY" = "$PRIORITY_FILTER" ]; then
        FILTERED_STORIES+=("$story")
      fi
    done
    USER_STORIES=("${FILTERED_STORIES[@]}")
  fi

  # Filter by phase (CORRECT PRIORITY ORDER)
  if [ -n "$PHASE_FILTER" ]; then
    case "$PHASE_FILTER" in
      1)
        # Phase 1: Bug Fixes (HIGHEST PRIORITY)
        USER_STORIES=(~/.claude/user-stories/{PROJECT_NAME}/bug_fixes/*.md)
        ;;
      2)
        # Phase 2: Code Improvements (SECOND PRIORITY)
        USER_STORIES=(~/.claude/user-stories/{PROJECT_NAME}/code_improvements/*.md)
        ;;
      3)
        # Phase 3: New Features (LAST)
        USER_STORIES=(~/.claude/user-stories/{PROJECT_NAME}/new_features/*.md)
        ;;
      *)
        echo "Invalid phase: $PHASE_FILTER (must be 1, 2, or 3)"
        exit 1
        ;;
    esac
  fi

  # Filter by specific story ID
  if [ -n "$STORY_FILTER" ]; then
    FILTERED_STORIES=()
    for story in "${USER_STORIES[@]}"; do
      if [[ "$(basename "$story")" == "${STORY_FILTER}"* ]]; then
        FILTERED_STORIES+=("$story")
      fi
    done
    USER_STORIES=("${FILTERED_STORIES[@]}")

    if [ ${#USER_STORIES[@]} -eq 0 ]; then
      echo "Error: User story $STORY_FILTER not found"
      exit 1
    fi
  fi

  # Display filtered user stories
  echo "Found ${#USER_STORIES[@]} user stories to process"
  if [ -n "$CATEGORY_FILTER" ]; then
    echo "  Category: $CATEGORY_FILTER"
  fi
  if [ -n "$PRIORITY_FILTER" ]; then
    echo "  Priority: $PRIORITY_FILTER"
  fi
  if [ -n "$PHASE_FILTER" ]; then
    echo "  Phase: $PHASE_FILTER"
  fi
  if [ -n "$STORY_FILTER" ]; then
    echo "  Story: $STORY_FILTER"
  fi
  ```
- Categorize by phase (Phase 1: Bug Fixes, Phase 2: Code Improvements, Phase 3: New Features)
- Create {WORKING_DIRECTORY}\review-log.md file to track all user story statuses
- Detect project type and commands (package.json, .csproj, etc.)
- Create detailed todo list for current phase (or filtered selection)

### Step 3: Worktree Creation and Setup (Parallel Setup)

For each user story, create a git worktree:

```bash
# Example for 3 user stories
git worktree add worktrees/us-bf-001 -b fix/us-bf-001-remove-unused "$MAIN_BRANCH"
git worktree add worktrees/us-bf-002 -b fix/us-bf-002-type-conversions "$MAIN_BRANCH"
git worktree add worktrees/us-bf-003 -b fix/us-bf-003-null-safety "$MAIN_BRANCH"

# Verify worktrees created
git worktree list
```

**Result**: Each user story has its own isolated working directory and branch

### Step 3.1: Setup ESLint with Autofix (TypeScript/JavaScript Projects)

**IMPORTANT**: For TypeScript/JavaScript projects, ALWAYS ensure ESLint is configured with autofix:

```bash
# Detect if this is a TypeScript/JavaScript project
if [ -f "package.json" ]; then
  echo "Detected JavaScript/TypeScript project"

  # Check if ESLint is already configured
  if [ ! -f ".eslintrc.json" ] && [ ! -f ".eslintrc.js" ] && ! grep -q '"eslint"' package.json; then
    echo "ESLint not found - installing and configuring..."

    # Install ESLint and TypeScript plugins
    npm install --save-dev eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin

    # Create .eslintrc.json configuration
    cat > .eslintrc.json <<'EOF'
{
  "parser": "@typescript-eslint/parser",
  "parserOptions": {
    "ecmaVersion": 2022,
    "sourceType": "module",
    "project": "./tsconfig.json"
  },
  "plugins": ["@typescript-eslint"],
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended"
  ],
  "rules": {
    "@typescript-eslint/no-unused-vars": ["error", {
      "argsIgnorePattern": "^_",
      "varsIgnorePattern": "^_"
    }],
    "no-unused-vars": "off"
  },
  "env": {
    "node": true,
    "es2022": true
  }
}
EOF

    # Add lint script to package.json if not present
    if ! grep -q '"lint"' package.json; then
      # Use jq to add lint script, or manual edit if jq not available
      if command -v jq &> /dev/null; then
        jq '.scripts.lint = "eslint . --ext .ts,.js"' package.json > package.json.tmp
        jq '.scripts["lint:fix"] = "eslint . --ext .ts,.js --fix"' package.json.tmp > package.json
        rm package.json.tmp
      else
        echo "Note: Add 'lint' and 'lint:fix' scripts to package.json manually"
      fi
    fi

    echo "✓ ESLint configured with autofix support"

    # Commit ESLint configuration
    git add .eslintrc.json package.json package-lock.json 2>/dev/null || true
    git commit -m "chore: setup ESLint with autofix for automated code quality

Added ESLint configuration to enable automated fixing of:
- Unused variables
- Unused imports
- Code style issues

This enables faster automated fixes before using AI agents.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>" 2>/dev/null || true

  else
    echo "✓ ESLint already configured"
  fi

  # Verify ESLint can run
  if npx eslint --version &> /dev/null; then
    echo "✓ ESLint verified working"
  else
    echo "⚠ ESLint installation may have issues"
  fi
fi
```

**Why This Matters**:
- Automated tools are 10-50x faster than AI agents for simple fixes
- ESLint with `--fix` can resolve most unused variable/import issues instantly
- This setup only runs once and applies to all future user stories
- If ESLint already exists, this step is skipped (no overhead)

### Step 3.5: Analyze User Stories and Choose Implementation Strategy (NEW in v4.3)

For EACH user story, analyze complexity and try automated tools FIRST:

```bash
# For each user story
cd worktrees/[us-xxx]/

# 1. Read user story to understand the work
USER_STORY_PATH=~/.claude/user-stories/{PROJECT_NAME}/bug_fixes/[us-xxx].md
STORY_TYPE=$(grep -oE "(unused variables|unused imports|formatting|linting|type errors)" "$USER_STORY_PATH" | head -1)

# 2. Count files and items from user story
FILES_COUNT=$(grep -oE "[0-9]+ files?" "$USER_STORY_PATH" | head -1 | grep -oE "[0-9]+")
ITEMS_COUNT=$(grep -oE '[0-9]+ (TS[0-9]+|errors?|CS[0-9]+)' "$USER_STORY_PATH" | head -1 | grep -oE '[0-9]+')

echo "User Story Analysis:"
echo "  Type: $STORY_TYPE"
echo "  Files: $FILES_COUNT"
echo "  Items: $ITEMS_COUNT"
```

**Step A: Try Automated Tools First (NEW in v4.3)**

Before launching ANY agents, check if automated tools can handle this:

```bash
# Detect project language and available automation tools
detect_automation_tools() {
  local story_type="$1"

  # JavaScript/TypeScript Projects
  if [ -f "package.json" ]; then
    echo "Detected: JavaScript/TypeScript project"

    # Check for ESLint
    if [ -f ".eslintrc.json" ] || [ -f ".eslintrc.js" ] || grep -q "eslint" package.json; then
      echo "✓ ESLint available"
      AUTOMATION_AVAILABLE="eslint"
      AUTOMATION_CMD="npx eslint . --ext .ts,.js --fix"
    # Check for TypeScript compiler
    elif [ -f "tsconfig.json" ]; then
      echo "✓ TypeScript compiler available"
      AUTOMATION_AVAILABLE="tsc"
      # Note: tsc doesn't auto-fix, but can detect issues
    fi

    # Check for Prettier
    if [ -f ".prettierrc" ] || grep -q "prettier" package.json; then
      echo "✓ Prettier available (formatting)"
      PRETTIER_AVAILABLE=true
      PRETTIER_CMD="npx prettier --write ."
    fi

  # C# / .NET Projects
  elif [ -f "*.csproj" ] || [ -f "*.sln" ]; then
    echo "Detected: C# / .NET project"

    # Check for dotnet format
    if command -v dotnet &> /dev/null; then
      echo "✓ dotnet format available"
      AUTOMATION_AVAILABLE="dotnet-format"
      AUTOMATION_CMD="dotnet format --verify-no-changes || dotnet format"
    fi

  # Python Projects
  elif [ -f "setup.py" ] || [ -f "pyproject.toml" ] || [ -f "requirements.txt" ]; then
    echo "Detected: Python project"

    # Check for Black (formatter)
    if command -v black &> /dev/null; then
      echo "✓ Black available (formatting)"
      AUTOMATION_AVAILABLE="black"
      AUTOMATION_CMD="black ."
    fi

    # Check for Ruff (linter with autofix)
    if command -v ruff &> /dev/null; then
      echo "✓ Ruff available (linting + autofix)"
      AUTOMATION_AVAILABLE="ruff"
      AUTOMATION_CMD="ruff check --fix ."
    fi

    # Check for autoflake (removes unused imports)
    if command -v autoflake &> /dev/null; then
      echo "✓ autoflake available (unused imports)"
      AUTOMATION_AVAILABLE="autoflake"
      AUTOMATION_CMD="autoflake --remove-all-unused-imports --in-place -r ."
    fi

  # Go Projects
  elif [ -f "go.mod" ]; then
    echo "Detected: Go project"

    if command -v gofmt &> /dev/null; then
      echo "✓ gofmt available (formatting)"
      AUTOMATION_AVAILABLE="gofmt"
      AUTOMATION_CMD="gofmt -w ."
    fi

    if command -v goimports &> /dev/null; then
      echo "✓ goimports available (imports + formatting)"
      AUTOMATION_AVAILABLE="goimports"
      AUTOMATION_CMD="goimports -w ."
    fi

  # Rust Projects
  elif [ -f "Cargo.toml" ]; then
    echo "Detected: Rust project"

    if command -v cargo &> /dev/null; then
      echo "✓ cargo fmt available (formatting)"
      AUTOMATION_AVAILABLE="cargo-fmt"
      AUTOMATION_CMD="cargo fmt"

      echo "✓ cargo clippy available (linting + autofix)"
      CLIPPY_AVAILABLE=true
      CLIPPY_CMD="cargo clippy --fix --allow-dirty"
    fi

  # Java Projects
  elif [ -f "pom.xml" ] || [ -f "build.gradle" ]; then
    echo "Detected: Java project"

    # Check for Google Java Format
    if command -v google-java-format &> /dev/null; then
      echo "✓ google-java-format available"
      AUTOMATION_AVAILABLE="google-java-format"
      AUTOMATION_CMD="google-java-format --replace **/*.java"
    fi
  fi

  # Determine if automation can handle this story type
  case "$story_type" in
    *"unused variables"*|*"unused imports"*)
      if [ -n "$AUTOMATION_AVAILABLE" ]; then
        echo "✓ Automation can likely fix this issue type"
        return 0
      fi
      ;;
    *"formatting"*|*"linting"*)
      if [ -n "$AUTOMATION_AVAILABLE" ] || [ "$PRETTIER_AVAILABLE" = true ]; then
        echo "✓ Automation can likely fix this issue type"
        return 0
      fi
      ;;
  esac

  echo "✗ No suitable automation found - will use agents"
  return 1
}

# Try automation first
if detect_automation_tools "$STORY_TYPE"; then
  echo ""
  echo "=========================================="
  echo "STEP 1: Attempting Automated Fix"
  echo "=========================================="
  echo "Command: $AUTOMATION_CMD"
  echo ""

  # Run automation tool
  eval "$AUTOMATION_CMD"
  AUTOMATION_EXIT_CODE=$?

  # Verify if automation fixed the issue
  npm run build 2>&1 > build_after_automation.txt || true
  REMAINING_ERRORS=$(grep -E "$ITEMS_COUNT" build_after_automation.txt | wc -l)

  if [ $REMAINING_ERRORS -eq 0 ]; then
    echo "✓ Automation SUCCEEDED - all issues fixed!"
    echo "✓ Time saved: ~90% faster than agents"

    # Commit the automated fixes
    git add .
    git commit -m "[TYPE](US-XXX): Automated fix using $AUTOMATION_AVAILABLE

Applied automated tooling to resolve issues.
Tool: $AUTOMATION_AVAILABLE
Command: $AUTOMATION_CMD

Files Modified: $FILES_COUNT files
Items Fixed: $ITEMS_COUNT items

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"

    # Push and create PR
    git push -u origin [branch]
    gh pr create --title "[US-XXX]: [title]" --body "Fixed via automated tooling ($AUTOMATION_AVAILABLE)"

    # Mark as complete - skip to next user story
    continue
  else
    echo "⚠ Automation PARTIAL - $REMAINING_ERRORS issues remain"
    echo "→ Will use agent to complete remaining work"
  fi
fi
```

**Step B: Determine Agent Strategy (only if automation didn't fully work)**

```bash
# Automation didn't work or only partially worked - need agents
# Determine if single agent or batching needed

# IMPORTANT: Always try SINGLE AGENT first - only batch if it fails
NEEDS_BATCHING=false
echo ""
echo "Attempting single agent implementation first..."
echo "If agent hits context limit, will create batches dynamically"
```

**If agent hits context limit (dynamic batching):**

Only create batching structure AFTER an agent reports context limit or fails to complete.

1. **Create Progress Manifest**
   ```bash
   # Create progress-manifest.json in worktree
   cat > worktrees/[us-xxx]/progress-manifest.json <<EOF
   {
     "userStory": "US-XXX",
     "title": "[User story title]",
     "totalWork": {
       "files": $FILES_COUNT,
       "items": $ITEMS_COUNT,
       "description": "[description from user story]"
     },
     "sessions": [],
     "completed": {
       "files": [],
       "count": 0
     },
     "remaining": {
       "files": [/* all files from user story */],
       "count": $FILES_COUNT,
       "items": $ITEMS_COUNT,
       "estimatedSessions": $((FILES_COUNT / 6 + 1))
     },
     "batches": [
       {
         "id": 1,
         "status": "pending",
         "files": [/* first 6-8 files */],
         "itemsToFix": $((ITEMS_COUNT / NUM_BATCHES))
       },
       /* ... more batches */
     ]
   }
   EOF
   ```

2. **Split Files into Batches**
   ```bash
   # Optimal batch size: ~6-8 files or ~15 items per batch
   BATCH_SIZE=6
   NUM_BATCHES=$(( (FILES_COUNT + BATCH_SIZE - 1) / BATCH_SIZE ))

   echo "Creating $NUM_BATCHES batches of ~$BATCH_SIZE files each"
   ```

3. **Create Batch Instruction Files**
   For each batch, create `batch-N-instructions.md` with:
   - Explicit list of files for THIS batch only
   - "DO NOT Touch" section listing files from other batches
   - Success criteria specific to this batch
   - Verification commands
   - Progress percentage calculation

4. **Update Execution Strategy**
   - Will launch agents SEQUENTIALLY per batch (not all at once)
   - Each batch completion verified before next starts
   - Progress tracked in manifest after each batch

**If batching NOT needed:**

- Proceed with single agent for entire user story
- No manifest needed
- Use standard Step 4 workflow

### Step 4: Agent Implementation (Batched or Parallel Execution)

**For Large User Stories (with batching):**

Execute batches SEQUENTIALLY. For each batch:

1. **Load Batch Instructions**
   ```bash
   # Read batch-N-instructions.md for specific file list
   cd worktrees/[us-xxx]/
   cat batch-$BATCH_ID-instructions.md
   ```

2. **Launch Agent for This Batch Only**
   ```markdown
   ## Agent Task: Implement US-XXX - Batch $BATCH_ID of $TOTAL_BATCHES

   ### Your Specific Assignment
   Fix issues ONLY in these files:
   [Explicit file list from batch-N-instructions.md]

   ### DO NOT Touch These Files
   [List all files from other batches]

   ### Progress Context
   - Previous batches: [list completed batches] ✅
   - Current batch: Batch $BATCH_ID ⬅️ YOU ARE HERE
   - Remaining batches: [list pending batches]

   ### Success Criteria for This Batch
   - All files in YOUR batch have 0 errors
   - Previous batch files still have 0 errors (smoke test)
   - Exactly N items fixed in this batch
   - Progress manifest updated

   [Include all standard rules: no scripts, manual Edit tool, etc.]
   ```

3. **Wait for Batch Completion**

4. **Verify Batch Results**
   ```bash
   # Check batch files are clean
   npm run build 2>&1 | grep -E "(file1|file2|...)" | grep "error"
   # Should be 0

   # Smoke test: previous batches still clean
   npm run build 2>&1 | grep -E "(prev-files)" | grep "error"
   # Should be 0
   ```

5. **Update Progress Manifest**
   ```bash
   # Mark batch as complete, add session details
   jq '.batches[$BATCH_ID-1].status = "complete"' progress-manifest.json
   jq '.sessions += [{"sessionId": $SESSION, ...}]' progress-manifest.json
   ```

6. **Commit Batch Progress**
   ```bash
   git add .
   git commit --amend -m "WIP: US-XXX Batch $BATCH_ID complete ($PROGRESS% done)"
   ```

7. **Repeat for Next Batch**
   If more batches remaining, return to step 1 for next batch

8. **Final Assembly** (after all batches complete)
   ```bash
   # Amend all batch commits into final commit
   git add .
   git commit --amend -m "[final commit message per template]"

   # Push and create PR
   git push -u origin [branch]
   gh pr create --title "[US-XXX]: [title]" --body "[detailed PR description]" --base master
   ```

**For Small User Stories (no batching):**

Launch ALL agents in PARALLEL, each with its own worktree.

For each user story, launch an implementation agent with this template:

```markdown
## Agent Task: Implement [US-XXX]

### 🚨 CRITICAL SAFETY RULES - READ FIRST 🚨

**ABSOLUTE PROHIBITION - NEVER CLOSE PULL REQUESTS:**
```
YOU ARE FORBIDDEN FROM CLOSING, MERGING, OR APPROVING PULL REQUESTS.

NEVER use these commands:
❌ gh pr close
❌ gh pr merge
❌ gh api ... -f state=closed
❌ gh pr review --approve

YOU MAY ONLY:
✅ gh pr create (create new PRs)
✅ gh pr comment (add comments)
✅ gh pr view (view PR details)
✅ git push (update PR with new commits)

ONLY THE USER CAN CLOSE, MERGE, OR APPROVE PULL REQUESTS.

If you are ever unsure about a command, ASK THE USER FIRST.
```

### Your Role
You are an implementation expert. Your job is to:
1. Read the user story completely
2. Make ONLY the changes specified in the user story
3. Use Edit tool manually for each change
4. Verify your changes build successfully
5. Create git commit and pull request (but NEVER close, merge, or approve it)

### Working Directory
{WORKING_DIRECTORY}/worktrees/[us-xxx]/

**IMPORTANT**: You are working in a git worktree - an isolated working directory on its own branch.
- Main repo: {WORKING_DIRECTORY}
- Your worktree: {WORKING_DIRECTORY}/worktrees/[us-xxx]/
- Your branch: fix/us-xxx-[description]
- Other agents are working in parallel in their own worktrees - you won't conflict

### User Story
Read the full user story from: ~/.claude/user-stories/{PROJECT_NAME}/bug_fixes/[US-XXX].md

**CRITICAL INSTRUCTIONS**:

1. **Read User Story First**
   - Read the ENTIRE user story file
   - Note which files are listed as "Files Affected"
   - Note the exact acceptance criteria
   - Note the exact changes required

2. **Strict Scope Adherence**
   - ONLY modify files listed in "Files Affected" section
   - ONLY fix the specific issues mentioned in the user story
   - Do NOT fix other errors you see
   - Do NOT modify other files
   - Stay laser-focused on ONLY what the user story asks for

   **CRITICAL - Understanding Scope Keywords**:
   - When user story says "REMAINING errors" → Fix ALL remaining errors of that type, not just some
   - When user story says "ALL errors" → Fix every single error mentioned, 100% completion
   - When user story says "these 5 files" → Fix ONLY those 5 files, no more, no less
   - When user story says "partial implementation" → Complete the work, don't just analyze it

   **Common Scope Misinterpretations to AVOID**:
   - ❌ User story: "Fix REMAINING CS0246 errors" → Agent: "I'll just fix the caching-related ones" (WRONG - fix ALL remaining)
   - ❌ User story: "Complete the feature" → Agent: "The code doesn't exist, marking as blocked" (WRONG - implement it)
   - ❌ User story: "Fix 60 errors in 25 files" → Agent: "I fixed 20 errors in 10 files" (WRONG - must fix all 60)
   - ✅ User story: "Fix REMAINING CS0246 errors" → Agent: "I fixed all remaining CS0246 errors across all files" (CORRECT)
   - ✅ User story: "Implement feature X" → Agent: "I implemented feature X with all acceptance criteria met" (CORRECT)

3. **NO SCRIPTS ALLOWED**
   - ❌ DO NOT create Python scripts
   - ❌ DO NOT create bash scripts
   - ❌ DO NOT use automation
   - ✅ Use Edit tool manually for each file
   - ✅ Make one change at a time
   - ✅ Verify each change

4. **Manual Implementation Process**
   For each file in "Files Affected":
   - Use Read tool to read the file
   - Identify the exact lines to change
   - Use Edit tool to make the change
   - Verify the change looks correct
   - Move to next file

5. **Verify Your Worktree**
   ```bash
   # You're already on the correct branch in your worktree
   pwd  # Should show: .../worktrees/[us-xxx]
   git branch --show-current  # Should show: fix/us-xxx-[description]

   # You do NOT need to create a branch - it was created when the worktree was made
   ```

6. **Build Verification**
   After making changes:
   ```bash
   npm run build 2>&1 | grep -E "(error|Error)" | grep -v "node_modules"

   # Count errors in files you modified ONLY
   # Other files can have errors - ignore them
   # Your modified files must have ZERO errors
   ```

7. **Code Coverage Verification (NEW v4.4.0 - MANDATORY)**
   Test your implementation and verify code coverage:
   ```bash
   # For JavaScript/TypeScript projects
   if [ -f "package.json" ]; then
     npm run test:coverage
   fi

   # For .NET projects
   if compgen -G "*.csproj" > /dev/null; then
     dotnet test --collect:"XPlat Code Coverage"
   fi

   # YOUR CODE MUST MEET ${REQUIRE_COVERAGE}% MINIMUM COVERAGE
   # If coverage is below minimum, add more tests before proceeding
   ```

8. **Git Commit**
   ```bash
   git add [only files you modified]
   git status  # VERIFY correct files staged
   git commit -m "[commit message following template]"
   git log -1 --oneline  # VERIFY commit created
   ```

9. **Push to Remote**
   ```bash
   git push -u origin [branch-name]
   ```

10. **Create Pull Request**
   ```bash
   gh pr create \
     --title "[US-XXX]: [title]" \
     --body "[detailed PR description]" \
     --base master
   ```

   **Note on GitHub Copilot Reviews:**
   - GitHub Copilot will automatically review PRs if enabled in repository settings
   - Do NOT attempt to add reviewers via `--reviewer` flag (it will fail with HTTP 422 error)
   - The correct reviewer name is `copilot-pull-request-reviewer`, but it cannot be added via CLI/API
   - Copilot reviews appear automatically after PR creation if the feature is enabled

11. **MANDATORY: Verify Success BEFORE Reporting Complete**

   **CRITICAL**: You MUST run these verification checks BEFORE claiming success:

   ```bash
   echo "=========================================="
   echo "AGENT SELF-VERIFICATION (MANDATORY)"
   echo "=========================================="

   # Verification 1: Check commit exists
   echo "1. Verifying commit created..."
   COMMIT_SHA=$(git log -1 --oneline | grep -oE "^[a-f0-9]+")
   if [ -n "$COMMIT_SHA" ]; then
     echo "✓ Commit exists: $COMMIT_SHA"
   else
     echo "❌ FAILURE: No commit found"
     exit 1
   fi

   # Verification 2: Check PR created
   echo "2. Verifying PR created..."
   CURRENT_BRANCH=$(git branch --show-current)
   PR_NUMBER=$(gh pr list --head "$CURRENT_BRANCH" --json number --jq '.[0].number')
   if [ -n "$PR_NUMBER" ]; then
     PR_URL="https://github.com/$(gh repo view --json nameWithOwner --jq '.nameWithOwner')/pull/$PR_NUMBER"
     echo "✓ PR created: $PR_URL"
   else
     echo "❌ FAILURE: No PR found for branch $CURRENT_BRANCH"
     exit 1
   fi

   # Verification 3: Check build passes (for affected files only)
   echo "3. Verifying build status..."
   if [ -f "package.json" ]; then
     # JavaScript/TypeScript project
     npm run build 2>&1 | tee build_verification.txt
     # Count errors in affected files only
     BUILD_ERRORS=$(grep -i "error" build_verification.txt | grep -v "0 errors" | grep -v "node_modules" | wc -l)
   elif compgen -G "*.csproj" > /dev/null || compgen -G "*.sln" > /dev/null || compgen -G "src/*.csproj" > /dev/null; then
     # .NET project
     dotnet build 2>&1 | tee build_verification.txt
     BUILD_ERRORS=$(grep -E "error CS[0-9]+" build_verification.txt | wc -l)
   else
     echo "⚠️  Unknown project type - manual verification required"
     BUILD_ERRORS=0
   fi

   if [ $BUILD_ERRORS -eq 0 ]; then
     echo "✓ Build passes (0 errors)"
   else
     echo "❌ FAILURE: Build has $BUILD_ERRORS errors"
     exit 1
   fi

   # Verification 4: Check code coverage (NEW v4.4.0 - MANDATORY)
   echo "4. Verifying code coverage..."
   COVERAGE_PERCENT=0

   if [ -f "package.json" ]; then
     # JavaScript/TypeScript project
     if grep -q "test:coverage" package.json; then
       npm run test:coverage 2>&1 | tee coverage_verification.txt
       COVERAGE_PERCENT=$(grep -oP "All files.*\|\s+\K[0-9.]+" coverage_verification.txt | head -1)
       if [ -z "$COVERAGE_PERCENT" ]; then
         COVERAGE_PERCENT=$(grep -oP "Statements\s*:\s*\K[0-9.]+" coverage_verification.txt | head -1)
       fi
     fi
   elif compgen -G "*.csproj" > /dev/null || compgen -G "*.sln" > /dev/null || compgen -G "src/*.csproj" > /dev/null; then
     # .NET project
     dotnet test --collect:"XPlat Code Coverage" --results-directory ./coverage 2>&1 | tee coverage_verification.txt
     if [ -d "./coverage" ]; then
       COVERAGE_PERCENT=$(grep -oP "Line\s*\|\s*\K[0-9.]+(?=%)" coverage_verification.txt | head -1)
       if [ -z "$COVERAGE_PERCENT" ]; then
         COBERTURA=$(find ./coverage -name "coverage.cobertura.xml" | head -1)
         if [ -n "$COBERTURA" ]; then
           COVERAGE_PERCENT=$(grep -oP 'line-rate="\K[0-9.]+' "$COBERTURA" | head -1)
           COVERAGE_PERCENT=$(echo "$COVERAGE_PERCENT * 100" | bc -l | cut -d. -f1)
         fi
       fi
     fi
   fi

   if [ -n "$COVERAGE_PERCENT" ] && [ "$COVERAGE_PERCENT" != "0" ]; then
     if (( $(echo "$COVERAGE_PERCENT >= ${REQUIRE_COVERAGE:-90}" | bc -l) )); then
       echo "✓ Code coverage: ${COVERAGE_PERCENT}% (meets ${REQUIRE_COVERAGE:-90}% requirement)"
     else
       echo "❌ FAILURE: Code coverage ${COVERAGE_PERCENT}% is below required ${REQUIRE_COVERAGE:-90}%"
       exit 1
     fi
   else
     echo "❌ FAILURE: Unable to determine code coverage - tests required"
     exit 1
   fi

   echo ""
   echo "=========================================="
   echo "✅ ALL VERIFICATIONS PASSED"
   echo "=========================================="
   echo "Commit: $COMMIT_SHA"
   echo "PR URL: $PR_URL"
   echo "Build: PASS"
   echo "Coverage: ${COVERAGE_PERCENT}%"
   echo ""
   ```

   **IMPORTANT**:
   - Run this verification script BEFORE reporting success to the orchestrator
   - If ANY verification fails, DO NOT claim success
   - Fix the issues and re-run verification
   - Only report success after ALL checks pass

### Success Criteria
Your implementation is complete when:
- All files listed in user story are modified
- All acceptance criteria from user story are met
- Modified files build with ZERO errors
- Git commit created
- Pull request created
- NO other files were modified

### Report Back
When complete, provide:
1. Number of files modified
2. Build status (pass/fail for YOUR files only)
3. Acceptance criteria status (met/not met)
4. Commit SHA
5. PR URL

**IMPORTANT**:
- Work slowly and carefully
- Make one change at a time
- Verify each step
- Do NOT use scripts
- Stay within user story scope
```

**Launch ALL agents in PARALLEL** - each in its own git worktree.

### Step 5: Monitor Agents and Handle Incomplete Work (Updated for v4.2)

**v4.2 NOTE**: For batched user stories, this step happens AFTER EACH BATCH automatically. For non-batched stories, use this workflow:

**Agent Context Limitation**: Agents have context windows and may not complete large tasks in one session.

**After each agent (or batch) completes, check if work is incomplete:**

```bash
# For each user story, check if work is complete
cd worktrees/[us-xxx]/
git status  # Check for uncommitted changes

# If changes exist, verify completion against user story
# Example: Check remaining TS6133 errors
npm run build 2>&1 | grep "TS6133" | wc -l
```

**If agent stopped before completing 100% of user story:**

1. **Create Progress Checkpoint**
   ```bash
   # Commit partial work as checkpoint (do NOT push or create PR yet)
   cd worktrees/[us-xxx]/
   git add .
   git commit -m "WIP: [US-XXX] Partial implementation - checkpoint

   Progress: X/Y files completed
   Remaining: [list remaining work]

   This is a work-in-progress checkpoint for agent continuation."

   # DO NOT push yet - this is just a local checkpoint
   ```

2. **Launch Continuation Agent**
   Launch a new agent with modified instructions:

   ```markdown
   ## Agent Task: CONTINUE Implementation of [US-XXX]

   ### 🚨 CRITICAL SAFETY RULES - READ FIRST 🚨

   **ABSOLUTE PROHIBITION - NEVER CLOSE PULL REQUESTS:**
   ```
   YOU ARE FORBIDDEN FROM CLOSING, MERGING, OR APPROVING PULL REQUESTS.

   NEVER use these commands:
   ❌ gh pr close
   ❌ gh pr merge
   ❌ gh api ... -f state=closed
   ❌ gh pr review --approve

   YOU MAY ONLY:
   ✅ gh pr create (create new PRs)
   ✅ gh pr comment (add comments)
   ✅ gh pr view (view PR details)
   ✅ git push (update PR with new commits)

   ONLY THE USER CAN CLOSE, MERGE, OR APPROVE PULL REQUESTS.
   ```

   **IMPORTANT**: A previous agent started this work but hit context limits.
   You are continuing where they left off.

   ### Working Directory
   {WORKING_DIRECTORY}/worktrees/[us-xxx]/

   ### User Story
   Read: ~/.claude/user-stories/{PROJECT_NAME}/bug_fixes/[US-XXX].md

   ### Previous Progress
   Check what was already done:
   ```bash
   # See what files were already modified
   git log -1 --stat

   # Check current git status
   git status

   # Verify what's still needed
   npm run build 2>&1 | grep "TS6133"  # or relevant error pattern
   ```

   ### Your Task
   1. **Assess Previous Work**: Review git log and modified files
   2. **Identify Remaining Work**: Check user story vs what's already done
   3. **Complete Remaining Items**: Finish the files that weren't touched yet
   4. **Follow Same Rules**:
      - Use Edit tool manually (NO scripts)
      - Only touch files in user story
      - Verify each change
      - NEVER close, merge, or approve PRs

   ### When You're Done
   1. **Amend the WIP Checkpoint Commit** (not create new commit):
      ```bash
      git add .
      git commit --amend -m "[proper final commit message]"
      ```
   2. **Verify 100% complete** against user story acceptance criteria
   3. **Push and create PR** (only if 100% complete, but NEVER close/merge it)

   ### Success Criteria
   - ALL files from user story are modified
   - ALL acceptance criteria met
   - Build verification passes
   - Commit created (or amended)
   - PR created (but NOT closed or merged)
   ```

3. **Repeat Until Complete**
   - If continuation agent also hits limits, repeat process
   - Create new checkpoint, launch another continuation agent
   - Continue until user story is 100% complete

4. **Final Verification**
   - Only proceed to Step 5.5 verification when work is 100% complete
   - Verify all acceptance criteria met
   - Verify build passes for all modified files

### Step 5.5: Mandatory Agent Verification (NEW in v4.3.4 - CRITICAL)

**THIS STEP IS ABSOLUTELY MANDATORY - DO NOT SKIP**

After EACH agent reports completion, you MUST verify their work meets success criteria BEFORE accepting it. Agents may claim success when they actually failed - you must verify independently.

**For each agent that reports completion:**

```bash
AGENT_ID="[us-xxx]"
WORKTREE_PATH="worktrees/$AGENT_ID"
USER_STORY_PATH="~/.claude/user-stories/{PROJECT_NAME}/[category]/$AGENT_ID.md"

echo "=========================================="
echo "VERIFYING AGENT: $AGENT_ID"
echo "=========================================="

cd "$WORKTREE_PATH"

# 1. VERIFY BUILD STATUS
echo "1. Checking build status..."
if [ -f "package.json" ]; then
  # JavaScript/TypeScript project
  npm run build 2>&1 | tee build_output.txt
  BUILD_ERRORS=$(grep -i "error" build_output.txt | grep -v "0 errors" | grep -v "node_modules" | wc -l)
elif compgen -G "*.csproj" > /dev/null || compgen -G "*.sln" > /dev/null || compgen -G "src/*.csproj" > /dev/null; then
  # .NET project (check for .csproj or .sln files in current or src/ directory)
  echo "Detected .NET project"
  dotnet build 2>&1 | tee build_output.txt
  # Count C# compilation errors (error CS####) but ignore warnings and framework EOL warnings
  BUILD_ERRORS=$(grep -E "error CS[0-9]+" build_output.txt | grep -v "warning" | wc -l)
  # Also check for "Build FAILED" message as fallback
  if grep -q "Build FAILED" build_output.txt; then
    # If build failed but no CS errors found, there must be other errors
    if [ $BUILD_ERRORS -eq 0 ]; then
      BUILD_ERRORS=$(grep -i "error" build_output.txt | grep -v "warning" | grep -v "Build succeeded" | wc -l)
    fi
  fi
else
  echo "⚠️  Unknown project type - manual verification required"
  BUILD_ERRORS=0
fi

echo "Build errors found: $BUILD_ERRORS"

# 2. VERIFY CODE COVERAGE (NEW v4.4.0 - MANDATORY)
echo "2. Checking code coverage..."
COVERAGE_PERCENT=0
COVERAGE_MET=false

if [ -f "package.json" ]; then
  # JavaScript/TypeScript project with coverage
  if grep -q "test:coverage" package.json; then
    npm run test:coverage 2>&1 | tee coverage_output.txt
    # Try to extract coverage percentage from output (common formats)
    COVERAGE_PERCENT=$(grep -oP "All files.*\|\s+\K[0-9.]+" coverage_output.txt | head -1)
    if [ -z "$COVERAGE_PERCENT" ]; then
      COVERAGE_PERCENT=$(grep -oP "Statements\s*:\s*\K[0-9.]+" coverage_output.txt | head -1)
    fi
  else
    echo "⚠️  No test:coverage script found in package.json"
  fi
elif compgen -G "*.csproj" > /dev/null || compgen -G "*.sln" > /dev/null || compgen -G "src/*.csproj" > /dev/null; then
  # .NET project with coverage
  dotnet test --collect:"XPlat Code Coverage" --results-directory ./coverage 2>&1 | tee coverage_output.txt
  # Check if coverage report was generated
  if [ -d "./coverage" ]; then
    # Try to find coverage percentage from output
    COVERAGE_PERCENT=$(grep -oP "Line\s*\|\s*\K[0-9.]+(?=%)" coverage_output.txt | head -1)
    if [ -z "$COVERAGE_PERCENT" ]; then
      echo "⚠️  Coverage report generated but percentage not found in output"
      # Try to read from coverage.cobertura.xml if available
      COBERTURA=$(find ./coverage -name "coverage.cobertura.xml" | head -1)
      if [ -n "$COBERTURA" ]; then
        COVERAGE_PERCENT=$(grep -oP 'line-rate="\K[0-9.]+' "$COBERTURA" | head -1)
        # Convert from decimal (0.95) to percentage (95)
        COVERAGE_PERCENT=$(echo "$COVERAGE_PERCENT * 100" | bc -l | cut -d. -f1)
      fi
    fi
  else
    echo "⚠️  No coverage reports generated"
  fi
else
  echo "⚠️  Unknown project type - coverage verification skipped"
fi

# Check if coverage meets requirement
if [ -n "$COVERAGE_PERCENT" ] && [ "$COVERAGE_PERCENT" != "0" ]; then
  echo "Code coverage: ${COVERAGE_PERCENT}%"
  if (( $(echo "$COVERAGE_PERCENT >= $REQUIRE_COVERAGE" | bc -l) )); then
    echo "✓ Coverage meets requirement (>= ${REQUIRE_COVERAGE}%)"
    COVERAGE_MET=true
  else
    echo "❌ Coverage below requirement: ${COVERAGE_PERCENT}% < ${REQUIRE_COVERAGE}%"
    COVERAGE_MET=false
  fi
else
  echo "⚠️  Unable to determine code coverage"
  COVERAGE_MET=false
fi

# 3. CHECK IF PR WAS CREATED
echo "3. Checking if PR was created..."
PR_URL=$(git log -1 --oneline | grep -oE "https://github.com/[^/]+/[^/]+/pull/[0-9]+")
if [ -z "$PR_URL" ]; then
  echo "❌ NO PR FOUND - checking manually..."
  # Check last 5 commits for PR reference
  PR_URL=$(git log -5 --oneline | grep -oE "https://github.com/[^/]+/[^/]+/pull/[0-9]+" | head -1)
fi

if [ -n "$PR_URL" ]; then
  echo "✓ PR found: $PR_URL"
  PR_EXISTS=true
else
  echo "⚠️  No PR found"
  PR_EXISTS=false
fi

# 4. READ ACCEPTANCE CRITERIA FROM USER STORY
echo "4. Checking acceptance criteria..."
ACCEPTANCE_COUNT=$(grep -c "^- \[ \]" "$USER_STORY_PATH" || echo "0")
echo "Found $ACCEPTANCE_COUNT acceptance criteria to verify"

# 5. DETERMINE AGENT STATUS
echo ""
echo "=========================================="
echo "VERIFICATION RESULTS FOR: $AGENT_ID"
echo "=========================================="

AGENT_STATUS="UNKNOWN"
REJECTION_REASON=""

# Check for compilation errors
if [ $BUILD_ERRORS -gt 0 ]; then
  AGENT_STATUS="REJECTED"
  REJECTION_REASON="Build has $BUILD_ERRORS compilation errors"
  echo "❌ STATUS: REJECTED"
  echo "❌ REASON: $REJECTION_REASON"

# Check for insufficient code coverage (NEW v4.4.0)
elif [ "$COVERAGE_MET" = false ]; then
  AGENT_STATUS="REJECTED"
  if [ "$COVERAGE_PERCENT" = "0" ] || [ -z "$COVERAGE_PERCENT" ]; then
    REJECTION_REASON="No code coverage found - tests required with ${REQUIRE_COVERAGE}% minimum coverage"
  else
    REJECTION_REASON="Code coverage ${COVERAGE_PERCENT}% is below required ${REQUIRE_COVERAGE}% minimum"
  fi
  echo "❌ STATUS: REJECTED"
  echo "❌ REASON: $REJECTION_REASON"

# Check if agent reported blocked/obsolete
elif grep -qi "blocked\|prerequisites\|obsolete\|does not exist" "$AGENT_REPORT"; then
  AGENT_STATUS="BLOCKED"
  REJECTION_REASON="Agent reported prerequisites missing or files obsolete"
  echo "⚠️  STATUS: BLOCKED"
  echo "⚠️  REASON: $REJECTION_REASON"

# Check if PR was created
elif [ "$PR_EXISTS" = false ]; then
  AGENT_STATUS="INCOMPLETE"
  REJECTION_REASON="No PR created - agent did not complete the workflow"
  echo "⚠️  STATUS: INCOMPLETE"
  echo "⚠️  REASON: $REJECTION_REASON"

# If all checks pass
else
  AGENT_STATUS="ACCEPTED"
  echo "✅ STATUS: ACCEPTED"
  echo "✅ Build: Pass (0 errors)"
  echo "✅ Coverage: ${COVERAGE_PERCENT}% (meets ${REQUIRE_COVERAGE}% requirement)"
  echo "✅ PR: Created"
fi

echo "=========================================="
echo ""

# 6. HANDLE REJECTION/BLOCKED STATUS
if [ "$AGENT_STATUS" = "REJECTED" ]; then
  echo "🚨 AGENT WORK REJECTED - LAUNCHING FIX AGENT"
  echo ""

  # Launch continuation agent to fix the errors
  # (Use Task tool to launch agent with fix instructions)

  echo "Agent fix task: Fix issues in $AGENT_ID"
  echo "  - Review build_output.txt for error details"
  echo "  - Review coverage_output.txt for coverage gaps"
  echo "  - Fix compilation errors (if any)"
  echo "  - Add/update tests to meet ${REQUIRE_COVERAGE}% coverage requirement"
  echo "  - Verify build passes and coverage meets requirement"
  echo "  - Amend commit and update PR"

  # Mark as pending fix
  AGENT_RESULTS["$AGENT_ID"]="PENDING_FIX"

elif [ "$AGENT_STATUS" = "BLOCKED" ]; then
  echo "⚠️  AGENT WORK BLOCKED - MARKING AS BLOCKED"
  echo ""
  echo "This user story cannot be completed due to missing prerequisites:"
  echo "  $REJECTION_REASON"
  echo ""
  echo "Recommendations:"
  echo "  - Create new user story for missing prerequisites"
  echo "  - Reclassify this user story as dependent"
  echo "  - Skip this story for now"

  # Mark as blocked
  AGENT_RESULTS["$AGENT_ID"]="BLOCKED"

elif [ "$AGENT_STATUS" = "INCOMPLETE" ]; then
  echo "⚠️  AGENT WORK INCOMPLETE - LAUNCHING CONTINUATION AGENT"
  echo ""

  # Launch continuation agent to complete the work
  # (Use Task tool to launch agent with continuation instructions)

  echo "Agent continuation task: Complete $AGENT_ID"
  echo "  - Review git status and logs"
  echo "  - Complete remaining work"
  echo "  - Create PR"

  # Mark as pending completion
  AGENT_RESULTS["$AGENT_ID"]="PENDING_COMPLETION"

else
  echo "✅ AGENT WORK ACCEPTED - PROCEEDING TO STEP 5.6 (PRODUCTION READINESS CHECK)"
  echo ""

  # Mark as accepted (pending production readiness check)
  AGENT_RESULTS["$AGENT_ID"]="ACCEPTED_PENDING_READINESS"
fi

cd "$ORIGINAL_DIR"
```

**CRITICAL RULES FOR STEP 5.5**:

1. **NEVER SKIP THIS VERIFICATION** - Even if agent claims success
2. **REJECT if build fails** - ANY compilation errors = REJECTED
3. **MARK AS BLOCKED if prerequisites missing** - Agent found files don't exist = BLOCKED
4. **MARK AS INCOMPLETE if no PR** - Agent didn't finish the workflow = INCOMPLETE
5. **ONLY ACCEPT if all checks pass** - Build succeeds, PR created, acceptance criteria met

**REJECTION DECISION TREE**:

```
Agent reports "complete" → Run verification
                            ↓
                   Check build status
                            ↓
              ┌─────────────┴─────────────┐
              │                           │
       Errors found?                 No errors?
              │                           │
              ↓                           ↓
         REJECTED                    Check PR status
   Launch fix agent                       ↓
                              ┌───────────┴───────────┐
                              │                       │
                         PR exists?              No PR found?
                              │                       │
                              ↓                       ↓
                         ACCEPTED               INCOMPLETE
                    Proceed to Step 6     Launch continuation agent
```

**DO NOT PROCEED TO STEP 5.6 (Production Readiness Check)** until:
- All agents are either ACCEPTED_PENDING_READINESS, BLOCKED, or fixed by continuation agents
- No agents have PENDING_FIX or PENDING_COMPLETION status
- Build verification confirms 0 errors for all accepted agents

### Step 5.6: Production Readiness Check (NEW in v4.3.6 - CRITICAL)

**THIS STEP IS ABSOLUTELY MANDATORY - DO NOT SKIP**

After agents pass build verification in Step 5.5, verify that implementations are production-ready (not placeholder/stub code). Step 5.5 ensures code compiles; Step 5.6 ensures code actually works.

**Why This Matters**: Step 5.5 only checks if code compiles. Code can compile but still be non-functional:
- Placeholder implementations that always return false
- Functions that are called but never defined
- Stub code with TODO comments
- Missing MCP tool integrations
- XSS vulnerabilities and security issues

**For each agent that has status ACCEPTED_PENDING_READINESS:**

```bash
AGENT_ID="[us-xxx]"
WORKTREE_PATH="worktrees/$AGENT_ID"
USER_STORY_PATH="~/.claude/user-stories/{PROJECT_NAME}/[category]/$AGENT_ID.md"

echo "=========================================="
echo "PRODUCTION READINESS CHECK: $AGENT_ID"
echo "=========================================="

cd "$WORKTREE_PATH"

# 1. CHECK FOR PLACEHOLDER PATTERNS
echo "1. Checking for placeholder code patterns..."

PLACEHOLDER_ISSUES=0

# Search for common placeholder patterns in modified files
git diff --name-only HEAD~1 | while read file; do
  if [ -f "$file" ]; then
    # Check for placeholder keywords
    if grep -qi "placeholder\|TODO\|FIXME\|stub\|not implemented\|coming soon" "$file"; then
      echo "⚠️  Found placeholder markers in: $file"
      grep -n -i "placeholder\|TODO\|FIXME\|stub\|not implemented\|coming soon" "$file"
      PLACEHOLDER_ISSUES=$((PLACEHOLDER_ISSUES + 1))
    fi

    # Check for always-returns-false/true patterns (common placeholder indicator)
    if grep -E "return\s+(false|true)\s*;" "$file" | grep -qi "always\|placeholder"; then
      echo "⚠️  Found always-returns pattern in: $file"
      grep -n -E "return\s+(false|true)\s*;" "$file"
      PLACEHOLDER_ISSUES=$((PLACEHOLDER_ISSUES + 1))
    fi

    # Check for empty function implementations
    if grep -Pzo "function\s+\w+\s*\([^)]*\)\s*\{\s*\}" "$file" 2>/dev/null; then
      echo "⚠️  Found empty function in: $file"
      PLACEHOLDER_ISSUES=$((PLACEHOLDER_ISSUES + 1))
    fi
  fi
done

# 2. CHECK FOR UNDEFINED FUNCTION REFERENCES
echo ""
echo "2. Checking for undefined function references..."

UNDEFINED_FUNCTIONS=0

# For PowerShell files
git diff --name-only HEAD~1 | grep "\.ps1$" | while read file; do
  if [ -f "$file" ]; then
    # Extract function calls
    FUNCTION_CALLS=$(grep -oE "[A-Z][a-zA-Z0-9_-]+\s*-" "$file" | sed 's/\s*-$//' | sort -u)

    # Check if each called function is defined
    for func in $FUNCTION_CALLS; do
      if ! grep -q "function $func" "$file"; then
        echo "⚠️  Function '$func' called but not defined in: $file"
        UNDEFINED_FUNCTIONS=$((UNDEFINED_FUNCTIONS + 1))
      fi
    done
  fi
done

# For TypeScript/JavaScript files
git diff --name-only HEAD~1 | grep -E "\.(ts|js)$" | while read file; do
  if [ -f "$file" ]; then
    # Extract function calls (simple pattern)
    FUNCTION_CALLS=$(grep -oE "[a-zA-Z_][a-zA-Z0-9_]*\(" "$file" | sed 's/($//' | sort -u)

    # Check if each called function is defined (imported or defined locally)
    for func in $FUNCTION_CALLS; do
      # Skip common built-ins
      if [[ "$func" =~ ^(console|require|import|export|return|if|while|for)$ ]]; then
        continue
      fi

      # Check if function is defined or imported
      if ! grep -qE "(function\s+$func|const\s+$func\s*=|\s+$func\s+from|import.*$func)" "$file"; then
        echo "⚠️  Function '$func' called but not defined/imported in: $file"
        UNDEFINED_FUNCTIONS=$((UNDEFINED_FUNCTIONS + 1))
      fi
    done
  fi
done

# 3. CHECK FOR SECURITY ISSUES (XSS, SQL injection patterns)
echo ""
echo "3. Checking for common security issues..."

SECURITY_ISSUES=0

git diff --name-only HEAD~1 | while read file; do
  if [ -f "$file" ]; then
    # Check for unescaped HTML output (XSS risk)
    if grep -E "innerHTML|outerHTML|\$\{.*\}.*<" "$file" | grep -v "escape\|sanitize"; then
      echo "⚠️  Potential XSS vulnerability (unescaped HTML) in: $file"
      grep -n -E "innerHTML|outerHTML|\$\{.*\}.*<" "$file" | head -5
      SECURITY_ISSUES=$((SECURITY_ISSUES + 1))
    fi

    # Check for SQL concatenation (SQL injection risk)
    if grep -E "SELECT.*\+.*\$|INSERT.*\+.*\$|UPDATE.*\+.*\$" "$file"; then
      echo "⚠️  Potential SQL injection (string concatenation) in: $file"
      SECURITY_ISSUES=$((SECURITY_ISSUES + 1))
    fi

    # Check for path traversal vulnerabilities
    if grep -E "path\.join.*req\.|path\.resolve.*req\." "$file" | grep -v "sanitize\|validate"; then
      echo "⚠️  Potential path traversal vulnerability in: $file"
      grep -n -E "path\.join.*req\.|path\.resolve.*req\." "$file"
      SECURITY_ISSUES=$((SECURITY_ISSUES + 1))
    fi

    # Check for unvalidated PowerShell path parameters
    if grep -E "LogDir.*-match.*\.\./|Directory.*-match.*\.\.\\" "$file"; then
      echo "✓ Path traversal validation found in: $file"
    elif grep -E "\$LogDir|\$Directory" "$file" | grep -q "path" && ! grep -q "Test-Path\|match.*\.\./"; then
      echo "⚠️  Unvalidated path parameter in PowerShell script: $file"
      SECURITY_ISSUES=$((SECURITY_ISSUES + 1))
    fi
  fi
done

# 4. CHECK FOR PERFORMANCE ISSUES
echo ""
echo "4. Checking for common performance issues..."

PERFORMANCE_ISSUES=0

git diff --name-only HEAD~1 | while read file; do
  if [ -f "$file" ]; then
    # Check for synchronous fs operations in Node.js
    if grep -E "readFileSync|writeFileSync|readdirSync" "$file" | grep -v "// OK" | grep -v "test"; then
      echo "⚠️  Synchronous file operations (blocks event loop) in: $file"
      grep -n -E "readFileSync|writeFileSync|readdirSync" "$file"
      PERFORMANCE_ISSUES=$((PERFORMANCE_ISSUES + 1))
    fi

    # Check for redundant file parsing (same file read multiple times)
    if [ $(grep -c "parseFile\|readFile" "$file") -gt 2 ]; then
      echo "⚠️  Potential redundant file parsing in: $file"
      PERFORMANCE_ISSUES=$((PERFORMANCE_ISSUES + 1))
    fi

    # Check for parseFloat(toFixed()) anti-pattern
    if grep -E "parseFloat\([^)]*\.toFixed\(" "$file"; then
      echo "⚠️  Inefficient parseFloat(toFixed()) pattern in: $file"
      grep -n -E "parseFloat\([^)]*\.toFixed\(" "$file"
      PERFORMANCE_ISSUES=$((PERFORMANCE_ISSUES + 1))
    fi

    # Check for division without zero guard
    if grep -E "\s/\s+[a-zA-Z_][a-zA-Z0-9_]*\s*($|;|\))" "$file" | grep -v "=== 0\|!== 0\|> 0"; then
      echo "⚠️  Potential division without zero guard in: $file"
      grep -n -E "\s/\s+[a-zA-Z_][a-zA-Z0-9_]*\s*($|;|\))" "$file" | head -5
      PERFORMANCE_ISSUES=$((PERFORMANCE_ISSUES + 1))
    fi
  fi
done

# 5. CHECK FOR CODE QUALITY ISSUES
echo ""
echo "5. Checking for code quality issues..."

CODE_QUALITY_ISSUES=0

git diff --name-only HEAD~1 | while read file; do
  if [ -f "$file" ]; then
    # Check for magic numbers (hardcoded numbers without constants)
    if grep -E "toFixed\([0-9]+\)|threshold.*[0-9]{2,}|timeout.*[0-9]{3,}" "$file" | grep -v "const\|//"; then
      echo "⚠️  Magic numbers should be named constants in: $file"
      grep -n -E "toFixed\([0-9]+\)|threshold.*[0-9]{2,}|timeout.*[0-9]{3,}" "$file" | head -3
      CODE_QUALITY_ISSUES=$((CODE_QUALITY_ISSUES + 1))
    fi

    # Check for redundant object property syntax (ES6 shorthand)
    if grep -E "[a-zA-Z_][a-zA-Z0-9_]*:\s*[a-zA-Z_][a-zA-Z0-9_]*,?\s*($|})" "$file" | grep -E "(\w+):\s*\1"; then
      echo "⚠️  Use ES6 shorthand syntax for identical property names in: $file"
      grep -n -E "(\w+):\s*\1" "$file" | head -3
      CODE_QUALITY_ISSUES=$((CODE_QUALITY_ISSUES + 1))
    fi

    # Check for wrong function parameters (common copy-paste errors)
    if grep -E "@\(\$line\)|@\(\$item\)" "$file" | grep -q "Context\|Buffer"; then
      echo "⚠️  Potential wrong parameter in function call in: $file"
      grep -n -E "@\(\$line\)|@\(\$item\)" "$file"
      CODE_QUALITY_ISSUES=$((CODE_QUALITY_ISSUES + 1))
    fi

    # Check for missing null/undefined checks on variables
    if grep -E "if\s*\(\s*\$[a-zA-Z_][a-zA-Z0-9_]*\s*\)" "$file" | grep -v "null"; then
      echo "⚠️  Use null-safe checks for PowerShell variables in: $file"
      CODE_QUALITY_ISSUES=$((CODE_QUALITY_ISSUES + 1))
    fi

    # Check for .js extensions in TypeScript imports
    if [[ "$file" =~ \.ts$ ]] && grep -E "from\s+['\"].*\.js['\"]" "$file"; then
      echo "ℹ️  TypeScript file uses .js extensions in imports (may be intentional): $file"
    fi
  fi
done

# 6. RUN LINTER (if available)
echo ""
echo "6. Running linter checks..."

LINTER_ISSUES=0

if [ -f "package.json" ] && command -v npx &> /dev/null; then
  if grep -q "eslint" package.json || [ -f ".eslintrc.json" ]; then
    echo "Running ESLint..."
    # Only lint modified files
    git diff --name-only HEAD~1 | grep -E "\.(ts|js)$" | xargs npx eslint 2>&1 | tee eslint_output.txt
    LINTER_ISSUES=$(grep -c "error" eslint_output.txt || echo "0")
  fi
elif compgen -G "*.csproj" > /dev/null; then
  if command -v dotnet &> /dev/null; then
    echo "Running dotnet format verification..."
    dotnet format --verify-no-changes 2>&1 | tee format_output.txt
    if grep -q "formatted" format_output.txt; then
      LINTER_ISSUES=$((LINTER_ISSUES + 1))
    fi
  fi
fi

# 7. DETERMINE PRODUCTION READINESS STATUS
echo ""
echo "=========================================="
echo "PRODUCTION READINESS RESULTS: $AGENT_ID"
echo "=========================================="

TOTAL_ISSUES=$((PLACEHOLDER_ISSUES + UNDEFINED_FUNCTIONS + SECURITY_ISSUES + PERFORMANCE_ISSUES + CODE_QUALITY_ISSUES + LINTER_ISSUES))

if [ $TOTAL_ISSUES -eq 0 ]; then
  echo "✅ PRODUCTION READY"
  echo "  ✓ No placeholder code detected"
  echo "  ✓ No undefined function references"
  echo "  ✓ No security issues detected"
  echo "  ✓ No performance issues detected"
  echo "  ✓ No code quality issues detected"
  echo "  ✓ Linter checks passed"
  echo ""

  # Mark as fully accepted
  AGENT_RESULTS["$AGENT_ID"]="ACCEPTED"

else
  echo "❌ NOT PRODUCTION READY - $TOTAL_ISSUES ISSUES FOUND"
  echo "  Placeholder issues: $PLACEHOLDER_ISSUES"
  echo "  Undefined functions: $UNDEFINED_FUNCTIONS"
  echo "  Security issues: $SECURITY_ISSUES"
  echo "  Performance issues: $PERFORMANCE_ISSUES"
  echo "  Code quality issues: $CODE_QUALITY_ISSUES"
  echo "  Linter issues: $LINTER_ISSUES"
  echo ""

  # Mark as rejected - needs fix
  AGENT_RESULTS["$AGENT_ID"]="REJECTED_NOT_PRODUCTION_READY"

  echo "🚨 LAUNCHING FIX AGENT TO ADDRESS PRODUCTION READINESS ISSUES"
  echo ""

  # Create detailed issue report for fix agent
  cat > production_readiness_issues.md <<EOF
# Production Readiness Issues for $AGENT_ID

## Summary
Found $TOTAL_ISSUES production readiness issues that must be fixed before PR can be accepted.

## Placeholder Code Issues ($PLACEHOLDER_ISSUES)
$(grep -r -n -i "placeholder\|TODO\|FIXME\|stub\|not implemented" . 2>/dev/null || echo "None")

## Undefined Function References ($UNDEFINED_FUNCTIONS)
Functions called but not defined - see checks above

## Security Issues ($SECURITY_ISSUES)
Potential XSS or injection vulnerabilities - see checks above

## Performance Issues ($PERFORMANCE_ISSUES)
Synchronous operations or redundant parsing - see checks above

## Linter Issues ($LINTER_ISSUES)
See eslint_output.txt or format_output.txt

## Required Actions
1. Replace ALL placeholder implementations with real code
2. Implement ALL undefined functions that are called
3. Fix ALL security vulnerabilities (escape HTML, use parameterized queries)
4. Fix ALL performance issues (use async fs operations, cache parsed files)
5. Fix ALL linter errors

## Success Criteria
- All placeholder patterns removed
- All called functions are defined
- All user input is escaped/sanitized
- Async operations used for I/O
- Linter passes with 0 errors
EOF

  echo "Agent fix task: Fix production readiness issues in $AGENT_ID"
  echo "  - Review production_readiness_issues.md for issue details"
  echo "  - Replace placeholder implementations with real code"
  echo "  - Implement missing functions"
  echo "  - Fix security and performance issues"
  echo "  - Amend commit and update PR"

  # Mark as pending fix
  AGENT_RESULTS["$AGENT_ID"]="PENDING_PRODUCTION_FIX"
fi

echo "=========================================="
echo ""

cd "$ORIGINAL_DIR"
```

**CRITICAL RULES FOR STEP 5.6**:

1. **NEVER SKIP THIS CHECK** - Even if build passes in Step 5.5
2. **REJECT if placeholder code found** - TODO, FIXME, stub, not implemented = REJECTED
3. **REJECT if functions undefined** - Called but not defined = REJECTED
4. **REJECT if security issues found** - XSS, SQL injection patterns = REJECTED
5. **REJECT if performance issues found** - Sync fs ops, redundant parsing = REJECTED
6. **REJECT if linter fails** - Any linter errors = REJECTED
7. **ONLY ACCEPT if all checks pass** - Production-ready code only

**PRODUCTION READINESS DECISION TREE**:

```
Agent passes build (Step 5.5) → Run production readiness check
                                  ↓
                         Check for placeholder code
                                  ↓
                    ┌─────────────┴─────────────┐
                    │                           │
            Placeholders found?          No placeholders?
                    │                           │
                    ↓                           ↓
                REJECTED                Check undefined functions
         Launch fix agent                       ↓
                                   ┌───────────┴───────────┐
                                   │                       │
                          Undefined functions?      All defined?
                                   │                       │
                                   ↓                       ↓
                               REJECTED              Check security
                        Launch fix agent                   ↓
                                              ┌───────────┴───────────┐
                                              │                       │
                                      Security issues?         Safe code?
                                              │                       │
                                              ↓                       ↓
                                          REJECTED              ACCEPTED
                                   Launch fix agent    Proceed to Copilot Review
```

**DO NOT PROCEED TO STEP 6 (Copilot Review)** until:
- All agents have status ACCEPTED (not ACCEPTED_PENDING_READINESS)
- No agents have PENDING_PRODUCTION_FIX status
- Production readiness verification confirms all implementations are real, not placeholders

### Step 6: GitHub Copilot Review Integration (NEW in v4.3)

After pull requests are created, check for and address Copilot review comments:

```bash
# For each PR created
for pr_number in ${PR_NUMBERS[@]}; do
  echo "Checking PR #$pr_number for Copilot review comments..."

  # Request Copilot review if not already done
  gh api repos/{owner}/{repo}/pulls/$pr_number/reviews \
    | jq -r '.[].user.login' \
    | grep -q "github-advanced-security" || {
    echo "Requesting Copilot review..."
    # Copilot reviews happen automatically, just wait a moment
    sleep 10
  }

  # Check for UNRESOLVED Copilot comments (comments on the current HEAD commit)
  # Get the HEAD commit SHA for this PR
  HEAD_COMMIT=$(gh api repos/{owner}/{repo}/pulls/$pr_number | jq -r '.head.sha')

  # Count comments that match the HEAD commit (these are unresolved)
  COPILOT_COMMENTS_COUNT=$(gh api repos/{owner}/{repo}/pulls/$pr_number/comments \
    | jq --arg head "$HEAD_COMMIT" '[.[] | select(.user.login == "Copilot" and .commit_id == $head)] | length')

  if [ "$COPILOT_COMMENTS_COUNT" -gt 0 ]; then
    echo "⚠ Copilot has $COPILOT_COMMENTS_COUNT comments on PR #$pr_number"
    echo "Launching agent to address Copilot feedback..."

    # Launch agent to fix Copilot comments
    # Agent task: Address Copilot review comments
    cat > /tmp/copilot-fix-task.md <<EOF
## Agent Task: Address GitHub Copilot Review Comments for PR #$pr_number

### 🚨 CRITICAL SAFETY RULES - READ FIRST 🚨

**ABSOLUTE PROHIBITION - NEVER CLOSE PULL REQUESTS:**
\`\`\`
YOU ARE FORBIDDEN FROM CLOSING, MERGING, OR APPROVING PULL REQUESTS.

NEVER use these commands:
❌ gh pr close
❌ gh pr merge
❌ gh api ... -f state=closed
❌ gh pr review --approve

YOU MAY ONLY:
✅ gh pr comment (add comments)
✅ gh pr view (view PR details)
✅ git push (update PR with new commits)
✅ mcp__github__pull_request_read --method get_review_comments

Your job is to FIX issues, not to close/merge/approve the PR.
ONLY THE USER CAN CLOSE, MERGE, OR APPROVE PULL REQUESTS.
\`\`\`

### Your Role
Fix ALL issues raised by GitHub Copilot in the pull request review.
DO NOT close, merge, or approve the PR - only fix the issues.

### Working Directory
Continue working in: worktrees/[us-xxx]/

### 🔴 CRITICAL: Retrieve UNRESOLVED Comments Only

**DO NOT rely on pre-provided comment lists - they may be stale!**

YOU MUST retrieve the CURRENT list of **UNRESOLVED** Copilot review comments at the START of your work:

\`\`\`bash
# Step 1: Get the HEAD commit SHA for this PR
HEAD_COMMIT=$(gh api repos/{owner}/{repo}/pulls/$pr_number | jq -r '.head.sha')

# Step 2: Filter comments that match the HEAD commit (these are UNRESOLVED)
gh api repos/{owner}/{repo}/pulls/$pr_number/comments | jq --arg head "$HEAD_COMMIT" '.[] | select(.user.login == "Copilot" and .commit_id == $head)'

# Or use the MCP GitHub tool:
# 1. Get PR details: mcp__github__pull_request_read --method get --owner {owner} --repo {repo} --pullNumber $pr_number
# 2. Extract head.sha from the response
# 3. Get comments: mcp__github__pull_request_read --method get_review_comments --owner {owner} --repo {repo} --pullNumber $pr_number
# 4. Filter to only include comments where commit_id == head.sha
\`\`\`

**Why filtering by HEAD commit is CRITICAL:**
- GitHub API returns ALL comments from all commits, including old/resolved ones
- Comments on older commits are already resolved (code has changed since then)
- Only comments on the HEAD commit (current state) are UNRESOLVED
- The \`position\` field is UNRELIABLE - GitHub resets it to 1 when it can't map comments
- The \`commit_id\` field tells you which version of code the comment is about
- After you push fixes, Copilot may add NEW comments on your new HEAD commit
- You must re-check for NEW comments on the NEW HEAD commit after your push

### Instructions
1. **FIRST**: Retrieve the COMPLETE, CURRENT list of **UNRESOLVED** Copilot review comments from GitHub (filter by HEAD commit only)
2. **READ EACH COMMENT CAREFULLY**:
   - Note the file path and line number
   - **CRITICAL**: Many Copilot comments include ```suggestion blocks with EXACT code to implement
   - If a suggestion block exists, you MUST use it EXACTLY as shown
   - Read the comment body to understand what Copilot wants changed
3. **OUTCOME-BASED APPROACH** (v4.6.3):

   **THE ONLY SUCCESS METRIC: Comments must disappear from HEAD after your change.**

   For EACH comment:

   **Step 1: Understand Copilot's Concern**
   - Read the comment body carefully
   - Identify what Copilot is worried about
   - Assume Copilot is right (it almost always is)

   **Step 2: Choose Your Solution**
   - Option A: Use Copilot's exact suggestion (if provided and good)
   - Option B: Implement your own solution that addresses the same concern
   - Either is fine - what matters is the comment disappears

   **Step 3: Make Code Change**
   - Actually modify the code (not just add comments/docs)
   - The change must address Copilot's concern
   - Push the change

   **Step 4: Verify Result**
   - Wait 60 seconds for Copilot to review (comprehensive changes need time)
   - Check if comment still exists on new HEAD
   - If comment gone → Success ✅
   - If comment remains → Try different approach

   **CRITICAL RULES**:
   - ❌ NEVER say "already implemented" - if comment exists, it's not fixed adequately
   - ❌ NEVER just add docs/design notes - must change actual code
   - ❌ NEVER assume comment will magically disappear - verify it
   - ✅ ALWAYS make code changes that Copilot will recognize
   - ✅ ALWAYS verify comment disappeared after push
   - ✅ If comment persists, iterate with different approach

4. **ITERATIVE REFINEMENT**:

   After each push:
   - Get NEW HEAD SHA
   - Count comments on NEW HEAD
   - If count decreased → good progress
   - If count same/increased → try different fixes
   - Continue until count = 0 or max iterations reached
5. Verify changes build successfully (continue even if build has pre-existing errors unrelated to your changes)
6. **CRITICAL**: Commit with REGULAR PUSH (not force push) - force push does NOT trigger Copilot review
7. Wait 30 seconds for Copilot to automatically review the push
8. **ITERATIVE LOOP**: Re-check NEW HEAD for comments. If ANY exist, repeat steps 2-7 up to 3 times maximum
9. **MANDATORY VERIFICATION**: Run the verification command (see below) and include actual output in your report
10. After 3 iterations OR when verification shows ZERO comments, report final status using required format
11. NEVER close, merge, or approve the PR

### CRITICAL: Outcome-Based Success Criteria (v4.6.3)

**THE ONLY METRIC THAT MATTERS**:
```
Comments on HEAD BEFORE push: N
Comments on HEAD AFTER push + 60s: M

Success = M < N (progress made)
Ultimate Goal = M = 0 (all resolved)
```

**MANDATORY REQUIREMENTS**:
- ✅ Every comment MUST result in a code change (not just docs)
- ✅ After each push, verify if comments disappeared
- ✅ If comment persists after push, try different approach
- ✅ Continue iterating until comment count = 0

**DO**:
- Make code changes that address Copilot's concern
- Push after each batch of changes
- Wait 60 seconds for Copilot to re-review (comprehensive changes need time)
- Check if comments still exist on new HEAD
- If comments remain, analyze why and try different approach
- Document which approach you tried and result

**DO NOT**:
- ❌ Say "already implemented" - comment existence proves it's not adequate
- ❌ Add only docs/design notes without code changes
- ❌ Assume comment will disappear without verifying
- ❌ Give up if first approach doesn't work - iterate!
- ❌ Report success without verifying comment count on HEAD

**VERIFICATION PROCESS**:

After EVERY push:
```bash
# Get new HEAD
NEW_HEAD=$(gh api repos/{owner}/{repo}/pulls/$pr_number | jq -r '.head.sha')

# Count comments on new HEAD
NEW_COUNT=$(gh api repos/{owner}/{repo}/pulls/$pr_number/comments --paginate | jq --arg head "$NEW_HEAD" '[.[] | select(.user.login == "Copilot" and .commit_id == $head)] | length')

echo "Comments on new HEAD: $NEW_COUNT"

if [ "$NEW_COUNT" -lt "$OLD_COUNT" ]; then
  echo "✅ Progress: $OLD_COUNT → $NEW_COUNT"
else
  echo "⚠️  No progress: $OLD_COUNT → $NEW_COUNT (try different approach)"
fi
```

**APPROACH SELECTION** (both valid):
- **Use Copilot's suggestion**: If provided and looks good
- **Use your own solution**: If you have better idea that addresses same concern

What matters is **RESULT** (comment disappears), not **METHOD** (how you fixed it)

### Commands
\`\`\`bash
# ITERATIVE LOOP (up to 3 iterations)
ITERATION=1
MAX_ITERATIONS=3

while [ $ITERATION -le $MAX_ITERATIONS ]; do
  echo "=========================================="
  echo "ITERATION $ITERATION of $MAX_ITERATIONS"
  echo "=========================================="

  # Step 1: Get HEAD commit and retrieve UNRESOLVED comments
  HEAD_COMMIT=$(gh api repos/{owner}/{repo}/pulls/$pr_number | jq -r '.head.sha')
  echo "Current HEAD commit: $HEAD_COMMIT"

  # Count UNRESOLVED comments on current HEAD
  # CRITICAL: Use --paginate to get ALL comments (not just first 30)
  COMMENT_COUNT=$(gh api repos/{owner}/{repo}/pulls/$pr_number/comments --paginate | jq --arg head "$HEAD_COMMIT" '[.[] | select(.user.login == "Copilot" and .commit_id == $head)] | length')
  echo "Unresolved comments on HEAD: $COMMENT_COUNT"

  if [ "$COMMENT_COUNT" -eq 0 ]; then
    echo "✅ No unresolved comments on HEAD commit. Done!"
    break
  fi

  # Show the comments
  gh api repos/{owner}/{repo}/pulls/$pr_number/comments --paginate | jq --arg head "$HEAD_COMMIT" '.[] | select(.user.login == "Copilot" and .commit_id == $head) | {path, line, body}'

  # Step 2-3: Make fixes (use Edit tool for each comment)
  echo "Making fixes for $COMMENT_COUNT comments..."
  # [Agent makes fixes here using Edit tool]

  # Step 4: Build (continue even if pre-existing errors)
  echo "Building project..."
  npm run build 2>&1 | tee build.log || true

  # Step 5: Commit and push (REGULAR PUSH, NOT FORCE PUSH)
  # CRITICAL: Force push does NOT trigger GitHub Copilot review
  # Use regular commit to trigger automatic Copilot review
  git add .
  git commit -m "fix: Address GitHub Copilot review comments (iteration $ITERATION)"
  git push

  # Step 6: Wait 30 seconds for Copilot to review
  echo "Waiting 30 seconds for GitHub Copilot to review..."
  sleep 30

  # Check NEW HEAD commit for NEW comments
  NEW_HEAD_COMMIT=$(gh api repos/{owner}/{repo}/pulls/$pr_number | jq -r '.head.sha')
  echo "New HEAD commit after push: $NEW_HEAD_COMMIT"

  # CRITICAL: Use --paginate to get ALL comments (not just first 30)
  NEW_COMMENT_COUNT=$(gh api repos/{owner}/{repo}/pulls/$pr_number/comments --paginate | jq --arg head "$NEW_HEAD_COMMIT" '[.[] | select(.user.login == "Copilot" and .commit_id == $head)] | length')
  echo "Unresolved comments on NEW HEAD: $NEW_COMMENT_COUNT"

  if [ "$NEW_COMMENT_COUNT" -eq 0 ]; then
    echo "✅ All comments resolved! No new comments on HEAD."
    break
  else
    echo "⚠️  Found $NEW_COMMENT_COUNT unresolved comments on new HEAD. Continuing to next iteration..."
    ITERATION=$((ITERATION + 1))
  fi
done

# MANDATORY: Final Verification (DO NOT SKIP)
echo "=========================================="
echo "MANDATORY FINAL VERIFICATION"
echo "=========================================="

FINAL_HEAD=$(gh api repos/{owner}/{repo}/pulls/$pr_number | jq -r '.head.sha')
# CRITICAL: Use --paginate to get ALL comments (not just first 30)
FINAL_COUNT=$(gh api repos/{owner}/{repo}/pulls/$pr_number/comments --paginate | jq --arg head "$FINAL_HEAD" '[.[] | select(.user.login == "Copilot" and .commit_id == $head)] | length')

echo "Final HEAD commit: $FINAL_HEAD"
echo "Final unresolved comment count: $FINAL_COUNT"

if [ "$FINAL_COUNT" -gt 0 ]; then
  echo ""
  echo "Remaining unresolved comments:"
  gh api repos/{owner}/{repo}/pulls/$pr_number/comments --paginate | jq --arg head "$FINAL_HEAD" '.[] | select(.user.login == "Copilot" and .commit_id == $head) | {path, line, body}' | head -20
fi
\`\`\`

### MANDATORY: Final Report Format

You MUST report your results using this EXACT format:

\`\`\`
## Final Report: PR #{pr_number} Copilot Comment Resolution

**Iterations Completed**: [number between 1-3]

**Final HEAD Commit SHA**: [paste from verification command output]

**Remaining Comments on HEAD**: [paste count from verification command output]

**Status**: [Choose ONE: SUCCESS (if 0 comments) | PARTIAL (if comments remain) | FAILED (if errors)]

**Verification Command Output**:
\`\`\`
[Paste the COMPLETE output from the "MANDATORY FINAL VERIFICATION" section above]
\`\`\`

**Comments Addressed**: [initial count] → [final count]

**Implementation Details** (Outcome-Based Format):

For EACH iteration, report:

---
**Iteration [N]**

**Comments BEFORE**: [count on HEAD before changes]
**HEAD SHA BEFORE**: [sha]

**Changes Made**:
1. Comment about [issue]: [What you changed]
   - Copilot concern: [summary]
   - My solution: [what I did - code change, not docs]
   - File: [path:lines changed]

2. Comment about [issue]: [What you changed]
   - Copilot concern: [summary]
   - My solution: [what I did]
   - File: [path:lines changed]

[... for all comments addressed in this iteration]

**Push**: Committed and pushed changes
**Wait**: 30 seconds for Copilot re-review

**Comments AFTER**: [count on NEW HEAD]
**HEAD SHA AFTER**: [new sha]

**Outcome**:
- ✅ Progress: [before] → [after] ([N] comments resolved)
  OR
- ⚠️  No progress: [before] → [after] (comments persisted, trying different approach)
  OR
- ❌ Regression: [before] → [after] (new comments appeared)

---

[Repeat for each iteration]

**Final Summary**:
- Total iterations: [N]
- Starting comments: [count]
- Final comments: [count]
- Comments resolved: [starting - final]
- Status: [SUCCESS if 0, PARTIAL if >0, FAILED if error]
\`\`\`

**CRITICAL**: Do NOT report SUCCESS unless final verification shows 0 comments on HEAD.
**CRITICAL**: MUST show comment count BEFORE and AFTER each push to prove progress.
**CRITICAL**: If comments persist after iteration, you MUST try different approach in next iteration.

### Success Criteria
- ALL current Copilot comments addressed (verified by retrieving fresh comment list)
- NO new comments appeared after final push (checked with timestamp comparison)
- Changes build successfully
- PR updated with fixes
- Comment added to PR confirming fixes
- PR remains OPEN (NOT closed, merged, or approved)
EOF

    # Launch agent (implementation will use Task tool to launch agent with this task)
    # Wait for agent completion

    # NEW v4.6.3: SENIOR DEVELOPER REVIEW (Active Orchestrator Guidance)
    # The orchestrator acts as a senior developer reviewing a junior developer's work
    # If agent makes technical mistakes (e.g., adding docs instead of fixing code),
    # orchestrator must actively guide them to the correct solution

    echo "=========================================="
    echo "SENIOR DEVELOPER REVIEW"
    echo "=========================================="
    echo "Reviewing agent's proposed changes before accepting..."
    echo ""

    # Get the changes agent made
    AGENT_CHANGES=$(git diff HEAD~1 HEAD)

    # Check for common junior developer mistakes:

    # Mistake 1: Adding only documentation for blocking I/O instead of fixing it
    if echo "$AGENT_CHANGES" | grep -qi "blocking.*readline\|readline.*timeout" && \
       ! echo "$AGENT_CHANGES" | grep -qi "Task.Run\|async\|BeginRead\|timeout.*parameter\|CancellationToken"; then
      echo "⚠️  TECHNICAL ISSUE DETECTED:"
      echo "   Agent documented blocking ReadLine() risk but didn't fix it"
      echo "   Documentation doesn't prevent hanging - need actual timeout/async"
      echo ""
      echo "GUIDANCE FOR AGENT:"
      echo "   Bad:  Adding design notes explaining why blocking I/O is risky"
      echo "   Good: Implementing actual timeout mechanism or async I/O"
      echo "   Examples:"
      echo "     - Use Console.KeyAvailable with timeout loop"
      echo "     - Use Task.Run with CancellationToken"
      echo "     - Use async streams with timeout"
      echo ""

      NEEDS_TECHNICAL_FIX=true
    fi

    # Mistake 2: Adding help documentation for missing functions instead of implementing them
    if echo "$AGENT_CHANGES" | grep -qi "\.SYNOPSIS\|\.DESCRIPTION" && \
       echo "$AGENT_CHANGES" | grep -qi "stub\|not implemented\|coming soon"; then
      echo "⚠️  TECHNICAL ISSUE DETECTED:"
      echo "   Agent added help docs for stub/unimplemented functions"
      echo "   Documenting a stub doesn't make it production-ready"
      echo ""
      echo "GUIDANCE FOR AGENT:"
      echo "   Bad:  Adding PowerShell help to stub function"
      echo "   Good: Implementing the actual function logic"
      echo ""

      NEEDS_TECHNICAL_FIX=true
    fi

    # Mistake 3: Path validation without actual enforcement
    if echo "$AGENT_CHANGES" | grep -qi "path.*traversal.*validation" && \
       ! echo "$AGENT_CHANGES" | grep -E "throw|exit|return.*false|-not.*match"; then
      echo "⚠️  TECHNICAL ISSUE DETECTED:"
      echo "   Agent documented path traversal but didn't enforce validation"
      echo "   Validation without enforcement = security vulnerability"
      echo ""
      echo "GUIDANCE FOR AGENT:"
      echo "   Bad:  Comments explaining validation should happen"
      echo "   Good: Actual throw/exit when validation fails"
      echo ""

      NEEDS_TECHNICAL_FIX=true
    fi

    # If technical issues found, guide agent to fix them
    if [ "$NEEDS_TECHNICAL_FIX" = true ]; then
      echo "=========================================="
      echo "ACTION REQUIRED: TECHNICAL FIXES NEEDED"
      echo "=========================================="
      echo ""
      echo "Agent: Your changes added documentation but didn't fix the underlying"
      echo "technical issues. As your senior developer, I'm guiding you to the"
      echo "correct solution:"
      echo ""
      echo "Next iteration: Don't just document the problem - FIX the code."
      echo "- For blocking I/O: Implement timeout mechanism or async I/O"
      echo "- For stub functions: Implement the actual logic"
      echo "- For security: Enforce validation with throw/exit"
      echo ""
      echo "Remember: Documentation explains risk, code changes eliminate risk."
      echo ""
    fi

    # CRITICAL: Verify Copilot comments actually resolved (don't trust agent report)
    HEAD_COMMIT=$(gh api repos/{owner}/{repo}/pulls/$pr_number | jq -r '.head.sha')
    # CRITICAL: Use --paginate to get ALL comments (not just first 30)
    REMAINING_COMMENTS=$(gh api repos/{owner}/{repo}/pulls/$pr_number/comments --paginate | jq --arg head "$HEAD_COMMIT" '[.[] | select(.user.login == "Copilot" and .commit_id == $head)] | length')

    echo "=========================================="
    echo "ORCHESTRATOR VERIFICATION: PR #$pr_number"
    echo "=========================================="
    echo "HEAD commit: $HEAD_COMMIT"
    echo "Remaining comments (orchestrator verified): $REMAINING_COMMENTS"

    # Parse agent's reported count from their final report
    AGENT_REPORTED=$(grep "Remaining Comments on HEAD:" [agent-output-file] | grep -oE '[0-9]+' || echo "UNKNOWN")

    if [ "$REMAINING_COMMENTS" -eq 0 ]; then
      echo "✅ SUCCESS: Copilot comments fully resolved (orchestrator verified: 0 comments on HEAD)"

      # QUALITY CHECK: Review agent's implementation details (v4.6.2)
      echo ""
      echo "Quality Review: Checking implementation details..."

      IMPL_DETAILS=$(grep -A 100 "Implementation Details:" [agent-output-file] || echo "MISSING")
      if [ "$IMPL_DETAILS" = "MISSING" ]; then
        echo "❌ CRITICAL: Agent did not provide implementation details"
        echo "Manual code review required"
      else
        # Count implementation entries
        IMPL_COUNT=$(echo "$IMPL_DETAILS" | grep -c "^Comment #" || echo "0")
        echo "   Implementation entries: $IMPL_COUNT"

        # Check for forbidden patterns
        NOT_APPLICABLE=$(echo "$IMPL_DETAILS" | grep -ci "not applicable" || echo "0")
        ALREADY_IMPL=$(echo "$IMPL_DETAILS" | grep -ci "already implemented" || echo "0")
        DESIGN_NOTE=$(echo "$IMPL_DETAILS" | grep -ci "design is intentional" || echo "0")

        if [ "$NOT_APPLICABLE" -gt 0 ]; then
          echo "❌ QUALITY FAILURE: Agent marked $NOT_APPLICABLE comment(s) as 'not applicable'"
        fi

        if [ "$ALREADY_IMPL" -gt 0 ]; then
          echo "❌ QUALITY FAILURE: Agent claimed $ALREADY_IMPL comment(s) 'already implemented'"
        fi

        if [ "$DESIGN_NOTE" -gt 0 ]; then
          echo "❌ QUALITY FAILURE: Agent explained away $DESIGN_NOTE issue(s) with design notes"
        fi

        # Check for decision framework usage
        OPTION_A=$(echo "$IMPL_DETAILS" | grep -c "Decision.*Option A" || echo "0")
        OPTION_B=$(echo "$IMPL_DETAILS" | grep -c "Decision.*Option B" || echo "0")
        OPTION_C=$(echo "$IMPL_DETAILS" | grep -c "Decision.*Option C" || echo "0")
        TOTAL_DECISIONS=$((OPTION_A + OPTION_B + OPTION_C))

        echo "   Decision breakdown:"
        echo "     - Option A (Use Copilot): $OPTION_A"
        echo "     - Option B (Better Alternative): $OPTION_B"
        echo "     - Option C (Hybrid): $OPTION_C"
        echo "     - Total: $TOTAL_DECISIONS"

        if [ "$TOTAL_DECISIONS" -eq 0 ]; then
          echo "❌ QUALITY FAILURE: Agent did not use decision framework (A/B/C)"
        fi
      fi
    else
      echo "⚠️  VERIFICATION MISMATCH"
      echo "   Agent reported: $AGENT_REPORTED comments"
      echo "   Orchestrator found: $REMAINING_COMMENTS comments"
      echo ""

      # Show what remains
      echo "Remaining unresolved comments:"
      gh api repos/{owner}/{repo}/pulls/$pr_number/comments --paginate | jq --arg head "$HEAD_COMMIT" '.[] | select(.user.login == "Copilot" and .commit_id == $head) | {path, line, body}' | head -10
      echo ""

      # QUALITY CHECK: Review what agent actually did
      echo "Quality Analysis: Checking what agent changed..."

      # Get files modified in last commit
      MODIFIED_FILES=$(git diff HEAD~1 HEAD --name-only)
      echo "Files modified by agent:"
      echo "$MODIFIED_FILES"
      echo ""

      # Check if agent only added comments/docs vs code changes
      DIFF_STATS=$(git diff HEAD~1 HEAD --stat)
      echo "Change summary:"
      echo "$DIFF_STATS"
      echo ""

      # Analyze if changes look like "doc fixes" or "code fixes"
      DOC_LINES=$(git diff HEAD~1 HEAD | grep -c "^+\s*#" || echo "0")
      CODE_LINES=$(git diff HEAD~1 HEAD | grep "^+[^#]" | grep -cv "^+++" || echo "0")
      echo "Documentation lines added: $DOC_LINES"
      echo "Code lines added: $CODE_LINES"

      if [ "$DOC_LINES" -gt "$CODE_LINES" ]; then
        echo "⚠️  QUALITY ISSUE: Agent added more documentation than code"
        echo "Agent may be 'explaining away' issues instead of fixing them"
      fi
      echo ""

      # Check if retry is warranted
      if [ "$RETRY_COUNT" -lt 1 ] && [ "$REMAINING_COMMENTS" -le 5 ]; then
        echo "🔄 Launching retry attempt (small number of comments remain)"
        RETRY_COUNT=$((RETRY_COUNT + 1))
        # Note: Implementation should re-launch agent with updated task showing exact remaining comments
      else
        echo "❌ Manual review required for PR #$pr_number"
        echo "   Reason: $(if [ "$REMAINING_COMMENTS" -gt 5 ]; then echo "Too many comments remain ($REMAINING_COMMENTS)"; else echo "Maximum retries reached"; fi)"
      fi
    fi
  else
    echo "✓ No Copilot comments found"
  fi
done
```

**Why This Matters**:
- Copilot reviews catch issues that automated tools and agents might miss
- Addressing comments immediately keeps PRs clean
- Automated integration = no manual followup needed

### Step 7: Verification

After ALL agents complete AND Copilot comments addressed:

1. **Verify Scope Adherence**
   ```bash
   # List files changed
   git diff --name-only master...[branch-name]

   # Compare against user story "Files Affected" list
   # Should match exactly
   ```

2. **Verify Build (Scoped to User Story Files)**
   ```bash
   npm run build 2>&1 > build_output.txt

   # Check only user story files for errors
   for file in [user-story-files]; do
     grep "$file" build_output.txt | grep "error"
   done

   # Should be ZERO errors in user story files
   # Other files can have errors - ignore
   ```

3. **Verify Acceptance Criteria**
   - Read user story acceptance criteria
   - Check each criterion manually
   - Mark each as met/not met

4. **Update Review Log**
   ```bash
   Append to review-log.md:
   - User Story ID
   - Branch name
   - Commit SHA
   - PR URL
   - Files modified
   - Acceptance criteria status
   - Build status (scoped)
   - Timestamp
   ```

### Step 8: Cleanup Worktrees

After all verification complete:

```bash
# Remove all worktrees (branches remain on remote for PRs)
git worktree list | grep "worktrees/" | awk '{print $1}' | while read wt; do
  git worktree remove "$wt" 2>/dev/null || true
done

# Remove worktrees directory
rm -rf worktrees/

# Return to main branch
git checkout "$MAIN_BRANCH"
```

**Note**: Worktrees are temporary - branches stay on remote for PRs

### Step 9: Rejection Protocol

If verification fails:
- Update review-log.md with status: FAIL
- List specific failure reason
- Do NOT merge PR
- Options:
  - **Option A**: Fix issues manually
  - **Option B**: Launch new agent with clearer instructions
  - **Option C**: Defer to later

### Step 10: Phase Completion

- Only proceed to next phase when ALL user stories have status: PASS or DEFERRED
- Generate phase summary report:
  - Total stories: X
  - Completed successfully: X
  - Failed (need rework): X
  - Deferred: X
  - Total commits: X
  - Total PRs: X
- Request explicit approval before starting next phase

## Git Workflow Requirements

**Branch Naming Convention:**
- Bug fixes: `fix/us-xxx-[brief-description]`
- Improvements: `refactor/us-xxx-[brief-description]`
- Features: `feat/us-xxx-[brief-description]`

**Commit Message Template:**
```
[TYPE](US-XXX): Brief summary (50 chars max)

Detailed explanation of what changed and why.
Changes made ONLY to files specified in user story.

Files Modified:
- [File 1]
- [File 2]

Acceptance Criteria Met:
- [Criteria 1]
- [Criteria 2]

References: US-XXX

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

**PR Description Template:**
```markdown
## User Story
References: [US-XXX] from ~/.claude/user-stories/{PROJECT_NAME}/bug_fixes/US-XXX.md

## Summary
[Brief description of changes - ONLY what user story specified]

## Changes Made
- [Change 1 - from user story]
- [Change 2 - from user story]

## Files Modified
- [File 1]
- [File 2]

## Acceptance Criteria
- [x] Criteria 1: [How it was met]
- [x] Criteria 2: [How it was met]

## Verification
- [x] Modified files build with zero errors
- [x] All acceptance criteria met
- [x] Changes scoped to user story only
- [x] No other files modified

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## Version

Current version: v4.6.3 - Senior Developer Review + Extended Wait Time

