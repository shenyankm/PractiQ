export interface SourceJson { value: unknown; floatTokens: boolean; unsafeIntegers: boolean; scalarNumber: string | null }

/** Trusted source text uses Python JSON constants; model/wire JSON stays strict. */
export function parseSourceJson(source: string): SourceJson {
  let position = 0, floatTokens = false, unsafeIntegers = false, scalarNumber: string | null = null; const replacements: [number, number][] = [];
  const whitespace = () => { while (/[ \t\r\n]/u.test(source[position] ?? "")) position++; };
  const string = () => { const start = position++; while (position < source.length) { const char = source[position++]; if (char === "\\") position++; else if (char === '"') break; } return JSON.parse(source.slice(start, position)) as string; };
  function scan(depth: number): void {
    if (depth > 1000) throw new Error("Source JSON nesting limit"); whitespace(); const char = source[position++];
    if (char === "{" || char === "[") {
      const end = char === "{" ? "}" : "]", keys = new Set<string>(); whitespace(); if (source[position] === end) { position++; return; }
      while (position <= source.length) { if (char === "{") { whitespace(); const key = string(); if (keys.has(key)) throw new Error("Duplicate source JSON key"); keys.add(key); whitespace(); position++; } scan(depth + 1); whitespace(); if (source[position++] === end) return; } throw new Error("Invalid source JSON");
    }
    if (char === '"') { position--; string(); return; }
    const start = position - 1; while (position < source.length && !/[,}\]\s]/u.test(source[position])) position++;
    const token = source.slice(start, position), constant = ["NaN", "Infinity", "-Infinity"].includes(token);
    if (constant) replacements.push([start, position]);
    if (constant || /^-?\d/u.test(token)) {
      const fractional = constant || /[.eE]/u.test(token); floatTokens ||= fractional;
      if (!fractional) { if (token.replace("-", "").length > 4300) throw new Error("Source integer exceeds reference runtime limit"); unsafeIntegers ||= !Number.isSafeInteger(Number(token)); }
      if (depth === 0) scalarNumber = token;
    }
  }
  scan(0); let normalized = source; for (const [start, end] of replacements.reverse()) normalized = normalized.slice(0, start) + "0" + normalized.slice(end);
  const value = JSON.parse(normalized); return { value, floatTokens, unsafeIntegers, scalarNumber };
}

/** Python's scalar string distinguishes integral floats and scientific notation. */
export function sourceNumberString(token: string): string {
  if (!/[.eE]/u.test(token) && !["NaN", "Infinity", "-Infinity"].includes(token)) return BigInt(token).toString();
  const value = Number(token); if (Number.isNaN(value)) return "nan"; if (!Number.isFinite(value)) return value < 0 ? "-inf" : "inf"; if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const [mantissa, power] = value.toExponential().split("e"), exponent = Number(power);
  if (exponent < -4 || exponent >= 16) return `${mantissa}e${exponent < 0 ? "-" : "+"}${Math.abs(exponent).toString().padStart(2, "0")}`;
  const rendered = value.toString(); return rendered.includes(".") ? rendered : rendered + ".0";
}
