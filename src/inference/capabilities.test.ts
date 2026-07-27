import { describe, expect, it } from 'vitest';
import { describeModel, estimateRam, type GgufMetadata } from './capabilities';

/**
 * Chat templates abbreviated from the real published templates, preserving
 * every construct the detector keys on: the `tools` guard, the tool-call
 * delimiters, the tool_calls render branch and the `role == "tool"` branch.
 *
 * Structural fidelity is what matters — the full templates run to thousands of
 * characters of whitespace control that changes nothing about detection.
 */
const TEMPLATES = {
  /** Qwen3 — Hermes-style tags, full round-trip, reasoning model. */
  qwen3: `{%- if tools %}
    {{- '<|im_start|>system\\n' }}
    {{- "# Tools\\n\\nYou may call one or more functions.\\n<tools>" }}
    {%- for tool in tools %}
        {{- "\\n" }}{{- tool | tojson }}
    {%- endfor %}
    {{- "\\n</tools>\\n\\nReturn a json object within <tool_call></tool_call> XML tags:\\n<tool_call>\\n{\\"name\\": <function-name>, \\"arguments\\": <args-json-object>}\\n</tool_call><|im_end|>\\n" }}
{%- endif %}
{%- for message in messages %}
    {%- if message.role == "assistant" and message.tool_calls %}
        {%- for tool_call in message.tool_calls %}
            {{- '<tool_call>\\n{"name": "' }}{{- tool_call.function.name }}{{- '"}\\n</tool_call>' }}
        {%- endfor %}
    {%- elif message.role == "tool" %}
        {{- '<|im_start|>user\\n<tool_response>\\n' + message.content + '\\n</tool_response><|im_end|>\\n' }}
    {%- endif %}
{%- endfor %}`,

  /** Llama 3.2 — python_tag dialect, tools injected into the user message. */
  llama32: `{%- if tools is not none %}
    {%- set tools_in_user_message = true %}
{%- endif %}
{{- "<|start_header_id|>system<|end_header_id|>\\n\\n" }}
{%- if tools is not none %}
    {{- "You have access to the following functions:\\n" }}
    {%- for t in tools %}
        {{- t | tojson(indent=4) }}
    {%- endfor %}
    {{- "If you choose to call a function ONLY reply in the following format:\\n" }}
    {{- "<|python_tag|>{\\"name\\": function_name, \\"parameters\\": dictionary}" }}
{%- endif %}
{%- for message in messages %}
    {%- if message.role == "tool" %}
        {{- "<|start_header_id|>ipython<|end_header_id|>\\n\\n" + message.content }}
    {%- endif %}
{%- endfor %}`,

  /** Ministral — Mistral's bracketed dialect. */
  mistral: `{%- if tools is defined and tools is not none %}
    {{- "[AVAILABLE_TOOLS] " }}
    {%- for tool in tools %}{{- tool | tojson }}{%- endfor %}
    {{- "[/AVAILABLE_TOOLS]" }}
{%- endif %}
{%- for message in messages %}
    {%- if message.tool_calls is defined %}
        {{- "[TOOL_CALLS] " + message.tool_calls | tojson + eos_token }}
    {%- elif message.role == "tool" %}
        {{- "[TOOL_RESULTS] " + message.content + "[/TOOL_RESULTS]" }}
    {%- endif %}
{%- endfor %}`,

  /** DeepSeek-R1 distill — fullwidth delimiters, emits <think> traces. */
  deepseekR1: `{%- if tools %}
    {{- '<｜tool▁calls▁begin｜>' }}
    {%- for tool in tools %}{{- tool | tojson }}{%- endfor %}
{%- endif %}
{%- for message in messages %}
    {%- if message.role == 'assistant' and message.tool_calls %}
        {{- '<｜tool▁call▁begin｜>' + message.tool_calls[0].function.name }}
    {%- endif %}
    {%- if message.role == 'tool' %}{{- '<｜tool▁output▁begin｜>' + message.content }}{%- endif %}
{%- endfor %}
{{- '<think>\\n' }}`,

  /** Gemma 3 — no tool support in the published instruct template. */
  gemma3: `{{ bos_token }}
{%- if messages[0]['role'] == 'system' -%}
    {%- set loop_messages = messages[1:] -%}
{%- else -%}
    {%- set loop_messages = messages -%}
{%- endif -%}
{%- for message in loop_messages -%}
    {%- if (message['role'] == 'assistant') -%}
        {%- set role = "model" -%}
    {%- else -%}
        {%- set role = message['role'] -%}
    {%- endif -%}
    {{ '<start_of_turn>' + role + '\\n' + message['content'] | trim + '<end_of_turn>\\n' }}
{%- endfor -%}
{{ '<start_of_turn>model\\n' }}`,

  /** Phi-3 mini — plain role tags, no tool concept whatsoever. */
  phi3: `{% for message in messages %}{% if message['role'] == 'system' %}{{'<|system|>\\n' + message['content'] + '<|end|>\\n'}}{% elif message['role'] == 'user' %}{{'<|user|>\\n' + message['content'] + '<|end|>\\n'}}{% elif message['role'] == 'assistant' %}{{'<|assistant|>\\n' + message['content'] + '<|end|>\\n'}}{% endif %}{% endfor %}{% if add_generation_prompt %}{{ '<|assistant|>\\n' }}{% endif %}`,

  /**
   * Mentions tools but in no recognised dialect — must degrade to 'generic'
   * rather than being misread as Hermes.
   */
  unknownDialect: `{%- if tools %}
    {{- "Available functions:\\n" }}
    {%- for tool in tools %}{{- tool.name }}{%- endfor %}
    {{- "To use one, write CALL(name, args)." }}
{%- endif %}
{%- for message in messages %}{{- message.role + ": " + message.content }}{%- endfor %}`,
} as const;

/** Qwen3 4B at Q4_K_M — the reference "good phone model". */
const qwen3: GgufMetadata = {
  'general.architecture': 'qwen3',
  'general.basename': 'Qwen3',
  'general.size_label': '4B',
  'general.file_type': 15,
  'qwen3.context_length': 32768,
  'qwen3.block_count': 36,
  'qwen3.embedding_length': 2560,
  'qwen3.attention.head_count': 32,
  'qwen3.attention.head_count_kv': 8,
  'qwen3.attention.key_length': 128,
  'tokenizer.chat_template': TEMPLATES.qwen3,
};

const llama32: GgufMetadata = {
  'general.architecture': 'llama',
  'general.basename': 'Llama-3.2',
  'general.size_label': '3B',
  'general.file_type': 15,
  'llama.context_length': 131072,
  'llama.block_count': 28,
  'llama.embedding_length': 3072,
  'llama.attention.head_count': 24,
  'llama.attention.head_count_kv': 8,
  'tokenizer.chat_template': TEMPLATES.llama32,
};

const ministral: GgufMetadata = {
  'general.architecture': 'llama',
  'general.basename': 'Ministral',
  'general.size_label': '8B',
  'general.file_type': 17,
  'llama.context_length': 32768,
  'llama.block_count': 36,
  'llama.embedding_length': 4096,
  'llama.attention.head_count': 32,
  'llama.attention.head_count_kv': 8,
  'tokenizer.chat_template': TEMPLATES.mistral,
};

const deepseekR1: GgufMetadata = {
  'general.architecture': 'qwen2',
  'general.basename': 'DeepSeek-R1-Distill-Qwen',
  'general.size_label': '1.5B',
  'general.file_type': 15,
  'qwen2.context_length': 131072,
  'qwen2.block_count': 28,
  'qwen2.embedding_length': 1536,
  'qwen2.attention.head_count': 12,
  'qwen2.attention.head_count_kv': 2,
  'tokenizer.chat_template': TEMPLATES.deepseekR1,
};

/** No tool support — case 1 of the two the plan requires. */
const gemma3: GgufMetadata = {
  'general.architecture': 'gemma3',
  'general.basename': 'gemma-3',
  'general.size_label': '270M',
  'general.file_type': 15,
  'gemma3.context_length': 32768,
  'gemma3.block_count': 18,
  'gemma3.embedding_length': 640,
  'gemma3.attention.head_count': 4,
  'gemma3.attention.head_count_kv': 1,
  'gemma3.attention.key_length': 256,
  'tokenizer.chat_template': TEMPLATES.gemma3,
};

/** No tool support — case 2. */
const phi3: GgufMetadata = {
  'general.architecture': 'phi3',
  'general.basename': 'Phi-3-mini',
  'general.size_label': '3.8B',
  'general.file_type': 15,
  'phi3.context_length': 4096,
  'phi3.block_count': 32,
  'phi3.embedding_length': 3072,
  'phi3.attention.head_count': 32,
  'phi3.attention.head_count_kv': 32,
  'tokenizer.chat_template': TEMPLATES.phi3,
};

/** EmbeddingGemma — pooling only, no chat template at all. */
const embeddingGemma: GgufMetadata = {
  'general.architecture': 'gemma-embedding',
  'general.basename': 'embeddinggemma',
  'general.size_label': '300M',
  'general.file_type': 15,
  'gemma-embedding.context_length': 2048,
  'gemma-embedding.block_count': 24,
  'gemma-embedding.embedding_length': 768,
  'gemma-embedding.attention.head_count': 12,
  'gemma-embedding.attention.head_count_kv': 12,
  'gemma-embedding.pooling_type': 1,
};

describe('tool support detection', () => {
  it('recognises tool support across every major dialect', () => {
    const cases: Array<[string, GgufMetadata, string]> = [
      ['qwen3', qwen3, 'hermes'],
      ['llama3.2', llama32, 'llama3'],
      ['ministral', ministral, 'mistral'],
      ['deepseek-r1', deepseekR1, 'deepseek'],
    ];

    for (const [label, metadata, expectedStyle] of cases) {
      const caps = describeModel(metadata);
      expect(caps.supportsTools, `${label} should support tools`).toBe(true);
      expect(caps.toolCallStyle, `${label} dialect`).toBe(expectedStyle);
    }
  });

  it('reports no tool support for models whose template lacks the concept', () => {
    for (const [label, metadata] of [
      ['gemma3', gemma3],
      ['phi3', phi3],
    ] as const) {
      const caps = describeModel(metadata);
      expect(caps.supportsTools, `${label} must not claim tool support`).toBe(false);
      expect(caps.toolCallStyle).toBe('none');
      expect(caps.supportsToolResults).toBe(false);
    }
  });

  it('does not mistake tool_calls for the tools variable', () => {
    // A template that renders prior tool calls but never advertises tools
    // cannot start a tool interaction, so it must not be gated as capable.
    const rendersOnly: GgufMetadata = {
      'general.architecture': 'llama',
      'tokenizer.chat_template':
        '{%- for message in messages %}{%- if message.tool_calls %}{{- message.tool_calls[0].function.name }}{%- endif %}{%- endfor %}',
    };
    expect(describeModel(rendersOnly).supportsTools).toBe(false);
  });

  it('degrades an unrecognised dialect to generic rather than guessing', () => {
    const caps = describeModel({
      'general.architecture': 'llama',
      'tokenizer.chat_template': TEMPLATES.unknownDialect,
    });
    expect(caps.supportsTools).toBe(true);
    expect(caps.toolCallStyle).toBe('generic');
  });

  it('distinguishes emitting a call from carrying a multi-step conversation', () => {
    // Advertises tools but has no branch for feeding results back — capped at
    // one tool per turn, which the chat loop needs to know.
    const oneShot: GgufMetadata = {
      'general.architecture': 'llama',
      'tokenizer.chat_template':
        '{%- if tools %}{{- "Functions: " }}{%- for tool in tools %}{{- tool.name }}{%- endfor %}{%- endif %}',
    };
    const caps = describeModel(oneShot);
    expect(caps.supportsTools).toBe(true);
    expect(caps.supportsToolResults).toBe(false);

    expect(describeModel(qwen3).supportsToolResults).toBe(true);
  });
});

describe('model classification', () => {
  it('identifies an embedding model and never offers it tools', () => {
    const caps = describeModel(embeddingGemma);
    expect(caps.isEmbeddingModel).toBe(true);
    expect(caps.supportsTools).toBe(false);
    expect(caps.hasChatTemplate).toBe(false);
  });

  it('flags reasoning models so the UI can collapse their traces', () => {
    expect(describeModel(deepseekR1).supportsReasoning).toBe(true);
    expect(describeModel(qwen3).supportsReasoning).toBe(true);
    expect(describeModel(phi3).supportsReasoning).toBe(false);
  });

  it('detects vision from a projector file rather than metadata alone', () => {
    expect(describeModel(gemma3).supportsVision).toBe(false);
    expect(describeModel(gemma3, { hasProjector: true }).supportsVision).toBe(true);
  });

  it('reads parameter counts in billions regardless of unit', () => {
    expect(describeModel(qwen3).parameterCount).toBe(4);
    expect(describeModel(deepseekR1).parameterCount).toBe(1.5);
    expect(describeModel(gemma3).parameterCount).toBeCloseTo(0.27, 5);
  });

  it('resolves quantization from the file_type enum', () => {
    expect(describeModel(qwen3).quantization).toBe('Q4_K_M');
    expect(describeModel(ministral).quantization).toBe('Q5_K_M');
  });

  it('falls back to the filename when file_type is absent', () => {
    const noFileType = { ...qwen3 };
    delete noFileType['general.file_type'];
    expect(
      describeModel(noFileType, { fileName: 'Qwen3-4B-Q6_K.gguf' }).quantization,
    ).toBe('Q6_K');
  });
});

describe('resilience', () => {
  it('returns a conservative record for empty metadata instead of throwing', () => {
    const caps = describeModel({});
    expect(caps.architecture).toBe('unknown');
    expect(caps.supportsTools).toBe(false);
    expect(caps.hasChatTemplate).toBe(false);
    expect(caps.contextLength).toBe(2048);
    expect(caps.parameterCount).toBeNull();
  });

  it('coerces numeric metadata that arrives as strings', () => {
    // llama.rn surfaces some GGUF values as strings depending on value type.
    const stringy: GgufMetadata = {
      'general.architecture': 'llama',
      'llama.context_length': '8192',
      'llama.block_count': '32',
    };
    expect(describeModel(stringy).contextLength).toBe(8192);
  });
});

describe('memory estimation', () => {
  it('scales the KV cache linearly with context length', () => {
    const short = estimateRam(qwen3, 'qwen3', 0, 4096);
    const long = estimateRam(qwen3, 'qwen3', 0, 8192);
    expect(long.kvCacheBytes).toBe(short.kvCacheBytes * 2);
  });

  it('computes the KV cache from real GQA metadata', () => {
    // 2 (K+V) x 36 layers x 8 kv-heads x 128 head-dim x 4096 ctx x 2 bytes
    expect(estimateRam(qwen3, 'qwen3', 0, 4096).kvCacheBytes).toBe(
      2 * 36 * 8 * 128 * 4096 * 2,
    );
  });

  it('credits grouped-query attention with the saving it actually provides', () => {
    // Phi-3 has no GQA (32 kv-heads); Qwen3 has 8. Despite Qwen3 having more
    // layers, its cache per token is dramatically smaller — which is why model
    // fit cannot be predicted from parameter count alone.
    const withGqa = estimateRam(qwen3, 'qwen3', 0, 4096).kvCacheBytes;
    const withoutGqa = estimateRam(phi3, 'phi3', 0, 4096).kvCacheBytes;
    expect(withGqa).toBeLessThan(withoutGqa);
  });

  it('totals weights, cache and overhead', () => {
    const weights = 2_500_000_000;
    const estimate = estimateRam(qwen3, 'qwen3', weights, 4096);
    expect(estimate.weightsBytes).toBe(weights);
    expect(estimate.totalBytes).toBe(
      estimate.weightsBytes + estimate.kvCacheBytes + estimate.overheadBytes,
    );
  });

  it('sizes the cache against the requested context, not the trained maximum', () => {
    // Qwen3 trains to 32k but a phone should open far less. The record must
    // report the trained ceiling while costing only what we intend to allocate.
    const caps = describeModel(qwen3, {
      contextLength: 4096,
      fileSizeBytes: 2_500_000_000,
    });
    expect(caps.contextLength).toBe(32768);
    expect(caps.estimatedRam.kvCacheBytes).toBe(2 * 36 * 8 * 128 * 4096 * 2);
  });
});
