/**
 * Model installation.
 *
 * This module and `huggingface.ts` are the only two places in the entire app
 * that touch the network. That is the whole architecture of the offline
 * guarantee: inference, tools, storage and search have no network code to
 * accidentally invoke, so "nothing leaves the device" is enforced by the
 * dependency graph rather than by discipline.
 *
 * Downloads are resumable because the files are large and phones move between
 * networks. A 2.5GB download that restarts from zero when the user walks out of
 * wifi range is the difference between a usable app and an abandoned one.
 */

import { Directory, File, Paths, type DownloadTask } from 'expo-file-system';
import type { InstalledModel } from '../db';
import { inspectModel } from '../inference/engine';
import { downloadUrl, type CatalogEntry } from './catalog';

/** Which file is being fetched. Vision models need two. */
export type DownloadPhase = 'weights' | 'projector' | 'verifying';

export interface DownloadProgress {
  modelId: string;
  phase: DownloadPhase;
  bytesWritten: number;
  /** Zero until the server reports a length. */
  totalBytes: number;
  /** 0–1 across the whole install, not just the current file. */
  fraction: number;
}

export type DownloadState =
  | { status: 'idle' }
  | { status: 'downloading'; progress: DownloadProgress }
  | { status: 'paused'; progress: DownloadProgress }
  | { status: 'installed'; model: InstalledModel }
  | { status: 'failed'; message: string };

/**
 * Headroom required beyond the model's own size.
 *
 * The filesystem needs room to breathe, and a device that fills completely
 * during a download fails in confusing ways — often by corrupting the partial
 * file rather than reporting a clean error.
 */
const FREE_SPACE_MARGIN_BYTES = 500 * 1024 * 1024;

/** Where installed models live. One directory per model id. */
function modelDirectory(modelId: string): Directory {
  return new Directory(Paths.document, 'models', modelId);
}

/**
 * Whether a real filesystem is reachable.
 *
 * `expo-file-system`'s Directory/File classes are native-only — in a browser
 * preview they throw on construction. Every public entry point below checks
 * this so the model manager degrades to "nothing installed, downloads
 * unavailable" instead of taking the whole screen down with an uncaught error.
 */
let filesystemUsable: boolean | null = null;

export function isFilesystemAvailable(): boolean {
  if (filesystemUsable !== null) return filesystemUsable;
  try {
    // Constructing is enough to trip the unsupported-platform path.
    void new Directory(Paths.document, 'models').uri;
    filesystemUsable = true;
  } catch {
    filesystemUsable = false;
  }
  return filesystemUsable;
}

export function installedModelPath(modelId: string, fileName: string): string {
  return new File(modelDirectory(modelId), fileName).uri;
}

/** True when the weights are already on disk and non-empty. */
export function isInstalled(entry: CatalogEntry): boolean {
  if (!isFilesystemAvailable()) return false;
  try {
    const file = new File(modelDirectory(entry.id), entry.file);
    return file.exists && file.size > 0;
  } catch {
    return false;
  }
}

export interface DownloadHandle {
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  cancel: () => void;
  /** Resolves when the install finishes, or rejects with a readable reason. */
  completion: Promise<InstalledModel>;
}

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void;
  /** Opens the model at this context to size the RAM estimate stamped on it. */
  contextLength?: number;
}

/**
 * Downloads and installs a catalog model.
 *
 * The returned handle exposes pause/resume/cancel so the UI can offer them
 * without knowing anything about the transfer mechanism.
 */
export function installModel(
  entry: CatalogEntry,
  options: DownloadOptions = {},
): DownloadHandle {
  // Checked before anything touches the filesystem. `modelDirectory` throws
  // synchronously on a platform without one, which would escape the handle
  // entirely and crash the caller's render rather than rejecting `completion`.
  if (!isFilesystemAvailable()) {
    return {
      completion: Promise.reject(
        new Error(
          'Downloading models needs a development build — this platform has no filesystem to store them in.',
        ),
      ),
      pause: async () => undefined,
      resume: async () => undefined,
      cancel: () => undefined,
    };
  }

  const directory = modelDirectory(entry.id);

  // Both files are counted in one denominator so the progress bar advances
  // monotonically across the pair instead of resetting between them.
  const projectorEstimate = entry.mmprojFile ? Math.round(entry.sizeBytes * 0.2) : 0;
  const totalExpected = entry.sizeBytes + projectorEstimate;

  let currentTask: DownloadTask | null = null;
  let cancelled = false;
  let completedBytes = 0;

  const report = (phase: DownloadPhase, bytesWritten: number, totalBytes: number) => {
    options.onProgress?.({
      modelId: entry.id,
      phase,
      bytesWritten: completedBytes + bytesWritten,
      totalBytes,
      fraction: Math.min(1, (completedBytes + bytesWritten) / totalExpected),
    });
  };

  async function fetchFile(fileName: string, phase: DownloadPhase): Promise<File> {
    const task = File.createDownloadTask(downloadUrl(entry, fileName), directory, {
      onProgress: ({ bytesWritten, totalBytes }) => {
        report(phase, bytesWritten, totalBytes);
      },
    });
    currentTask = task;

    const file = await task.downloadAsync();
    currentTask = null;

    // A null result means the task was cancelled or errored before producing a
    // file. An existing-but-empty file means the connection dropped mid-write;
    // both must fail loudly rather than leaving a broken model installed.
    if (file === null) {
      throw new Error(`Downloading ${fileName} was interrupted.`);
    }
    if (!file.exists || file.size === 0) {
      throw new Error(
        `${fileName} downloaded but is empty. The transfer was interrupted.`,
      );
    }

    completedBytes += file.size;
    return file;
  }

  const completion = (async (): Promise<InstalledModel> => {
    // Refuse before starting rather than failing 90% of the way through a
    // download the device was never going to be able to hold.
    const available = Paths.availableDiskSpace;
    if (available !== null && available < totalExpected + FREE_SPACE_MARGIN_BYTES) {
      const needGb = ((totalExpected + FREE_SPACE_MARGIN_BYTES) / 1024 ** 3).toFixed(1);
      const haveGb = (available / 1024 ** 3).toFixed(1);
      throw new Error(
        `Not enough space. ${entry.name} needs about ${needGb} GB free, but only ${haveGb} GB is available.`,
      );
    }

    if (!directory.exists) directory.create({ intermediates: true });

    const weights = await fetchFile(entry.file, 'weights');
    if (cancelled) throw new Error('Download cancelled');

    let projector: File | null = null;
    if (entry.mmprojFile) {
      projector = await fetchFile(entry.mmprojFile, 'projector');
      if (cancelled) throw new Error('Download cancelled');
    }

    // Capabilities are read once here and stored, so no screen ever has to
    // re-open a multi-gigabyte GGUF just to decide which badges to render.
    report('verifying', 0, totalExpected);
    const capabilities = await inspectModel(weights.uri, {
      fileSizeBytes: weights.size,
      contextLength: options.contextLength ?? entry.defaultContext,
      hasProjector: projector !== null,
    });

    return {
      id: entry.id,
      catalogId: entry.id,
      name: entry.name,
      path: weights.uri,
      mmprojPath: projector?.uri ?? null,
      sizeBytes: weights.size + (projector?.size ?? 0),
      capabilities: JSON.stringify(capabilities),
      installedAt: Date.now(),
    };
  })();

  return {
    completion,

    async pause() {
      await currentTask?.pauseAsync();
    },

    async resume() {
      await currentTask?.resumeAsync();
    },

    cancel() {
      cancelled = true;
      currentTask?.cancel();
      // The partial file is removed rather than left behind: a half-written
      // GGUF that looks installed is worse than no model at all.
      if (directory.exists) directory.delete();
    },
  };
}

/**
 * Removes an installed model from disk.
 *
 * Deleting the directory takes the weights, the projector and any saved KV
 * session with it, so nothing is orphaned.
 */
export function uninstallModel(modelId: string): void {
  if (!isFilesystemAvailable()) return;
  try {
    const directory = modelDirectory(modelId);
    if (directory.exists) directory.delete();
  } catch {
    // Nothing to clean up if the directory was never reachable.
  }
}

/** Total bytes used by installed models — shown in storage settings. */
export function installedBytes(): number {
  if (!isFilesystemAvailable()) return 0;
  try {
    const root = new Directory(Paths.document, 'models');
    return root.exists ? (root.size ?? 0) : 0;
  } catch {
    return 0;
  }
}

/** Free space on the device, or null when the platform will not say. */
export function availableBytes(): number | null {
  try {
    return Paths.availableDiskSpace;
  } catch {
    return null;
  }
}

/** Where a model's KV cache is persisted across backgrounding, if anywhere. */
export function sessionPathFor(modelId: string): string | undefined {
  if (!isFilesystemAvailable()) return undefined;
  try {
    return new File(modelDirectory(modelId), 'session.bin').uri;
  } catch {
    return undefined;
  }
}
