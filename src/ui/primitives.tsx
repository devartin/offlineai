/**
 * The component vocabulary every screen is built from.
 *
 * The premium feel of this app is decided here rather than in the screens.
 * Three things carry most of that weight, and all three were missing before:
 *
 *   1. **Icons.** Every control that can carry a glyph does. A button whose
 *      affordance is a text character reads as a placeholder.
 *   2. **Response.** Every pressable scales under the finger on a spring and
 *      fires a haptic. The research on this is unanimous — the tactile layer is
 *      what separates "I hope that worked" from "I felt it work".
 *   3. **Graceful glass.** Every translucent surface degrades in three steps:
 *      real Liquid Glass on iOS 26, a `UIVisualEffectView` blur on older iOS,
 *      then an opaque tonal surface. A user on iOS 18 or a budget Android
 *      should see a coherent app, not a broken one.
 *
 * Screens import from here and nowhere else for chrome, so a change to the
 * house style is a change to this file.
 */

import { BlurView } from 'expo-blur';
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  Text as RNText,
  StyleSheet,
  View,
  type StyleProp,
  type TextProps as RNTextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import * as haptics from './haptics';
import { Icon, type IconName } from './icon';
import { useTheme, type RadiusScale, type Theme } from './theme';

/**
 * Whether real Liquid Glass can be rendered, resolved once at module load.
 *
 * Both checks are required and they answer different questions:
 * `isLiquidGlassAvailable()` reports whether the design system supports it,
 * while `isGlassEffectAPIAvailable()` validates that the runtime API is
 * actually present — the pair is what keeps iOS 26 beta builds from crashing.
 *
 * The answer cannot change during a session, and calling into the native module
 * on every render of every surface is measurable on a long chat transcript.
 */
const LIQUID_GLASS =
  Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

/** Blur is only convincing on iOS. Android's is expensive and Material does not want it. */
const CAN_BLUR = Platform.OS === 'ios';

type SpaceKey = keyof Theme['space'];
type RadiusKey = keyof RadiusScale;

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export interface SurfaceProps {
  children?: ReactNode;
  /**
   * `glass` opts into real Liquid Glass where the OS provides it. Use it for
   * chrome that floats over content — bars, sheets, the composer. Body content
   * should use `plain` or `raised`, because glass over glass reads as mud.
   */
  variant?: 'plain' | 'raised' | 'glass';
  radius?: RadiusKey;
  padding?: SpaceKey;
  bordered?: boolean;
  /** Soft drop shadow. Floating chrome should have one; inline cards usually not. */
  shadow?: 'none' | 'sm' | 'md' | 'lg';
  style?: StyleProp<ViewStyle>;
}

export function Surface({
  children,
  variant = 'plain',
  radius = 'md',
  padding,
  bordered = false,
  shadow = 'none',
  style,
}: SurfaceProps) {
  const theme = useTheme();

  const base: ViewStyle = {
    borderRadius: theme.radius[radius],
    ...(padding !== undefined ? { padding: theme.space[padding] } : null),
    ...(bordered
      ? { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.border }
      : null),
  };

  const shadowStyle = shadow === 'none' ? null : theme.elevation[shadow];

  if (variant === 'glass') {
    if (LIQUID_GLASS) {
      // Never animate a glass surface to `opacity: 0` — on iOS that silently
      // stops the effect rendering entirely rather than fading it. Fade the
      // children, or switch `glassEffectStyle` to 'none', instead.
      return (
        <View style={[shadowStyle, style]}>
          <GlassView glassEffectStyle="regular" style={[base, styles.clipped]}>
            {children}
          </GlassView>
        </View>
      );
    }

    if (CAN_BLUR) {
      // The second step of the ladder: a real blur, plus a hairline and a very
      // slight tint. Blur alone over a dark background is nearly invisible;
      // the tint is what gives the surface an edge to be seen by.
      return (
        <View style={[shadowStyle, style]}>
          <BlurView
            intensity={theme.scheme === 'dark' ? 40 : 60}
            tint={theme.scheme === 'dark' ? 'dark' : 'light'}
            style={[base, styles.clipped, { backgroundColor: theme.color.surface }]}
          >
            {children}
          </BlurView>
        </View>
      );
    }
  }

  return (
    <View
      style={[
        base,
        {
          backgroundColor:
            variant === 'raised' ? theme.color.surfaceRaised : theme.color.surface,
        },
        shadowStyle,
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export interface TextProps extends Omit<RNTextProps, 'style'> {
  variant?: keyof Theme['typography'];
  color?:
    | 'primary'
    | 'secondary'
    | 'tertiary'
    | 'accent'
    | 'danger'
    | 'success'
    | 'warning'
    | 'onAccent';
  weight?: '400' | '500' | '600' | '700';
  align?: 'left' | 'center' | 'right';
  style?: StyleProp<TextStyle>;
  children?: ReactNode;
}

export function Text({
  variant = 'body',
  color = 'primary',
  weight,
  align,
  style,
  children,
  ...rest
}: TextProps) {
  const theme = useTheme();

  const palette = {
    primary: theme.color.text,
    secondary: theme.color.textSecondary,
    tertiary: theme.color.textTertiary,
    accent: theme.color.accent,
    danger: theme.color.danger,
    success: theme.color.success,
    warning: theme.color.warning,
    onAccent: theme.color.onAccent,
  } as const;

  return (
    <RNText
      {...rest}
      style={[
        theme.typography[variant],
        { color: palette[color] },
        weight ? { fontWeight: weight } : null,
        align ? { textAlign: align } : null,
        style,
      ]}
    >
      {children}
    </RNText>
  );
}

/** A section label above a grouped list. Small, wide-tracked, uppercase. */
export function SectionHeader({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <RNText
      accessibilityRole="header"
      style={[
        theme.typography.overline,
        {
          color: theme.color.textTertiary,
          textTransform: 'uppercase',
          marginBottom: theme.space[2],
          marginLeft: theme.space[1],
        },
      ]}
    >
      {children}
    </RNText>
  );
}

// ---------------------------------------------------------------------------
// PressableScale
// ---------------------------------------------------------------------------

export interface PressableScaleProps {
  onPress: () => void;
  children: ReactNode;
  /** How far to shrink under the finger. Larger controls want less. */
  scaleTo?: number;
  disabled?: boolean;
  haptic?: 'none' | 'tap' | 'press' | 'select';
  accessibilityLabel: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * The press behaviour every control in the app shares.
 *
 * Runs on the UI thread through Reanimated, so it stays smooth while the JS
 * thread is busy decoding tokens — which, in this app, it very often is. That
 * is the whole reason this is not a plain `Animated.View`: a press that stutters
 * during generation would undo the effect on exactly the screen that matters.
 */
export function PressableScale({
  onPress,
  children,
  scaleTo = 0.96,
  disabled = false,
  haptic = 'tap',
  accessibilityLabel,
  accessibilityHint,
  style,
}: PressableScaleProps) {
  const theme = useTheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Animated.View style={[animatedStyle, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPressIn={() => {
          scale.value = withSpring(scaleTo, theme.motion.spring);
        }}
        onPressOut={() => {
          scale.value = withSpring(1, theme.motion.spring);
        }}
        onPress={() => {
          if (haptic !== 'none') haptics[haptic]();
          onPress();
        }}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  icon?: IconName;
  /** Draw the icon after the label instead of before. */
  iconTrailing?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

const BUTTON_HEIGHTS = { sm: 36, md: 48, lg: 56 } as const;
const BUTTON_ICON = { sm: 15, md: 17, lg: 19 } as const;

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  icon,
  iconTrailing = false,
  fullWidth = false,
  style,
}: ButtonProps) {
  const theme = useTheme();

  const foreground =
    variant === 'primary'
      ? theme.color.onSolid
      : variant === 'danger'
        ? theme.color.onAccent
        : variant === 'ghost'
          ? theme.color.accent
          : theme.color.text;

  const body = (
    <>
      {icon && !iconTrailing && (
        <Icon name={icon} size={BUTTON_ICON[size]} color={foreground} />
      )}
      <RNText
        style={[
          size === 'sm' ? theme.typography.subhead : theme.typography.headline,
          { color: foreground, fontWeight: '600' },
        ]}
        numberOfLines={1}
      >
        {label}
      </RNText>
      {icon && iconTrailing && (
        <Icon name={icon} size={BUTTON_ICON[size]} color={foreground} />
      )}
    </>
  );

  const inner: ViewStyle = {
    height: BUTTON_HEIGHTS[size],
    paddingHorizontal: theme.space[size === 'sm' ? 4 : 6],
    borderRadius: theme.radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[2],
  };

  const content = loading ? (
    <ActivityIndicator size="small" color={foreground} />
  ) : (
    body
  );

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled || loading}
      haptic={variant === 'primary' ? 'press' : 'tap'}
      accessibilityLabel={label}
      scaleTo={0.96}
      style={[
        fullWidth ? styles.fullWidth : null,
        { opacity: disabled ? 0.4 : 1 },
        style,
      ]}
    >
      <View
        style={[
          inner,
            {
              backgroundColor:
                // Inverted ground rather than a colour: white on dark, near
                // black on light. This is what makes a primary action read as
                // primary in a monochrome interface.
                variant === 'primary'
                  ? theme.color.solid
                  : variant === 'danger'
                    ? theme.color.danger
                    : variant === 'secondary'
                      ? theme.color.surfaceRaised
                      : 'transparent',
            },
            variant === 'secondary'
              ? {
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: theme.color.border,
                }
              : null,
          ]}
        >
        {content}
      </View>
    </PressableScale>
  );
}

// ---------------------------------------------------------------------------
// IconButton
// ---------------------------------------------------------------------------

export interface IconButtonProps {
  icon: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  size?: number;
  variant?: 'plain' | 'filled' | 'solid';
  tone?: 'primary' | 'secondary' | 'accent' | 'danger';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A circular icon-only control.
 *
 * The frame is always at least 44pt regardless of the glyph size, because
 * that is Apple's minimum tap target and the most common accessibility failure
 * in otherwise well-built apps.
 */
export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  size = 20,
  variant = 'plain',
  tone = 'secondary',
  disabled = false,
  style,
}: IconButtonProps) {
  const theme = useTheme();
  const frame = Math.max(44, size + 20);

  const foreground =
    variant === 'solid'
      ? theme.color.onSolid
      : tone === 'primary'
        ? theme.color.text
        : tone === 'accent'
          ? theme.color.accent
          : tone === 'danger'
            ? theme.color.danger
            : theme.color.textSecondary;

  const frameStyle: ViewStyle = {
    width: frame,
    height: frame,
    borderRadius: frame / 2,
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      scaleTo={0.9}
      accessibilityLabel={accessibilityLabel}
      style={[{ opacity: disabled ? 0.35 : 1 }, style]}
    >
      <View
        style={[
          frameStyle,
          variant === 'solid'
            ? { backgroundColor: theme.color.solid }
            : variant === 'filled'
              ? { backgroundColor: theme.color.surfaceRaised }
              : null,
        ]}
      >
        <Icon
          name={icon}
          size={size}
          color={foreground}
          weight={variant === 'solid' ? 'bold' : 'semibold'}
        />
      </View>
    </PressableScale>
  );
}

// ---------------------------------------------------------------------------
// Chip
// ---------------------------------------------------------------------------

export interface ChipProps {
  label: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
  icon?: IconName;
  size?: 'sm' | 'md';
  onPress?: () => void;
}

/** A compact status label — capability badges, fit verdicts, tool names. */
export function Chip({ label, tone = 'neutral', icon, size = 'sm', onPress }: ChipProps) {
  const theme = useTheme();

  const tones = {
    neutral: { bg: theme.color.toolChip, fg: theme.color.toolChipText },
    success: { bg: withAlpha(theme.color.success, 0.14), fg: theme.color.success },
    warning: { bg: withAlpha(theme.color.warning, 0.14), fg: theme.color.warning },
    danger: { bg: withAlpha(theme.color.danger, 0.14), fg: theme.color.danger },
    accent: { bg: theme.color.accentMuted, fg: theme.color.accent },
  } as const;

  const body = (
    <View
      style={[
        styles.chip,
        {
          backgroundColor: tones[tone].bg,
          borderRadius: theme.radius.pill,
          paddingHorizontal: theme.space[size === 'sm' ? 2 : 3],
          paddingVertical: size === 'sm' ? 4 : 6,
          gap: 5,
        },
      ]}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 11 : 13} color={tones[tone].fg} />}
      <RNText
        style={[
          size === 'sm' ? theme.typography.caption : theme.typography.subhead,
          { color: tones[tone].fg, fontWeight: '600' },
        ]}
      >
        {label}
      </RNText>
    </View>
  );

  if (!onPress) return body;
  return (
    <PressableScale
      onPress={onPress}
      scaleTo={0.94}
      accessibilityLabel={label}
      style={styles.selfStart}
    >
      {body}
    </PressableScale>
  );
}

// ---------------------------------------------------------------------------
// Card and ListRow
// ---------------------------------------------------------------------------

export interface CardProps {
  children: ReactNode;
  onPress?: () => void;
  padding?: SpaceKey;
  style?: StyleProp<ViewStyle>;
}

/** The standard content container: raised, bordered, generously rounded. */
export function Card({ children, onPress, padding = 4, style }: CardProps) {
  const theme = useTheme();

  const surface = (
    <Surface variant="raised" radius="lg" padding={padding} bordered style={style}>
      {children}
    </Surface>
  );

  if (!onPress) return surface;
  return (
    <PressableScale onPress={onPress} scaleTo={0.985} accessibilityLabel="Open">
      {surface}
    </PressableScale>
  );
}

export interface ListRowProps {
  label: string;
  detail?: string;
  icon?: IconName;
  /** Right-hand content — a value, a switch, a chip. */
  accessory?: ReactNode;
  onPress?: () => void;
  tone?: 'primary' | 'danger';
  first?: boolean;
  last?: boolean;
}

/**
 * A grouped-list row.
 *
 * The shape iOS users read as "a setting". Corner rounding is applied only to
 * the first and last rows of a group so a run of them forms one continuous
 * card, which is the detail that distinguishes a native-feeling settings screen
 * from a stack of separate boxes.
 */
export function ListRow({
  label,
  detail,
  icon,
  accessory,
  onPress,
  tone = 'primary',
  first = false,
  last = false,
}: ListRowProps) {
  const theme = useTheme();
  const foreground = tone === 'danger' ? theme.color.danger : theme.color.text;

  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space[3],
        paddingHorizontal: theme.space[4],
        paddingVertical: theme.space[3],
        minHeight: 52,
        backgroundColor: theme.color.surfaceRaised,
        borderTopLeftRadius: first ? theme.radius.md : 0,
        borderTopRightRadius: first ? theme.radius.md : 0,
        borderBottomLeftRadius: last ? theme.radius.md : 0,
        borderBottomRightRadius: last ? theme.radius.md : 0,
      }}
    >
      {icon && <Icon name={icon} size={18} color={theme.color.accent} />}
      <View style={styles.grow}>
        <RNText style={[theme.typography.callout, { color: foreground }]}>{label}</RNText>
        {detail && (
          <RNText
            style={[theme.typography.footnote, { color: theme.color.textTertiary }]}
          >
            {detail}
          </RNText>
        )}
      </View>
      {accessory}
      {onPress && !accessory && (
        <Icon name="chevronRight" size={14} color={theme.color.textTertiary} />
      )}
    </View>
  );

  if (!onPress) return content;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        haptics.tap();
        onPress();
      }}
    >
      {content}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

export interface SegmentedProps<T extends string> {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

/** A two-to-four-way switch. Selection is a spring, not a fade. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: SegmentedProps<T>) {
  const theme = useTheme();

  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        backgroundColor: theme.color.toolChip,
        borderRadius: theme.radius.pill,
        padding: 3,
        gap: 2,
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={option.label}
            onPress={() => {
              if (!active) haptics.select();
              onChange(option.value);
            }}
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: theme.space[2],
              borderRadius: theme.radius.pill,
              backgroundColor: active ? theme.color.surfaceRaised : 'transparent',
            }}
          >
            <RNText
              style={[
                theme.typography.subhead,
                {
                  color: active ? theme.color.text : theme.color.textSecondary,
                  fontWeight: active ? '600' : '500',
                },
              ]}
            >
              {option.label}
            </RNText>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Divider, ProgressBar, Skeleton
// ---------------------------------------------------------------------------

export function Divider({ inset = 0 }: { inset?: number }) {
  const theme = useTheme();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.color.border,
        marginLeft: inset,
      }}
    />
  );
}

export interface ProgressBarProps {
  /** 0–1. Values outside the range are clamped rather than overflowing. */
  progress: number;
  tone?: 'accent' | 'success' | 'warning';
  height?: number;
}

export function ProgressBar({ progress, tone = 'accent', height = 6 }: ProgressBarProps) {
  const theme = useTheme();
  const clamped = Math.max(0, Math.min(1, progress));

  const animatedStyle = useAnimatedStyle(() => ({
    width: withTiming(`${clamped * 100}%`, { duration: theme.motion.normal }),
  }));


  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={[
        styles.progressTrack,
        { height, backgroundColor: theme.color.toolChip, borderRadius: height / 2 },
      ]}
    >
      <Animated.View
        style={[
          animatedStyle,
          {
            height: '100%',
            borderRadius: height / 2,
            backgroundColor: tone === 'accent' ? theme.color.text : theme.color[tone],
          },
        ]}
      />
    </View>
  );
}

/**
 * A placeholder for content that has not loaded.
 *
 * Sweeps rather than pulses. A pulsing block reads as "something is broken";
 * a sweep reads as "something is arriving", and it is the difference between a
 * loading state that feels considered and one that feels like a stub.
 */
export function Skeleton({
  height = 16,
  width = '100%',
  radius: radiusKey = 'sm',
}: {
  height?: number;
  width?: number | `${number}%`;
  radius?: RadiusKey;
}) {
  const theme = useTheme();
  const offset = useSharedValue(-1);

  useEffect(() => {
    offset.value = withRepeat(
      withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.quad) }),
      -1,
      false,
    );
  }, [offset]);

  const sweep = useAnimatedStyle(() => ({
    transform: [{ translateX: `${offset.value * 100}%` }],
  }));

  return (
    <View
      style={{
        height,
        width,
        backgroundColor: theme.color.toolChip,
        borderRadius: theme.radius[radiusKey],
        overflow: 'hidden',
      }}
    >
      <Animated.View style={[StyleSheet.absoluteFill, sweep]}>
        <LinearGradient
          colors={['transparent', theme.color.surfacePressed, 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether the software keyboard is on screen.
 *
 * The chat composer needs this to decide how much room to leave beneath itself.
 * iOS gets the `Will` events so the layout change starts on the same frame as
 * the keyboard's own animation; Android only emits `Did`.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const show = Keyboard.addListener(showEvent, () => setVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return visible;
}

/**
 * Applies alpha to a token colour.
 *
 * Handles the three notations the palettes actually use — #RGB, #RRGGBB and
 * rgba() — and returns the input unchanged for anything else, so an unexpected
 * value degrades to a visible colour rather than a crash.
 */
export function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split('')
            .map((c) => c + c)
            .join('')
        : hex;
    if (full.length !== 6) return color;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  const rgba = /^rgba?\(([^)]+)\)$/.exec(color);
  if (rgba) {
    const [r, g, b] = rgba[1].split(',').map((part) => part.trim());
    return `rgba(${r},${g},${b},${alpha})`;
  }

  return color;
}

const styles = StyleSheet.create({
  fullWidth: { width: '100%' },
  clipped: { overflow: 'hidden' },
  selfStart: { alignSelf: 'flex-start' },
  grow: { flex: 1, gap: 1 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  progressTrack: {
    width: '100%',
    overflow: 'hidden',
  },
});
