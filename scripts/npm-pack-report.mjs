/** npm <=11 returns an array; npm 12 keys pack reports by package name. */
export function parsePackReport(text, expectedName) {
  const value = JSON.parse(text);
  const reports = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.values(value)
      : [];
  const matches = reports.filter((report) => report?.name === expectedName);
  if (
    matches.length !== 1 ||
    !Array.isArray(matches[0].files) ||
    matches[0].files.length === 0 ||
    !matches[0].files.every(
      (file) => typeof file?.path === 'string' && file.path.length > 0
    )
  )
    throw Error(
      `npm pack did not return one valid file list for ${expectedName}`
    );
  return matches[0];
}
