/**
 * The chat screen.
 *
 * This is the surface the app is judged on. The structural decisions here are
 * the ones that separate a credible assistant from a demo, and each is taken
 * from the reference app because each is right rather than because it is
 * theirs:
 *
 *   - **Assistant replies are not bubbles.** Model output renders full-width
 *     and unchromed; the bubble is reserved for the user. A four-hundred-word
 *     answer inside an 82%-width speech bubble is a readability failure no
 *     amount of polish recovers from.
 *   - **Output is rendered as markdown.** Models emit markdown; showing literal
 *     asterisks and hash marks destroys credibility instantly.
 *   - **The header is three controls and nothing else** — drawer, model, new
 *     chat — because everything else belongs behind one of them.
 *   - **Streaming tokens are accumulated outside React** and flushed on an
 *     interval rather than calling setState per token. A 4B model emits 20–40
 *     tokens a second; re-rendering a long transcript that often drops frames
 *     on exactly the mid-range devices we care about.
 *   - **Tool activity is shown as it happens**, not summarised afterwards.
 *     Watching the assistant reach for a calculator is what makes the tool
 *     system feel trustworthy rather than magical.
 *   - **Everything tool-related is gated on the model's capability record.** A
 *     model that cannot call tools renders a clean chat app with no dead
 *     affordances — which is also why the composer carries no attachment or
 *     microphone button: neither feature exists yet, and an affordance that
 *     does nothing is worse than an absent one.
 */

import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../app-state';
import {
  dropAssistantFrom,
  loadConversation,
  persistAssistantTurn,
  persistUserTurn,
  type Bubble,
} from '../chat/history';
import {
  inferenceUnavailableReason,
  type ChatMessage,
  type ToolRun,
} from '../inference/engine';
import { Mark } from '../ui/brand';
import * as haptics from '../ui/haptics';
import { Icon, type IconName } from '../ui/icon';
import { Markdown } from '../ui/markdown';
import {
  Chip,
  IconButton,
  PressableScale,
  Surface,
  Text,
  useKeyboardVisible,
} from '../ui/primitives';
import { useTheme } from '../ui/theme';

/** How often streamed tokens are flushed to React, in milliseconds. */
const STREAM_FLUSH_MS = 60;

/** Placeholder shown on a tool chip between the call and its result. */
const PENDING = '…';

/**
 * Openers offered on an empty transcript.
 *
 * The job of an empty state is to get the user to one meaningful action, not to
 * explain the product. These demonstrate what is actually distinctive here —
 * that it works with no connection, and that the model can reach real tools —
 * rather than showing off generic chat.
 */
const OPENERS: { icon: IconName; label: string; prompt: string }[] = [
  {
    icon: 'privacy',
    label: 'What works offline',
    prompt: 'What can you help me with when I have no internet connection at all?',
  },
  {
    icon: 'tools',
    label: 'Work something out',
    prompt: 'What is 15% of 2,480, plus 340?',
  },
  {
    icon: 'sparkles',
    label: 'Draft a reply',
    prompt: 'Help me politely decline a meeting invitation that clashes with my day.',
  },
  {
    icon: 'thinking',
    label: 'Think it through',
    prompt: 'I have two job offers and cannot decide. Ask me what you need to know.',
  },
];

export default function ChatScreen() {
  const theme = useTheme();
  const { ready, startupError, engine, dispatcher, registry, repos } = useApp();
  const params = useLocalSearchParams<{ conversationId?: string; fresh?: string }>();

  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState('');
  const [generating, setGenerating] = useState(false);
  const [engineState, setEngineState] = useState(engine.getState());
  const [atBottom, setAtBottom] = useState(true);

  const listRef = useRef<FlatList<Bubble>>(null);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * The conversation being written to.
   *
   * A ref rather than state: it is set inside `send`, read again when the turn
   * finishes, and never rendered. Holding it in state would let the completion
   * handler close over a stale value and file the assistant's reply against the
   * wrong conversation.
   */
  const conversationRef = useRef<string | null>(null);

  useEffect(() => engine.subscribe(setEngineState), [engine]);

  /**
   * Responds to the drawer.
   *
   * The drawer navigates here with either a `conversationId` to open or a
   * `fresh` timestamp to start over. The timestamp exists because navigating
   * with identical params twice produces no change for an effect to observe, so
   * "New chat" pressed twice would silently do nothing the second time.
   */
  useEffect(() => {
    if (params.fresh) {
      abortRef.current?.abort();
      conversationRef.current = null;
      setBubbles([]);
      setDraft('');
      return;
    }

    const requested = params.conversationId;
    if (!requested || requested === conversationRef.current) return;

    let cancelled = false;
    void (async () => {
      abortRef.current?.abort();
      const restored = await loadConversation(repos, requested);
      if (cancelled) return;
      conversationRef.current = requested;
      setBubbles(restored);
      setAtBottom(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [params.conversationId, params.fresh, repos]);

  /**
   * Reopens the most recent conversation on launch.
   *
   * An app that greets a returning user with a blank screen has thrown away the
   * thing they came back for. Skipped when the drawer has already asked for
   * something specific.
   */
  useEffect(() => {
    if (!repos) return;
    let cancelled = false;

    void (async () => {
      try {
        const [latest] = await repos.conversations.list();
        if (!latest || cancelled || conversationRef.current !== null) return;
        const restored = await loadConversation(repos, latest.id);
        if (cancelled || restored.length === 0) return;
        conversationRef.current = latest.id;
        setBubbles(restored);
      } catch {
        // A history that will not load is not worth blocking the app over.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [repos]);

  const model = engineState.status === 'ready' ? engineState.model : null;
  const canSend = ready && model !== null && draft.trim().length > 0 && !generating;

  /**
   * Runs one turn.
   *
   * Takes the history explicitly rather than reading `bubbles`, so regenerate
   * can replay a truncated transcript without a second copy of this logic.
   */
  const runTurn = useCallback(
    async (history: ChatMessage[], assistantId: string) => {
      if (!model || !dispatcher) return;
      setGenerating(true);

      // Token buffers live outside React. Flushing on a timer keeps the
      // transcript smooth regardless of how fast the model decodes.
      let content = '';
      let reasoning = '';
      let dirty = false;

      const flush = () => {
        if (!dirty) return;
        dirty = false;
        setBubbles((previous) =>
          previous.map((bubble) =>
            bubble.id === assistantId
              ? { ...bubble, content, reasoning: reasoning || null }
              : bubble,
          ),
        );
      };
      const timer = setInterval(flush, STREAM_FLUSH_MS);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const result = await engine.run(
          history,
          {
            dispatcher,
            toolSpecs: model.capabilities.supportsTools ? registry.toolSpecs() : [],
          },
          {
            onToken: (token) => {
              content += token;
              dirty = true;
            },
            onReasoningToken: (token) => {
              reasoning += token;
              dirty = true;
            },
            onToolCall: (name, args) => {
              // Shown immediately, before the tool runs, so a slow or blocked
              // tool reads as "working" rather than as a frozen app.
              setBubbles((previous) =>
                previous.map((bubble) =>
                  bubble.id === assistantId
                    ? {
                        ...bubble,
                        toolRuns: [
                          ...bubble.toolRuns,
                          { name, args, ok: true, rendered: PENDING },
                        ],
                      }
                    : bubble,
                ),
              );
            },
            onToolResult: (name, ok, rendered) => {
              setBubbles((previous) =>
                previous.map((bubble) =>
                  bubble.id === assistantId
                    ? {
                        ...bubble,
                        toolRuns: bubble.toolRuns.map((run, index) =>
                          index === bubble.toolRuns.length - 1
                            ? { ...run, name, ok, rendered }
                            : run,
                        ),
                      }
                    : bubble,
                ),
              );
            },
          },
          { signal: controller.signal },
        );

        clearInterval(timer);
        haptics.success();

        const settled: Bubble = {
          id: assistantId,
          role: 'assistant',
          content: result.content || content,
          reasoning: result.reasoning,
          toolRuns: result.toolRuns,
          streaming: false,
        };
        setBubbles((previous) =>
          previous.map((bubble) => (bubble.id === assistantId ? settled : bubble)),
        );
        // Written after the turn rather than during it: a partial answer is not
        // worth a row, and writing per token would put a database call on the
        // decode path.
        void persistAssistantTurn(repos, conversationRef.current, settled);
      } catch (cause) {
        clearInterval(timer);
        haptics.error();
        const message = cause instanceof Error ? cause.message : String(cause);
        setBubbles((previous) =>
          previous.map((bubble) =>
            bubble.id === assistantId
              ? {
                  ...bubble,
                  content: content || `Something went wrong: ${message}`,
                  streaming: false,
                }
              : bubble,
          ),
        );
      } finally {
        abortRef.current = null;
        setGenerating(false);
      }
    },
    [model, dispatcher, registry, engine, repos],
  );

  const send = useCallback(
    (text?: string) => {
      const prompt = (text ?? draft).trim();
      if (!prompt || !model || !dispatcher || generating) return;

      setDraft('');
      const assistantId = `a_${Date.now()}`;

      // Captured before the state update so the model sees the history that
      // existed when the user pressed send, not a later render's version.
      const history: ChatMessage[] = [
        ...bubbles.map((bubble) => ({ role: bubble.role, content: bubble.content })),
        { role: 'user' as const, content: prompt },
      ];

      setBubbles((previous) => [
        ...previous,
        {
          id: `u_${Date.now()}`,
          role: 'user',
          content: prompt,
          reasoning: null,
          toolRuns: [],
          streaming: false,
        },
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          reasoning: null,
          toolRuns: [],
          streaming: true,
        },
      ]);

      // Recorded before the model is asked anything, so a turn that crashes
      // mid-generation still leaves the user's own message in their history.
      void persistUserTurn(
        repos,
        conversationRef.current,
        prompt,
        model.capabilities.displayName,
      ).then((id) => {
        conversationRef.current = id;
      });

      void runTurn(history, assistantId);
    },
    [draft, model, dispatcher, generating, bubbles, runTurn, repos],
  );

  /**
   * Re-runs the last turn.
   *
   * The assistant's previous answer is dropped from both the transcript and the
   * history before replaying, so the model is not conditioned on the response
   * the user just rejected.
   */
  const regenerate = useCallback(() => {
    if (generating || !model) return;

    const lastAssistant = bubbles.findLastIndex((bubble) => bubble.role === 'assistant');
    if (lastAssistant < 0) return;

    const kept = bubbles.slice(0, lastAssistant);
    const assistantId = `a_${Date.now()}`;
    const history: ChatMessage[] = kept.map((bubble) => ({
      role: bubble.role,
      content: bubble.content,
    }));

    // The rejected answer leaves storage as well as the screen. Without this,
    // reopening the conversation would resurrect the reply the user just asked
    // to replace.
    void dropAssistantFrom(repos, conversationRef.current, bubbles[lastAssistant].id);

    setBubbles([
      ...kept,
      {
        id: assistantId,
        role: 'assistant',
        content: '',
        reasoning: null,
        toolRuns: [],
        streaming: true,
      },
    ]);

    void runTurn(history, assistantId);
  }, [bubbles, generating, model, runTurn, repos]);

  const stop = useCallback(() => {
    haptics.warning();
    abortRef.current?.abort();
  }, []);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    // Clearing the ref rather than deleting anything: the previous conversation
    // stays in history, and the next message opens a new one.
    conversationRef.current = null;
    setBubbles([]);
    setDraft('');
  }, []);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
    setAtBottom(distance < 80);
  }, []);

  if (startupError && bubbles.length === 0 && !ready) {
    return (
      <View
        style={[styles.root, styles.centred, { backgroundColor: theme.color.background }]}
      >
        <Icon name="error" size={30} color={theme.color.danger} />
        <Text variant="title3" align="center">
          Could not start
        </Text>
        <Text variant="footnote" color="secondary" align="center">
          {startupError}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ChatHeader onNewChat={newChat} canClear={bubbles.length > 0} />

      <FlatList
        ref={listRef}
        data={bubbles}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.listContent,
          {
            paddingHorizontal: theme.space[4],
            paddingTop: theme.space[2],
            paddingBottom: theme.space[4],
            gap: theme.space[6],
          },
        ]}
        onContentSizeChange={() => {
          if (atBottom) listRef.current?.scrollToEnd({ animated: true });
        }}
        onScroll={onScroll}
        scrollEventThrottle={64}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <EmptyState hasModel={model !== null} onPick={(prompt) => send(prompt)} />
        }
        renderItem={({ item, index }) => (
          <MessageBubble
            bubble={item}
            isLast={index === bubbles.length - 1}
            onRegenerate={regenerate}
            canRegenerate={!generating}
          />
        )}
      />

      {!atBottom && bubbles.length > 0 && (
        <Animated.View
          entering={FadeIn.duration(theme.motion.fast)}
          exiting={FadeOut.duration(theme.motion.fast)}
          style={styles.scrollDown}
        >
          <IconButton
            icon="chevronDown"
            variant="filled"
            size={15}
            accessibilityLabel="Scroll to latest message"
            onPress={() => listRef.current?.scrollToEnd({ animated: true })}
          />
        </Animated.View>
      )}

      <Composer
        draft={draft}
        onChangeDraft={setDraft}
        onSend={() => send()}
        onStop={stop}
        canSend={canSend}
        generating={generating}
        disabledReason={
          !ready ? 'Starting…' : model === null ? 'Choose a model to begin' : undefined
        }
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/**
 * Three controls: drawer, model, new chat.
 *
 * The model button doubles as the app's capability disclosure — the glyphs
 * beside the name are read from the loaded model's record, so a user can always
 * see whether the assistant in front of them can use tools or see images
 * without having to discover it by asking and failing.
 */
function ChatHeader({
  onNewChat,
  canClear,
}: {
  onNewChat: () => void;
  canClear: boolean;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const navigation = useNavigation();
  const { engine } = useApp();
  const [state, setState] = useState(engine.getState());

  useEffect(() => engine.subscribe(setState), [engine]);

  const model = state.status === 'ready' ? state.model : null;

  const status =
    state.status === 'loading'
      ? {
          tone: theme.color.warning,
          label: `Loading ${Math.round(state.progress * 100)}%`,
        }
      : state.status === 'evicted'
        ? { tone: theme.color.warning, label: 'Paused' }
        : state.status === 'error'
          ? { tone: theme.color.danger, label: 'Failed' }
          : model
            ? { tone: theme.color.success, label: model.capabilities.quantization }
            : { tone: theme.color.textTertiary, label: 'Tap to choose' };

  return (
    <View
      style={[
        styles.header,
        { paddingTop: insets.top + theme.space[1], paddingHorizontal: theme.space[2] },
      ]}
    >
      <IconButton
        icon="menu"
        size={20}
        accessibilityLabel="Open menu"
        onPress={() => {
          haptics.tap();
          // `openDrawer` is not on the generic navigation type, so it is reached
          // by dispatching the action rather than by casting the whole object.
          navigation.dispatch({ type: 'OPEN_DRAWER' });
        }}
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Model: ${model ? model.capabilities.displayName : 'none selected'}. ${status.label}.`}
        accessibilityHint="Opens the model manager"
        onPress={() => {
          haptics.tap();
          router.push('/models');
        }}
        style={[styles.modelButton, { gap: theme.space[2] }]}
      >
        <View style={[styles.dot, { backgroundColor: status.tone }]} />
        <Text variant="headline" numberOfLines={1} style={styles.shrink}>
          {model ? model.capabilities.displayName : 'No model'}
        </Text>
        <Icon name="chevronDown" size={11} color={theme.color.textTertiary} />
        {model && (
          <View style={[styles.capabilityRow, { gap: theme.space[2] }]}>
            {model.capabilities.supportsTools && (
              <Icon name="tools" size={12} color={theme.color.textTertiary} />
            )}
            {model.capabilities.supportsVision && (
              <Icon name="vision" size={12} color={theme.color.textTertiary} />
            )}
            {model.gpuAccelerated && (
              <Icon name="bolt" size={12} color={theme.color.textTertiary} />
            )}
          </View>
        )}
      </Pressable>

      <IconButton
        icon="newChat"
        size={19}
        accessibilityLabel="New conversation"
        onPress={onNewChat}
        disabled={!canClear}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function MessageBubble({
  bubble,
  isLast,
  onRegenerate,
  canRegenerate,
}: {
  bubble: Bubble;
  isLast: boolean;
  onRegenerate: () => void;
  canRegenerate: boolean;
}) {
  const theme = useTheme();

  if (bubble.role === 'user') {
    return (
      <Animated.View
        entering={FadeInDown.duration(theme.motion.normal).springify()}
        layout={LinearTransition.springify()}
        style={styles.userRow}
      >
        <View
          style={{
            maxWidth: '82%',
            backgroundColor: theme.color.bubbleUser,
            borderRadius: theme.radius.xl,
            paddingHorizontal: theme.space[4],
            paddingVertical: theme.space[3],
          }}
        >
          <Text variant="body" selectable style={{ color: theme.color.bubbleUserText }}>
            {bubble.content}
          </Text>
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      entering={FadeInDown.duration(theme.motion.normal).springify()}
      layout={LinearTransition.springify()}
      style={{ gap: theme.space[3] }}
    >
      {/* Tool activity sits above the answer, in the order it happened, so the
          transcript reads as a narrative rather than a result with footnotes. */}
      {bubble.toolRuns.length > 0 && (
        <View style={{ gap: theme.space[1] }}>
          {bubble.toolRuns.map((run, index) => (
            <ToolRow key={`${run.name}-${index}`} run={run} />
          ))}
        </View>
      )}

      {bubble.reasoning && <ReasoningDisclosure text={bubble.reasoning} />}

      {bubble.content.length > 0 ? (
        <Markdown source={bubble.content} />
      ) : bubble.streaming ? (
        <ThinkingIndicator />
      ) : (
        <Text variant="body" color="tertiary">
          No response.
        </Text>
      )}

      {/* Actions appear only on the settled last message. Showing them on every
          bubble turns the transcript into a control panel. */}
      {!bubble.streaming && isLast && bubble.content.length > 0 && (
        <Animated.View
          entering={FadeIn.duration(theme.motion.normal)}
          style={[styles.actionRow, { gap: theme.space[1] }]}
        >
          <CopyAction text={bubble.content} />
          <MessageAction
            icon="regenerate"
            label="Regenerate"
            disabled={!canRegenerate}
            onPress={onRegenerate}
          />
        </Animated.View>
      )}
    </Animated.View>
  );
}

function MessageAction({
  icon,
  label,
  onPress,
  disabled = false,
  tone,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: string;
}) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingVertical: theme.space[1],
        paddingHorizontal: theme.space[2],
        borderRadius: theme.radius.pill,
        opacity: disabled ? 0.35 : 1,
      }}
    >
      <Icon name={icon} size={14} color={tone ?? theme.color.textTertiary} />
      <Text variant="caption" style={{ color: tone ?? theme.color.textTertiary }}>
        {label}
      </Text>
    </Pressable>
  );
}

function CopyAction({ text }: { text: string }) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);

  return (
    <MessageAction
      icon={copied ? 'copied' : 'copy'}
      label={copied ? 'Copied' : 'Copy'}
      tone={copied ? theme.color.success : undefined}
      onPress={() => {
        void Clipboard.setStringAsync(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    />
  );
}

/**
 * A tool call, shown as a row rather than a chip.
 *
 * A row has space for the tool's name *and* what it returned, which is the
 * difference between the user believing the answer and merely being told to.
 */
function ToolRow({ run }: { run: ToolRun }) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const pending = run.rendered === PENDING;

  const tone = pending
    ? theme.color.textSecondary
    : run.ok
      ? theme.color.success
      : theme.color.danger;

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Tool ${run.name}. ${pending ? 'Running' : run.ok ? 'Succeeded' : 'Failed'}. Tap for detail.`}
        accessibilityState={{ expanded }}
        onPress={() => {
          haptics.tap();
          setExpanded((value) => !value);
        }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space[2],
          paddingVertical: theme.space[2],
          paddingHorizontal: theme.space[3],
          borderRadius: theme.radius.sm,
          backgroundColor: theme.color.toolChip,
          alignSelf: 'flex-start',
          maxWidth: '100%',
        }}
      >
        {pending ? (
          <PulsingDot color={tone} />
        ) : (
          <Icon name="tools" size={13} color={tone} />
        )}
        <Text variant="caption" weight="600" style={{ color: tone }}>
          {run.name}
        </Text>
        {!pending && run.rendered.length > 0 && (
          <Text variant="caption" color="tertiary" numberOfLines={1} style={styles.shrink}>
            {run.rendered.replace(/\s+/g, ' ').slice(0, 60)}
          </Text>
        )}
        <Icon
          name={expanded ? 'chevronUp' : 'chevronDown'}
          size={10}
          color={theme.color.textTertiary}
        />
      </Pressable>

      {expanded && !pending && (
        <Animated.View entering={FadeIn.duration(theme.motion.fast)}>
          <Surface
            radius="sm"
            padding={3}
            bordered
            style={{ marginTop: theme.space[1], gap: theme.space[2] }}
          >
            <View>
              <Text variant="overline" color="tertiary">
                ARGUMENTS
              </Text>
              <Text variant="mono" color="secondary" selectable>
                {JSON.stringify(run.args, null, 2)}
              </Text>
            </View>
            <View>
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

function ReasoningDisclosure({ text }: { text: string }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <View>
      <Chip
        label={open ? 'Hide thinking' : 'Show thinking'}
        icon="thinking"
        onPress={() => setOpen((value) => !value)}
      />
      {open && (
        <Animated.View entering={FadeIn.duration(theme.motion.fast)}>
          <Surface radius="md" padding={3} bordered style={{ marginTop: theme.space[2] }}>
            <Text variant="footnote" color="secondary" selectable>
              {text}
            </Text>
          </Surface>
        </Animated.View>
      )}
    </View>
  );
}

/** A single dot that breathes. Used while a tool is in flight. */
function PulsingDot({ color }: { color: string }) {
  const scale = useSharedValue(1);

  useEffect(() => {
    scale.value = withRepeat(
      withSequence(
        withTiming(1.5, { duration: 500, easing: Easing.inOut(Easing.quad) }),
        withTiming(1, { duration: 500, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      false,
    );
  }, [scale]);

  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View
      style={[animated, { width: 7, height: 7, borderRadius: 4, backgroundColor: color }]}
    />
  );
}

/**
 * The gap between pressing send and the first token.
 *
 * Three staggered dots rather than a spinner. A spinner is the universal signal
 * for "the app is busy"; staggered dots are the signal for "something is being
 * composed", which is the accurate one here and reads as far less anxious
 * during the two-to-three seconds a cold prompt takes on a phone.
 */
function ThinkingIndicator() {
  const theme = useTheme();

  return (
    <View style={[styles.thinking, { gap: theme.space[2] }]}>
      {[0, 1, 2].map((index) => (
        <ThinkingDot key={index} delay={index * 160} color={theme.color.textTertiary} />
      ))}
    </View>
  );
}

function ThinkingDot({ delay, color }: { delay: number; color: string }) {
  const value = useSharedValue(0.3);

  useEffect(() => {
    const timer = setTimeout(() => {
      value.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 400, easing: Easing.inOut(Easing.quad) }),
          withTiming(0.3, { duration: 400, easing: Easing.inOut(Easing.quad) }),
        ),
        -1,
        false,
      );
    }, delay);
    return () => clearTimeout(timer);
  }, [delay, value]);

  const animated = useAnimatedStyle(() => ({
    opacity: value.value,
    transform: [{ scale: 0.85 + value.value * 0.25 }],
  }));

  return (
    <Animated.View
      style={[animated, { width: 7, height: 7, borderRadius: 4, backgroundColor: color }]}
    />
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({
  hasModel,
  onPick,
}: {
  hasModel: boolean;
  onPick: (prompt: string) => void;
}) {
  const theme = useTheme();
  const router = useRouter();
  const unavailable = inferenceUnavailableReason();

  return (
    <View style={[styles.empty, { gap: theme.space[5] }]}>
      <Mark size={44} />

      <Text variant="display" align="center">
        {hasModel ? 'What can I help with?' : 'Private by design'}
      </Text>

      {!hasModel && (
        <Text variant="callout" color="secondary" align="center" style={styles.prose}>
          A real assistant that runs entirely on your phone. No account, no
          server, no telemetry.
        </Text>
      )}

      {/* Being explicit about a preview host beats a composer that silently
          does nothing. The rest of the app — catalogue, fit prediction,
          consent, document search — is fully interactive here. The call to
          action below still renders: a dead end with no next step is worse
          than an honest one. */}
      {unavailable && (
        <View
          style={[
            styles.notice,
            {
              backgroundColor: theme.color.surfaceRaised,
              borderRadius: theme.radius.md,
              padding: theme.space[4],
              gap: theme.space[3],
            },
          ]}
        >
          <Icon name="info" size={16} color={theme.color.textSecondary} />
          <Text variant="footnote" color="secondary" style={styles.grow}>
            Preview mode. Every screen works here, but running a model needs a
            development build — a browser cannot load native modules.
          </Text>
        </View>
      )}

      {hasModel ? (
        <View style={[styles.openers, { gap: theme.space[2] }]}>
          {OPENERS.map((opener) => (
            <PressableScale
              key={opener.label}
              onPress={() => onPick(opener.prompt)}
              scaleTo={0.96}
              accessibilityLabel={opener.label}
              accessibilityHint={opener.prompt}
            >
              <View
                style={[
                  styles.openerPill,
                  {
                    borderColor: theme.color.border,
                    borderRadius: theme.radius.pill,
                    paddingVertical: theme.space[2],
                    paddingHorizontal: theme.space[4],
                    gap: theme.space[2],
                  },
                ]}
              >
                <Icon name={opener.icon} size={14} color={theme.color.textSecondary} />
                <Text variant="subhead" color="secondary">
                  {opener.label}
                </Text>
              </View>
            </PressableScale>
          ))}
        </View>
      ) : (
        <PressableScale
          onPress={() => router.push('/models')}
          accessibilityLabel="Browse models"
          haptic="press"
        >
          <View
            style={[
              styles.openerPill,
              {
                backgroundColor: theme.color.solid,
                borderColor: 'transparent',
                borderRadius: theme.radius.pill,
                paddingVertical: theme.space[3],
                paddingHorizontal: theme.space[5],
                gap: theme.space[2],
              },
            ]}
          >
            <Icon name="download" size={15} color={theme.color.onSolid} />
            <Text variant="subhead" weight="600" style={{ color: theme.color.onSolid }}>
              Browse models
            </Text>
          </View>
        </PressableScale>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

interface ComposerProps {
  draft: string;
  onChangeDraft: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  canSend: boolean;
  generating: boolean;
  disabledReason?: string;
}

function Composer({
  draft,
  onChangeDraft,
  onSend,
  onStop,
  canSend,
  generating,
  disabledReason,
}: ComposerProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View
        style={{
          marginHorizontal: theme.space[3],
          marginBottom: keyboardVisible ? theme.space[2] : insets.bottom + theme.space[2],
          padding: theme.space[2],
          backgroundColor: theme.color.surfaceRaised,
          borderRadius: theme.radius.xxl,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.color.border,
        }}
      >
        <View style={[styles.composerRow, { gap: theme.space[2] }]}>
          <TextInput
            value={draft}
            onChangeText={onChangeDraft}
            placeholder={disabledReason ?? 'Message'}
            placeholderTextColor={theme.color.textTertiary}
            editable={disabledReason === undefined}
            multiline
            accessibilityLabel="Message"
            style={[
              theme.typography.body,
              styles.input,
              {
                color: theme.color.text,
                paddingHorizontal: theme.space[3],
                paddingVertical: theme.space[2],
              },
            ]}
          />

          {generating ? (
            <PressableScale
              onPress={onStop}
              scaleTo={0.9}
              haptic="none"
              accessibilityLabel="Stop generating"
            >
              <View style={[styles.sendButton, { backgroundColor: theme.color.solid }]}>
                <Icon name="stop" size={12} color={theme.color.onSolid} />
              </View>
            </PressableScale>
          ) : (
            <SendButton canSend={canSend} onPress={onSend} />
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

/**
 * The send affordance.
 *
 * A high-contrast disc — white on dark, near-black on light — that fades in as
 * the field becomes valid. This is the reference app's signature control, and
 * it works because inverting the ground is a stronger "this is the action" than
 * any colour would be in an otherwise monochrome interface.
 */
function SendButton({ canSend, onPress }: { canSend: boolean; onPress: () => void }) {
  const theme = useTheme();
  const armed = useSharedValue(canSend ? 1 : 0);

  useEffect(() => {
    armed.value = withTiming(canSend ? 1 : 0, { duration: theme.motion.fast });
  }, [canSend, armed, theme.motion.fast]);

  const armedStyle = useAnimatedStyle(() => ({
    opacity: armed.value,
    transform: [{ scale: 0.86 + armed.value * 0.14 }],
  }));

  return (
    <PressableScale
      onPress={onPress}
      disabled={!canSend}
      scaleTo={0.88}
      haptic="press"
      accessibilityLabel="Send message"
    >
      <View style={styles.sendButton}>
        <View
          style={[
            StyleSheet.absoluteFill,
            styles.sendDisc,
            { backgroundColor: theme.color.toolChip },
          ]}
        />
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            armedStyle,
            styles.sendDisc,
            { backgroundColor: theme.color.solid },
          ]}
        />
        <Icon
          name="send"
          size={16}
          weight="bold"
          color={canSend ? theme.color.onSolid : theme.color.textTertiary}
        />
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centred: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  grow: { flex: 1 },
  shrink: { flexShrink: 1 },
  listContent: { flexGrow: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 4,
  },
  modelButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    minHeight: 44,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  capabilityRow: { flexDirection: 'row', alignItems: 'center', marginLeft: 2 },

  userRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  actionRow: { flexDirection: 'row', alignItems: 'center', marginLeft: -8 },
  thinking: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },

  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 40,
  },
  prose: { maxWidth: 300 },
  openers: { alignSelf: 'center', alignItems: 'center' },
  openerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    alignSelf: 'stretch',
    maxWidth: 420,
  },

  composerRow: { flexDirection: 'row', alignItems: 'flex-end' },
  input: { flex: 1, maxHeight: 132 },
  sendButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    overflow: 'hidden',
  },
  sendDisc: { borderRadius: 17 },

  scrollDown: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: 92,
  },
});
