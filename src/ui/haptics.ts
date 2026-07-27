/**
 * Haptics.
 *
 * Every piece of research on what makes a mobile app feel expensive lands on
 * the same point: the tactile layer is what turns "I hope that worked" into "I
 * felt it work". It is also the cheapest premium signal available — a few
 * milliseconds of Taptic Engine costs nothing and is felt on every single
 * interaction.
 *
 * The rules this module encodes:
 *   - `tap` for ordinary buttons. Light, because a heavy thud on every press
 *     becomes noise within a minute.
 *   - `select` for moving between discrete options — tabs, segmented controls.
 *     This is the one iOS reserves for pickers, and using it elsewhere is the
 *     most common way apps get haptics wrong.
 *   - `success` / `warning` / `error` for outcomes only. Never for input.
 *
 * Everything is fire-and-forget. A haptic that fails is not worth a rejected
 * promise, and awaiting one would put a native round-trip in the middle of a
 * press handler.
 */

import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Whether the platform has a haptics implementation worth calling.
 *
 * Web has none, and calling into the module there throws. Android's
 * implementation exists but maps everything onto a coarse vibration; it is
 * still worth firing, because the alternative is that Android users get no
 * feedback at all.
 */
const ENABLED = Platform.OS === 'ios' || Platform.OS === 'android';

function fire(run: () => Promise<void>): void {
  if (!ENABLED) return;
  // Swallowed deliberately. A device with haptics disabled in Settings, or one
  // whose engine is busy, rejects here — and none of that is worth surfacing to
  // a user who just tapped a button.
  void run().catch(() => undefined);
}

/** An ordinary button press. */
export function tap(): void {
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** A weightier press — send, confirm, primary actions. */
export function press(): void {
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
}

/** Moving between discrete options: tabs, segments, list selection. */
export function select(): void {
  fire(() => Haptics.selectionAsync());
}

/** An operation completed. Use sparingly — this one is felt. */
export function success(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/** An operation completed, but not cleanly. */
export function warning(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}

/** An operation failed. */
export function error(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
}
