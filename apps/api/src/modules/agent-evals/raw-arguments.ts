/** Reject ambiguous native JSON before parsed fields can hide earlier keys. */
export function validRawToolArguments(value: unknown, args: Record<string, unknown>): boolean {
  let raw: string;
  try {
    if (typeof value === "string") raw = value;
    else if (value && typeof value === "object" && !Array.isArray(value)) raw = JSON.stringify(value);
    else return false;
  } catch { return false; }
  if (raw.length > 262144) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const objects: Set<string>[] = [];
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '{') { objects.push(new Set()); continue; }
    if (char === '}') { objects.pop(); continue; }
    if (char !== '"') continue;
    const start = i;
    for (++i; i < raw.length; i++) {
      if (raw[i] === '\\') { i++; continue; }
      if (raw[i] === '"') break;
    }
    let next = i + 1;
    while (next < raw.length && /\s/.test(raw[next]!)) next++;
    if (raw[next] !== ':') continue;
    const keys = objects.at(-1);
    const key: string = JSON.parse(raw.slice(start, i + 1));
    if (!keys || keys.has(key)) return false;
    keys.add(key);
  }
  const stable = (value: unknown, depth = 0): string => {
    if (depth > 64) throw new Error('Tool argument nesting exceeds the contract.');
    if (Array.isArray(value)) return '[' + value.map(item => stable(item, depth + 1)).join(',') + ']';
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + stable(record[key], depth + 1)).join(',') + '}';
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Tool argument value is not JSON.");
    return encoded;
  };
  try { return stable(parsed) === stable(args); } catch { return false; }
}
