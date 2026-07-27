/**
 * The consent sheet.
 *
 * This is where the app's privacy posture stops being architecture and becomes
 * something the user can see. The kernel's consent broker is defined in terms
 * of an async `prompt()` that resolves to an answer; this component is the only
 * thing that ever resolves it. Without it mounted, every scoped tool call would
 * block forever.
 *
 * Two rules are load-bearing and both are visible in what this renders:
 *
 *   - The exact arguments the model asked for are shown verbatim. Approving
 *     "create a calendar event" without seeing which event is not consent.
 *   - A mutating tool re-asks every single time, even under a standing grant,
 *     so "always allow" can never quietly authorise future writes.
 *
 * Together these are also what Apple guideline 4.7.3 requires of anything
 * running non-embedded logic, which is the door this leaves open for plugins.
 *
 * Visually it is a bottom sheet with a grab handle rather than a centred alert.
 * That is not decoration: a sheet rising from the bottom is the shape iOS uses
 * for a decision the user is being asked to make, and an alert is the shape it
 * uses for something that already happened. Getting that backwards is one of
 * the clearest tells that an interface was not designed for the platform.
 */

import { Modal, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../app-state';
import type { PromptAnswer } from '../tools/kernel/consent';
import * as haptics from './haptics';
import { Icon } from './icon';
import { Button, Surface, Text } from './primitives';
import { useTheme } from './theme';

/**
 * Turns a scope into something a person can read.
 *
 * Scopes are written for the kernel (`write:calendar`); this is the only place
 * they are translated for a human, and the wording deliberately names the
 * consequence rather than the permission.
 */
function describeScope(scope: string): string {
  const [action, resource] = scope.split(':');
  const readable = (resource ?? '').replace(/[-_]/g, ' ');

  switch (action) {
    case 'read':
      return `Read your ${readable}`;
    case 'write':
      return `Change your ${readable}`;
    case 'execute':
      return `Run ${readable} on this device`;
    default:
      return scope;
  }
}

/** Pretty-prints tool arguments, falling back to a raw string if need be. */
function formatArguments(args: unknown): string {
  if (args === null || args === undefined) return '(no details)';
  try {
    const text = JSON.stringify(args, null, 2);
    return text === '{}' ? '(no details)' : text;
  } catch {
    return String(args);
  }
}

export function ConsentSheet() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { pendingConsent, answerConsent } = useApp();

  if (!pendingConsent) return null;

  const { tool, args, scopes } = pendingConsent;
  const mutates = tool.mutates === true;

  /** Every choice is felt, and a denial feels different from an approval. */
  const answer = (value: PromptAnswer) => {
    if (value === 'deny' || value === 'deny-always') haptics.warning();
    else haptics.success();
    answerConsent(value);
  };

  return (
    <Modal
      transparent
      animationType="fade"
      visible
      // Dismissing without choosing is a denial, not a no-op — leaving the
      // promise unsettled would strand the turn forever.
      onRequestClose={() => answer('deny')}
    >
      <Animated.View entering={FadeIn.duration(theme.motion.fast)} style={styles.scrim}>
        <Animated.View entering={FadeInUp.duration(theme.motion.normal).springify()}>
          <Surface
            variant="raised"
            radius="xxl"
            bordered
            shadow="lg"
            style={{
              paddingHorizontal: theme.space[5],
              paddingTop: theme.space[2],
              paddingBottom: insets.bottom + theme.space[5],
              // Only the top corners round: the sheet is anchored to the bottom
              // edge, and rounding all four makes it float unmoored.
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
            }}
          >
            <View style={{ gap: theme.space[5] }}>
              <View
                style={[styles.handle, { backgroundColor: theme.color.borderStrong }]}
              />

              <View style={{ gap: theme.space[3], alignItems: 'center' }}>
                <View
                  style={[
                    styles.iconDisc,
                    {
                      backgroundColor: mutates
                        ? withWarningTint(theme.color.warning)
                        : theme.color.accentMuted,
                    },
                  ]}
                >
                  <Icon
                    name={mutates ? 'warning' : 'privacy'}
                    size={24}
                    color={mutates ? theme.color.warning : theme.color.accent}
                  />
                </View>
                <Text variant="title" align="center">
                  {mutates ? 'Allow this change?' : 'Allow access?'}
                </Text>
                <Text
                  variant="callout"
                  color="secondary"
                  align="center"
                  style={styles.prose}
                >
                  {tool.description}
                </Text>
              </View>

              {/* Scopes as a checklist rather than as chips. A chip row reads as
                  metadata; a checklist reads as the thing being agreed to. */}
              <Surface radius="md" padding={4} bordered style={{ gap: theme.space[3] }}>
                {scopes.map((scope) => (
                  <View key={scope} style={[styles.scopeRow, { gap: theme.space[3] }]}>
                    <Icon
                      name={scope.startsWith('write:') ? 'warning' : 'checkCircle'}
                      size={16}
                      color={
                        scope.startsWith('write:')
                          ? theme.color.warning
                          : theme.color.success
                      }
                    />
                    <Text variant="subhead" style={styles.grow}>
                      {describeScope(scope)}
                    </Text>
                  </View>
                ))}

                <View style={{ gap: theme.space[1] }}>
                  <Text variant="overline" color="tertiary">
                    {tool.name}
                  </Text>
                  <ScrollView style={styles.argumentBox} nestedScrollEnabled>
                    <Text variant="mono" color="secondary" selectable>
                      {formatArguments(args)}
                    </Text>
                  </ScrollView>
                </View>
              </Surface>

              <View style={{ gap: theme.space[2] }}>
                <Button
                  label={mutates ? 'Allow once' : 'Allow'}
                  icon="checkCircle"
                  fullWidth
                  onPress={() => answer('allow-once')}
                />

                <View style={[styles.buttonRow, { gap: theme.space[2] }]}>
                  {/* Deliberately absent for mutating tools. A standing grant to
                      write would defeat the point of confirming each change. */}
                  {!mutates && (
                    <Button
                      label="Always allow"
                      variant="secondary"
                      onPress={() => answer('allow-always')}
                      style={styles.grow}
                    />
                  )}
                  <Button
                    label="Don't allow"
                    variant="secondary"
                    onPress={() => answer('deny')}
                    style={styles.grow}
                  />
                </View>

                <Button
                  label="Never allow this"
                  variant="ghost"
                  size="sm"
                  fullWidth
                  onPress={() => answer('deny-always')}
                />
              </View>

              <View style={[styles.footnote, { gap: theme.space[2] }]}>
                <Icon name="privacy" size={12} color={theme.color.textTertiary} />
                <Text variant="caption" color="tertiary">
                  Nothing here leaves your device.
                </Text>
              </View>
            </View>
          </Surface>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

/** A faint wash of the warning colour, for the mutating-tool icon well. */
function withWarningTint(color: string): string {
  return color.startsWith('#')
    ? `${color}26` // ~15% alpha in 8-digit hex
    : color;
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  handle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 4,
  },
  iconDisc: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grow: { flex: 1 },
  prose: { maxWidth: 320 },
  scopeRow: { flexDirection: 'row', alignItems: 'center' },
  buttonRow: { flexDirection: 'row' },
  argumentBox: { maxHeight: 120 },
  footnote: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});
