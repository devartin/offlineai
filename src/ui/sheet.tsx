/**
 * Bottom sheets.
 *
 * A sheet rising from the bottom edge is the shape both platforms use for "you
 * are being asked to choose"; a centred alert is the shape for "something has
 * already happened". Getting that pairing backwards is one of the clearest
 * tells that an interface was not designed for the platform it is running on,
 * and it is why every optional choice in this app arrives this way.
 *
 * This generalises the shape `consent-sheet.tsx` established. That file keeps
 * its own copy on purpose: consent is a decision that must never be dismissible
 * into a no-op — dismissing it *is* a denial, and it has to resolve a promise
 * on the way out — so sharing a container built around a plain `onClose` would
 * have made it easy to introduce exactly that bug later.
 */

import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as haptics from './haptics';
import { Icon, type IconName } from './icon';
import { Divider, Surface, Text } from './primitives';
import { useTheme } from './theme';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

/**
 * The container.
 *
 * The scrim is a pressable that closes: on a phone, tapping away from a sheet
 * is the gesture people reach for before they look for a close button, and a
 * sheet that ignores it feels stuck.
 */
export function Sheet({ visible, onClose, title, children }: SheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  if (!visible) return null;

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <Animated.View entering={FadeIn.duration(theme.motion.fast)} style={styles.fill}>
        {/* Absolutely positioned rather than `flex: 1`. A flexing scrim eats
            all the free space in this column and pushes the panel below the
            bottom edge of the screen, where it is present, focusable and
            completely invisible. */}
        <Pressable
          style={[styles.scrim, { backgroundColor: 'rgba(0,0,0,0.55)' }]}
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
          onPress={onClose}
        />

        {/* `FadeInDown`, not `FadeInUp`: Reanimated names these for the
            direction of travel, so `FadeInDown` starts 25pt *below* its resting
            place and rises. A sheet anchored to the bottom edge that drops in
            from above reads as an alert, which is the wrong shape entirely. */}
        <Animated.View entering={FadeInDown.duration(theme.motion.normal).springify()}>
          {/* Swallows taps so a press inside the panel does not fall through to
              the scrim behind it and dismiss the sheet the user is using. */}
          <Pressable accessible={false} onPress={() => undefined}>
            <Surface
              variant="raised"
              radius="xxl"
              bordered
              shadow="lg"
              style={{
                paddingTop: theme.space[2],
                paddingBottom: insets.bottom + theme.space[3],
                // Only the top corners round. The sheet is anchored to the
                // bottom edge, and rounding all four makes it float unmoored.
                borderBottomLeftRadius: 0,
                borderBottomRightRadius: 0,
              }}
            >
              <View
                style={[styles.handle, { backgroundColor: theme.color.borderStrong }]}
              />

              {title && (
                <Text
                  variant="footnote"
                  color="tertiary"
                  align="center"
                  numberOfLines={1}
                  style={{
                    paddingHorizontal: theme.space[5],
                    paddingTop: theme.space[3],
                    paddingBottom: theme.space[1],
                  }}
                >
                  {title}
                </Text>
              )}

              {children}
            </Surface>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

export interface SheetAction {
  icon: IconName;
  label: string;
  /** Tints the row red. Reserved for actions that destroy something. */
  destructive?: boolean;
  onPress: () => void;
}

export interface ActionSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  actions: SheetAction[];
}

/**
 * A list of things you can do to one object.
 *
 * Rows are full-width and 48pt tall, which is above both platforms' minimum
 * target and, more usefully, large enough to hit without looking while holding
 * the phone one-handed — the posture almost every one of these is invoked in.
 */
export function ActionSheet({ visible, onClose, title, actions }: ActionSheetProps) {
  const theme = useTheme();

  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <View style={{ paddingTop: theme.space[1] }}>
        {actions.map((action, index) => (
          <View key={action.label}>
            {index > 0 && <Divider inset={4} />}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={action.label}
              onPress={() => {
                haptics.tap();
                // Closed before the action runs, so an action that navigates or
                // opens another sheet is not racing this one's dismissal.
                onClose();
                action.onPress();
              }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.space[3],
                height: 48,
                paddingHorizontal: theme.space[5],
                backgroundColor: pressed ? theme.color.surfacePressed : 'transparent',
              })}
            >
              <Icon
                name={action.icon}
                size={18}
                color={action.destructive ? theme.color.danger : theme.color.text}
              />
              <Text
                variant="callout"
                style={{
                  color: action.destructive ? theme.color.danger : theme.color.text,
                }}
              >
                {action.label}
              </Text>
            </Pressable>
          </View>
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    opacity: 0.6,
  },
});
