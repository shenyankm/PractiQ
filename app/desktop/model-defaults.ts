import { contractSource } from "./contract-source.js";

/** Compare parsed-model values with the same declared defaults as the reference runtime. */
export function modelDefaults(name: string, value: unknown): Record<string, unknown> {
  const defaults = Object.fromEntries(Object.entries(contractSource.definitions[name].properties ?? {}).filter(([, schema]) => Object.hasOwn(schema, "default")).map(([key, schema]) => [key, structuredClone(schema.default)]));
  return { ...defaults, ...Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, value]) => value !== undefined)) };
}

export function parsedQuestionDefaults(question: unknown): Record<string, unknown> {
  const value = modelDefaults("ParsedQuestion", question);
  for (const [field, name] of [["options", "ParsedOption"], ["items", "ParsedItem"], ["contentBlocks", "ContentBlock"], ["passage", "ContentBlock"], ["transcript", "ContentBlock"]]) if (Array.isArray(value[field])) value[field] = (value[field] as unknown[]).map(item => modelDefaults(name, item));
  return value;
}

/** Compact model fields only; arbitrary JSON payloads keep their nulls and empty arrays. */
export function compactModel(name: string, value: Record<string, unknown>): Record<string, unknown> {
  const schema = contractSource.definitions[name], result: Record<string, unknown> = {};
  for (const [field, property] of Object.entries(schema.properties ?? {})) {
    const child = value[field]; if (child == null || Object.hasOwn(property, "default") && child === property.default) continue;
    if (Array.isArray(child) && !child.length && (name === "ParsedQuestion" || property.type === "array" && !Object.hasOwn(property, "default") && !schema.required?.includes(field))) continue;
    const candidates = [property, ...property.anyOf ?? []], model = candidates.some(node => node.additionalProperties === true) ? undefined : candidates.find(node => node.$ref && contractSource.definitions[node.$ref.split("/").at(-1)!]?.properties), itemModel = property.items?.$ref?.split("/").at(-1);
    result[field] = model ? compactModel(model.$ref!.split("/").at(-1)!, child as Record<string, unknown>) : Array.isArray(child) && itemModel && contractSource.definitions[itemModel]?.properties ? child.map(item => compactModel(itemModel, item)) : child;
  }
  return result;
}
