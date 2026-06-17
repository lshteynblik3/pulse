import type { Category } from '@pulse/shared';

/**
 * Layer 2 of classification: regex heuristics, tried only when the normalized
 * app name misses the canonical map. Evaluated in order; FIRST MATCH WINS, so
 * ordering matters. Tests run against the NORMALIZED name (lowercase, no
 * separators), so patterns are plain substrings.
 *
 * Token choice is deliberately conservative to limit false positives — several
 * tempting-but-dangerous substrings are intentionally absent and left to the
 * canonical map instead:
 *   - bare "code"   would catch barcode/qrcode/unicode (VS Code is canonical)
 *   - bare "studio" would pull FL Studio / OBS Studio into development
 *   - bare "git"    would catch digit/legit (git clients are canonical)
 *   - bare "arc"/"edge" would catch search/ledger (Arc & Edge are canonical)
 *   - bare "mail"   would catch blackmail (specific mail clients listed instead)
 *
 * Known, accepted residual risks (all low-cost; entertainment is matched last):
 *   - "chat" classifies chatgpt-style apps as communication
 *     (ChatGPT/Claude are pinned to development in the canonical map first)
 *   - "music"/"launcher"/"game" are broad, but entertainment is non-productive
 *     and evaluated only after every other category has had its turn.
 */
export const HEURISTICS: ReadonlyArray<{ category: Category; test: RegExp }> = [
  // development — terminals / shells
  {
    category: 'development',
    test: /term|shell|tty|console|powershell|pwsh|mintty|alacritty|wezterm|conemu/,
  },
  // development — editors / IDEs / dev tooling
  {
    category: 'development',
    test: /vscode|vscodium|sublime|jetbrains|intellij|pycharm|webstorm|goland|rustrover|clion|phpstorm|datagrip|neovim|nvim|emacs|helix|docker|podman|kube|devenv|xcode/,
  },
  // development — build/SDK tooling
  { category: 'development', test: /sdk|devkit|gradle|cmake/ },
  // communication
  {
    category: 'communication',
    test: /slack|teams|zoom|discord|telegram|whatsapp|signal|webex|mattermost|rocketchat|chat|meet|inbox|mailspring|thunderbird|outlook/,
  },
  // creative
  {
    category: 'creative',
    test: /figma|sketch|photoshop|illustrator|indesign|lightroom|premiere|aftereffects|blender|cinema4d|zbrush|substance|affinity|krita|gimp|inkscape|resolve|ableton|cubase|protools|reaper|audacity|flstudio/,
  },
  // browser
  {
    category: 'browser',
    test: /chrome|chromium|firefox|mozilla|msedge|brave|vivaldi|librewolf|opera|webkit/,
  },
  // entertainment (last — broadest tokens, non-productive)
  {
    category: 'entertainment',
    test: /spotify|music|netflix|hulu|disney|twitch|steam|epicgames|battlenet|riot|league|minecraft|roblox|game|launcher/,
  },
];

/** First heuristic whose regex matches the normalized name, or undefined. */
export function matchHeuristic(normalized: string): Category | undefined {
  for (const { category, test } of HEURISTICS) {
    if (test.test(normalized)) return category;
  }
  return undefined;
}
