/**
 * Normalize an OS-reported application name into a stable lookup key.
 *
 * The Windows categorization bug was that `active-win`'s `owner.name` comes back
 * in many shapes ("Code.exe", "Notepad++", "zoom.us", "Windows Terminal") that
 * never matched the friendly-name keys in categories.json. Both the config keys
 * and the live app name go through THIS function, so they meet in the middle.
 *
 * Steps: lowercase -> drop a trailing ".exe" -> strip everything that isn't a
 * letter or digit (whitespace and punctuation). So "Visual Studio Code" ->
 * "visualstudiocode", "zoom.us" -> "zoomus", "ms-teams" -> "msteams".
 *
 * Privacy: the input is only ever the application/process name (owner.name) —
 * never a window title, URL, or path. Nothing here reads or retains content.
 */
export function normalize(appName: string): string {
  return appName
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/[^a-z0-9]/g, '');
}
