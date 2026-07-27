/**
 * Text with a band of light travelling across it.
 *
 * This is the reference app's "working on it" cue, and it is worth reproducing
 * precisely because it solves a problem a spinner does not. A spinner says the
 * app is busy; a shimmer running through the *label* says that this named step
 * is the thing in progress. When several steps can be in flight — reasoning,
 * then a tool, then more reasoning — attaching the motion to the words is what
 * keeps the user oriented.
 *
 * Implemented by animating per-character opacity rather than by masking a
 * gradient over the text. Masking would need `@react-native-masked-view`, a
 * native module, and this needs no new dependency at all. The band is a falloff
 * around a travelling head: characters near it brighten, characters away from
 * it sit at rest.
 *
 * Per-character animated styles are bounded here because the labels are short
 * and fixed — "Thinking", "Calculating", "Searching your documents". The
 * unbounded-per-glyph memory problem that makes this approach wrong for body
 * text does not arise, because this never touches streamed content.
 */

import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { Text, type TextProps } from './primitives';
import { useTheme } from './theme';

/** One full sweep, in milliseconds. Slow enough to read as breathing. */
const SWEEP_MS = 1400;

/**
 * How many characters either side of the head are lifted.
 *
 * Wide enough that short labels still show a gradient rather than a single
 * blinking character.
 */
const BAND = 4;

/** Rest opacity. High enough that the label stays comfortably legible. */
const DIM = 0.45;

export interface ShimmerTextProps {
  children: string;
  variant?: TextProps['variant'];
  weight?: TextProps['weight'];
  /** Overrides the resolved colour. Defaults to secondary text. */
  color?: string;
  /**
   * When false the text renders flat and no animation is scheduled. Lets a
   * caller keep the same element in place across the running/settled boundary
   * without branching at the call site.
   */
  active?: boolean;
}

export function ShimmerText({
  children,
  variant = 'subhead',
  weight = '500',
  color,
  active = true,
}: ShimmerTextProps) {
  const theme = useTheme();
  const tint = color ?? theme.color.textSecondary;

  if (!active) {
    return (
      <Text variant={variant} weight={weight} style={{ color: tint }}>
        {children}
      </Text>
    );
  }

  return <Sweep text={children} variant={variant} weight={weight} tint={tint} />;
}

/**
 * The animated branch.
 *
 * Split out so its hooks only exist while the shimmer is active. Mounting and
 * unmounting across that boundary is the point: it tears the loop down instead
 * of leaving it running behind a static label.
 */
function Sweep({
  text,
  variant,
  weight,
  tint,
}: {
  text: string;
  variant: TextProps['variant'];
  weight: TextProps['weight'];
  tint: string;
}) {
  // Travels from off the left edge to off the right, so the band enters and
  // exits rather than appearing and vanishing mid-word.
  const head = useSharedValue(-BAND);
  const characters = [...text];
  useSweep(head, characters.length + BAND * 2);

  return (
    <View style={styles.row} accessibilityLabel={text}>
      {characters.map((character, index) => (
        <ShimmerCharacter
          key={`${index}-${character}`}
          character={character}
          index={index}
          head={head}
          variant={variant}
          weight={weight}
          tint={tint}
        />
      ))}
    </View>
  );
}

/**
 * Starts, and restarts, the sweep.
 *
 * Keyed on the travel distance so a label of a different length gets a fresh
 * loop. Reusing the previous distance would leave the band stalling past the
 * end of a shorter label or running off early on a longer one — and restarting
 * on a label change is also correct semantically, since a step that renames
 * itself mid-flight is a new step.
 */
function useSweep(head: SharedValue<number>, span: number) {
  useEffect(() => {
    head.value = -BAND;
    head.value = withRepeat(
      withTiming(span - BAND, { duration: SWEEP_MS, easing: Easing.linear }),
      -1,
      false,
    );
  }, [head, span]);
}

function ShimmerCharacter({
  character,
  index,
  head,
  variant,
  weight,
  tint,
}: {
  character: string;
  index: number;
  head: SharedValue<number>;
  variant: TextProps['variant'];
  weight: TextProps['weight'];
  tint: string;
}) {
  const animated = useAnimatedStyle(() => {
    const distance = Math.abs(index - head.value);
    // Linear falloff. A cosine looks marginally softer and costs a transcendental
    // per character per frame, which is not a trade worth making at 60fps on the
    // mid-range Android hardware this app targets.
    const lift = Math.max(0, 1 - distance / BAND);
    return { opacity: DIM + lift * (1 - DIM) };
  });

  return (
    <Animated.View style={animated}>
      <Text variant={variant} weight={weight} style={{ color: tint }}>
        {/* A plain space inside a per-character <Text> collapses during layout,
            so it is substituted with a non-breaking space. Without this the
            label renders as one run-on word. */}
        {character === ' ' ? ' ' : character}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Wraps, so a long label such as "Searching your documents" behaves like
  // ordinary text in a narrow column rather than clipping.
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
});
