/**
 * Behavior tags.
 *
 * A layer's name is the only channel Figma gives us for authoring behavior, so
 * tags are appended to it (or placed anywhere) and stripped before import:
 *
 *   "Shop_button"        -> name "Shop",     behavior "button"
 *   "Body_scroll"        -> name "Body",     behavior "scroll"
 *   "Settings_panel"     -> name "Settings", behavior "panel"
 *   "Close_close"        -> name "Close",    behavior "close"
 *   "OpenShop_open:Shop" -> name "OpenShop", behavior "open", target "Shop"
 *   "Tab1_tab:Weapons"   -> tab within group "Weapons"
 *   "Page_tab:Weapons"   -> page shown when tab group "Weapons" is active
 *   "Coins{Coins}"       -> name "Coins", live text bound to attribute "Coins"
 *
 * Tags are matched case-insensitively. Unknown underscore-prefixed tokens are
 * left alone so ordinary layer names survive.
 */

export type BehaviorKind =
  | 'button'
  | 'scroll'
  | 'panel'
  | 'close'
  | 'open'
  | 'tab'
  | 'page'
  | 'closed';

export type Behavior = {
  kind: BehaviorKind;
  /** Target name for _open / _tab / _page. */
  target?: string;
};

export type AttributeBinding = {
  /** Attribute name placed on the ScreenGui, e.g. "Coins". */
  name: string;
};

export type ParsedName = {
  /** Layer name with every behavior tag removed and whitespace collapsed. */
  name: string;
  behaviors: Behavior[];
  bindings: AttributeBinding[];
};

const BEHAVIOR_PATTERN =
  /_(button|scroll|panel|close|closed)(?![a-z0-9])|_(open|tab|page):([A-Za-z0-9_.-]+)/gi;
const BINDING_PATTERN = /\{([A-Za-z0-9_.-]+)\}/g;

export function parseLayerName(rawName: string): ParsedName {
  const behaviors: Behavior[] = [];
  const cleaned = rawName
    .replace(
      BEHAVIOR_PATTERN,
      (
        _match,
        simple: string | undefined,
        targeted: string | undefined,
        target: string | undefined,
      ) => {
        if (simple) {
          behaviors.push({ kind: simple.toLowerCase() as BehaviorKind });
        } else if (targeted && target) {
          behaviors.push({ kind: targeted.toLowerCase() as BehaviorKind, target });
        }
        return ' ';
      },
    )
    .replace(/\s+/g, ' ')
    .trim();

  const bindings: AttributeBinding[] = [];
  for (const match of rawName.matchAll(BINDING_PATTERN)) {
    bindings.push({ name: match[1]! });
  }

  return {
    name: cleaned.length > 0 ? cleaned : 'Layer',
    behaviors,
    bindings,
  };
}

/** True when any node in the tree carries behavior tags or bindings. */
export function hasBehaviors(nodes: Array<{ rawName: string }>): boolean {
  return nodes.some((node) => {
    const parsed = parseLayerName(node.rawName);
    return parsed.behaviors.length > 0 || parsed.bindings.length > 0;
  });
}

/** True when a parsed name should become a button. */
export function isButton(parsed: ParsedName): boolean {
  return parsed.behaviors.some((behavior) => behavior.kind === 'button');
}

/** Target of the first behavior of a kind, if any. */
export function behaviorTarget(parsed: ParsedName, kind: BehaviorKind): string | undefined {
  return parsed.behaviors.find((behavior) => behavior.kind === kind)?.target;
}

/**
 * Build the Lua/format string for bound text.
 * "Coins: {Coins}" -> "Coins: %s"
 */
export function textFormatString(text: string): string {
  return text.replace(BINDING_PATTERN, '%s');
}
