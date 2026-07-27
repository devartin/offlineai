/**
 * Settings.
 *
 * The lead item is the privacy guarantee, stated as a fact rather than a
 * marketing line, because it is the one thing this product has that no cloud
 * assistant can offer. Everything below it is disclosure: what is installed,
 * what the assistant is able to reach, and what this device can support.
 *
 * There is deliberately very little to *configure* here. The app has almost no
 * meaningful preferences — appearance follows the system, storage is managed on
 * the Models tab, and consent is granted in context rather than pre-set in a
 * list. A settings screen padded out with switches nobody needs is a tell that
 * a product does not know what it is.
 */

import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../app-state';
import { inferenceUnavailableReason } from '../inference/engine';
import { availableBytes, installedBytes } from '../models/downloader';
import { Mark } from '../ui/brand';
import { Icon, type IconName } from '../ui/icon';
import { Chip, Divider, ListRow, SectionHeader, Surface, Text } from '../ui/primitives';
import { useTheme } from '../ui/theme';

/**
 * Icon per tool family, keyed by the segment before the dot.
 *
 * Falls back to a generic wrench, so registering a new family never leaves a
 * blank space in this list.
 */
const FAMILY_ICONS: Record<string, IconName> = {
  compute: 'chip',
  memory: 'memory',
  docs: 'document',
  calendar: 'history',
  contacts: 'chat',
  reminders: 'checkCircle',
  health: 'bolt',
  vision: 'vision',
  code: 'chip',
};

export default function SettingsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { installedModels, registry, device, startupError } = useApp();

  const tools = useMemo(
    () => [...registry.list()].sort((a, b) => a.name.localeCompare(b.name)),
    [registry],
  );

  const used = installedBytes();
  const free = availableBytes();
  const unavailable = inferenceUnavailableReason();

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + theme.space[4],
          paddingHorizontal: theme.space[4],
          paddingBottom: insets.bottom + theme.space[10],
          gap: theme.space[6],
        }}
        showsVerticalScrollIndicator={false}
      >
        <Text variant="largeTitle">Settings</Text>

        {/* The claim, stated once and plainly. */}
        <Surface variant="raised" radius="lg" padding={5} bordered shadow="sm">
          <View style={{ gap: theme.space[3] }}>
            <View style={[styles.row, { gap: theme.space[3] }]}>
              <Mark size={30} />
              <View style={styles.grow}>
                <Text variant="title3">Nothing leaves this device</Text>
              </View>
            </View>
            <Text variant="callout" color="secondary">
              Models run locally. Conversations, documents and tool results are
              stored only on this phone. The app has no account, no server and no
              analytics — the only network requests it can make are downloading a
              model you chose.
            </Text>
            <View style={[styles.chips, { gap: theme.space[1] }]}>
              <Chip label="No telemetry" icon="privacy" tone="success" />
              <Chip label="No account" icon="privacy" tone="success" />
              <Chip label="Open source" icon="external" tone="accent" />
            </View>
          </View>
        </Surface>

        {startupError && (
          <Surface variant="raised" radius="lg" padding={4} bordered>
            <View style={[styles.row, { gap: theme.space[3] }]}>
              <Icon name="warning" size={17} color={theme.color.warning} />
              <View style={styles.grow}>
                <Text variant="subhead" weight="600">
                  Running without storage
                </Text>
                <Text variant="footnote" color="secondary">
                  {startupError}
                </Text>
                <Text variant="footnote" color="tertiary">
                  Conversations and grants will not survive a restart. Consent is
                  still enforced.
                </Text>
              </View>
            </View>
          </Surface>
        )}

        <Group title="Storage">
          <ListRow
            first
            icon="models"
            label="Installed models"
            accessory={
              <Text variant="callout" color="tertiary">
                {installedModels.length}
              </Text>
            }
          />
          <Divider inset={16} />
          <ListRow
            icon="storage"
            label="Space used"
            accessory={
              <Text variant="callout" color="tertiary">
                {used > 0 ? formatBytes(used) : '—'}
              </Text>
            }
          />
          <Divider inset={16} />
          <ListRow
            last
            icon="chip"
            label="Free space"
            accessory={
              <Text variant="callout" color="tertiary">
                {free !== null && free > 0 ? formatBytes(free) : 'Unknown'}
              </Text>
            }
          />
        </Group>

        <Group
          title={`Tools · ${tools.length}`}
          footer="The assistant can only call these, and only after you allow the scope they ask for. Every call is recorded."
        >
          {tools.map((tool, index) => (
            <View key={tool.name}>
              {index > 0 && <Divider inset={16} />}
              <ListRow
                first={index === 0}
                last={index === tools.length - 1}
                icon={FAMILY_ICONS[tool.name.split('.')[0]] ?? 'tools'}
                label={tool.name}
                detail={tool.scopes.join(', ')}
                accessory={
                  tool.mutates ? <Chip label="Confirms" tone="warning" /> : undefined
                }
              />
            </View>
          ))}
        </Group>

        <Group title="This device">
          <ListRow
            first
            icon="chip"
            label="Memory"
            accessory={
              <Text variant="callout" color="tertiary">
                {formatBytes(device.totalMemoryBytes)}
              </Text>
            }
          />
          <Divider inset={16} />
          <ListRow
            icon="bolt"
            label="Platform"
            accessory={
              <Text variant="callout" color="tertiary">
                {device.platform === 'ios' ? 'iOS' : 'Android'}
              </Text>
            }
          />
          <Divider inset={16} />
          <ListRow
            last
            icon="sparkles"
            label="On-device inference"
            accessory={
              <Chip
                label={unavailable ? 'Unavailable' : 'Ready'}
                tone={unavailable ? 'warning' : 'success'}
              />
            }
          />
        </Group>

        <View style={[styles.footer, { gap: theme.space[2] }]}>
          <Mark size={22} />
          <Text variant="caption" color="tertiary" align="center">
            OfflineAI · Apache-2.0
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * A titled group of rows.
 *
 * The rows render as one continuous card because `ListRow` only rounds its
 * first and last members — the detail that makes a grouped list read as native
 * rather than as a stack of separate boxes.
 */
function Group({
  title,
  footer,
  children,
}: {
  title: string;
  footer?: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View>
      <SectionHeader>{title}</SectionHeader>
      <View style={{ borderRadius: theme.radius.md, overflow: 'hidden' }}>
        {children}
      </View>
      {footer && (
        <Text
          variant="caption"
          color="tertiary"
          style={{ marginTop: theme.space[2], marginHorizontal: theme.space[1] }}
        >
          {footer}
        </Text>
      )}
    </View>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  grow: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
  footer: { alignItems: 'center', paddingTop: 8 },
});
