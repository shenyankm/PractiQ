import { parseJson } from "./document-contract.js";
import { invariant } from "./errors.js";
import { sourceSpace, sourceTrim } from "./source-text.js";
import { contractSource, type Schema } from "./contract-source.js";

/** Repair punctuation only; never invent values or finish a truncated string. */
export function parseModelJson(source: string, schema?: Schema): unknown {
  try { return parseAiJson(source, schema); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  source = sourceTrim(source);
  if (source.startsWith("```json\n") && source.endsWith("```")) source = sourceTrim(source.slice(8, -3));
  else if (source.startsWith("```\n") && source.endsWith("```")) source = sourceTrim(source.slice(4, -3));
  const stack: string[] = [], output: string[] = []; let quoted = false, escaped = false;
  for (const char of source) {
    if (quoted) {
      output.push(char);
      if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{" || char === "[") { stack.push(char === "{" ? "}" : "]"); invariant(stack.length <= 128, "AI_RESPONSE_INVALID", "Provider JSON nesting exceeds its limit"); }
    else if (char === "}" || char === "]") {
      if (!stack.length && char === (output[0] === "{" ? "}" : output[0] === "[" ? "]" : "")) continue;
      invariant(stack.length && stack.pop() === char, "AI_RESPONSE_INVALID", "Provider JSON has mismatched closing brackets");
      while (output.length && sourceSpace(output.at(-1)!)) output.pop();
      if (output.at(-1) === ",") {
        output.pop(); let last = output.length - 1; while (last >= 0 && sourceSpace(output[last])) last--;
        invariant(!["{", "["].includes(output[last]), "AI_RESPONSE_INVALID", "Provider JSON has a missing value");
      }
    }
    output.push(char);
  }
  invariant(!quoted, "AI_RESPONSE_INVALID", "Provider JSON has an unfinished string");
  return parseAiJson(output.join("") + stack.reverse().join(""), schema);
}

export function parseAiJson(source: string, schema?: Schema): unknown {
  invariant(!/[\ud800-\udfff]/u.test(source), "AI_RESPONSE_INVALID", "Provider JSON contains invalid Unicode");
  const value = parseJson(Buffer.from(source)); let position = 0;
  const whitespace = () => { while (/\s/.test(source[position] ?? "") && position < source.length) position++; };
  function string(): string {
    const start = position++;
    while (position < source.length) { const char = source[position++]; if (char === "\\") position++; else if (char === '"') break; }
    return JSON.parse(source.slice(start, position));
  }
  function expand(nodes: Schema[], seen = new Set<string>()): Schema[] {
    return nodes.flatMap(node => {
      if (node.$ref) {
        invariant(!seen.has(node.$ref), "LOCAL_SCHEMA_INVALID", "Recursive scalar schema", { path: node.$ref, detail: "Recursive scalar schema" }); const name = node.$ref.split("/").at(-1)!, target = (schema?.$defs as Record<string, Schema> | undefined)?.[name] ?? contractSource.definitions[name]; invariant(target, "LOCAL_SCHEMA_INVALID", "Missing local model schema", { path: node.$ref, detail: "Missing local model schema" });
        // Audio/artifact references retain Pydantic's non-strict byte-count coercion.
        const resolved = ["AudioReference", "ArtifactReference"].includes(name) ? { ...target, properties: { ...target.properties, sizeBytes: { ...target.properties!.sizeBytes, type: "number" } } } : target;
        return expand([resolved], new Set([...seen, node.$ref]));
      }
      return node.anyOf || node.oneOf ? expand(node.anyOf ?? node.oneOf!, seen) : [node];
    });
  }
  function scan(depth: number, nodes: Schema[] = [], current: unknown = value): void {
    invariant(depth <= 128, "AI_RESPONSE_INVALID", "Provider JSON nesting exceeds its limit"); whitespace();
    const char = source[position++];
    if (char === "{" || char === "[") {
      const end = char === "{" ? "}" : "]", keys = new Set<string>(), candidates = expand(nodes); let index = 0; whitespace();
      if (source[position] === end) { position++; return; }
      for (;;) {
        let children = candidates.flatMap(node => node.items ? [node.items] : []), child = Array.isArray(current) ? current[index++] : undefined;
        if (char === "{") {
          whitespace(); const key = string(); invariant(!keys.has(key), "AI_RESPONSE_INVALID", "Provider JSON contains a duplicate key"); keys.add(key); whitespace(); position++;
          const owner = current as Record<string, unknown>; child = owner[key]; children = candidates.flatMap(node => node.properties?.[key] ? [node.properties[key]] : typeof node.additionalProperties === "object" ? [node.additionalProperties] : node.additionalProperties === true || !node.type ? [{}] : []);
          // ParsedQuestion exposes JSON answer payloads; its declared mode owns typed answer indexes.
          const answerSchema = owner.answerMode === "ordering" ? "OrderingAnswerPayload" : owner.answerMode === "matching" ? "MatchingAnswerPayload" : null;
          if (key === "answerPayload" && answerSchema && candidates.some(node => node.properties?.answerMode)) children = [contractSource.definitions[answerSchema]];
        }
        scan(depth + 1, children, child); whitespace(); if (source[position++] === end) return;
      }
    }
    if (char === '"') { position--; string(); return; }
    const start = position - 1; while (position < source.length && !/[,}\]\s]/.test(source[position])) position++;
    const token = source.slice(start, position), numeric = expand(nodes).filter(node => !node.type || node.type === "integer" || node.type === "number");
    // JavaScript loses the distinction between 1 and 1.0; check before trusting model integers.
    if (/^-?\d/.test(token) && /[.eE]/.test(token) && numeric.length && numeric.every(node => node.type === "integer" && node.const === undefined && node.enum === undefined)) invariant(false, "AI_RESPONSE_INVALID", "Model integer fields require literal integer JSON tokens");
  }
  scan(0, schema ? [schema] : []); return value;
}
