/**
 * Design tokens.
 *
 * The reference is the ChatGPT mobile app, and the most important thing to take
 * from it is what it *doesn't* do. It is very close to monochrome: a near-black
 * or white ground, three greys, and colour reserved for state that would
 * otherwise be ambiguous. The restraint is the style. An earlier version of
 * this file leaned on a saturated iris→cyan gradient across buttons, progress
 * bars and chrome, and beside a monochrome reference that reads as decoration
 * rather than as design.
 *
 * So: surfaces, bubbles and the send affordance are greyscale. The accent
 * survives in three places — selection, links, capability badges — where the
 * alternative is a user unable to tell what is active. The brand gradient
 * survives in exactly one place, the mark, which is the only element whose job
 * is to be recognisable rather than legible.
 *
 * The per-platform palette split is gone. It existed to make iOS translucent
 * and Android tonal, but both now resolve to the same near-monochrome ramp, and
 * two identical tables are just two places to forget to change something. Radii
 * and motion still diverge, because those genuinely differ between the two
 * platforms' shape and animation languages.
 */

import { Platform, useColorScheme } from 'react-native';

export type ColorSchemeName = 'light' | 'dark';

/**
 * The brand constants.
 *
 * Only the mark uses the gradient now. The accent appears rarely enough that it
 * functions as a highlight rather than as a theme colour.
 */
export const brand = {
  irisDark: '#7F70FF',
  irisLight: '#5A46E0',
  skyDark: '#54D2F0',
  skyLight: '#0FA8D4',
} as const;

export interface Palette {
  /** Furthest back. Behind everything. */
  background: string;
  /** A raised backdrop — sheets, the drawer, grouped-list backgrounds. */
  backgroundElevated: string;
  /** Cards, sheets, bars. */
  surface: string;
  /** A surface sitting on another surface — nested cards, the composer. */
  surfaceRaised: string;
  /** Pressed/hovered fill for rows and icon buttons. */
  surfacePressed: string;
  /** Hairlines and dividers. */
  border: string;
  /** A border that needs to be seen — focused inputs, selected cards. */
  borderStrong: string;

  text: string;
  textSecondary: string;
  /** Placeholders, disabled labels, timestamps. */
  textTertiary: string;

  /**
   * The high-contrast fill for primary actions and the send button.
   *
   * White on dark, near-black on light — the inversion of the ground. This is
   * the reference app's signature control, and the reason its primary actions
   * read as primary with no colour at all.
   */
  solid: string;
  /** Text and icons drawn on `solid`. */
  onSolid: string;

  /** Selection, links, capability badges. Deliberately rare. */
  accent: string;
  onAccent: string;
  /** A wash of accent for selected rows. */
  accentMuted: string;

  /** The user's own chat bubbles. Grey, not coloured. */
  bubbleUser: string;
  bubbleUserText: string;
  /**
   * The assistant's surface.
   *
   * Assistant answers render full-width and unbubbled, as in the reference.
   * This colour is kept for the rare inline cases — errors, quoted blocks —
   * that still need a fill.
   */
  bubbleAssistant: string;
  bubbleAssistantText: string;

  success: string;
  warning: string;
  danger: string;

  /** Tool-call chips and the reasoning disclosure. */
  toolChip: string;
  toolChipText: string;

  /** Fenced code blocks. */
  codeBackground: string;
  codeText: string;
}

const DARK: Palette = {
  background: '#0D0D0D',
  backgroundElevated: '#171717',
  surface: '#1C1C1C',
  surfaceRaised: '#2A2A2A',
  surfacePressed: 'rgba(255,255,255,0.08)',
  border: 'rgba(255,255,255,0.10)',
  borderStrong: 'rgba(255,255,255,0.22)',

  text: '#ECECEC',
  textSecondary: '#B4B4B4',
  textTertiary: '#8E8E8E',

  solid: '#FFFFFF',
  onSolid: '#0D0D0D',

  accent: brand.irisDark,
  onAccent: '#FFFFFF',
  accentMuted: 'rgba(127,112,255,0.18)',

  bubbleUser: '#2F2F2F',
  bubbleUserText: '#ECECEC',
  bubbleAssistant: '#1C1C1C',
  bubbleAssistantText: '#ECECEC',

  success: '#4ADE9B',
  warning: '#F5A623',
  danger: '#F16B6B',

  toolChip: 'rgba(255,255,255,0.07)',
  toolChipText: '#B4B4B4',

  codeBackground: '#171717',
  codeText: '#ECECEC',
};

const LIGHT: Palette = {
  background: '#FFFFFF',
  backgroundElevated: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceRaised: '#F7F7F7',
  surfacePressed: 'rgba(0,0,0,0.05)',
  border: 'rgba(0,0,0,0.10)',
  borderStrong: 'rgba(0,0,0,0.22)',

  text: '#0D0D0D',
  textSecondary: '#5D5D5D',
  textTertiary: '#8E8E8E',

  solid: '#0D0D0D',
  onSolid: '#FFFFFF',

  accent: brand.irisLight,
  onAccent: '#FFFFFF',
  accentMuted: 'rgba(90,70,224,0.10)',

  bubbleUser: '#F4F4F4',
  bubbleUserText: '#0D0D0D',
  bubbleAssistant: '#F7F7F7',
  bubbleAssistantText: '#0D0D0D',

  success: '#12855C',
  warning: '#9A6100',
  danger: '#C0392B',

  toolChip: '#F0F0F0',
  toolChipText: '#5D5D5D',

  codeBackground: '#F7F7F7',
  codeText: '#0D0D0D',
};

/** 4pt base scale. Keys are multipliers, so `space[4]` is 16pt. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  7: 28,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
  20: 80,
} as const;

export interface RadiusScale {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  xxl: number;
  pill: number;
}

/**
 * Corner radii.
 *
 * iOS runs larger and rounder; Material's shape scale is deliberately flatter.
 * One of the two places the platforms still genuinely diverge.
 */
export const radius: RadiusScale = Platform.select({
  ios: { xs: 8, sm: 12, md: 18, lg: 24, xl: 28, xxl: 34, pill: 999 },
  default: { xs: 6, sm: 10, md: 14, lg: 20, xl: 26, xxl: 32, pill: 999 },
});

/**
 * Type scale.
 *
 * `body` sits at 16/25 rather than iOS's stock 17/22. Chat is long-form
 * reading, and a ~1.55 line-height is the highest-leverage readability change
 * available for multi-paragraph model output — and it is what the reference
 * app does.
 */
export const typography = {
  /** The empty-state greeting, and nothing else. */
  display: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '600' as const,
    letterSpacing: -0.6,
  },
  /** Screen titles. */
  largeTitle: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700' as const,
    letterSpacing: -0.5,
  },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' as const, letterSpacing: -0.4 },
  /** Card titles and section leads. */
  title3: {
    fontSize: 19,
    lineHeight: 25,
    fontWeight: '600' as const,
    letterSpacing: -0.3,
  },
  headline: {
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '600' as const,
    letterSpacing: -0.3,
  },
  /** Body copy, including message text. */
  body: { fontSize: 16, lineHeight: 25, fontWeight: '400' as const, letterSpacing: -0.2 },
  callout: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '400' as const,
    letterSpacing: -0.2,
  },
  subhead: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500' as const,
    letterSpacing: -0.1,
  },
  footnote: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '400' as const,
    letterSpacing: 0,
  },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' as const, letterSpacing: 0 },
  /** Section headers above grouped lists. Render with `textTransform`. */
  overline: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600' as const,
    letterSpacing: 0.5,
  },
  /** Tool arguments, model metadata, code spans. */
  mono: {
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '400' as const,
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    }),
  },
} as const;

/**
 * Motion.
 *
 * iOS gets springs because that is what every system animation there is built
 * from; Android gets emphasised duration/easing pairs. Using one for the other
 * is the most obvious tell that an app is cross-platform.
 */
export const motion = {
  /** Duration in ms for opacity and colour transitions. */
  fast: 150,
  normal: 220,
  slow: 340,
  /** Reanimated spring config for anything that moves or scales. */
  spring: { damping: 22, stiffness: 260, mass: 0.9 },
  /** A softer spring for entrances, so new messages settle rather than snap. */
  springGentle: { damping: 26, stiffness: 180, mass: 1 },
  /** Overshoots slightly. For the send button and other confirmations. */
  springBouncy: { damping: 15, stiffness: 320, mass: 0.8 },
} as const;

export interface ElevationStyle {
  shadowColor: string;
  shadowOpacity: number;
  shadowRadius: number;
  shadowOffset: { width: number; height: number };
  elevation: number;
}

/**
 * Shadow presets.
 *
 * Softer and used far less than before. The reference separates surfaces with a
 * hairline and a tone step, not with shadow; heavy drop shadows are one of the
 * clearest tells of an interface trying to look expensive rather than being
 * well-proportioned.
 */
export const elevation: Record<'sm' | 'md' | 'lg', ElevationStyle> = {
  sm: {
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  lg: {
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 14 },
    elevation: 12,
  },
};

export interface Theme {
  scheme: ColorSchemeName;
  color: Palette;
  space: typeof space;
  radius: RadiusScale;
  typography: typeof typography;
  motion: typeof motion;
  elevation: typeof elevation;
  /** The brand gradient. Used by the mark, and nowhere else. */
  gradient: readonly [string, string];
  /** True when the platform can render real Liquid Glass surfaces. */
  glass: boolean;
}

export function getTheme(scheme: ColorSchemeName): Theme {
  const dark = scheme === 'dark';

  return {
    scheme,
    color: dark ? DARK : LIGHT,
    space,
    radius,
    typography,
    motion,
    elevation,
    gradient: dark
      ? ([brand.irisDark, brand.skyDark] as const)
      : ([brand.irisLight, brand.skyLight] as const),
    glass: Platform.OS === 'ios',
  };
}

/**
 * The theme for the current appearance.
 *
 * Defaults to dark when the system reports no preference: an app whose main
 * surface is a conversation reads better dark.
 */
export function useTheme(): Theme {
  const scheme = useColorScheme();
  return getTheme(scheme === 'light' ? 'light' : 'dark');
}
