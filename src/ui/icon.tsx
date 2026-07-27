/**
 * The icon system.
 *
 * The app previously had no icons at all — the send button was the literal
 * text character `↑`. That one detail did more damage to how finished the app
 * felt than any layout decision, because a glyph rendered in the body font
 * reads as a placeholder no matter how good everything around it is.
 *
 * Icons are addressed by *semantic* name, never by platform glyph name. A
 * screen asks for `send`, and this module decides that means `arrow.up` on iOS
 * and `arrow-up` elsewhere. Screens therefore never contain a platform
 * conditional, and adding a platform later is a change to this file only.
 *
 * On iOS these are real SF Symbols, which means they inherit the system's
 * optical sizing and weight matching against SF Pro — the reason a native app's
 * icons sit correctly next to its text and a bundled icon font's usually do
 * not. Everywhere else they fall back to Ionicons, whose geometric style is the
 * closest widely-available match.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { SymbolView, type SymbolViewProps, type SymbolWeight } from 'expo-symbols';
import type { ComponentProps } from 'react';
import { View, Platform, type StyleProp, type ViewStyle } from 'react-native';

type IoniconName = ComponentProps<typeof Ionicons>['name'];
/**
 * The SF Symbols catalogue is a literal union, not `string`. Naming the type
 * here means a typo in the map below fails the build rather than rendering a
 * blank square on a device.
 */
type SymbolName = SymbolViewProps['name'];

/** Every icon the app is allowed to draw. */
export type IconName =
  // Composer and generation
  | 'send'
  | 'stop'
  | 'mic'
  | 'attach'
  // Navigation
  | 'chat'
  | 'models'
  | 'settings'
  | 'history'
  | 'menu'
  | 'search'
  | 'back'
  | 'chevronRight'
  | 'chevronDown'
  | 'chevronUp'
  | 'close'
  | 'newChat'
  // Message actions
  | 'copy'
  | 'copied'
  | 'regenerate'
  | 'share'
  // Model management
  | 'download'
  | 'pause'
  | 'play'
  | 'trash'
  | 'checkCircle'
  | 'storage'
  // Capability and status
  | 'privacy'
  | 'sparkles'
  | 'bolt'
  | 'vision'
  | 'tools'
  | 'thinking'
  | 'document'
  | 'memory'
  | 'chip'
  | 'warning'
  | 'info'
  | 'error'
  | 'external';

/**
 * Semantic name → per-platform glyph.
 *
 * The SF Symbol is the source of truth for what the icon *means*; the Ionicon
 * is chosen to match its silhouette rather than its name, which is why a few
 * pairs look mismatched in text and correct on screen.
 */
const GLYPHS: Record<IconName, { sf: SymbolName; ion: IoniconName }> = {
  send: { sf: 'arrow.up', ion: 'arrow-up' },
  stop: { sf: 'stop.fill', ion: 'stop' },
  mic: { sf: 'mic.fill', ion: 'mic' },
  attach: { sf: 'paperclip', ion: 'attach' },

  chat: { sf: 'bubble.left.and.bubble.right.fill', ion: 'chatbubbles' },
  models: { sf: 'square.stack.3d.up.fill', ion: 'layers' },
  settings: { sf: 'gearshape.fill', ion: 'settings' },
  history: { sf: 'clock.arrow.circlepath', ion: 'time' },
  menu: { sf: 'line.3.horizontal', ion: 'menu' },
  search: { sf: 'magnifyingglass', ion: 'search' },
  back: { sf: 'chevron.left', ion: 'chevron-back' },
  chevronRight: { sf: 'chevron.right', ion: 'chevron-forward' },
  chevronDown: { sf: 'chevron.down', ion: 'chevron-down' },
  chevronUp: { sf: 'chevron.up', ion: 'chevron-up' },
  close: { sf: 'xmark', ion: 'close' },
  newChat: { sf: 'square.and.pencil', ion: 'create-outline' },

  copy: { sf: 'doc.on.doc', ion: 'copy-outline' },
  copied: { sf: 'checkmark', ion: 'checkmark' },
  regenerate: { sf: 'arrow.clockwise', ion: 'refresh' },
  share: { sf: 'square.and.arrow.up', ion: 'share-outline' },

  download: { sf: 'arrow.down.circle.fill', ion: 'arrow-down-circle' },
  pause: { sf: 'pause.fill', ion: 'pause' },
  play: { sf: 'play.fill', ion: 'play' },
  trash: { sf: 'trash', ion: 'trash-outline' },
  checkCircle: { sf: 'checkmark.circle.fill', ion: 'checkmark-circle' },
  storage: { sf: 'internaldrive.fill', ion: 'server' },

  privacy: { sf: 'lock.shield.fill', ion: 'shield-checkmark' },
  sparkles: { sf: 'sparkles', ion: 'sparkles' },
  bolt: { sf: 'bolt.fill', ion: 'flash' },
  vision: { sf: 'eye.fill', ion: 'eye' },
  tools: { sf: 'wrench.and.screwdriver.fill', ion: 'construct' },
  thinking: { sf: 'brain', ion: 'bulb' },
  document: { sf: 'doc.text.fill', ion: 'document-text' },
  memory: { sf: 'bookmark.fill', ion: 'bookmark' },
  chip: { sf: 'cpu.fill', ion: 'hardware-chip' },
  warning: { sf: 'exclamationmark.triangle.fill', ion: 'warning' },
  info: { sf: 'info.circle.fill', ion: 'information-circle' },
  error: { sf: 'exclamationmark.circle.fill', ion: 'alert-circle' },
  external: { sf: 'arrow.up.right', ion: 'open-outline' },
};

export interface IconProps {
  name: IconName;
  /** Point size. Matches the SF Symbol point size, not the glyph's bounding box. */
  size?: number;
  color: string;
  /**
   * SF Symbol weight. Ignored off iOS, where Ionicons has a single weight.
   * Default is `semibold`, which is what sits correctly beside 600-weight text.
   */
  weight?: SymbolWeight;
  style?: StyleProp<ViewStyle>;
}

/**
 * An icon.
 *
 * Always decorative here: every icon in this app either sits beside a text
 * label or lives inside a control that carries its own `accessibilityLabel`, so
 * announcing the glyph too would make the screen reader repeat itself.
 */
export function Icon({ name, size = 20, color, weight = 'semibold', style }: IconProps) {
  const glyph = GLYPHS[name];

  if (Platform.OS === 'ios') {
    return (
      <SymbolView
        name={glyph.sf}
        size={size}
        tintColor={color}
        weight={weight}
        type="monochrome"
        // Sized explicitly because SymbolView lays out from the symbol's own
        // bounding box, which varies per glyph — without this, rows of icons
        // fail to align with each other.
        style={[{ width: size, height: size }, style]}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
    );
  }

  // Wrapped rather than styled directly: Ionicons takes a `TextStyle`, and
  // passing this component's `ViewStyle` through would mean either a cast or a
  // second style prop. The wrapper also matches the explicit frame the iOS
  // branch gives SymbolView, so icons align in a row on both platforms.
  return (
    <View style={style}>
      <Ionicons
        name={glyph.ion}
        size={size}
        color={color}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
    </View>
  );
}
