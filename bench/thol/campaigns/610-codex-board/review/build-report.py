"""Build the review documents from checked source metadata, without model work."""
import csv
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write(name, text):
    (HERE / name).write_text(text.rstrip() + '\n', encoding='utf-8')


def main():
    upstream = read(HERE / 'current-upstreams.json')
    packages = {r['name']: r for r in read(HERE / 'package-versions.json')['records']}
    installed = {r['tool']: r for r in read(HERE / 'installed-versions.json')}
    readmes = {r['name']: r for r in upstream['readmes']}
    entries = list(upstream['competitors'])
    entries.append({'name': 'tokenade', 'pin': 'legacy 0.8.13; actual product 2.0.9',
                    'upstream': 'https://tokenade.net', 'verified': True})
    entries += [{'name': name, 'pin': pin, 'upstream': url, 'verified': True} for name, pin, url in
                [('cto', '2.3.20', 'https://www.npmjs.com/package/claude-token-optimizer'),
                 ('tokenjuice', '0.11.0', 'https://www.npmjs.com/package/tokenjuice')]]
    entries.sort(key=lambda r: r['name'].lower())
    assert len(entries) == 47 and len({r['name'] for r in entries}) == 47
    matrix = []
    for entry in entries:
        name = entry['name']
        package_name = 'tokenade-product' if name == 'tokenade' else name
        package = packages.get(package_name, {})
        current = package.get('latest') or entry.get('release')
        source = package.get('source') or (f"https://github.com/{entry.get('canonicalRepo') or entry.get('repo')}/releases/latest"
                                          if entry.get('release') else f"https://api.github.com/repos/{entry.get('canonicalRepo') or entry.get('repo')}/commits?per_page=1")
        action = 'Free install, registration, output-correctness and activation preflight required; no paid qualification yet.'
        if not current and entry.get('head'):
            current = 'source HEAD ' + entry['head'][:12]
        elif not current:
            current = 'UNRESOLVED'
            action = 'Upstream unavailable; resolve canonical source before admission. Do not silently drop this entry.'
        if name == 'squeez':
            current = 'GitHub v1.49.3; crates.io 1.48.18'
            source = 'https://github.com/claudioemmanuel/squeez/releases/latest'
            action = 'Resolve release-versus-registry gap and verify release asset/source build; do not install an unavailable crate version.'
        if name == 'edgee':
            action = 'Installed binary fails GLIBC_2.38/2.39. Qualify latest release asset, auth and unchanged-model routing in the measured image.'
        if name == 'tokenade':
            action = 'Use vendor product 2.0.9 and its installer, not the upstream 0.8.13 rules-text replica; qualify the Codex integration.'
        if name == 'tokf':
            current = 'source HEAD ' + entry['head'][:12]
            action = 'Latest GitHub release is catalog-types-v0.2.54; map the product/package before choosing a release pin.'
        if name == 'memphis':
            action = 'Repository moved to path-warden/pyra; check renamed product relevance and current installer before admission.'
        if name in ['opencode-ctx', 'opencode-extreme-compress']:
            action = 'OpenCode-oriented integration: qualify its supported client; do not pretend Claude settings execute in Codex.'
        if name == 'claude-token-efficient':
            action = 'Static CLAUDE.md integration; verify vendor-supported Codex instructions or label any port as an adapted configuration.'
        row = dict(entry, latestObserved=current, versionSource=source, prePaidAction=action,
                   latestPackage=package.get('latest'), installedCli=installed.get(name),
                   codexMentionInCheckedReadme=readmes.get(name, {}).get('mentionsCodex'),
                   codexQualified=False)
        matrix.append(row)
    write('competitor-matrix.json', json.dumps({'checkedAt': upstream['checkedAt'], 'externalProducts': 47,
          'qualifiedForPaidCodexRuns': 0, 'entries': matrix}, indent=2))
    lines = ['# Competitor inventory and current-version audit', '',
             'Checked ' + upstream['checkedAt'] + '. No paid competitor run was started.', '',
             'Scope: all 45 external products in the current upstream 46-entry board (one entry is control), plus the two local external products CTO and Tokenjuice. Our own variants, patched third-party variants and two Headroom configurations are not additional products. There are **47 external products** to account for. This is the board inventory, not a claim to cover every product on the internet.', '',
             'The upstream board HEAD still matches the image pin `5ee6ea7f81dc21db1aae8d359cda3e1f7ded6dde`. Individual products have newer releases. Each entry below is accounted for regardless of the upstream verified badge. A source-only project gets an observed immutable HEAD; that is not falsely presented as a stable package release.', '',
             '**No entry is yet qualified by this review for a new paid Codex comparison.** README mentions show a documented integration candidate, not proof that its installer, hooks, proxy and output work in this exact image. Older Claude manifests cannot be reused unchanged as Codex integrations.', '',
             '| Product | Current rig/manifest pin | Latest release or source observed | Source HEAD | Required action before paid use |',
             '|---|---|---|---|---|']
    for row in matrix:
        name = row['name']
        if name == 'cto':
            name = 'CTO (claude-token-optimizer)'
        if name == 'token-optimizer':
            name = 'token-optimizer (edisonaugusthy)'
        source = row.get('canonicalRepo') or row.get('repo')
        head = f"[{row['head'][:12]}](https://github.com/{source}/commit/{row['head']})" if row.get('head') else 'not resolved / package-based'
        lines.append(f"| {name} | {row.get('pin')} | [{row['latestObserved']}]({row['versionSource']}) | {head} | {row['prePaidAction']} |")
    lines += ['', '## Source and installation evidence', '',
              '`current-upstreams.json` retains source/release lookups, canonical moves and README excerpts. `package-versions.json` records live npm/PyPI/crates results. `installed-versions.json` records actual no-model `--version` probes inside the existing image. A latest version in a registry does not prove that version is installed or runnable.', '',
              'Confirmed stale pins include Codegraph 1.6.2 ->1.6.3, Lean-ctx 3.12.3 ->3.12.6, Graphify 0.9.106 ->0.9.112, Claude-mem 15.17.1 ->15.21.0, Claude-context 0.1.15 ->0.1.16 and Edgee v0.16.5 ->v0.18.1. Squeez has GitHub v1.49.3 while crates.io still reports 1.48.18; that discrepancy must be resolved rather than hidden.', '',
              'Graphify moved to Graphify-Labs/graphify. Memphis moved to path-warden/pyra. token-slayer and the placeholder unknown/claude-restart-trajectory-analysis returned404 at the recorded sources. These are explicit unresolved entries, not evidence that the products are bad or an excuse to exclude them silently.', '',
              'The true no-optimizer control also needs a qualified fresh config. The completed Codex campaign compared our candidate with our master; its baseline was not this control.']
    write('COMPETITORS.md', '\n'.join(lines))
    with (HERE / 'competitor-matrix.csv').open('w', newline='', encoding='utf-8') as stream:
        names = ['name', 'pin', 'latestObserved', 'versionSource', 'head', 'canonicalRepo', 'codexMentionInCheckedReadme', 'codexQualified', 'prePaidAction']
        writer = csv.DictWriter(stream, fieldnames=names, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(matrix)
    summary = read(ROOT / 'results-v1/summary.json')
    audit = read(HERE / 'audit.json')
    lines = ['# Full results and adversarial review', '',
             '**Paid execution is on hold.** No additional benchmark model calls were made. The audit scripts did not run another campaign. The failed candidate result remains unchanged.', '',
             '## Completed Codex comparison', '',
             'Candidate6c3bd71d vs master1518a5d7, Codex0.169.0, GPT-6.1 Sol high reasoning. Seventeen tasks, five repetitions per product. Both products passed85/85 task runs: 80 scores of1.0 and five PDF scores of0.9 each. The primary geometric mean of task-median credit ratios is1.020455 (+2.05%): the pre-registered cost gate failed.', '',
             'All task results are below. Costs are estimated standard Codex credits, not subscription invoices. Lower candidate cost is better. Every cell has five repetitions; both products passed5/5 on every task.', '',
             '| Task | Candidate median credits | Master median credits | Change | Candidate score range | Master score range |',
             '|---|---:|---:|---:|---:|---:|']
    rows = read(ROOT / 'results-v1/runs.json')
    for task, pair in summary['perTask'].items():
        scores = {arm: [r['score'] for r in rows if r['task'] == task and r['image'] == arm] for arm in ['pr610', 'master']}
        lines.append(f"| {task} | {pair['pr610']['medianCredits']:.5f} | {pair['master']['medianCredits']:.5f} | {(pair['ratio']-1)*100:+.2f}% | {min(scores['pr610']):g}-{max(scores['pr610']):g} | {min(scores['master']):g}-{max(scores['master']):g} |")
    lines += ['',
              '`all-170-runs.csv` contains every repetition, score, success flag, input/cached/uncached/output/reasoning tokens, credit estimate, recorded duration and failed MCP calls. `all-17-tasks.csv` includes all five individual credit observations for both products. Original numerical JSON is in ../results-v1/.', '',
              f"Scored estimates total{audit['scoredCredits']:.5f} credits; retained setup probes add{audit['recordedSetupCredits']:.5f}. The native availability smoke is not included in that retained setup total. No account invoice is claimed. Total input includes cached input; it must not be charged twice. Recorded agentSeconds includes grading after the CLI, so it is not pure model latency.", '',
              '## Findings, ordered by consequence', '',
              '###1. No current competitor ranking exists (blocks competitive claims)', '',
              'The 170-run study has two arms, both ours. It has zero competitor observations and zero no-optimizer controls. It cannot answer whether we beat Tokenjuice, Tokenade, Headroom or any of the47 external products. Use the complete COMPETITORS.md matrix; do not call the verified subset the full field.', '',
              '###2. Version and integration admission is incomplete (blocks paid expansion)', '',
              'The old pins were checked November11. Current release checks found multiple stale packages, repository moves, a source placeholder and a release-versus-registry discrepancy. The installed Edgee binary fails with missing GLIBC_2.38 and GLIBC_2.39 on the image. Old manifests invoke Claude-specific installers/wrappers even for products now documenting Codex. Each latest official client integration needs a free activation and fidelity probe first. Do not count installation or tool presence as measured use.', '',
              '###3. The frozen report accepts missing hook evidence and impossible scores (blocks relying on it alone)', '',
              'In memory, removing every hooks, selectedSettings and taskEvents record still produced complete=true. A score of99 was also accepted. The runner normally supplies these records, so this is not evidence the measured rows were forged. It is a missing independent report guard. The separate audit now checks actual hook counts, live model, categories/settings, original artifact hashes, published rows and Codex usage. All170 actual records passed those checks. Add strict reusable guards and negative controls before another paid campaign.', '',
              '###4. Real failed MCP calls consume work even when tasks pass (fixable product issue)', '',
              'Baseline:13 wiki_write failures and one smart_edit failure. Candidate:10 wiki_write failures. There were580 completed MCP calls and24 failed ones. The340 error-typed Codex items were duplicate informational hook-trust warnings, not340 product failures; there were no unexpected error items.', '',
              'Offline reproduction shows why qualified Python method anchors fail: extractSymbols returns Money and from_float, while #Money.from_float does not resolve. A #from_float anchor and a file-only anchor each store successfully. reproduce-anchor.mjs proves this with no model work. Some other failures used an unrooted project or empty anchors; do not attribute every failed write to this one mechanism. Improve exact symbol support or actionable diagnostics/advice, and verify each remaining class offline before paying to measure it again.', '',
              '###5. Reproducibility and grading isolation need stronger boundaries', '',
              'The candidate SEO audit repetition4 used two live web-tool actions. That adds an external-data path even though the dedicated live-web task was excluded. Retain that run; do not remove it post hoc. The next protocol must explicitly permit and freeze web inputs, or disable web consistently.', '',
              'The model runs with bypassed sandbox permissions in the same container as mounted truth, graders and credentials. Read-only mounts prevent writes, not reads. Audit found no recorded commands or tool arguments referencing the protected paths, but that scan is not a security boundary or proof of non-access. Keep grading/truth outside the agent-accessible runtime. No final code-workspace snapshots were retained, so the code tasks cannot now be regraded against their final files without reconstructing them; archive final workspace state before container removal next time.', '',
              '###6. The small cost difference is uncertain; settings causality is unmeasured', '',
              f"Exploratory paired within-task bootstrap,10000 draws,seed20261118, gave a95% ratio interval [{audit['exploratoryPairedBootstrap']['ratio95'][0]:.4f},{audit['exploratoryPairedBootstrap']['ratio95'][1]:.4f}]. This does not replace the fixed failed gate or establish a population effect. The board has only one rewrite and one locate task, no explain task, and no conversational follow-up accuracy sample.", '',
              'Thirteen candidate sessions were held out: fix2, build5, survey5, locate1, rewrite0. That is15.3% overall and20% of survey runs. It dilutes category effects and adds small-sample variability. Preserve them; do not filter for a more favorable result.', '',
              'The arms differ by the whole product change, not solely the survey flag. The fixed rule required removing the survey override; it does not prove the flag alone caused a5.56% increase. A claim about the best setting needs a controlled same-code ablation after the free checks. The learned classifier in #611 was disabled, so this study says nothing about its savings or independent task accuracy.', '',
              '###7. Cost and monitoring controls were incomplete', '',
              'The driver cap counts completed scored estimates; retained setup usage was outside that total. Timeout or missing usage can leave exposure unknown. A cap checked between runs can overshoot on one expensive run. Include setup/failed-attempt usage, per-run limits and explicit handling of unknown exposure in the next plan.', '',
              'The detached process completed without updating the checkpoint or the maintainer. A future supervisor must record milestones and terminal success/failure, enforce stop conditions and produce a final report automatically. A detached launch is not monitoring, and a status file is not a delivered chat notification.', '',
              '## Historical competitor evidence (separate model and product builds)', '',
              'historical-all-runs.csv and .json export all458 retained records from three older campaigns:294 development records (288 ok,6 errors),101 held-out records (96 ok,5 errors), and63 check records (all ok). They use Claude Sonnet4.6, not this GPT-6.1 Sol campaign. Retried errors are retained. Their controls, current-for-that-study versions and older product trees are not a current Codex leaderboard.', '',
              '| Historical campaign | Product observations | Correct reading |', '|---|---|---|',
              '| #565 development | ours, Tokenjuice, Tokenade, Headroom in two modes, CTO, patched CTO, control;288 ok | Our mean task-cost ratio to control was1.149; not a current competitive result. |',
              '| #565 held-out | same eight arms;96 ok | Our mean ratio was0.843,95% interval[0.643,1.029]; primary interval includes parity. |',
              '| #594 check | ours, Tokenjuice, control;63 ok | Our product failed its fixed acceptance bar; all three arms passed21/21 tasks. |', '',
              'Full historical per-task tables remain in ../../565-five-product/RESULTS-BEFORE-FIXES.md, ../../565-heldout/RESULTS.md and ../../594-check/RESULTS.md. Do not pool these means or their dollar rates with the Codex medians and credit scenario.', '',
              '## Disposition', '',
              'Do not start another paid run from this review. Preserve the failed experiment, repair the report/admission/retention controls and reproduce product failures offline. Account for every competitor with an immutable latest-version lock and either a qualified official integration or an explicit evidence-backed blocker. Present the resulting design, exposure cap and any scope limits for review before spending again. See NEXT_CAMPAIGN.md.']
    # Keep prose readable while preserving numeric evidence in machine artifacts.
    text = '\n'.join(lines)
    for old, new in [('###1.', '### 1.'), ('###2.', '### 2.'), ('###3.', '### 3.'), ('###4.', '### 4.'), ('###5.', '### 5.'), ('###6.', '### 6.'), ('###7.', '### 7.')]:
        text = text.replace(old, new)
    # Exact prose corrections only: a generic letter/digit regex corrupts SHAs.
    corrections = {
        'Candidate6c3bd71d': 'Candidate `6c3bd71d`',
        'master1518a5d7': 'master `1518a5d7`',
        'Codex0.169.0': 'Codex CLI 0.169.0',
        'passed85/85': 'passed 85/85', 'scores of1.0': 'scores of 1.0',
        'scores of0.9': 'scores of 0.9', 'ratios is1.020455': 'ratios is 1.020455',
        'passed5/5': 'passed 5/5', 'total379.14152': 'total 379.14152',
        'add3.31051': 'add 3.31051', 'the47': 'the 47',
        'November11': 'November 11', 'of99': 'of 99', 'All170': 'All 170',
        'Baseline:13': 'Baseline: 13', 'Candidate:10': 'Candidate: 10',
        'were580': 'were 580', 'and24': 'and 24', 'The340': 'The 340',
        'not340': 'not 340', 'repetition4': 'repetition 4',
        'bootstrap,10000': 'bootstrap, 10000', 'draws,seed20261118': 'draws, seed 20261118',
        'a95%': 'a 95%', 'fix2': 'fix 2', 'build5': 'build 5',
        'survey5': 'survey 5', 'locate1': 'locate 1', 'rewrite0': 'rewrite 0',
        'is15.3%': 'is 15.3%', 'and20%': 'and 20%',
        'caused a5.56%': 'caused a 5.56%',
        'all458': 'all 458', 'campaigns:294': 'campaigns: 294',
        '(288 ok,6': '(288 ok, 6', 'errors),101': 'errors), 101',
        '(96 ok,5': '(96 ok, 5', 'errors), and63': 'errors), and 63',
        'Sonnet4.6': 'Sonnet 4.6', 'control;288': 'control; 288',
        'was1.149': 'was 1.149', 'arms;96': 'arms; 96',
        'was0.843,95%': 'was 0.843, 95%', 'interval[0.643,1.029]': 'interval [0.643,1.029]',
        'control;63': 'control; 63', 'passed21/21': 'passed 21/21',
    }
    for old, new in corrections.items():
        text = text.replace(old, new)
    write('ADVERSARIAL_REVIEW.md', text)
    print(json.dumps({'externalProducts': len(matrix), 'paidQualified': 0,
                      'report': str(HERE / 'ADVERSARIAL_REVIEW.md')}))


if __name__ == '__main__':
    main()
