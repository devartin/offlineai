import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The offline guarantee, enforced structurally.
 *
 * The product claim is "no data ever leaves the device". A claim like that is
 * worthless if it rests on the discipline of whoever edits the code next, so
 * this suite makes it an invariant of the dependency graph: network access is
 * confined to an explicit allowlist of modules, and nothing involved in
 * inference, tools, storage or search is permitted to reach them.
 *
 * If someone adds `fetch` to a tool handler, or imports the downloader from the
 * chat loop, the build fails here rather than shipping a quiet regression.
 */

const SOURCE_ROOT = resolve(__dirname);

/**
 * The only modules allowed to touch the network.
 *
 * Downloading model weights is the single legitimate reason this app opens a
 * socket. Everything else — inference, tools, persistence, retrieval, the UI —
 * must work with the radio off.
 */
const NETWORK_ALLOWLIST = new Set([
  'models/downloader.ts',
  'models/huggingface.ts',
  'offline-guarantee.test.ts',
]);

/** Subsystems that must remain free of any path to a networked module. */
const SEALED_DIRECTORIES = [
  'inference',
  'tools',
  'db',
  'knowledge',
  'ui',
  'voice',
  // Conversation persistence. Sealed for the same reason as `db`: it handles
  // the full text of everything the user has ever said, so it is exactly the
  // module where an accidental network import would matter most.
  'chat',
];

/** Runtime primitives that open a connection. */
const NETWORK_PRIMITIVES = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bnavigator\.sendBeacon\b/,
];

/** Packages that exist to make network requests. */
const NETWORK_PACKAGES = [
  'axios',
  'node-fetch',
  'superagent',
  'got',
  'ky',
  'undici',
  'expo-updates',
  '@react-native-community/netinfo',
];

interface SourceFile {
  /** Path relative to `src/`, e.g. "tools/builtin/compute.ts". */
  id: string;
  source: string;
  imports: string[];
}

function listSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules') continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

/** Strips comments so a mention of `fetch` in prose is not read as a call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function extractImports(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /import\s[^'"]*from\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

const FILES: SourceFile[] = listSourceFiles(SOURCE_ROOT).map((path) => {
  const source = stripComments(readFileSync(path, 'utf8'));
  return {
    id: relative(SOURCE_ROOT, path).split('\\').join('/'),
    source,
    imports: extractImports(source),
  };
});

/** Files belonging to a sealed subsystem, excluding their own tests. */
const SEALED_FILES = FILES.filter(
  (file) =>
    SEALED_DIRECTORIES.some((directory) => file.id.startsWith(`${directory}/`)) &&
    !file.id.endsWith('.test.ts'),
);

describe('offline guarantee', () => {
  it('finds the source tree it is meant to be policing', () => {
    // A traversal bug that silently matched nothing would make every assertion
    // below pass vacuously, which is the one failure mode that matters here.
    expect(FILES.length).toBeGreaterThan(10);
    expect(SEALED_FILES.length).toBeGreaterThan(5);
  });

  it('confines network primitives to the download modules', () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      if (NETWORK_ALLOWLIST.has(file.id)) continue;
      for (const primitive of NETWORK_PRIMITIVES) {
        if (primitive.test(file.source)) {
          offenders.push(`${file.id} uses ${primitive.source}`);
        }
      }
    }

    expect(
      offenders,
      `Network access outside the allowlist:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('imports no networking library anywhere in the app', () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      for (const specifier of file.imports) {
        if (
          NETWORK_PACKAGES.some(
            (pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`),
          )
        ) {
          offenders.push(`${file.id} imports ${specifier}`);
        }
      }
    }

    expect(offenders, `Networking dependencies found:\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });

  it('keeps inference, tools, storage and retrieval sealed from the downloader', () => {
    // The load-bearing rule. A tool that can import the downloader can
    // exfiltrate, whatever its author intended, so the edge itself is forbidden.
    const offenders: string[] = [];

    for (const file of SEALED_FILES) {
      for (const specifier of file.imports) {
        if (/(^|\/)(downloader|huggingface)$/.test(specifier)) {
          offenders.push(`${file.id} imports ${specifier}`);
        }
      }
    }

    expect(
      offenders,
      `Sealed subsystems reaching networked modules:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('routes every tool through the kernel rather than calling out directly', () => {
    // Built-in tools are the most likely place for a well-meaning network call
    // to appear, so they are checked independently of the sweep above.
    const tools = FILES.filter(
      (file) => file.id.startsWith('tools/builtin/') && !file.id.endsWith('.test.ts'),
    );
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      for (const primitive of NETWORK_PRIMITIVES) {
        expect(
          primitive.test(tool.source),
          `${tool.id} must not open connections`,
        ).toBe(false);
      }
    }
  });

  it('never sends analytics, telemetry or crash reports', () => {
    // An offline-guarantee app that phones home about crashes has broken its
    // promise just as thoroughly as one that uploads conversations.
    const forbidden = [
      'sentry',
      'bugsnag',
      'firebase',
      'amplitude',
      'mixpanel',
      'posthog',
      'segment',
      'datadog',
    ];
    const offenders: string[] = [];

    for (const file of FILES) {
      for (const specifier of file.imports) {
        const lowered = specifier.toLowerCase();
        if (forbidden.some((name) => lowered.includes(name))) {
          offenders.push(`${file.id} imports ${specifier}`);
        }
      }
    }

    expect(offenders, `Telemetry found:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('reaches Hugging Face only over HTTPS when it does download', () => {
    const downloader = FILES.find((file) => file.id === 'models/downloader.ts');
    expect(downloader).toBeDefined();

    // Model weights are executed by llama.cpp, so a plaintext fetch would be a
    // remote-code-execution vector, not merely a privacy lapse.
    expect(/http:\/\/(?!localhost)/.test(downloader!.source)).toBe(false);
  });
});
