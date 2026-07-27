import { describe, expect, it } from 'vitest';
import type { RamEstimate } from '../inference/capabilities';
import {
  CATALOG,
  CatalogEntry,
  EMBEDDING_MODEL_ID,
  chatModels,
  downloadUrl,
  findEntry,
  validateCatalog,
} from './catalog';
import { assessFit, usableMemory, VERDICT_RANK, type DeviceProfile } from './fit';

const GB = 1024 ** 3;

const iphone8gb: DeviceProfile = { totalMemoryBytes: 8 * GB, platform: 'ios' };
const iphone4gb: DeviceProfile = { totalMemoryBytes: 4 * GB, platform: 'ios' };
const android12gb: DeviceProfile = { totalMemoryBytes: 12 * GB, platform: 'android' };

function estimate(weightsGb: number, cacheGb: number): RamEstimate {
  const weightsBytes = weightsGb * GB;
  const kvCacheBytes = cacheGb * GB;
  const overheadBytes = 0.15 * GB;
  return {
    weightsBytes,
    kvCacheBytes,
    overheadBytes,
    totalBytes: weightsBytes + kvCacheBytes + overheadBytes,
  };
}

describe('usable memory', () => {
  it('never promises an app the whole device', () => {
    // The single most important property: an 8GB phone does not give an app
    // 8GB. Getting this wrong causes the download-then-crash failure.
    expect(usableMemory(iphone8gb)).toBeLessThan(8 * GB);
    expect(usableMemory(iphone8gb)).toBe(4 * GB);
  });

  it('caps iOS below physical memory even on large devices', () => {
    const iphone16gb: DeviceProfile = { totalMemoryBytes: 16 * GB, platform: 'ios' };
    // Jetsam does not scale linearly forever — the ceiling must bind.
    expect(usableMemory(iphone16gb)).toBe(4 * GB);
  });

  it('gives Android slightly more headroom than iOS at equal RAM', () => {
    const androidSame: DeviceProfile = { totalMemoryBytes: 6 * GB, platform: 'android' };
    const iosSame: DeviceProfile = { totalMemoryBytes: 6 * GB, platform: 'ios' };
    expect(usableMemory(androidSame)).toBeGreaterThan(usableMemory(iosSame));
  });
});

describe('fit verdicts', () => {
  it('calls a small model on a big phone comfortable', () => {
    const result = assessFit(estimate(0.8, 0.1), android12gb, 8192);
    expect(result.verdict).toBe('comfortable');
    expect(result.headroomBytes).toBeGreaterThan(0);
    expect(result.suggestedContextLength).toBeNull();
  });

  it('refuses a model larger than the device can hold', () => {
    const result = assessFit(estimate(4.9, 0.5), iphone4gb, 4096);
    expect(result.verdict).toBe('wont-fit');
    expect(result.headroomBytes).toBeLessThan(0);
    expect(result.reason).toContain('will not load');
  });

  it('suggests a smaller context when the cache is what pushes it over', () => {
    // Weights fit easily; an oversized KV cache is the whole problem, so
    // halving the context should rescue it.
    const result = assessFit(estimate(1.5, 2.0), iphone8gb, 16384);
    expect(result.verdict).not.toBe('comfortable');
    expect(result.suggestedContextLength).not.toBeNull();
    expect(result.suggestedContextLength!).toBeLessThan(16384);
    expect(result.reason).toContain('Reducing the context');
  });

  it('offers no suggestion when the weights alone are too large', () => {
    // No amount of context trimming saves a model whose weights exceed the
    // budget — promising otherwise would be a lie in the UI.
    const result = assessFit(estimate(5.0, 0.2), iphone8gb, 8192);
    expect(result.verdict).toBe('wont-fit');
    expect(result.suggestedContextLength).toBeNull();
  });

  it('separates tight from risky by headroom, not by fitting at all', () => {
    const usable = usableMemory(iphone8gb);
    const at = (fraction: number): RamEstimate => ({
      weightsBytes: usable * fraction,
      kvCacheBytes: 0,
      overheadBytes: 0,
      totalBytes: usable * fraction,
    });

    // ~15% headroom -> tight; ~3% headroom -> risky. Both technically "fit".
    expect(assessFit(at(0.85), iphone8gb, 4096).verdict).toBe('tight');
    expect(assessFit(at(0.97), iphone8gb, 4096).verdict).toBe('risky');
    expect(VERDICT_RANK.tight).toBeLessThan(VERDICT_RANK.risky);
  });

  it('writes reasons a user can act on, in gigabytes', () => {
    const result = assessFit(estimate(2.5, 0.6), iphone8gb, 8192);
    expect(result.reason).toMatch(/\d\.\d GB/);
    expect(result.reason).not.toContain('undefined');
  });
});

describe('catalog', () => {
  it('validates every entry against the schema', () => {
    expect(() => validateCatalog()).not.toThrow();
  });

  it('has no duplicate ids', () => {
    const ids = CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ships models small enough for a 4GB phone', () => {
    // The catalog is worthless if nothing in it runs on a mid-range device.
    expect(CATALOG.filter((e) => e.sizeBytes < 1.5 * GB).length).toBeGreaterThanOrEqual(4);
  });

  it('marks models without tool support honestly', () => {
    // Gemma's published instruct template has no tools; claiming otherwise
    // would put a broken agent in front of the user.
    expect(findEntry('gemma-3-270m-it')?.toolGrade).toBe('none');
    expect(findEntry('gemma-3-4b-it')?.toolGrade).toBe('none');
  });

  it('publishes no tool grade it has not measured', () => {
    // Every graded entry must come from the eval harness. Until it runs, the
    // only honest values are "unmeasured" or the structural "none".
    for (const entry of CATALOG) {
      expect(['unmeasured', 'none']).toContain(entry.toolGrade);
    }
  });

  it('keeps default contexts well below the trained maximum', () => {
    // A 128k-capable model handed 128k of KV cache fits on no phone.
    for (const entry of CATALOG) {
      expect(entry.defaultContext).toBeLessThanOrEqual(8192);
    }
  });

  it('excludes the embedding model from chat', () => {
    expect(chatModels().some((e) => e.id === EMBEDDING_MODEL_ID)).toBe(false);
    expect(findEntry(EMBEDDING_MODEL_ID)).toBeDefined();
  });

  it('pairs a projector with every vision model', () => {
    for (const entry of CATALOG) {
      if (entry.tags.includes('vision')) {
        expect(entry.mmprojFile, `${entry.id} needs a projector`).toBeDefined();
      }
    }
  });

  it('builds Hugging Face download URLs', () => {
    const entry = findEntry('qwen3-4b-instruct')!;
    expect(downloadUrl(entry, entry.file)).toBe(
      'https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf?download=true',
    );
  });

  it('rejects a malformed entry', () => {
    expect(() => CatalogEntry.parse({ ...CATALOG[0], id: 'Has Capitals' })).toThrow();
    expect(() => CatalogEntry.parse({ ...CATALOG[0], file: 'weights.bin' })).toThrow();
  });
});
