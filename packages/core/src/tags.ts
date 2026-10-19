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
 *   "Shop_toggle:Shop"   -> toggles the panel named "Shop"
 *   "Close_close:Shop"   -> hides the panel named "Shop"
 *   "Exit_exit"          -> disables the whole ScreenGui
 *   "Tab1_tab:Weapons"   -> tab button (group "Weapons", or the nearest _tabgroup)
 *   "Tab1_tab"           -> tab belonging to the nearest _tabgroup
 *   "Tabs_tabgroup"      -> scopes its _tab / _page children into one group
 *   "Page_tab:Weapons"   -> page shown when tab group "Weapons" is active
 *   "Glow_hover"         -> state layer shown while its button is hovered
 *   "Press_clicked"      -> state layer shown while its button is held
 *   "Idle_default"       -> state layer shown when no other state is active
 *   "Lock_disabled"      -> state layer shown while the button is uninteractable
 *   "Chosen_active"      -> state layer shown while figrbxActive is true
 *   "Weapon_select"      -> one choice at a time within the parent frame
 *   "Card_lean"          -> tilts toward the pointer while hovered
 *   "Card_magnet"        -> drifts slightly toward the pointer
 *   "Card_nopointer"     -> no hover dim, tilt, magnet, or auto button colour
 *   "Score_bind:Coins"   -> replaces the whole label from a player path
 *   "Prompt_billboard:12"-> root host: billboard 12 studs wide
 *   "Prompt_surface:8"   -> root host: SurfaceGui on a part, 8 studs wide
 *   "Prompt_prompt:6"    -> root host: anchor part + ProximityPrompt
 *   "Ring_hold:1.5"      -> fills its UIStroke over a 1.5 s prompt hold
 *   "Coins{Coins}"       -> name "Coins", live text bound to leaderstats.Coins
 *                           (falling back to the ScreenGui attribute "Coins")
 *   "Rank{attr:Rank}"    -> bound to the local player's attribute "Rank"
 *   "Hi{PlayerName}"     -> bound to Player.Name; {DisplayName} to DisplayName
 *
 * Control tags change how a layer is converted:
 *
 *   "Hero_image"         -> bake the layer (with children) to one image
 *   "#Hero" / "img:Hero" -> same, using the prefix spelling
 *   "Hero_ignore"        -> skip the layer and its children
 *   "Hero_frame"         -> keep an editable Frame instead of an automatic bake
 *   "Title_txt"          -> keep text live even when the mode says bake
 *   "Title_fit"          -> opt into TextScaled
 *   "Glow_keep"          -> stay editable when the parent is baked
 *   "Logo_aspect"        -> add a UIAspectRatioConstraint
 *   "Overlay_canvas"     -> force a CanvasGroup
 *   "Button_nodim"       -> turn off the hover dim on this button
 *   "Rows_nolist"        -> opt out of _list auto-detection
 *   "Rows_list"          -> lay children out with a UIListLayout
 *   "Cards_grid"         -> lay children out with a UIGridLayout
 *   "Name_input"         -> import the drawn text as a TextBox placeholder
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
  | 'toggle'
  | 'exit'
  | 'tab'
  | 'tabgroup'
  | 'page'
  | 'hover'
  | 'clicked'
  | 'default'
  | 'disabled'
  | 'active'
  | 'select'
  | 'lean'
  | 'magnet'
  | 'nopointer'
  | 'bind'
  | 'billboard'
  | 'surface'
  | 'prompt'
  | 'hold'
  | 'closed';

export type Behavior = {
  kind: BehaviorKind;
  /** Target for _open / _toggle / _close / _tab / _page, or a parameter for
   *  _bind / _billboard / _surface / _prompt / _hold. */
  target?: string;
};

export type ControlTag =
  | 'ignore'
  | 'bake'
  | 'frame'
  | 'text'
  | 'textbox'
  | 'keep'
  | 'fit'
  | 'aspect'
  | 'canvas'
  | 'nodim'
  | 'list'
  | 'grid'
  | 'nolist';

export type AttributeBinding = {
  /** Attribute name placed on the ScreenGui, e.g. "Coins". */
  name: string;
};

export type ParsedName = {
  /** Layer name with every behavior and control tag removed. */
  name: string;
  behaviors: Behavior[];
  controls: ControlTag[];
  bindings: AttributeBinding[];
};

const BEHAVIOR_PATTERN =
  /_(open|tab|page|toggle|close|bind|billboard|surface|prompt|hold):([A-Za-z0-9_.-]+)|_(button|scroll|panel|close|exit|closed|tabgroup|tab|hover|clicked|default|disabled|active|select|lean|magnet|nopointer|billboard|surface|prompt|hold)(?![a-z0-9])/gi;
const CONTROL_PATTERN =
  /_(ignore|frame|txt|textbox|input|image|img|lock|keep|fit|aspect|canvas|nodim|list|grid|nolist)(?![a-z0-9])/gi;
const BINDING_PATTERN = /\{([A-Za-z0-9_.:-]+)\}/g;

const CONTROL_ALIASES: Record<string, ControlTag> = {
  ignore: 'ignore',
  frame: 'frame',
  txt: 'text',
  textbox: 'textbox',
  input: 'textbox',
  image: 'bake',
  img: 'bake',
  lock: 'bake',
  keep: 'keep',
  fit: 'fit',
  aspect: 'aspect',
  canvas: 'canvas',
  nodim: 'nodim',
  list: 'list',
  grid: 'grid',
  nolist: 'nolist',
};

export function parseLayerName(rawName: string): ParsedName {
  const behaviors: Behavior[] = [];
  const controls: ControlTag[] = [];
  let cleaned = rawName;

  // Prefix spellings have no underscore to anchor on, so they are stripped
  // before the token pass. Both are authoring directives, not part of the name.
  cleaned = cleaned.replace(/^\s*(?:#|img:)\s*/i, () => {
    controls.push('bake');
    return '';
  });

  cleaned = cleaned.replace(CONTROL_PATTERN, (_match, token: string) => {
    const control = CONTROL_ALIASES[token.toLowerCase()];
    if (control && !controls.includes(control)) controls.push(control);
    return ' ';
  });

  cleaned = cleaned
    .replace(
      BEHAVIOR_PATTERN,
      (
        _match,
        targeted: string | undefined,
        target: string | undefined,
        simple: string | undefined,
      ) => {
        if (targeted && target) {
          behaviors.push({ kind: targeted.toLowerCase() as BehaviorKind, target });
        } else if (simple) {
          behaviors.push({ kind: simple.toLowerCase() as BehaviorKind });
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
    controls,
    bindings,
  };
}

/** True when the parsed name carries a control tag. */
export function hasControl(parsed: ParsedName, control: ControlTag): boolean {
  return parsed.controls.includes(control);
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
