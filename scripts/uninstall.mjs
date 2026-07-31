#!/usr/bin/env node
/**
 * Removal, from the record of what was installed.
 *
 * DRY RUN BY DEFAULT. Deleting files on somebody else's machine is the last
 * place to infer consent from the fact that a command was typed, so this prints
 * the plan and changes nothing unless `--apply` is passed.
 *
 * It removes only what the manifest says we wrote AND that still hashes to what
 * we wrote. A file edited since is left in place and named -- removing it would
 * destroy work that is now partly the user's, and removing it silently would be
 * worse than leaving it. Anything not in the manifest was not ours and is not
 * touched, including hooks the user added themselves.
 *
 *     node scripts/uninstall.mjs            # show the plan
 *     node scripts/uninstall.mjs --apply    # carry it out
 */

import { readManifest, removalPlan, uninstall, residue, manifestPath } from '../hooks-core/manifest.mjs';

const apply = process.argv.includes('--apply');
const manifest = readManifest();

if (!manifest) {
  console.log(`No installation record at ${manifestPath()}.`);
  console.log('Nothing to remove that we can prove is ours -- and we will not guess.');
  console.log('If hooks were installed by hand, remove the token-optimizer entries from your');
  console.log('settings.json and delete ~/.claude-global/hooks/ yourself.');
  process.exit(0);
}

const plan = removalPlan(manifest);
console.log(`Installed ${new Date(manifest.installedAt).toISOString().slice(0, 10)}` +
  `${manifest.packageVersion ? `, version ${manifest.packageVersion}` : ''}.`);
console.log('');

if (plan.remove.length) {
  console.log(`Will remove ${plan.remove.length} file(s) we wrote and that are unchanged:`);
  for (const path of plan.remove) console.log(`  - ${path}`);
} else {
  console.log('No files to remove.');
}

if (plan.keep.length) {
  console.log('');
  console.log('Leaving alone (edited since we wrote them -- removing would destroy your changes):');
  for (const item of plan.keep) console.log(`  ! ${item.path}`);
}

if (plan.gone.length) {
  console.log('');
  console.log(`${plan.gone.length} file(s) already gone.`);
}

if (plan.entries.length) {
  console.log('');
  console.log('Config entries we added (remove these by hand, so we never rewrite your settings):');
  for (const entry of plan.entries) console.log(`  - ${entry.file}: ${entry.path}${entry.description ? ` (${entry.description})` : ''}`);
}

console.log('');
console.log(plan.untouched);

if (!apply) {
  console.log('');
  console.log('Dry run -- nothing was changed. Re-run with --apply to carry this out.');
  process.exit(0);
}

const result = uninstall({ apply: true, manifest });
console.log('');
console.log(`Removed ${result.removed.length} file(s).`);
if (result.failed?.length) {
  console.log(`${result.failed.length} could not be removed:`);
  for (const failure of result.failed) console.log(`  ! ${failure.path}: ${failure.error}`);
}

// Confirm rather than assert. The claim "your machine is clean" should be
// checked by looking, not by having intended it.
const settings = process.env.TOKEN_OPTIMIZER_SETTINGS;
if (settings) {
  const found = residue(settings);
  console.log(found.clean
    ? 'Verified: no token-optimizer entries remain in the settings file.'
    : `${found.entries.length} entry/entries remain in ${settings} -- remove them by hand.`);
}
