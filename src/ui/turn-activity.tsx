/**
 * What the model is doing, while it is doing it.
 *
 * Two surfaces live here because they are the same idea at two moments: a step
 * that is running, named and shimmering, which then settles into a collapsed
 * row you can open if you want the detail. Keeping them together is what stops
 * them drifting apart visually, which is exactly what had happened when they
 * were two unrelated blocks inside the chat screen.
 *
 * The design rule both follow, taken from the reference app: **while it runs,
 * say what it is doing; once it is done, say what it did, and get out of the
 * way.** A panel that stays expanded turns a transcript into a debug log. The
 * detail is never destroyed, only folded — which matters more here than in a
 * cloud assistant, because a local model's reasoning is often the only way to
 * tell a good answer from a confident wrong one.
 */

import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  describeTool,
  formatThinkingDuration,
  reasoningTail,
  type ToolKind,
} from '../chat/activity';
import type { ToolRun } from '../inference/engine';
import * as haptics from './haptics';
import { Icon, type IconName } from './icon';
import { Surface, Text } from './primitives';
import { ShimmerText } from './shimmer';
import { useTheme } from './theme';

/**
 * Which glyph stands for which family of tool.
 *
 * This mapping lives here rather than in `chat/activity.ts` so that module can
 * stay free of every import, and therefore stay loadable by the test runner.
 */
const KIND_ICONS: Record<ToolKind, IconName> = {
  compute: 'chip',
  documents: 'document',
  memory: 'memory',
  generic: 'tools',
};

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

export interface ReasoningPanelProps {
  reasoning: string;
  /** Wall-clock time spent reasoning. Null until the trace has settled. */
  durationMs: number | null;
  /** True while reasoning tokens are still arriving. */
  active: boolean;
}

/**
 * The thinking module.
 *
 * Live, it is a shimmering "Thinking" over a single line of the most recent
 * reasoning. That line is the tail rather than the head deliberately: a trace
 * which opens with a fixed first sentence and never moves is indistinguishable
 * from a hang, and watching the model's latest thought change is what makes a
 * slow local model feel alive rather than stuck.
 *
 * Settled, it collapses to one quiet row — "Thought for 12 seconds" — that
 * opens on tap. Collapsed is the right default because the answer is what the
 * user asked for; the reasoning is evidence, available when they want to audit
 * it and silent when they do not.
 */
export function ReasoningPanel({ reasoning, durationMs, active }: ReasoningPanelProps) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  if (active) {
    const tail = reasoningTail(reasoning);
    return (
      <View style={{ gap: theme.space[1] }}>
        <ShimmerText variant="subhead" weight="500">
          Thinking
        </ShimmerText>
        {tail.length > 0 && (
          // Clipped to one line. A gradient fading toward the trailing edge
          // would need a mask view; this is the dependency-free version of the
          // same intent, and it reads almost identically at this size.
          <Text variant="footnote" color="tertiary" numberOfLines={1}>
            {tail}
          </Text>
        )}
      </View>
    );
  }

  if (reasoning.trim().length === 0) return null;

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={formatThinkingDuration(durationMs ?? 0)}
        accessibilityHint={open ? 'Hides the reasoning' : 'Shows the reasoning'}
        accessibilityState={{ expanded: open }}
        hitSlop={6}
        onPress={() => {
          haptics.tap();
          setOpen((value) => !value);
        }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space[2],
          alignSelf: 'flex-start',
          paddingVertical: theme.space[1],
        }}
      >
        <Text variant="subhead" color="tertiary">
          {formatThinkingDuration(durationMs ?? 0)}
        </Text>
        <Icon
          name={open ? 'chevronUp' : 'chevronDown'}
          size={11}
          color={theme.color.textTertiary}
        />
      </Pressable>

      {open && (
        <Animated.View entering={FadeIn.duration(theme.motion.fast)}>
          <Surface radius="md" padding={3} bordered style={{ marginTop: theme.space[1] }}>
            <Text variant="footnote" color="secondary" selectable>
              {reasoning.trim()}
            </Text>
          </Surface>
        </Animated.View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export interface ToolActivityProps {
  run: ToolRun;
  /** True between the model deciding to call the tool and the tool returning. */
  pending: boolean;
}

/**
 * One tool call.
 *
 * Rendered the moment the model commits to the call, before the tool has run,
 * so a slow or consent-blocked tool reads as work in progress rather than as a
 * frozen app. Watching the assistant reach for a calculator is most of what
 * makes the tool system feel trustworthy instead of magical — and on a device
 * where these tools touch real personal data, trustworthy is the whole product.
 */
export function ToolActivity({ run, pending }: ToolActivityProps) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  const presentation = describeTool(run.name);
  const failed = !pending && !run.ok;
  const tint = failed ? theme.color.danger : theme.color.textSecondary;
  const label = pending ? presentation.running : presentation.done;

  if (pending) {
    return (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space[2],
          paddingVertical: theme.space[1],
        }}
      >
        <Icon name={KIND_ICONS[presentation.kind]} size={14} color={tint} />
        <ShimmerText variant="subhead" weight="500">
          {label}
        </ShimmerText>
      </View>
    );
  }

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}. ${failed ? 'Failed' : 'Succeeded'}.`}
        accessibilityHint={open ? 'Hides the detail' : 'Shows what was sent and returned'}
        accessibilityState={{ expanded: open }}
        hitSlop={6}
        onPress={() => {
          haptics.tap();
          setOpen((value) => !value);
        }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space[2],
          alignSelf: 'flex-start',
          paddingVertical: theme.space[1],
        }}
      >
        <Icon
          name={failed ? 'warning' : KIND_ICONS[presentation.kind]}
          size={14}
          color={tint}
        />
        <Text variant="subhead" weight="500" style={{ color: tint }}>
          {label}
        </Text>
        <Icon
          name={open ? 'chevronUp' : 'chevronDown'}
          size={11}
          color={theme.color.textTertiary}
        />
      </Pressable>

      {open && (
        <Animated.View entering={FadeIn.duration(theme.motion.fast)}>
          <Surface
            radius="md"
            padding={3}
            bordered
            style={{ marginTop: theme.space[1], gap: theme.space[3] }}
          >
            <View style={{ gap: theme.space[1] }}>
              <Text variant="overline" color="tertiary">
                ARGUMENTS
              </Text>
              <Text variant="mono" color="secondary" selectable>
                {JSON.stringify(run.args, null, 2)}
              </Text>
            </View>
            <View style={{ gap: theme.space[1] }}>
              <Text variant="overline" color="tertiary">
                RESULT
              </Text>
              <Text variant="mono" color="secondary" selectable>
                {run.rendered || '(not recorded)'}
              </Text>
            </View>
          </Surface>
        </Animated.View>
      )}
    </View>
  );
}
