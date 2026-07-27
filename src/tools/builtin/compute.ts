/**
 * Arithmetic, units and dates — the tool that fixes what small models are
 * worst at.
 *
 * A 1B model will confidently tell you 17% of 8,432 is "about 1,400". Handing
 * it a calculator is the highest-value tool in the app, because it converts a
 * category of confident wrongness into a category of correctness.
 *
 * The evaluator is a hand-written recursive-descent parser. It does not use
 * `eval` or `new Function` — Hermes supports neither, so anything built on them
 * dies on device. Writing the parser also means the language is exactly what we
 * choose to allow, with no path to arbitrary code execution.
 */

import { z } from 'zod';
import { defineTool } from '../kernel/types';

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

type TokenKind = 'number' | 'identifier' | 'operator' | 'lparen' | 'rparen' | 'comma';

interface Token {
  kind: TokenKind;
  text: string;
  value?: number;
}

export class ParseError extends Error {}

const OPERATOR_CHARS = new Set(['+', '-', '*', '/', '%', '^']);

function tokenise(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (/\s/.test(char)) {
      index++;
      continue;
    }

    if (/\d/.test(char) || (char === '.' && /\d/.test(input[index + 1] ?? ''))) {
      let text = '';
      while (index < input.length) {
        // Thousands separators are how humans write numbers, and the model
        // echoes them straight back from the user's message. They are consumed
        // as part of the number rather than skipped, because skipping would
        // split "1,234" into two adjacent number tokens.
        if (
          input[index] === ',' &&
          /\d/.test(text.at(-1) ?? '') &&
          /\d/.test(input[index + 1] ?? '')
        ) {
          index++;
          continue;
        }
        if (!/[\d.]/.test(input[index])) break;
        text += input[index++];
      }
      const value = Number(text);
      if (!Number.isFinite(value)) throw new ParseError(`"${text}" is not a number`);
      tokens.push({ kind: 'number', text, value });
      continue;
    }

    if (/[a-z_]/i.test(char)) {
      let text = '';
      while (index < input.length && /[a-z0-9_]/i.test(input[index])) text += input[index++];
      tokens.push({ kind: 'identifier', text: text.toLowerCase() });
      continue;
    }

    if (char === '(') {
      tokens.push({ kind: 'lparen', text: char });
      index++;
      continue;
    }
    if (char === ')') {
      tokens.push({ kind: 'rparen', text: char });
      index++;
      continue;
    }
    if (char === ',') {
      tokens.push({ kind: 'comma', text: char });
      index++;
      continue;
    }
    if (OPERATOR_CHARS.has(char)) {
      // ** is how a model trained on Python writes exponentiation.
      if (char === '*' && input[index + 1] === '*') {
        tokens.push({ kind: 'operator', text: '^' });
        index += 2;
        continue;
      }
      tokens.push({ kind: 'operator', text: char });
      index++;
      continue;
    }

    throw new ParseError(`Unexpected character "${char}"`);
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Functions and constants
// ---------------------------------------------------------------------------

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

interface FunctionDefinition {
  arity: number | 'variadic';
  fn: (...args: number[]) => number;
}

const FUNCTIONS: Record<string, FunctionDefinition> = {
  sqrt: { arity: 1, fn: Math.sqrt },
  cbrt: { arity: 1, fn: Math.cbrt },
  abs: { arity: 1, fn: Math.abs },
  round: { arity: 1, fn: Math.round },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  sign: { arity: 1, fn: Math.sign },
  sin: { arity: 1, fn: Math.sin },
  cos: { arity: 1, fn: Math.cos },
  tan: { arity: 1, fn: Math.tan },
  asin: { arity: 1, fn: Math.asin },
  acos: { arity: 1, fn: Math.acos },
  atan: { arity: 1, fn: Math.atan },
  ln: { arity: 1, fn: Math.log },
  log: { arity: 1, fn: Math.log10 },
  log2: { arity: 1, fn: Math.log2 },
  exp: { arity: 1, fn: Math.exp },
  pow: { arity: 2, fn: Math.pow },
  min: { arity: 'variadic', fn: (...args) => Math.min(...args) },
  max: { arity: 'variadic', fn: (...args) => Math.max(...args) },
  sum: { arity: 'variadic', fn: (...args) => args.reduce((a, b) => a + b, 0) },
  avg: {
    arity: 'variadic',
    fn: (...args) => args.reduce((a, b) => a + b, 0) / (args.length || 1),
  },
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Grammar, loosest binding first:
 *
 *   expression := term (('+' | '-') term)*
 *   term       := power (('*' | '/' | '%') power)*
 *   power      := unary ('^' power)?           -- right associative
 *   unary      := ('-' | '+')? postfix
 *   postfix    := primary '%'?                 -- trailing percent
 *   primary    := number | constant | call | '(' expression ')'
 */
class Parser {
  private position = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.expression();
    if (this.position < this.tokens.length) {
      throw new ParseError(`Unexpected "${this.tokens[this.position].text}"`);
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private consumeOperator(...operators: string[]): string | null {
    const token = this.peek();
    if (token?.kind === 'operator' && operators.includes(token.text)) {
      this.position++;
      return token.text;
    }
    return null;
  }

  private expression(): number {
    let left = this.term();
    for (;;) {
      const operator = this.consumeOperator('+', '-');
      if (!operator) return left;
      const right = this.term();
      left = operator === '+' ? left + right : left - right;
    }
  }

  private term(): number {
    let left = this.power();
    for (;;) {
      const operator = this.consumeOperator('*', '/', '%');
      if (!operator) return left;

      const right = this.power();
      if ((operator === '/' || operator === '%') && right === 0) {
        throw new ParseError('Division by zero');
      }
      left =
        operator === '*' ? left * right : operator === '/' ? left / right : left % right;
    }
  }

  private power(): number {
    const base = this.unary();
    if (this.consumeOperator('^')) {
      // Right associative: 2^3^2 is 2^(3^2), matching every calculator.
      return Math.pow(base, this.power());
    }
    return base;
  }

  private unary(): number {
    const operator = this.consumeOperator('-', '+');
    if (operator === '-') return -this.unary();
    if (operator === '+') return this.unary();
    return this.postfix();
  }

  private postfix(): number {
    const value = this.primary();
    const next = this.peek();

    // `%` is ambiguous: infix modulo in `10 % 3`, but a trailing percentage in
    // `15% of 200` (which normalises to `15% * 200`). It is modulo only when
    // what follows can actually begin a right operand.
    if (next?.kind === 'operator' && next.text === '%') {
      const after = this.tokens[this.position + 1];
      const startsOperand =
        after?.kind === 'number' ||
        after?.kind === 'lparen' ||
        after?.kind === 'identifier';

      if (!startsOperand) {
        this.position++;
        return value / 100;
      }
    }
    return value;
  }

  private primary(): number {
    const token = this.peek();
    if (!token) throw new ParseError('Expression ended unexpectedly');

    if (token.kind === 'number') {
      this.position++;
      return token.value!;
    }

    if (token.kind === 'lparen') {
      this.position++;
      const value = this.expression();
      if (this.peek()?.kind !== 'rparen') {
        throw new ParseError('Missing closing parenthesis');
      }
      this.position++;
      return value;
    }

    if (token.kind === 'identifier') {
      this.position++;
      const name = token.text;
      if (this.peek()?.kind === 'lparen') return this.call(name);
      if (name in CONSTANTS) return CONSTANTS[name];
      throw new ParseError(`Unknown name "${name}"`);
    }

    throw new ParseError(`Unexpected "${token.text}"`);
  }

  private call(name: string): number {
    const definition = FUNCTIONS[name];
    if (!definition) throw new ParseError(`Unknown function "${name}"`);

    this.position++; // consume '('
    const args: number[] = [];

    if (this.peek()?.kind !== 'rparen') {
      for (;;) {
        args.push(this.expression());
        if (this.peek()?.kind === 'comma') {
          this.position++;
          continue;
        }
        break;
      }
    }

    if (this.peek()?.kind !== 'rparen') throw new ParseError(`Missing ) after ${name}(`);
    this.position++;

    if (args.length === 0) throw new ParseError(`${name}() needs at least one argument`);
    if (definition.arity !== 'variadic' && args.length !== definition.arity) {
      throw new ParseError(
        `${name}() takes ${definition.arity} argument(s), got ${args.length}`,
      );
    }

    const result = definition.fn(...args);
    if (!Number.isFinite(result)) {
      throw new ParseError(`${name}() is undefined for that input`);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

interface Unit {
  dimension: string;
  toBase: number;
  label: string;
}

/** Conversion factors to a canonical base unit per dimension. */
const UNITS: Record<string, Unit> = {
  // Length — base metre
  mm: { dimension: 'length', toBase: 0.001, label: 'mm' },
  cm: { dimension: 'length', toBase: 0.01, label: 'cm' },
  m: { dimension: 'length', toBase: 1, label: 'm' },
  km: { dimension: 'length', toBase: 1000, label: 'km' },
  inch: { dimension: 'length', toBase: 0.0254, label: 'inches' },
  inches: { dimension: 'length', toBase: 0.0254, label: 'inches' },
  ft: { dimension: 'length', toBase: 0.3048, label: 'ft' },
  feet: { dimension: 'length', toBase: 0.3048, label: 'feet' },
  yd: { dimension: 'length', toBase: 0.9144, label: 'yd' },
  mi: { dimension: 'length', toBase: 1609.344, label: 'miles' },
  mile: { dimension: 'length', toBase: 1609.344, label: 'miles' },
  miles: { dimension: 'length', toBase: 1609.344, label: 'miles' },

  // Mass — base kilogram
  mg: { dimension: 'mass', toBase: 0.000001, label: 'mg' },
  g: { dimension: 'mass', toBase: 0.001, label: 'g' },
  kg: { dimension: 'mass', toBase: 1, label: 'kg' },
  oz: { dimension: 'mass', toBase: 0.0283495, label: 'oz' },
  lb: { dimension: 'mass', toBase: 0.453592, label: 'lb' },
  lbs: { dimension: 'mass', toBase: 0.453592, label: 'lb' },
  stone: { dimension: 'mass', toBase: 6.35029, label: 'stone' },

  // Volume — base litre
  ml: { dimension: 'volume', toBase: 0.001, label: 'ml' },
  l: { dimension: 'volume', toBase: 1, label: 'l' },
  litre: { dimension: 'volume', toBase: 1, label: 'litres' },
  litres: { dimension: 'volume', toBase: 1, label: 'litres' },
  gal: { dimension: 'volume', toBase: 3.78541, label: 'gallons' },
  gallon: { dimension: 'volume', toBase: 3.78541, label: 'gallons' },
  gallons: { dimension: 'volume', toBase: 3.78541, label: 'gallons' },
  pint: { dimension: 'volume', toBase: 0.473176, label: 'pints' },
  pints: { dimension: 'volume', toBase: 0.473176, label: 'pints' },
  cup: { dimension: 'volume', toBase: 0.236588, label: 'cups' },
  cups: { dimension: 'volume', toBase: 0.236588, label: 'cups' },

  // Time — base second
  ms: { dimension: 'time', toBase: 0.001, label: 'ms' },
  sec: { dimension: 'time', toBase: 1, label: 'seconds' },
  secs: { dimension: 'time', toBase: 1, label: 'seconds' },
  seconds: { dimension: 'time', toBase: 1, label: 'seconds' },
  minutes: { dimension: 'time', toBase: 60, label: 'minutes' },
  hr: { dimension: 'time', toBase: 3600, label: 'hours' },
  hrs: { dimension: 'time', toBase: 3600, label: 'hours' },
  hours: { dimension: 'time', toBase: 3600, label: 'hours' },
  day: { dimension: 'time', toBase: 86400, label: 'days' },
  days: { dimension: 'time', toBase: 86400, label: 'days' },
  week: { dimension: 'time', toBase: 604800, label: 'weeks' },
  weeks: { dimension: 'time', toBase: 604800, label: 'weeks' },

  // Data — base byte
  bytes: { dimension: 'data', toBase: 1, label: 'bytes' },
  kb: { dimension: 'data', toBase: 1024, label: 'KB' },
  mb: { dimension: 'data', toBase: 1024 ** 2, label: 'MB' },
  gb: { dimension: 'data', toBase: 1024 ** 3, label: 'GB' },
  tb: { dimension: 'data', toBase: 1024 ** 4, label: 'TB' },
};

interface Temperature {
  toCelsius: (n: number) => number;
  fromCelsius: (n: number) => number;
  label: string;
}

/**
 * Temperature is affine rather than a simple ratio, so it cannot live in the
 * factor table above without producing wrong answers.
 */
const TEMPERATURES: Record<string, Temperature> = {
  c: { toCelsius: (n) => n, fromCelsius: (n) => n, label: '°C' },
  celsius: { toCelsius: (n) => n, fromCelsius: (n) => n, label: '°C' },
  f: {
    toCelsius: (n) => ((n - 32) * 5) / 9,
    fromCelsius: (n) => (n * 9) / 5 + 32,
    label: '°F',
  },
  fahrenheit: {
    toCelsius: (n) => ((n - 32) * 5) / 9,
    fromCelsius: (n) => (n * 9) / 5 + 32,
    label: '°F',
  },
  k: { toCelsius: (n) => n - 273.15, fromCelsius: (n) => n + 273.15, label: 'K' },
  kelvin: { toCelsius: (n) => n - 273.15, fromCelsius: (n) => n + 273.15, label: 'K' },
};

interface ConversionRequest {
  expression: string;
  from: string;
  to: string;
}

/** Splits "10 km to miles" into its parts. Returns null when there is no conversion. */
function parseConversion(input: string): ConversionRequest | null {
  const match = /^(.*?)\s*([a-z°]+)\s+(?:to|in|as)\s+([a-z°]+)\s*$/i.exec(input.trim());
  if (!match) return null;

  const [, expression, from, to] = match;
  const normalise = (unit: string) => unit.toLowerCase().replace(/^°/, '');
  return { expression: expression.trim(), from: normalise(from), to: normalise(to) };
}

function convert(value: number, from: string, to: string): { value: number; label: string } {
  if (from in TEMPERATURES && to in TEMPERATURES) {
    const celsius = TEMPERATURES[from].toCelsius(value);
    return { value: TEMPERATURES[to].fromCelsius(celsius), label: TEMPERATURES[to].label };
  }

  const source = UNITS[from];
  const target = UNITS[to];
  if (!source) throw new ParseError(`Unknown unit "${from}"`);
  if (!target) throw new ParseError(`Unknown unit "${to}"`);
  if (source.dimension !== target.dimension) {
    throw new ParseError(`Cannot convert ${source.dimension} to ${target.dimension}`);
  }

  return { value: (value * source.toBase) / target.toBase, label: target.label };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Formats a result for a model to read back.
 *
 * Floating-point noise is the enemy here: `0.1 + 0.2` must not reach the model
 * as `0.30000000000000004`, because it will faithfully repeat it to the user.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return value.toLocaleString('en-US');

  const rounded = Number(value.toPrecision(12));
  if (Math.abs(rounded) >= 1e15 || (Math.abs(rounded) < 1e-6 && rounded !== 0)) {
    return rounded.toExponential(6);
  }

  return rounded.toLocaleString('en-US', { maximumFractionDigits: 10 });
}

/** Rewrites the phrasings a model reaches for into operators the parser knows. */
function normaliseExpression(input: string): string {
  return input
    .replace(/\bof\b/gi, '*')
    .replace(/\bplus\b/gi, '+')
    .replace(/\bminus\b/gi, '-')
    .replace(/\btimes\b/gi, '*')
    .replace(/\bdivided by\b/gi, '/')
    .replace(/[×✕]/g, '*')
    .replace(/÷/g, '/')
    .replace(/[−–—]/g, '-')
    .replace(/[$£€]/g, '');
}

export interface ComputeResult {
  value: number;
  formatted: string;
  unit: string | null;
}

/** Evaluates an expression, with optional unit conversion. Throws `ParseError`. */
export function evaluate(input: string): ComputeResult {
  const conversion = parseConversion(input);

  if (conversion) {
    const known = (unit: string) => unit in UNITS || unit in TEMPERATURES;
    if (known(conversion.from) && known(conversion.to)) {
      const magnitude = conversion.expression
        ? new Parser(tokenise(normaliseExpression(conversion.expression))).parse()
        : 1;
      const { value, label } = convert(magnitude, conversion.from, conversion.to);
      return { value, formatted: `${formatNumber(value)} ${label}`, unit: label };
    }
  }

  const value = new Parser(tokenise(normaliseExpression(input))).parse();
  if (!Number.isFinite(value)) throw new ParseError('The result is not a finite number');
  return { value, formatted: formatNumber(value), unit: null };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const computeTool = defineTool({
  name: 'compute.evaluate',
  description:
    'Evaluate a mathematical expression or convert between units. Use this for ANY arithmetic, ' +
    'percentage, or unit conversion instead of calculating it yourself. Supports + - * / % ^, ' +
    'parentheses, sqrt/abs/round/floor/ceil/min/max/sum/avg/log/ln/exp/sin/cos/tan, the constants ' +
    'pi and e, and conversions such as "10 km to miles", "72 f to c", "5 GB to MB".',
  parameters: z.object({
    expression: z
      .string()
      .min(1)
      .max(500)
      .describe('The expression to evaluate, e.g. "1234 * 0.17" or "10 km to miles"'),
  }),
  scopes: ['execute:compute'],
  timeoutMs: 1_000,
  handler: async ({ expression }): Promise<ComputeResult> => {
    try {
      return evaluate(expression);
    } catch (cause) {
      // Rethrown as a plain Error so the dispatcher renders it as a readable
      // tool message the model can correct from, rather than a stack trace.
      throw new Error(
        cause instanceof ParseError
          ? `Could not evaluate "${expression}": ${cause.message}`
          : `Could not evaluate "${expression}"`,
      );
    }
  },
});
