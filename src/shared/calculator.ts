export interface CalculationOptions { remBase?: number }
export interface CommandCalculation { expression: string; result: string; copyText: string }
type Operator = '+' | '-' | '*' | '/' | '%';
type Unit = 'px' | 'rem' | 'MB' | 'GB' | 'C' | 'F' | 'km' | 'mi';
type Token = { kind: 'number'; value: number } | { kind: 'operator'; value: Operator } |
  { kind: 'open' | 'close' | 'conversion' } | { kind: 'unit'; value: Unit };
const units = new Map<string, Unit>([['px', 'px'], ['rem', 'rem'], ['mb', 'MB'], ['gb', 'GB'], ['c', 'C'], ['f', 'F'], ['km', 'km'], ['mi', 'mi']]);
const families: Record<Unit, string> = { px: 'length', rem: 'length', MB: 'data', GB: 'data', C: 'temperature', F: 'temperature', km: 'distance', mi: 'distance' };
const MAX_INPUT = 256;
const MAX_TOKENS = 100;
const MAX_DEPTH = 32;
const MAX_MAGNITUDE = 1e15;
class InvalidCalculation extends Error {}
function checked(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_MAGNITUDE) throw new InvalidCalculation();
  return value;
}
function tokenize(input: string): Token[] {
  if (!input || input.length > MAX_INPUT) throw new InvalidCalculation();
  const normalized = input.replace(/[×·⋅]/g, '*').replace(/÷/g, '/').replace(/[−–—]/g, '-');
  const tokens: Token[] = [];
  let position = 0;
  let conversions = 0;
  const push = (token: Token): void => {
    if (tokens.length >= MAX_TOKENS) throw new InvalidCalculation();
    tokens.push(token);
  };
  while (position < normalized.length) {
    const rest = normalized.slice(position);
    const number = /^\s*(\d+(?:\.\d*)?|\.\d+)/.exec(rest);
    if (number) {
      push({ kind: 'number', value: checked(Number(number[1])) });
      position += number[0].length;
      continue;
    }
    const word = /^\s*([a-z]+)/i.exec(rest);
    if (word) {
      const rawWord = word[1];
      const unit = units.get(rawWord.toLowerCase());
      const conversion = !unit && /^(to|in|as)$/i.test(rawWord);
      if (!unit && !conversion) throw new InvalidCalculation();
      if (conversion && ++conversions > 1) throw new InvalidCalculation();
      push(unit ? { kind: 'unit', value: unit } : { kind: 'conversion' });
      position += word[0].length;
      continue;
    }
    const symbol = /^\s*([+\-*/%()])/.exec(rest);
    if (!symbol) throw new InvalidCalculation();
    const value = symbol[1];
    if (value === '(') push({ kind: 'open' });
    else if (value === ')') push({ kind: 'close' });
    else push({ kind: 'operator', value: value as Operator });
    position += symbol[0].length;
  }
  return tokens;
}
class Parser {
  private index = 0;
  private depth = 0;
  constructor(private readonly tokens: readonly Token[]) {}
  parse(): { value: number; unit?: Unit; target?: Unit } {
    const value = this.expression();
    let target: Unit | undefined;
    if (this.tokens[this.index]?.kind === 'conversion') {
      this.index += 1;
      const token = this.take();
      if (token?.kind !== 'unit' || value.unit === undefined) throw new InvalidCalculation();
      target = token.value;
    }
    if (this.index !== this.tokens.length) throw new InvalidCalculation();
    return { ...value, target };
  }
  private expression(): { value: number; unit?: Unit } {
    let left = this.product();
    while (this.op('+') || this.op('-')) {
      const operator = (this.take() as { value: Operator }).value;
      const right = this.product();
      if (left.unit !== right.unit) throw new InvalidCalculation();
      left = { value: checked(operator === '+' ? left.value + right.value : left.value - right.value), unit: left.unit };
    }
    return left;
  }
  private product(): { value: number; unit?: Unit } {
    let left = this.unary();
    while (this.op('*') || this.op('/') || this.op('%')) {
      const operator = (this.take() as { value: Operator }).value;
      const right = this.unary();
      if (left.unit || right.unit) throw new InvalidCalculation();
      if ((operator === '/' || operator === '%') && right.value === 0) throw new InvalidCalculation();
      left = { value: checked(operator === '*' ? left.value * right.value : operator === '/' ? left.value / right.value : left.value % right.value) };
    }
    return left;
  }
  private unary(): { value: number; unit?: Unit } {
    const token = this.tokens[this.index];
    if (token?.kind === 'operator' && (token.value === '+' || token.value === '-')) {
      this.index += 1;
      this.depth += 1;
      if (this.depth > MAX_DEPTH) throw new InvalidCalculation();
      const operand = this.unary();
      this.depth -= 1;
      return { value: checked(token.value === '-' ? -operand.value : operand.value), unit: operand.unit };
    }
    return this.primary();
  }
  private primary(): { value: number; unit?: Unit } {
    const token = this.take();
    let value: { value: number; unit?: Unit };
    if (token?.kind === 'number') value = { value: token.value };
    else if (token?.kind === 'open') {
      this.depth += 1;
      if (this.depth > MAX_DEPTH) throw new InvalidCalculation();
      value = this.expression();
      this.depth -= 1;
      if (this.take()?.kind !== 'close') throw new InvalidCalculation();
    } else throw new InvalidCalculation();
    const suffix = this.tokens[this.index];
    if (suffix?.kind === 'unit') {
      if (value.unit !== undefined) throw new InvalidCalculation();
      this.index += 1;
      value.unit = suffix.value;
    }
    return value;
  }
  private op(operator: Operator): boolean {
    const token = this.tokens[this.index];
    return token?.kind === 'operator' && token.value === operator;
  }
  private take(): Token | undefined { return this.tokens[this.index++]; }
}
function convert(value: number, from: Unit, to: Unit, remBase: number): number {
  if (families[from] !== families[to]) throw new InvalidCalculation();
  if (from === to) return value;
  const family = families[from];
  if (family === 'length') {
    const px = checked(from === 'rem' ? value * remBase : value);
    return checked(to === 'rem' ? px / remBase : px);
  }
  if (family === 'data') {
    const mb = checked(from === 'GB' ? value * 1000 : value);
    return checked(to === 'GB' ? mb / 1000 : mb);
  }
  if (family === 'temperature') return checked(from === 'C' ? value * 9 / 5 + 32 : (value - 32) * 5 / 9);
  const km = checked(from === 'mi' ? value * 1.609344 : value);
  return checked(to === 'mi' ? km / 1.609344 : km);
}
export function evaluateCommandCalculation(query: string, options: CalculationOptions = {}): CommandCalculation | null {
  if (typeof query !== 'string') return null;
  const expression = query.trim().replace(/\s+/g, ' ');
  const remBase = options.remBase ?? 16;
  if (!Number.isFinite(remBase) || remBase <= 0 || remBase > MAX_MAGNITUDE) return null;
  try {
    const parsed = new Parser(tokenize(expression)).parse();
    const value = parsed.target ? convert(parsed.value, parsed.unit!, parsed.target, remBase) : checked(parsed.value);
    const formatted = String(Number(value.toPrecision(12)));
    const result = parsed.target || parsed.unit ? `${formatted} ${parsed.target ?? parsed.unit}` : formatted;
    return { expression, result, copyText: result };
  } catch (error) {
    if (error instanceof InvalidCalculation) return null;
    throw error;
  }
}
