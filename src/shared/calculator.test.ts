import { describe, expect, it } from 'vitest';
import { evaluateCommandCalculation } from './calculator';

describe('command calculator arithmetic', () => {
  it.each([
    ['2 + 3 * 4', '14'],
    ['(2 + 3) * 4', '20'],
    ['2*(3+4)-5/2', '11.5'],
    ['10px to rem', '0.625 rem'],
    ['.5 + 1.25 * 4', '5.5'],
    ['2 + -3', '-1'],
    ['-(4 + 3) * -2', '14'],
    ['--3', '3'], ['+ 1', '1'],
    ['17 % 5', '2'],
    ['20 / 2 / 5', '2'],
    ['32', '32'],
  ])('evaluates %s', (query, result) => {
    expect(evaluateCommandCalculation(query)).toEqual({ expression: query, result, copyText: result });
  });

  it('supports natural text, case-insensitive units, and unicode arithmetic notation', () => {
    expect(evaluateCommandCalculation('  1GB IN MB  ')?.result).toBe('1000 MB');
    expect(evaluateCommandCalculation('10 px to rem')?.copyText).toBe('0.625 rem');
    expect(evaluateCommandCalculation('20 C to F')?.result).toBe('68 F');
    expect(evaluateCommandCalculation('5 km in mi')?.result).toBe('3.10685596119 mi');
    expect(evaluateCommandCalculation('−7 × 3 ÷ 2')?.result).toBe('-10.5');
  });

  it('supports conversion in both directions', () => {
    expect(evaluateCommandCalculation('32px to rem')?.result).toBe('2 rem');
    expect(evaluateCommandCalculation('1.5rem to px')?.result).toBe('24 px');
    expect(evaluateCommandCalculation('1 GB to MB')?.result).toBe('1000 MB');
    expect(evaluateCommandCalculation('1000MB to gb')?.result).toBe('1 GB');
    expect(evaluateCommandCalculation('20 C to F')?.result).toBe('68 F');
    expect(evaluateCommandCalculation('68 F to C')?.result).toBe('20 C');
    expect(evaluateCommandCalculation('1 mi to km')?.result).toBe('1.609344 km');
  });

  it('round-trips units and clamps rounding artifacts only at display', () => {
    expect(evaluateCommandCalculation('0.1 + 0.2')?.result).toBe('0.3');
    expect(evaluateCommandCalculation('1 / 3')?.result).toBe('0.333333333333');
    expect(evaluateCommandCalculation('1 - 1')).toEqual({ expression: '1 - 1', result: '0', copyText: '0' });
    const mile = evaluateCommandCalculation('5 km in mi')!.copyText;
    const kilometers = Number.parseFloat(evaluateCommandCalculation(`${mile} to km`)!.result);
    expect(kilometers).toBeCloseTo(5, 9);
  });

  it('allows a finite positive rem base without changing the one-argument default', () => {
    expect(evaluateCommandCalculation('20px to rem')?.result).toBe('1.25 rem');
    expect(evaluateCommandCalculation('20px to rem', { remBase: 20 })?.result).toBe('1 rem');
    expect(evaluateCommandCalculation('3rem to px', { remBase: 20 })?.result).toBe('60 px');
  });

  it('permits same-unit arithmetic and parentheses with a conversion suffix', () => {
    expect(evaluateCommandCalculation('(10 + 6) px to rem')?.result).toBe('1 rem');
    expect(evaluateCommandCalculation('10px + 6px')?.result).toBe('16 px');
  });
});

describe('command calculator rejection', () => {
  it.each([
    '', '   ', 'calculate 2 + 2', '2 + 2 apples', 'px to rem', 'http://example.com',
    '1 +', '(1 + 2', '1 + 2)', '1.2.3', '2 ** 3', '1 // 2', '2 = 2', '1e3',
    '5 / 0', '5 % 0', '1e309', '9999999999999999 + 1', '1e15 * 1e15', '2 to 3',
    '2 px to rem extra', '2 km to F', '2 MB to C', '2 to MB', '2 px to', '10℃ to F',
    '10px + 3', '2px * 3', '2 + to rem', '2px to rem to px', 'NaN', 'Infinity',
  ])('returns null for invalid query %j', (query) => {
    expect(evaluateCommandCalculation(query)).toBeNull();
  });

  it('does not execute identifiers, property access, or JavaScript syntax', () => {
    const queries = [
      'process.env.SECRET', 'process.exit(1)', 'constructor.constructor("return process")()',
      'require("fs").readFileSync("/etc/passwd")', 'globalThis.alert(1)', 'window["loca" + "tion"]',
      '(()=>{throw new Error("executed")})()', 'fetch("https://attacker.invalid")',
      '2; throw new Error("FAIL_TEST")', '</script><script>alert(1)</script>', '__proto__',
      'Math.PI', 'console.log("leak")', '2px to rem.constructor', '1 IN 2', '5 To 3',
    ];
    for (const query of queries) expect(evaluateCommandCalculation(query)).toBeNull();
  });

  it('bounds long, deeply nested, and unicode input and does not throw', () => {
    const queries = [
      '1 + '.repeat(10_000) + '1', '9'.repeat(1_000_000),
      '('.repeat(250) + '1 + 1' + ')'.repeat(250), '-'.repeat(100) + '1',
      '́'.repeat(1_000) + '1 + 2', '😈'.repeat(10_000), '(1+2)MB**3 to GB',
    ];
    for (const query of queries) expect(() => evaluateCommandCalculation(query)).not.toThrow();
    expect('('.repeat(20) + '1 + 1' + ')'.repeat(20)).not.toBe('');
    for (const query of queries) expect(evaluateCommandCalculation(query)).toBeNull();
  });

  it('rejects invalid runtime config and retains finite, bounded output', () => {
    for (const remBase of [0, -16, NaN, Infinity, 1e16]) {
      expect(evaluateCommandCalculation('16px to rem', { remBase })).toBeNull();
    }
    const finiteQueries = ['2 + 3 * 4', '1 GB to MB', '20 C to F', '16px to rem', '1 / 1000000'];
    for (const query of finiteQueries) {
      const result = evaluateCommandCalculation(query)!;
      expect(Number.isFinite(Number.parseFloat(result.result))).toBe(true);
      expect(result.result.length).toBeLessThan(32);
    }
  });
});
