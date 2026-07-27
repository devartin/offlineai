/**
 * Predicts whether a model will actually run on this device.
 *
 * This is a first-class product feature, not a footnote. The failure mode it
 * prevents is the worst one the app has: a user spends twenty minutes on a
 * 2.5GB download, taps Load, and the OS kills the process. A warning before
 * the download costs nothing; a wrong answer costs their afternoon.
 *
 * Pure arithmetic over a RAM estimate and a device profile — no React Native
 * imports, so the thresholds are testable in Node.
 */

import type { RamEstimate } from '../inference/capabilities';

export type FitVerdict =
  | 'comfortable' // Runs with room to spare; safe to background
  | 'tight' // Runs, but expect eviction when other apps demand memory
  | 'risky' // Likely to be killed under normal multitasking
  | 'wont-fit'; // Will not load at all

export interface DeviceProfile {
  /** Physical RAM in bytes, from `Device.totalMemory`. */
  totalMemoryBytes: number;
  platform: 'ios' | 'android';
}

export interface FitAssessment {
  verdict: FitVerdict;
  /** What the app can realistically allocate before the OS intervenes. */
  usableMemoryBytes: number;
  requiredBytes: number;
  /** Negative when the model exceeds what the device can give it. */
  headroomBytes: number;
  /** One sentence, written for the user, not for a log. */
  reason: string;
  /**
   * A smaller context that would move this model up to a comfortable fit, or
   * null when no context reduction rescues it. Lets the UI offer a fix rather
   * than only a refusal.
   */
  suggestedContextLength: number | null;
}

/**
 * Fraction of physical RAM a single foreground app can hold before the OS
 * kills it.
 *
 * iOS jetsam is the binding constraint and it is far stricter than the spec
 * sheet suggests: an 8GB iPhone does not give an app 8GB, or even 6GB.
 * Observed jetsam limits land near half of physical memory, and an app holding
 * a large allocation is the first thing killed when it backgrounds.
 *
 * Android's low-memory killer is more forgiving in the foreground but varies
 * wildly by OEM, so the margin is only slightly wider.
 */
const USABLE_MEMORY_FRACTION: Record<DeviceProfile['platform'], number> = {
  ios: 0.5,
  android: 0.55,
};

/**
 * Absolute ceiling regardless of physical RAM.
 *
 * iOS caps a single app's footprint well below physical memory even on 12GB+
 * devices, so a fraction alone over-promises at the top of the range.
 */
const MEMORY_CEILING_BYTES: Record<DeviceProfile['platform'], number> = {
  ios: 4.0 * 1024 ** 3,
  android: 6.0 * 1024 ** 3,
};

/** Headroom as a fraction of usable memory, per verdict boundary. */
const COMFORTABLE_HEADROOM = 0.25;
const TIGHT_HEADROOM = 0.1;

/** Below this, a context window is too small to be worth suggesting. */
const MIN_USEFUL_CONTEXT = 2048;

export function usableMemory(device: DeviceProfile): number {
  return Math.min(
    device.totalMemoryBytes * USABLE_MEMORY_FRACTION[device.platform],
    MEMORY_CEILING_BYTES[device.platform],
  );
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function verdictFor(requiredBytes: number, usableBytes: number): FitVerdict {
  if (requiredBytes > usableBytes) return 'wont-fit';
  const headroomFraction = (usableBytes - requiredBytes) / usableBytes;
  if (headroomFraction >= COMFORTABLE_HEADROOM) return 'comfortable';
  if (headroomFraction >= TIGHT_HEADROOM) return 'tight';
  return 'risky';
}

/**
 * Finds the largest halved context that reaches a comfortable fit.
 *
 * Only the KV cache scales with context, and it scales linearly, so the search
 * is a simple walk down from the requested size. Returns null when even the
 * floor does not help — that means the weights alone are too large and no
 * amount of context trimming will save it.
 */
function suggestContext(
  estimate: RamEstimate,
  requestedContext: number,
  usableBytes: number,
  currentVerdict: FitVerdict,
): number | null {
  if (currentVerdict === 'comfortable') return null;

  const fixedBytes = estimate.weightsBytes + estimate.overheadBytes;
  const bytesPerToken = estimate.kvCacheBytes / requestedContext;

  for (let context = requestedContext / 2; context >= MIN_USEFUL_CONTEXT; context /= 2) {
    const required = fixedBytes + bytesPerToken * context;
    if (verdictFor(required, usableBytes) === 'comfortable') return context;
  }
  return null;
}

/**
 * Assesses a model against a device.
 *
 * `requestedContextLength` must match the context the estimate was built for —
 * the two together are what make the suggestion arithmetic valid.
 */
export function assessFit(
  estimate: RamEstimate,
  device: DeviceProfile,
  requestedContextLength: number,
): FitAssessment {
  const usableMemoryBytes = usableMemory(device);
  const requiredBytes = estimate.totalBytes;
  const verdict = verdictFor(requiredBytes, usableMemoryBytes);
  const suggestedContextLength = suggestContext(
    estimate,
    requestedContextLength,
    usableMemoryBytes,
    verdict,
  );

  return {
    verdict,
    usableMemoryBytes,
    requiredBytes,
    headroomBytes: usableMemoryBytes - requiredBytes,
    suggestedContextLength,
    reason: explain(verdict, requiredBytes, usableMemoryBytes, suggestedContextLength),
  };
}

function explain(
  verdict: FitVerdict,
  requiredBytes: number,
  usableBytes: number,
  suggestedContext: number | null,
): string {
  const need = formatGb(requiredBytes);
  const have = formatGb(usableBytes);
  const fix = suggestedContext
    ? ` Reducing the context to ${suggestedContext.toLocaleString()} tokens would fix this.`
    : '';

  switch (verdict) {
    case 'comfortable':
      return `Needs about ${need} of the ${have} available. Plenty of room.`;
    case 'tight':
      return `Needs about ${need} of the ${have} available. It will run, but may reload after you switch apps.${fix}`;
    case 'risky':
      return `Needs about ${need} of the ${have} available. Expect frequent reloads and possible crashes under normal use.${fix}`;
    case 'wont-fit':
      return `Needs about ${need} but only ${have} is available. This model will not load on your device.${fix}`;
  }
}

/** Ranks verdicts so lists can sort by "what actually works here" first. */
export const VERDICT_RANK: Record<FitVerdict, number> = {
  comfortable: 0,
  tight: 1,
  risky: 2,
  'wont-fit': 3,
};
