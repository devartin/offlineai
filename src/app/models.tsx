/**
 * The model manager.
 *
 * Model management is the screen users judge this category of app on, and the
 * thing every competitor gets wrong is honesty. A list of models with sizes is
 * not enough: what a user needs to know before spending twenty minutes and
 * 2.5GB is whether the thing will actually run on *their* phone, and what it
 * will be able to do once it does.
 *
 * So every row leads with a fit verdict computed from real architecture
 * metadata, and capability badges that are structurally derived rather than
 * marketing claims. A model that cannot use tools says so before download, not
 * after.
 *
 * The screen is a first-class tab rather than a modal reached from the chat
 * header. Burying the thing the product is judged on behind a header tap is
 * what made the app read as a prototype.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../app-state';
import { estimateRam } from '../inference/capabilities';
import { chatModels, type CatalogEntry } from '../models/catalog';
import {
  availableBytes,
  installModel,
  installedBytes,
  isFilesystemAvailable,
  isInstalled,
  sessionPathFor,
  uninstallModel,
  type DownloadHandle,
  type DownloadProgress,
} from '../models/downloader';
import {
  assessFit,
  VERDICT_RANK,
  type DeviceProfile,
  type FitAssessment,
} from '../models/fit';
import * as haptics from '../ui/haptics';
import { Icon } from '../ui/icon';
import {
  Button,
  Chip,
  IconButton,
  ProgressBar,
  Segmented,
  Surface,
  Text,
} from '../ui/primitives';
import { useTheme } from '../ui/theme';

type RowState =
  | { status: 'available' }
  | { status: 'downloading'; progress: DownloadProgress; handle: DownloadHandle }
  | { status: 'installed' }
  | { status: 'failed'; message: string };

type Filter = 'all' | 'fits' | 'installed';

const FILTERS = [
  { value: 'all' as const, label: 'All' },
  { value: 'fits' as const, label: 'Runs here' },
  { value: 'installed' as const, label: 'Installed' },
];

export default function ModelsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { engine, repos, device, refreshInstalledModels } = useApp();

  const [states, setStates] = useState<Record<string, RowState>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  // Seed each row from what is actually on disk, so a model installed in a
  // previous session shows as installed rather than as available.
  useEffect(() => {
    const seeded: Record<string, RowState> = {};
    for (const entry of chatModels()) {
      seeded[entry.id] = isInstalled(entry)
        ? { status: 'installed' }
        : { status: 'available' };
    }
    setStates(seeded);
  }, []);

  /**
   * Rows sorted by what will actually work here.
   *
   * Sorting by fit rather than by size or popularity is the most useful thing
   * this screen does — it puts the models that run well on this specific phone
   * at the top, instead of making the user decode gigabytes themselves.
   */
  const rows = useMemo(
    () =>
      chatModels()
        .map((entry) => ({ entry, fit: fitFor(entry, device) }))
        .sort((a, b) => {
          const byVerdict = VERDICT_RANK[a.fit.verdict] - VERDICT_RANK[b.fit.verdict];
          return byVerdict !== 0 ? byVerdict : b.entry.params - a.entry.params;
        }),
    [device],
  );

  const visible = useMemo(
    () =>
      rows.filter(({ entry, fit }) => {
        if (filter === 'installed') return states[entry.id]?.status === 'installed';
        if (filter === 'fits') return fit.verdict === 'comfortable' || fit.verdict === 'tight';
        return true;
      }),
    [rows, filter, states],
  );

  const setState = useCallback((id: string, next: RowState) => {
    setStates((previous) => ({ ...previous, [id]: next }));
  }, []);

  const download = useCallback(
    (entry: CatalogEntry) => {
      const handle = installModel(entry, {
        contextLength: entry.defaultContext,
        onProgress: (progress) => {
          setStates((previous) => {
            const current = previous[entry.id];
            if (current?.status !== 'downloading') return previous;
            return { ...previous, [entry.id]: { ...current, progress } };
          });
        },
      });

      setState(entry.id, {
        status: 'downloading',
        handle,
        progress: {
          modelId: entry.id,
          phase: 'weights',
          bytesWritten: 0,
          totalBytes: entry.sizeBytes,
          fraction: 0,
        },
      });

      handle.completion
        .then(async (model) => {
          await repos?.models.add(model);
          await refreshInstalledModels();
          haptics.success();
          setState(entry.id, { status: 'installed' });
        })
        .catch((cause: unknown) => {
          haptics.error();
          setState(entry.id, {
            status: 'failed',
            message: cause instanceof Error ? cause.message : String(cause),
          });
        });
    },
    [repos, refreshInstalledModels, setState],
  );

  const load = useCallback(
    async (entry: CatalogEntry) => {
      const installed = await repos?.models.get(entry.id);
      if (!installed) return;

      setLoadingId(entry.id);
      try {
        await engine.load({
          modelPath: installed.path,
          mmprojPath: installed.mmprojPath ?? undefined,
          contextLength: entry.defaultContext,
          sessionPath: sessionPathFor(entry.id),
        });
        haptics.success();
        // Straight to the conversation: loading a model is only ever a step
        // toward using it, and leaving the user on this screen afterwards makes
        // them find their own way back.
        router.push('/');
      } catch (cause) {
        haptics.error();
        Alert.alert(
          'Could not load model',
          cause instanceof Error ? cause.message : String(cause),
        );
      } finally {
        setLoadingId(null);
      }
    },
    [engine, repos, router],
  );

  const remove = useCallback(
    (entry: CatalogEntry) => {
      Alert.alert(
        `Delete ${entry.name}?`,
        'The downloaded files will be removed from this device.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                uninstallModel(entry.id);
                await repos?.models.remove(entry.id);
                await refreshInstalledModels();
                haptics.warning();
                setState(entry.id, { status: 'available' });
              })();
            },
          },
        ],
      );
    },
    [repos, refreshInstalledModels, setState],
  );

  return (
    <View style={styles.root}>
      <FlatList
        data={visible}
        keyExtractor={(row) => row.entry.id}
        contentContainerStyle={{
          paddingTop: insets.top + theme.space[4],
          paddingHorizontal: theme.space[4],
          paddingBottom: insets.bottom + theme.space[10],
          gap: theme.space[3],
        }}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={<Header filter={filter} onFilter={setFilter} />}
        ListEmptyComponent={<NoResults filter={filter} />}
        renderItem={({ item }) => (
          <ModelCard
            entry={item.entry}
            fit={item.fit}
            state={states[item.entry.id] ?? { status: 'available' }}
            loading={loadingId === item.entry.id}
            onDownload={() => download(item.entry)}
            onLoad={() => void load(item.entry)}
            onDelete={() => remove(item.entry)}
          />
        )}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({
  filter,
  onFilter,
}: {
  filter: Filter;
  onFilter: (value: Filter) => void;
}) {
  const theme = useTheme();
  const free = availableBytes();
  const used = installedBytes();
  const canDownload = isFilesystemAvailable();

  // Zero is not a real reading — it is what a platform without a filesystem
  // reports. Showing "0 KB free" would tell the user their phone is full.
  const freeSpaceKnown = free !== null && free > 0;

  return (
    <View style={{ marginBottom: theme.space[4], gap: theme.space[4] }}>
      <View style={{ gap: theme.space[1] }}>
        <Text variant="largeTitle">Models</Text>
        <Text variant="callout" color="secondary">
          Sorted by what actually runs on this phone.
        </Text>
      </View>

      {/* Storage is the constraint that decides everything on this screen, so
          it is stated once at the top rather than repeated per row. */}
      {(freeSpaceKnown || used > 0) && (
        <Surface variant="raised" radius="lg" padding={4} bordered>
          <View style={[styles.storageRow, { gap: theme.space[3] }]}>
            <View
              style={[
                styles.iconDisc,
                { backgroundColor: theme.color.accentMuted, borderRadius: 20 },
              ]}
            >
              <Icon name="storage" size={17} color={theme.color.accent} />
            </View>
            <View style={styles.grow}>
              <Text variant="subhead" weight="600">
                {used > 0 ? `${formatBytes(used)} of models installed` : 'No models yet'}
              </Text>
              {freeSpaceKnown && (
                <Text variant="footnote" color="tertiary">
                  {formatBytes(free)} free on this device
                </Text>
              )}
            </View>
          </View>
        </Surface>
      )}

      {!canDownload && (
        <Surface variant="raised" radius="lg" padding={4} bordered>
          <View style={[styles.storageRow, { gap: theme.space[3] }]}>
            <Icon name="info" size={17} color={theme.color.warning} />
            <Text variant="footnote" color="secondary" style={styles.grow}>
              Downloads need a development build. You can browse the catalogue
              and see how each model would fit, but nothing can be installed
              here.
            </Text>
          </View>
        </Surface>
      )}

      <Segmented options={FILTERS} value={filter} onChange={onFilter} />
    </View>
  );
}

function NoResults({ filter }: { filter: Filter }) {
  const theme = useTheme();
  return (
    <View style={[styles.noResults, { gap: theme.space[3] }]}>
      <Icon name="search" size={26} color={theme.color.textTertiary} />
      <Text variant="callout" color="secondary" align="center">
        {filter === 'installed'
          ? 'Nothing installed yet. Download a model to get started.'
          : 'No models in the catalogue fit comfortably on this device.'}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface ModelCardProps {
  entry: CatalogEntry;
  fit: FitAssessment;
  state: RowState;
  loading: boolean;
  onDownload: () => void;
  onLoad: () => void;
  onDelete: () => void;
}

const FIT_LABELS: Record<FitAssessment['verdict'], string> = {
  comfortable: 'Runs well',
  tight: 'Tight fit',
  risky: 'May crash',
  'wont-fit': "Won't fit",
};

function ModelCard(props: ModelCardProps) {
  const { entry, fit, state } = props;
  const theme = useTheme();

  const fitTone =
    fit.verdict === 'comfortable'
      ? 'success'
      : fit.verdict === 'tight'
        ? 'warning'
        : 'danger';

  const installed = state.status === 'installed';

  return (
    <Animated.View
      entering={FadeIn.duration(theme.motion.normal)}
      layout={LinearTransition.springify()}
    >
      <Surface
        variant="raised"
        radius="lg"
        padding={4}
        bordered
        shadow="sm"
        style={
          installed
            ? { borderColor: theme.color.accent, borderWidth: 1 }
            : undefined
        }
      >
        <View style={{ gap: theme.space[3] }}>
          <View style={[styles.titleRow, { gap: theme.space[3] }]}>
            <View
              style={[
                styles.iconDisc,
                {
                  backgroundColor: installed
                    ? theme.color.accentMuted
                    : theme.color.toolChip,
                  borderRadius: 20,
                },
              ]}
            >
              <Icon
                name={installed ? 'checkCircle' : 'chip'}
                size={18}
                color={installed ? theme.color.accent : theme.color.textSecondary}
              />
            </View>

            <View style={styles.grow}>
              <Text variant="headline" numberOfLines={1}>
                {entry.name}
              </Text>
              <Text variant="footnote" color="secondary" numberOfLines={2}>
                {entry.blurb}
              </Text>
            </View>

            <Chip label={FIT_LABELS[fit.verdict]} tone={fitTone} />
          </View>

          {/* Facts first, marketing never. Each of these is read from the
              catalogue entry or derived from GGUF metadata. */}
          <View style={[styles.metaRow, { gap: theme.space[4] }]}>
            <Meta icon="storage" label={formatBytes(entry.sizeBytes)} />
            <Meta icon="chip" label={entry.quant} />
            <Meta
              icon="document"
              label={`${(entry.defaultContext / 1000).toFixed(0)}k`}
            />
          </View>

          <View style={[styles.badgeRow, { gap: theme.space[1] }]}>
            {entry.tags.includes('tools') && (
              <Chip label="Tools" icon="tools" tone="accent" />
            )}
            {entry.tags.includes('vision') && (
              <Chip label="Vision" icon="vision" tone="accent" />
            )}
            {entry.tags.includes('reasoning') && (
              <Chip label="Thinks" icon="thinking" />
            )}
            {entry.toolGrade === 'none' && <Chip label="No tools" />}
          </View>

          {/* The fit sentence is shown for anything other than a clean pass —
              a warning the user cannot act on is just decoration. */}
          {fit.verdict !== 'comfortable' && (
            <View style={[styles.warningRow, { gap: theme.space[2] }]}>
              <Icon
                name="warning"
                size={13}
                color={fitTone === 'danger' ? theme.color.danger : theme.color.warning}
              />
              <Text
                variant="caption"
                color={fitTone === 'danger' ? 'danger' : 'warning'}
                style={styles.grow}
              >
                {fit.reason}
              </Text>
            </View>
          )}

          <CardAction {...props} />
        </View>
      </Surface>
    </Animated.View>
  );
}

function Meta({ icon, label }: { icon: 'storage' | 'chip' | 'document'; label: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.meta, { gap: 5 }]}>
      <Icon name={icon} size={12} color={theme.color.textTertiary} />
      <Text variant="caption" color="tertiary" weight="600">
        {label}
      </Text>
    </View>
  );
}

function CardAction({
  entry,
  fit,
  state,
  loading,
  onDownload,
  onLoad,
  onDelete,
}: ModelCardProps) {
  const theme = useTheme();

  if (state.status === 'downloading') {
    const { progress, handle } = state;
    const percent = Math.round(progress.fraction * 100);

    return (
      <View style={{ gap: theme.space[2] }}>
        <ProgressBar progress={progress.fraction} />
        <View style={styles.actionRow}>
          <Text variant="caption" color="secondary">
            {progress.phase === 'verifying'
              ? 'Checking model…'
              : `${percent}% · ${formatBytes(progress.bytesWritten)} of ${formatBytes(entry.sizeBytes)}`}
          </Text>
          <IconButton
            icon="close"
            size={15}
            tone="danger"
            accessibilityLabel={`Cancel downloading ${entry.name}`}
            onPress={() => handle.cancel()}
          />
        </View>
      </View>
    );
  }

  if (state.status === 'installed') {
    return (
      <View style={[styles.actionRow, { gap: theme.space[2] }]}>
        <Button
          label="Use this model"
          icon="play"
          size="sm"
          onPress={onLoad}
          loading={loading}
          style={styles.grow}
        />
        <IconButton
          icon="trash"
          size={17}
          tone="danger"
          accessibilityLabel={`Delete ${entry.name}`}
          onPress={onDelete}
        />
      </View>
    );
  }

  if (state.status === 'failed') {
    return (
      <View style={{ gap: theme.space[2] }}>
        <View style={[styles.warningRow, { gap: theme.space[2] }]}>
          <Icon name="error" size={13} color={theme.color.danger} />
          <Text variant="caption" color="danger" style={styles.grow}>
            {state.message}
          </Text>
        </View>
        <Button label="Try again" icon="regenerate" variant="secondary" size="sm" onPress={onDownload} />
      </View>
    );
  }

  // A model that will not fit can still be downloaded — the user may be about
  // to free space, or may want it for a different device. The warning is
  // honest; refusing outright would be paternalistic.
  return (
    <Button
      label={fit.verdict === 'wont-fit' ? 'Download anyway' : 'Download'}
      icon="download"
      variant={fit.verdict === 'wont-fit' ? 'secondary' : 'primary'}
      size="sm"
      fullWidth
      onPress={onDownload}
    />
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Estimates fit from catalog metadata alone.
 *
 * Before download there is no GGUF to inspect, so layer count and embedding
 * width are approximated from parameter count using ratios typical of modern
 * GQA architectures. Once installed, the real record measured by
 * `inspectModel` replaces this — but a rough honest warning beforehand is worth
 * far more than an exact one afterwards.
 */
function fitFor(entry: CatalogEntry, device: DeviceProfile): FitAssessment {
  const estimate = estimateRam(
    {
      'estimate.block_count': Math.round(16 + entry.params * 5),
      'estimate.embedding_length': Math.round(512 + entry.params * 512),
      'estimate.attention.head_count': 32,
      'estimate.attention.head_count_kv': 8,
    },
    'estimate',
    entry.sizeBytes,
    entry.defaultContext,
  );

  return assessFit(estimate, device, entry.defaultContext);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  grow: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start' },
  iconDisc: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  meta: { flexDirection: 'row', alignItems: 'center' },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap' },
  warningRow: { flexDirection: 'row', alignItems: 'flex-start' },
  storageRow: { flexDirection: 'row', alignItems: 'center' },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  noResults: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
});
