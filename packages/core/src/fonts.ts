/**
 * Font matching.
 *
 * Roblox ships a fixed set of font families. We map the fonts people actually
 * design with onto the closest built-in, and report how confident that match
 * is. The converter uses that confidence to decide whether an "exact" import
 * should bake the text layer to an image instead.
 */

export type FontMatch = {
  /** Enum.Font name, e.g. "GothamBold". */
  robloxFont: string;
  /** The family is a known design font with a deliberate mapping. */
  known: boolean;
  /** The mapping is visually equivalent (same family and cut). */
  exact: boolean;
  /** Human-readable explanation, surfaced in import reports. */
  note?: string;
};

type FamilyRule = {
  /** Fonts checked case-insensitively, without spaces for robustness. */
  names: string[];
  regular: string;
  bold?: string;
  black?: string;
  italic?: string;
  /** True when Roblox literally ships this family. */
  exact: boolean;
};

const FAMILIES: FamilyRule[] = [
  {
    names: ['roboto'],
    regular: 'Roboto',
    bold: 'Roboto',
    black: 'Roboto',
    exact: true,
  },
  {
    names: ['robotocondensed', 'roboto condensed'],
    regular: 'RobotoCondensed',
    bold: 'RobotoCondensed',
    exact: true,
  },
  {
    names: ['robotomono', 'roboto mono'],
    regular: 'RobotoMono',
    bold: 'RobotoMono',
    exact: true,
  },
  {
    names: ['arial', 'helvetica', 'helvetica neue'],
    regular: 'Arial',
    bold: 'ArialBold',
    exact: true,
  },
  {
    names: ['sourcesans3', 'source sans 3', 'sourcesanspro', 'source sans pro', 'source sans'],
    regular: 'SourceSans',
    bold: 'SourceSansBold',
    black: 'SourceSansBold',
    italic: 'SourceSansItalic',
    exact: true,
  },
  {
    names: ['buildersans', 'builder sans', 'builder'],
    regular: 'BuilderSans',
    bold: 'BuilderSansBold',
    black: 'BuilderSansHeavy',
    exact: true,
  },
  {
    names: ['inter', 'interdisplay', 'inter display', 'intertight', 'inter tight'],
    regular: 'GothamMedium',
    bold: 'GothamBold',
    black: 'GothamBlack',
    exact: false,
  },
  {
    names: ['gotham', 'gothamrounded', 'gotham rounded'],
    regular: 'Gotham',
    bold: 'GothamBold',
    black: 'GothamBlack',
    exact: true,
  },
  {
    names: ['montserrat', 'poppins', 'nunito', 'nunito sans', 'rubik', 'figtree', 'manrope'],
    regular: 'GothamMedium',
    bold: 'GothamBold',
    black: 'GothamBlack',
    exact: false,
  },
  {
    names: [
      'spacegrotesk',
      'space grotesk',
      'sora',
      'outfit',
      'dm sans',
      'dmsans',
      'plusjakarta sans',
    ],
    regular: 'GothamMedium',
    bold: 'GothamBold',
    black: 'GothamBlack',
    exact: false,
  },
  {
    names: [
      'jetbrainsmono',
      'jet brains mono',
      'firacode',
      'fira code',
      'consolas',
      'menlo',
      'monaco',
      'courier new',
      'courier',
    ],
    regular: 'RobotoMono',
    bold: 'RobotoMono',
    exact: false,
  },
  {
    names: [
      'opensans',
      'open sans',
      'lato',
      'noto sans',
      'notosans',
      'nunito',
      'segoe ui',
      'verdana',
      'tahoma',
    ],
    regular: 'SourceSans',
    bold: 'SourceSansBold',
    exact: false,
  },
  {
    names: [
      'georgia',
      'times new roman',
      'times',
      'garamond',
      'playfair display',
      'merriweather',
      'serif',
    ],
    regular: 'Legacy',
    bold: 'Legacy',
    exact: false,
  },
  {
    names: ['comic sans ms', 'comic sans', 'cursive'],
    regular: 'Script',
    bold: 'ScriptBold',
    exact: false,
  },
];

const BOLD_WORDS =
  /\b(bold|black|heavy|extrabold|extra bold|semibold|semi bold|demibold|demi bold|700|800|900)\b/i;
const BLACK_WORDS = /\b(black|heavy|extrabold|extra bold|900)\b/i;
const ITALIC_WORDS = /\b(italic|oblique)\b/i;

function normalize(family: string): string {
  // Spaces, hyphens and underscores are noise: "JetBrains Mono", "jetbrainsmono"
  // and "JetBrains-Mono" all describe the same family.
  return family
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/**
 * Map a Figma font family + style onto the closest Roblox Enum.Font.
 * Never throws: unknown families fall back to Gotham.
 */
export function resolveFont(family: string, style = 'Regular'): FontMatch {
  const normalizedFamily = normalize(family);
  const rule = FAMILIES.find((candidate) =>
    candidate.names.some((name) => normalize(name) === normalizedFamily),
  );

  const isBold = BOLD_WORDS.test(style);
  const isBlack = BLACK_WORDS.test(style);
  const isItalic = ITALIC_WORDS.test(style);

  if (!rule) {
    // Unknown families are the interesting case: these are exactly the ones a
    // designer picked by hand, so exact mode bakes them rather than substituting.
    return {
      robloxFont: isBlack ? 'GothamBlack' : isBold ? 'GothamBold' : 'GothamMedium',
      known: false,
      exact: false,
      note: `No built-in match for "${family}"`,
    };
  }

  let robloxFont = rule.regular;
  if (isItalic && rule.italic) robloxFont = rule.italic;
  else if (isBlack && rule.black) robloxFont = rule.black;
  else if (isBold && rule.bold) robloxFont = rule.bold;

  const styleExact =
    (!isBold && !isBlack && !isItalic) ||
    (isItalic && Boolean(rule.italic)) ||
    (isBlack && Boolean(rule.black)) ||
    (isBold && Boolean(rule.bold));

  // Roblox has a single cut for Roboto/RobotoMono/Arial etc. Treat weight
  // variations as exact only when the family ships one face.
  const familySingleCut = rule.bold === undefined || rule.bold === rule.regular;

  return {
    robloxFont,
    known: true,
    exact: rule.exact && (familySingleCut || styleExact),
    // Any substitution is an approximation worth reporting: either the family
    // is not a Roblox font, or the family is but this cut of it is not.
    note: !rule.exact
      ? `Substituted "${family}"`
      : !styleExact && !familySingleCut
        ? `Style "${style}" approximated`
        : undefined,
  };
}

/** Should this text layer be rasterized instead of imported as live text? */
export function shouldBakeText(mode: 'live' | 'exact' | 'auto', match: FontMatch): boolean {
  if (mode === 'live') return false;
  if (mode === 'exact') return !match.exact;
  return !match.known;
}

/** Roblox Enum.Font names this module can emit, for validation and docs. */
export const KNOWN_ROBLOX_FONTS = [
  'Legacy',
  'Arial',
  'ArialBold',
  'SourceSans',
  'SourceSansBold',
  'SourceSansSemibold',
  'SourceSansLight',
  'SourceSansItalic',
  'Gotham',
  'GothamMedium',
  'GothamBold',
  'GothamBlack',
  'Script',
  'ScriptBold',
  'Roboto',
  'RobotoCondensed',
  'RobotoMono',
  'BuilderSans',
  'BuilderSansBold',
  'BuilderSansMedium',
  'BuilderSansHeavy',
] as const;
