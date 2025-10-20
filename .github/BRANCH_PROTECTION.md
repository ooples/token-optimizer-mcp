# Branch Protection Rules

This document outlines the required branch protection settings for the `master` branch. These settings must be configured manually in the GitHub repository settings.

## How to Configure

1. Navigate to: `Settings` > `Branches` > `Branch protection rules`
2. Click `Add rule` or edit existing `master` rule
3. Apply the following settings:

## Required Settings

### Branch Name Pattern
```
master
```

### Protect matching branches

#### 1. Require a pull request before merging
- [x] **Require a pull request before merging**
  - Required number of approvals before merging: **1**
  - [x] Dismiss stale pull request approvals when new commits are pushed
  - [ ] Require review from Code Owners (optional - enable if CODEOWNERS file is created)
  - [x] Restrict who can dismiss pull request reviews
  - [ ] Allow specified actors to bypass required pull requests (leave empty)

#### 2. Require status checks to pass before merging
- [x] **Require status checks to pass before merging**
  - [x] Require branches to be up to date before merging

##### Required Status Checks (must pass)
Select the following checks from the list:
- `lint-and-format` (from CI workflow)
- `build` (from CI workflow)
- `test (18)` (from CI workflow - Node 18)
- `test (20)` (from CI workflow - Node 20)
- `test (22)` (from CI workflow - Node 22)
- `performance-benchmarks` (from CI workflow)
- `integration-test` (from CI workflow)
- `bundle-size` (from Quality Gates workflow)
- `security-audit` (from Quality Gates workflow)
- `license-compliance` (from Quality Gates workflow)
- `dependency-vulnerabilities` (from Quality Gates workflow)
- `code-quality` (from Quality Gates workflow)
- `commitlint` (from Commitlint workflow)

> Note: Status checks will only appear in the list after they have run at least once. Create a test PR to populate this list.

#### 3. Require conversation resolution before merging
- [x] **Require conversation resolution before merging**

#### 4. Require signed commits
- [ ] Require signed commits (optional but recommended)

#### 5. Require linear history
- [x] **Require linear history** (prevents merge commits, requires rebase or squash)

#### 6. Require deployments to succeed before merging
- [ ] Require deployments to succeed before merging (not applicable)

#### 7. Lock branch
- [ ] Lock branch (not applicable)

#### 8. Do not allow bypassing the above settings
- [x] **Do not allow bypassing the above settings**
  - [ ] Allow specified actors to bypass required pull requests (leave empty unless needed for automation)

#### 9. Restrict who can push to matching branches
- [ ] Restrict who can push to matching branches (optional)
  - If enabled, specify: Repository administrators and maintainers only

#### 10. Allow force pushes
- [ ] **Allow force pushes** (should be DISABLED)

#### 11. Allow deletions
- [ ] **Allow deletions** (should be DISABLED)

## Additional Recommended Settings

### Repository Settings

Navigate to: `Settings` > `General` > `Pull Requests`

- [x] Allow squash merging
  - Default commit message: **Pull request title**
  - [x] Default to pull request title and description
- [ ] Allow merge commits (disable to enforce linear history)
- [x] Allow rebase merging
- [x] Always suggest updating pull request branches
- [x] Automatically delete head branches

### Rulesets (Alternative to Branch Protection)

GitHub Rulesets provide more flexible protection. If you prefer rulesets over branch protection rules:

1. Navigate to: `Settings` > `Rules` > `Rulesets`
2. Create a new ruleset for `master` branch
3. Apply the same protections as listed above

## Verification Checklist

After configuring branch protection rules, verify:

- [ ] Cannot push directly to master
- [ ] Cannot merge PR without approval
- [ ] Cannot merge PR with failing status checks
- [ ] Cannot merge PR with unresolved conversations
- [ ] Force push is blocked
- [ ] Branch deletion is blocked
- [ ] Status checks listed are all green before merge is allowed

## Enforcement Timeline

These rules should be enforced:
- **Immediately** for new PRs
- **Gradually** for existing work (give teams time to adapt)

## Exemptions

If needed, specific users can be exempted from branch protection rules:
- Repository administrators (for emergency hotfixes only)
- CI/CD bot accounts (for automated releases)

**Important**: Use exemptions sparingly and document all exceptions.

## Testing Branch Protection

To test that branch protection is working correctly:

1. Create a test branch: `git checkout -b test-branch-protection`
2. Make a small change: `echo "test" > test.txt`
3. Commit: `git commit -am "test: branch protection"`
4. Push: `git push origin test-branch-protection`
5. Create a PR to master
6. Try to merge without approval → Should be blocked
7. Try to push directly to master → Should be blocked
8. Get approval and verify all checks pass → Should allow merge

## Troubleshooting

### Status checks not appearing in the list
- Run the workflows at least once (create a test PR)
- Wait a few minutes for GitHub to register the checks
- Refresh the branch protection settings page

### Cannot merge even with approvals
- Ensure all required status checks are passing
- Ensure branch is up to date with master
- Check for unresolved conversations

### Emergency hotfix needed
- Repository administrators can temporarily disable branch protection
- Apply hotfix
- Re-enable branch protection immediately
- Create follow-up PR to document the emergency change

## Related Documentation

- [GitHub Branch Protection Documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [Required Status Checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging)
- [Conventional Commits](https://www.conventionalcommits.org/)
