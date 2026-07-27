/**
 * The navigation drawer.
 *
 * This replaces a bottom tab bar, and the swap is the largest structural change
 * in this pass. Tabs were the wrong model: they imply three destinations of
 * roughly equal weight, when in fact this app has one screen you live in and
 * two you visit. The reference app resolves that the same way — a slide-out
 * drawer holding conversation history, with the utility screens tucked at the
 * bottom — and it is genuinely better here, because it hands the entire width
 * and height of the screen back to the conversation.
 *
 * The layout, top to bottom: search, new chat, conversations grouped by
 * recency, then a footer for Models and Settings. Recency grouping rather than
 * a flat list is what stops a long history becoming an undifferentiated wall,
 * and it costs one subtraction per row.
 */

import type { DrawerContentComponentProps } from 'expo-router/drawer';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../app-state';
import type { Conversation } from '../db';
import * as haptics from './haptics';
import { Icon, type IconName } from './icon';
import { Button, Divider, Skeleton, Text } from './primitives';
import { ActionSheet, Sheet } from './sheet';
import { useTheme } from './theme';

const DAY = 24 * 60 * 60 * 1000;

interface Group {
  label: string;
  items: Conversation[];
}

/**
 * Buckets conversations by recency.
 *
 * These are the boundaries every messaging app converges on, because they match
 * how people actually reach for a past conversation: today, yesterday, this
 * week, then everything else.
 */
function groupByRecency(conversations: Conversation[], now: number): Group[] {
  const buckets: Group[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Older', items: [] },
  ];

  for (const conversation of conversations) {
    const age = now - conversation.updatedAt;
    if (age < DAY) buckets[0].items.push(conversation);
    else if (age < 2 * DAY) buckets[1].items.push(conversation);
    else if (age < 7 * DAY) buckets[2].items.push(conversation);
    else buckets[3].items.push(conversation);
  }

  return buckets.filter((bucket) => bucket.items.length > 0);
}

export function AppDrawer({ navigation, state }: DrawerContentComponentProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { repos } = useApp();

  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [query, setQuery] = useState('');
  /** The conversation whose long-press menu is open. */
  const [menuFor, setMenuFor] = useState<Conversation | null>(null);
  /** The conversation being renamed, and the title being typed for it. */
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [titleDraft, setTitleDraft] = useState('');

  const activeRoute = state.routes[state.index]?.name;

  /**
   * Reloads history.
   *
   * Read here rather than cached in app state: the list changes on every single
   * turn, so a cached copy would need invalidating constantly, and this is the
   * only place it is ever read.
   */
  const reload = useCallback(() => {
    if (!repos) {
      setConversations([]);
      return;
    }
    void repos.conversations
      .list()
      .then(setConversations)
      .catch(() => setConversations([]));
  }, [repos]);

  // `state.index` changes on every navigation, which is a reasonable proxy for
  // "something happened that might have added a conversation".
  useEffect(() => {
    reload();
  }, [state.index, reload]);

  const groups = useMemo(() => {
    if (!conversations) return null;
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? conversations.filter((c) => c.title.toLowerCase().includes(needle))
      : conversations;
    return groupByRecency(filtered, Date.now());
  }, [conversations, query]);

  const openChat = useCallback(
    (conversationId?: string) => {
      haptics.tap();
      navigation.closeDrawer();
      // "New chat" carries a changing timestamp rather than no params at all:
      // navigating with identical params produces no change for the chat
      // screen's effect to observe, so pressing it twice in a row would
      // silently do nothing the second time.
      navigation.navigate(
        'index',
        conversationId ? { conversationId } : { fresh: String(Date.now()) },
      );
    },
    [navigation],
  );

  const goTo = useCallback(
    (route: 'models' | 'settings') => {
      haptics.tap();
      navigation.closeDrawer();
      navigation.navigate(route);
    },
    [navigation],
  );

  const commitRename = useCallback(() => {
    const conversation = renaming;
    const title = titleDraft.trim();
    setRenaming(null);
    if (!conversation || !repos || title.length === 0 || title === conversation.title) {
      return;
    }

    haptics.success();
    // Applied locally first. The write is durable, but waiting on a round trip
    // to SQLite before the row updates makes a rename feel laggy for no reason.
    setConversations(
      (previous) =>
        previous?.map((candidate) =>
          candidate.id === conversation.id ? { ...candidate, title } : candidate,
        ) ?? null,
    );
    void repos.conversations.rename(conversation.id, title, Date.now()).catch(reload);
  }, [renaming, titleDraft, repos, reload]);

  /**
   * Deletes a conversation, after asking.
   *
   * Confirmed rather than undoable: an undo needs somewhere to hold the deleted
   * rows, and holding data the user has asked to destroy is precisely the thing
   * this app exists not to do.
   */
  const confirmDelete = useCallback(
    (conversation: Conversation) => {
      Alert.alert(
        'Delete conversation?',
        `“${conversation.title}” and every message in it will be removed from this device. This cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              haptics.warning();
              setConversations(
                (previous) =>
                  previous?.filter((candidate) => candidate.id !== conversation.id) ??
                  null,
              );
              void repos?.conversations.remove(conversation.id).catch(reload);
              // The chat screen may be showing the conversation that just went
              // away, so it is reset rather than left displaying a ghost.
              navigation.navigate('index', { fresh: String(Date.now()) });
            },
          },
        ],
      );
    },
    [repos, reload, navigation],
  );

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: theme.color.backgroundElevated,
          paddingTop: insets.top + theme.space[2],
        },
      ]}
    >
      <View style={{ paddingHorizontal: theme.space[3], paddingBottom: theme.space[2] }}>
        <View
          style={[
            styles.search,
            {
              backgroundColor: theme.color.surfaceRaised,
              borderRadius: theme.radius.pill,
              paddingHorizontal: theme.space[3],
              gap: theme.space[2],
            },
          ]}
        >
          <Icon name="search" size={15} color={theme.color.textTertiary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={theme.color.textTertiary}
            accessibilityLabel="Search conversations"
            style={[
              theme.typography.callout,
              styles.searchInput,
              { color: theme.color.text },
            ]}
          />
          {query.length > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              onPress={() => setQuery('')}
              hitSlop={8}
            >
              <Icon name="close" size={14} color={theme.color.textTertiary} />
            </Pressable>
          )}
        </View>
      </View>

      <DrawerRow icon="newChat" label="New chat" onPress={() => openChat()} emphasis />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: theme.space[4] }}
      >
        {groups === null ? (
          <View style={{ padding: theme.space[4], gap: theme.space[3] }}>
            <Skeleton height={18} radius="sm" />
            <Skeleton height={18} width="80%" radius="sm" />
            <Skeleton height={18} width="60%" radius="sm" />
          </View>
        ) : groups.length === 0 ? (
          <View style={[styles.empty, { paddingHorizontal: theme.space[5] }]}>
            <Text variant="footnote" color="tertiary" align="center">
              {query.trim()
                ? `Nothing matches “${query.trim()}”.`
                : 'Your conversations will appear here.'}
            </Text>
          </View>
        ) : (
          groups.map((group) => (
            <View key={group.label} style={{ marginTop: theme.space[4] }}>
              <Text
                variant="overline"
                color="tertiary"
                style={{
                  paddingHorizontal: theme.space[4],
                  marginBottom: theme.space[1],
                }}
              >
                {group.label}
              </Text>
              {group.items.map((conversation) => (
                <DrawerRow
                  key={conversation.id}
                  label={conversation.title}
                  onPress={() => openChat(conversation.id)}
                  onLongPress={() => {
                    haptics.press();
                    setMenuFor(conversation);
                  }}
                />
              ))}
            </View>
          ))
        )}
      </ScrollView>

      {/* Utility screens live at the bottom, out of the way of the thing the
          drawer is actually for. */}
      <View style={{ paddingBottom: insets.bottom + theme.space[2] }}>
        <Divider />
        <DrawerRow
          icon="models"
          label="Models"
          active={activeRoute === 'models'}
          onPress={() => goTo('models')}
        />
        <DrawerRow
          icon="settings"
          label="Settings"
          active={activeRoute === 'settings'}
          onPress={() => goTo('settings')}
        />
      </View>

      <ActionSheet
        visible={menuFor !== null}
        onClose={() => setMenuFor(null)}
        title={menuFor?.title}
        actions={[
          {
            icon: 'newChat',
            label: 'Rename',
            onPress: () => {
              if (!menuFor) return;
              setTitleDraft(menuFor.title);
              setRenaming(menuFor);
            },
          },
          {
            icon: 'trash',
            label: 'Delete',
            destructive: true,
            onPress: () => {
              if (menuFor) confirmDelete(menuFor);
            },
          },
        ]}
      />

      <Sheet
        visible={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename conversation"
      >
        <View style={{ padding: theme.space[5], gap: theme.space[4] }}>
          <TextInput
            value={titleDraft}
            onChangeText={setTitleDraft}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            onSubmitEditing={commitRename}
            accessibilityLabel="Conversation title"
            maxLength={80}
            style={[
              theme.typography.callout,
              {
                color: theme.color.text,
                backgroundColor: theme.color.surfaceRaised,
                borderRadius: theme.radius.md,
                paddingHorizontal: theme.space[4],
                paddingVertical: theme.space[3],
              },
            ]}
          />
          <Button label="Save" onPress={commitRename} disabled={!titleDraft.trim()} />
        </View>
      </Sheet>
    </View>
  );
}

function DrawerRow({
  icon,
  label,
  onPress,
  onLongPress,
  active = false,
  emphasis = false,
}: {
  icon?: IconName;
  label: string;
  onPress: () => void;
  onLongPress?: () => void;
  active?: boolean;
  emphasis?: boolean;
}) {
  const theme = useTheme();
  const [pressed, setPressed] = useState(false);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={onLongPress ? 'Long press to rename or delete' : undefined}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={280}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space[3],
        marginHorizontal: theme.space[2],
        paddingHorizontal: theme.space[3],
        paddingVertical: theme.space[3],
        borderRadius: theme.radius.md,
        backgroundColor: active
          ? theme.color.surfaceRaised
          : pressed
            ? theme.color.surfacePressed
            : 'transparent',
      }}
    >
      {icon && (
        <Icon
          name={icon}
          size={17}
          color={active ? theme.color.text : theme.color.textSecondary}
        />
      )}
      <Text
        variant="callout"
        weight={emphasis || active ? '600' : '400'}
        numberOfLines={1}
        style={[styles.grow, !icon ? { marginLeft: theme.space[1] } : null]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  grow: { flex: 1 },
  search: { flexDirection: 'row', alignItems: 'center', height: 40 },
  // `padding: 0` matters on Android, where TextInput carries a default inset
  // that pushes the caret off the vertical centre of a 40pt pill.
  searchInput: { flex: 1, padding: 0 },
  empty: { paddingVertical: 40 },
});
