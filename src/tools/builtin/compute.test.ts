import { describe, expect, it } from 'vitest';
import { computeTool, evaluate, formatNumber } from './compute';

/** Shorthand: the formatted string is what actually reaches the model. */
const f = (expression: string) => evaluate(expression).formatted;
const v = (expression: string) => evaluate(expression).value;

describe('arithmetic', () => {
  it('respects operator precedence', () => {
    expect(v('2 + 3 * 4')).toBe(14);
    expect(v('(2 + 3) * 4')).toBe(20);
    expect(v('10 - 2 - 3')).toBe(5);
    expect(v('100 / 10 / 2')).toBe(5);
  });

  it('treats exponentiation as right associative', () => {
    // 2^(3^2) = 512, not (2^3)^2 = 64. Every calculator agrees; a naive
    // left-fold does not.
    expect(v('2^3^2')).toBe(512);
    expect(v('2**3**2')).toBe(512);
  });

  it('handles unary minus, including doubled', () => {
    expect(v('-5 + 3')).toBe(-2);
    expect(v('--5')).toBe(5);
    expect(v('3 * -2')).toBe(-6);
  });

  it('reads numbers the way people write them', () => {
    expect(v('1,234 + 1')).toBe(1235);
    expect(v('$50 * 2')).toBe(100);
    expect(v('.5 + .5')).toBe(1);
  });

  it('accepts the symbols and words a model reaches for', () => {
    expect(v('6 × 7')).toBe(42);
    expect(v('84 ÷ 2')).toBe(42);
    expect(v('40 plus 2')).toBe(42);
    expect(v('7 times 6')).toBe(42);
  });
});

describe('percentages', () => {
  it('reads a trailing percent as a fraction', () => {
    expect(v('15%')).toBeCloseTo(0.15, 10);
    expect(v('15% of 200')).toBeCloseTo(30, 10);
  });

  it('still treats an infix % as modulo', () => {
    // The ambiguity a naive implementation gets wrong: `10 % 3` is modulo,
    // but `10%` alone is a percentage.
    expect(v('10 % 3')).toBe(1);
    expect(v('17 % 5')).toBe(2);
  });
});

describe('functions and constants', () => {
  it('evaluates single-argument functions', () => {
    expect(v('sqrt(144)')).toBe(12);
    expect(v('abs(-7)')).toBe(7);
    expect(v('round(3.7)')).toBe(4);
    expect(v('floor(3.7)')).toBe(3);
    expect(v('ceil(3.2)')).toBe(4);
  });

  it('evaluates variadic functions', () => {
    expect(v('max(3, 9, 2)')).toBe(9);
    expect(v('min(3, 9, 2)')).toBe(2);
    expect(v('sum(1, 2, 3, 4)')).toBe(10);
    expect(v('avg(2, 4, 6)')).toBe(4);
  });

  it('knows pi and e', () => {
    expect(v('pi')).toBeCloseTo(Math.PI, 10);
    expect(v('e')).toBeCloseTo(Math.E, 10);
    expect(v('2 * pi')).toBeCloseTo(Math.PI * 2, 10);
  });

  it('nests calls and expressions', () => {
    expect(v('sqrt(pow(3, 2) + pow(4, 2))')).toBe(5);
    expect(v('max(sqrt(16), 3)')).toBe(4);
  });
});

describe('unit conversion', () => {
  it('converts length', () => {
    expect(evaluate('10 km to miles').value).toBeCloseTo(6.2137, 3);
    expect(evaluate('1 m to cm').value).toBeCloseTo(100, 6);
  });

  it('converts temperature affinely, not by ratio', () => {
    // The case a naive factor table gets wrong: 0 °C is 32 °F, not 0 °F.
    expect(evaluate('0 c to f').value).toBeCloseTo(32, 6);
    expect(evaluate('212 f to c').value).toBeCloseTo(100, 6);
    expect(evaluate('0 c to k').value).toBeCloseTo(273.15, 6);
  });

  it('converts mass, volume, time and data', () => {
    expect(evaluate('1 kg to lb').value).toBeCloseTo(2.2046, 3);
    expect(evaluate('2 gallons to litres').value).toBeCloseTo(7.5708, 3);
    expect(evaluate('2 hours to minutes').value).toBeCloseTo(120, 6);
    expect(evaluate('5 gb to mb').value).toBeCloseTo(5120, 6);
  });

  it('evaluates the magnitude before converting', () => {
    expect(evaluate('2 * 5 km to m').value).toBeCloseTo(10000, 6);
  });

  it('labels the result with the target unit', () => {
    const result = evaluate('10 km to miles');
    expect(result.unit).toBe('miles');
    expect(result.formatted).toContain('miles');
  });

  it('refuses to convert across dimensions', () => {
    expect(() => evaluate('10 km to kg')).toThrow(/Cannot convert/);
  });
});

describe('formatting', () => {
  it('hides floating-point noise', () => {
    // The model repeats verbatim what the tool returns, so
    // 0.30000000000000004 would otherwise reach the user unchanged.
    expect(f('0.1 + 0.2')).toBe('0.3');
    expect(f('1.1 * 3')).toBe('3.3');
  });

  it('groups large integers', () => {
    expect(f('1000000')).toBe('1,000,000');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });

  it('falls back to exponential for extreme magnitudes', () => {
    expect(formatNumber(1e20)).toContain('e+');
    expect(formatNumber(1e-9)).toContain('e-');
  });
});

describe('errors', () => {
  it('rejects division by zero rather than returning Infinity', () => {
    expect(() => evaluate('1 / 0')).toThrow(/Division by zero/);
  });

  it('names the unknown identifier', () => {
    expect(() => evaluate('foo + 1')).toThrow(/Unknown name "foo"/);
    expect(() => evaluate('frobnicate(2)')).toThrow(/Unknown function/);
  });

  it('reports unbalanced parentheses', () => {
    expect(() => evaluate('(1 + 2')).toThrow(/Missing closing parenthesis/);
    expect(() => evaluate('1 + 2)')).toThrow(/Unexpected/);
  });

  it('checks arity', () => {
    expect(() => evaluate('pow(2)')).toThrow(/takes 2 argument/);
    expect(() => evaluate('sqrt()')).toThrow(/at least one argument/);
  });

  it('rejects anything resembling code', () => {
    // The parser has no notion of these; there is no path from a tool call to
    // arbitrary evaluation.
    for (const attempt of [
      'process.exit(1)',
      'require("fs")',
      '[].constructor',
      '1; alert(1)',
    ]) {
      expect(() => evaluate(attempt), attempt).toThrow();
    }
  });
});

describe('tool definition', () => {
  it('declares an execute scope and does not mutate', () => {
    expect(computeTool.name).toBe('compute.evaluate');
    expect(computeTool.scopes).toEqual(['execute:compute']);
    expect(computeTool.mutates).toBeUndefined();
  });

  it('returns a structured result through the handler', async () => {
    const result = await computeTool.handler(
      { expression: '17% of 8432' },
      { signal: new AbortController().signal },
    );
    expect(result.value).toBeCloseTo(1433.44, 2);
    expect(result.formatted).toBe('1,433.44');
  });

  it('turns a parse failure into a message the model can correct from', async () => {
    await expect(
      computeTool.handler({ expression: 'sqrt(' }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/Could not evaluate "sqrt\("/);
  });
});
