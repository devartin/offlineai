# OfflineAI

A fully offline, open-source AI assistant for iOS and Android. You download open-weight models in the app, and the assistant can call tools that touch your real data — because none of it ever leaves the device.

Every mainstream AI assistant is a thin client over someone else's datacenter. The open-source local-LLM apps that exist today prove inference works on a phone, but they stop at "chat with a model" — none of them give the model *tools*, which is what makes an assistant useful rather than a novelty.

That's the inversion this is built on: because nothing leaves the device, the assistant can be trusted with data no cloud assistant should ever see.

---

## Status

**This is not finished software.** It builds and its logic is tested, but it has never run on a phone. Read [What's verified](#whats-verified) before relying on anything here.

```bash
npm install && npm run verify
```

---

## Install

**Android** — grab `app-release.apk` from [Releases](../../releases) and sideload it. You'll need to allow installation from unknown sources. The APK is signed with a debug keystore, which is fine for sideloading but means it can't go on Google Play.

**iOS** — there is no tap-to-install build, and there cannot be one: Apple requires a paid Developer account to sign an app for distribution, and this project holds no Apple credentials. Two ways in, both using your own free Apple ID:

1. **With a Mac and Xcode** — the easy path. Clone, `npm install`, then `npx expo run:ios --device`. Xcode's free provisioning signs it against your Apple ID automatically.
2. **Without Xcode** — download `OfflineAI-unsigned.ipa` from [Releases](../../releases) and sign it yourself with [AltStore](https://altstore.io) or [Sideloadly](https://sideloadly.io). You'll need a computer for the initial install.

Either way the app is signed with a *free* Apple ID, so iOS expires it after **seven days** and it has to be re-signed. That is Apple's limit on free provisioning, not a property of this app. AltStore refreshes automatically while it can reach your computer.

**From source, either platform:**

```bash
npm install
npx expo prebuild
npx expo run:android   # or run:ios
```

Expo Go will not work — `llama.rn` is a native module, so it needs a development build.

---

## The offline guarantee

The claim is "no data ever leaves the device". That claim is worthless if it rests on the discipline of whoever edits the code next, so it's enforced as a property of the dependency graph and checked on every test run by [`src/offline-guarantee.test.ts`](src/offline-guarantee.test.ts):

- Network primitives (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`) are confined to an explicit allowlist of two modules.
- `inference/`, `tools/`, `db/`, `knowledge/`, `ui/`, `chat/` and `voice/` may not import those modules — directly or transitively.
- No networking library, and no analytics, telemetry or crash-reporting SDK, may be imported anywhere.
- Model downloads must use HTTPS, because llama.cpp executes the weights.

Add `fetch` to a tool handler and the build fails. That's the point.

**Downloading model weights is the only reason this app opens a socket.**

---

## Architecture

```
src/
  inference/   capabilities.ts  GGUF metadata -> what a model can actually do
               engine.ts        llama.rn lifecycle, eviction, the turn loop
  models/      catalog.ts       12 curated models
               fit.ts           device RAM -> will this actually run here?
               downloader.ts    resumable install  [networked]
  tools/       kernel/          registry, consent, audit, dispatch
               builtin/         compute, memory
  db/          schema, migrations, repositories
  ui/          theme, primitives, consent sheet
  app/         Expo Router screens
```

### Capability gating

The feature that makes tools workable on small models. `loadLlamaModelInfo()` reads GGUF metadata *without* loading the model, so before a download even finishes we know whether its chat template understands tools, which dialect it emits, whether it can carry multi-step tool conversations, and how much RAM it will need at a given context length.

A model that can't call tools gets a clean chat app with no dead affordances — not a broken agent.

### The three-layer tool system

**Kernel** — a registry and dispatcher over JSON Schema. Knows nothing about LLMs, imports nothing native, and never throws: a bad name, malformed arguments, a refusal, a hang, and a crashing handler all come back as a result the model can read and recover from.

**Capability gate** — the turn loop only sends `tools` to models that support them, and the UI reads the same record.

**Consent broker** — every tool declares scopes (`read:calendar`, `write:memory`). Two rules are load-bearing:

- A **mutating** tool re-confirms on *every* call with the exact arguments visible, even under a standing grant. "Always allow" can never silently authorise future writes.
- One revoked scope denies a multi-scope tool outright, so revocation can't be routed around.

### Memory

iOS jetsam kills whichever backgrounded process holds the most memory, and a loaded 4B model makes this app that process every time. So the context is treated as disposable: the KV cache is saved and the context released on background, then restored on return. `fit.ts` refuses to promise an 8GB phone more than 4GB, because that's roughly what jetsam actually allows.

---

## Building

**You do not need Xcode.** EAS builds in the cloud:

```bash
npm i -g eas-cli && eas login
```

```bash
npm run build:android
```

That produces a sideloadable APK. Build the dev client once, then iterate on JS with hot reload — native rebuilds are only needed when native dependencies change.

For iOS, `npx expo run:ios --device` builds and installs in one step using Xcode's free provisioning — no paid account, but the resulting app expires after seven days. CI also produces an unsigned IPA (`.github/workflows/ios.yml`) for people who want to sideload without Xcode; it is built with `CODE_SIGNING_ALLOWED=NO` and carries no signing material at all, so it must be signed by whoever installs it.

---

## What's verified

136 tests, all passing. What they actually prove:

| Module | Tests | Verified behaviour |
|---|---|---|
| `tools/kernel/` | 16 | Dispatch never throws; mutating tools re-confirm; one revoked scope denies; a throwing consent prompt fails closed |
| `inference/capabilities.ts` | 18 | Tool support across 7 real chat-template dialects; 2 no-tool models correctly excluded; KV-cache maths from real GQA metadata |
| `models/` | 19 | Fit verdicts and context suggestions; catalog schema; no unmeasured tool grade is published |
| `tools/builtin/compute.ts` | 28 | Precedence, right-associative exponentiation, percent-vs-modulo, affine temperature conversion, float-noise suppression, code-injection rejection |
| `tools/builtin/memory.ts` | 22 | Cosine similarity, lexical fallback, duplicate suppression, consent semantics |
| `db/` | 26 | Real SQLite: migrations idempotent, cascades, upserts, BLOB round-trips, corrupt-JSON resilience |
| `offline-guarantee.test.ts` | 7 | The network invariants above |

## What's not verified

**Nothing here has run on a phone.** `engine.ts` typechecks against llama.rn 0.12.7's real types, but has never executed. No tokens/sec, no time-to-first-token, no peak RSS, no jetsam behaviour — and simulator numbers don't count for any of those.

The UI has never been rendered.

## Known gaps

- No document/RAG pipeline (`knowledge/` is unbuilt)
- Tools built: `compute.evaluate`, `memory.remember`, `memory.recall`. Not built: calendar, contacts, reminders, health, docs, code sandbox, vision
- No audit-log viewer, settings screen, or conversation history list
- No Hugging Face free-text browse (the 12-model curated catalog works)
- No tool-use eval harness, so every catalog entry's `toolGrade` is honestly `unmeasured`
- Voice input/output not started

---

## Contributing

The tool kernel is the most useful place to start — it has no native dependencies and runs entirely in Node.

A new tool is one `defineTool` call. Use the helper rather than annotating the type directly: `const t: ToolDefinition = {...}` erases the schema generic and silently degrades handler arguments to `unknown`.

Anything touching personal data must declare accurate scopes and set `mutates: true` if it writes. That isn't ceremony — it's what the consent sheet renders and what the audit log records.

## Licence

Apache-2.0 — the patent grant matters for a project that may attract corporate contributors.
