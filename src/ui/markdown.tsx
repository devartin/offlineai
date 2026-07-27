/**
 * Markdown rendering for model output.
 *
 * The parser lives in `markdown-parse.ts` — this file is only the renderer.
 * The split exists so the parser can be tested: `react-native` ships
 * Flow-annotated source that the test runner refuses to parse, so anything
 * importing it is untestable, and the parser is exactly the part that most
 * needs tests.
 *
 * The types and `parseMarkdown` are re-exported here so consumers can keep
 * importing everything markdown-related from one place.
 */

import * as Clipboard from 'expo-clipboard';
import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as haptics from './haptics';
import { Icon } from './icon';
import { parseMarkdown, type Block, type Span } from './markdown-parse';
import { useTheme, type Theme } from './theme';

export { parseMarkdown };
export type { Block, ListItem, Span } from './markdown-parse';

// ---------------------------------------------------------------------------
// Inline spans
// ---------------------------------------------------------------------------

function spanStyle(span: Span, theme: Theme) {
  return [
    span.bold ? { fontWeight: '700' as const } : null,
    span.italic ? { fontStyle: 'italic' as const } : null,
    span.code
      ? {
          ...theme.typography.mono,
          color: theme.color.codeText,
          backgroundColor: theme.color.codeBackground,
        }
      : null,
    span.href
      ? { color: theme.color.accent, textDecorationLine: 'underline' as const }
      : null,
  ];
}

function Spans({ spans, color }: { spans: Span[]; color: string }) {
  const theme = useTheme();
  return (
    <>
      {spans.map((span, index) => (
        <Text key={index} style={[{ color }, spanStyle(span, theme)]}>
          {span.text}
        </Text>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

/**
 * A fenced code block.
 *
 * Horizontally scrollable rather than wrapped, because wrapped code is
 * unreadable, and carrying a copy button because code the user cannot get out
 * of the app is close to useless on a phone.
 */
function CodeBlock({
  block,
  trailing,
}: {
  block: Extract<Block, { kind: 'code' }>;
  /** The streaming caret, when this is the block still being written. */
  trailing?: ReactNode;
}) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    haptics.tap();
    void Clipboard.setStringAsync(block.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [block.text]);

  return (
    <View
      style={{
        backgroundColor: theme.color.codeBackground,
        borderRadius: theme.radius.sm,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.color.border,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: theme.space[3],
          paddingRight: theme.space[1],
          paddingVertical: theme.space[1],
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.color.border,
        }}
      >
        <Text
          style={[
            theme.typography.overline,
            { color: theme.color.textTertiary, textTransform: 'uppercase' },
          ]}
        >
          {block.language ?? 'code'}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? 'Copied' : 'Copy code'}
          onPress={copy}
          hitSlop={8}
          style={{ padding: theme.space[2] }}
        >
          <Icon
            name={copied ? 'copied' : 'copy'}
            size={15}
            color={copied ? theme.color.success : theme.color.textTertiary}
          />
        </Pressable>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ padding: theme.space[3] }}
      >
        <Text selectable style={[theme.typography.mono, { color: theme.color.codeText }]}>
          {block.text}
          {trailing}
        </Text>
      </ScrollView>
    </View>
  );
}

function TableBlock({ block }: { block: Extract<Block, { kind: 'table' }> }) {
  const theme = useTheme();

  const cell = (spans: Span[], index: number, header: boolean) => (
    <View
      key={index}
      style={{
        minWidth: 96,
        flex: 1,
        paddingVertical: theme.space[2],
        paddingHorizontal: theme.space[3],
      }}
    >
      <Text style={[theme.typography.footnote, header ? { fontWeight: '700' } : null]}>
        <Spans
          spans={spans}
          color={header ? theme.color.text : theme.color.textSecondary}
        />
      </Text>
    </View>
  );

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View
        style={{
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.color.border,
          borderRadius: theme.radius.sm,
          overflow: 'hidden',
        }}
      >
        <View
          style={{ flexDirection: 'row', backgroundColor: theme.color.codeBackground }}
        >
          {block.header.map((spans, index) => cell(spans, index, true))}
        </View>
        {block.rows.map((row, rowIndex) => (
          <View
            key={rowIndex}
            style={{
              flexDirection: 'row',
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: theme.color.border,
            }}
          >
            {row.map((spans, index) => cell(spans, index, false))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// The streaming caret
// ---------------------------------------------------------------------------

/** Blink period, in milliseconds. Matches a typical terminal cursor. */
const BLINK_MS = 530;

/**
 * The block that sits at the end of text still being written.
 *
 * Worth the trouble because it answers a question the user is actually asking
 * during a pause: has the model stopped, or is it thinking? Text alone cannot
 * distinguish "finished" from "stalled mid-sentence", and on a phone running a
 * 4B model at three tokens a second, pauses are ordinary.
 *
 * The blink is driven by swapping the character rather than by animating
 * opacity. This renders as a nested inline span so it sits on the baseline
 * after the final word, and nested text is flattened into a single attributed
 * string natively — an animated opacity on that nesting level does not
 * reliably survive the flattening, whereas changing the character always does.
 * The cost is one `setState` on one leaf component roughly twice a second.
 */
function Caret({ color }: { color: string }) {
  const [on, setOn] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => setOn((value) => !value), BLINK_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ color: on ? color : 'transparent' }}
    >
      {' ▍'}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export interface MarkdownProps {
  source: string;
  /** Body text colour. Defaults to the theme's primary text. */
  color?: string;
  /**
   * Draws a blinking caret after the final block. Set while the message is
   * still streaming and cleared the moment it settles.
   */
  caret?: boolean;
}

/**
 * Renders model output.
 *
 * Memoised on `source` because this re-parses from scratch on every streaming
 * flush, and a long transcript would otherwise re-parse every prior message
 * sixteen times a second while the newest one streams.
 */
export const Markdown = memo(function Markdown({ source, color, caret }: MarkdownProps) {
  const theme = useTheme();
  const bodyColor = color ?? theme.color.text;
  const blocks = parseMarkdown(source);

  const HEADING_VARIANT = {
    1: theme.typography.title3,
    2: theme.typography.headline,
    3: theme.typography.subhead,
  } as const;

  /**
   * The caret, for the final block only.
   *
   * Returned as a node to nest rather than rendered as a sibling, so it lands
   * on the baseline after the last word instead of on a line of its own.
   * `rule` and `table` are excluded: neither has a text baseline to sit on, and
   * a caret after a horizontal rule reads as a rendering fault.
   */
  const trailing = (index: number, kind: Block['kind']) =>
    caret && index === blocks.length - 1 && kind !== 'rule' && kind !== 'table' ? (
      <Caret color={theme.color.textTertiary} />
    ) : null;

  return (
    <View style={{ gap: theme.space[3] }}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading':
            return (
              <Text
                key={index}
                selectable
                style={[
                  HEADING_VARIANT[block.level],
                  { color: bodyColor, marginTop: index === 0 ? 0 : theme.space[1] },
                ]}
              >
                <Spans spans={block.spans} color={bodyColor} />
                {trailing(index, block.kind)}
              </Text>
            );

          case 'code':
            return (
              <CodeBlock key={index} block={block} trailing={trailing(index, block.kind)} />
            );

          case 'table':
            return <TableBlock key={index} block={block} />;

          case 'rule':
            return (
              <View
                key={index}
                style={{
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: theme.color.border,
                }}
              />
            );

          case 'quote':
            return (
              <View
                key={index}
                style={{
                  borderLeftWidth: 3,
                  borderLeftColor: theme.color.accent,
                  paddingLeft: theme.space[3],
                }}
              >
                <Text selectable style={theme.typography.body}>
                  <Spans spans={block.spans} color={theme.color.textSecondary} />
                  {trailing(index, block.kind)}
                </Text>
              </View>
            );

          case 'list':
            return (
              <View key={index} style={{ gap: theme.space[2] }}>
                {block.items.map((item, itemIndex) => (
                  <View
                    key={itemIndex}
                    style={{
                      flexDirection: 'row',
                      gap: theme.space[2],
                      paddingLeft: item.depth * theme.space[4],
                    }}
                  >
                    <Text
                      style={[
                        theme.typography.body,
                        {
                          color: theme.color.textTertiary,
                          // Numbers need a wider column than bullets, or the
                          // text edge goes ragged once a list passes nine items.
                          minWidth: item.marker === '•' ? 10 : 22,
                        },
                      ]}
                    >
                      {item.marker}
                    </Text>
                    <Text selectable style={[theme.typography.body, styles.flexText]}>
                      <Spans spans={item.spans} color={bodyColor} />
                      {itemIndex === block.items.length - 1
                        ? trailing(index, block.kind)
                        : null}
                    </Text>
                  </View>
                ))}
              </View>
            );

          case 'paragraph':
          default:
            return (
              <Text key={index} selectable style={theme.typography.body}>
                <Spans spans={block.spans} color={bodyColor} />
                {trailing(index, block.kind)}
              </Text>
            );
        }
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  // `flex: 1` beside a bullet is what makes long items wrap under themselves
  // rather than overflowing the row. Web additionally needs `minWidth: 0`,
  // because a flex child there defaults to `min-width: auto` and refuses to
  // shrink below its content.
  flexText: Platform.select({
    web: { flex: 1, minWidth: 0 },
    default: { flex: 1 },
  }),
});
