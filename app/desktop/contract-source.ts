import source from "../../shared/ai-contracts.json" with { type: "json" };

export interface Schema {
  $ref?: string; const?: unknown; enum?: unknown[]; anyOf?: Schema[]; oneOf?: Schema[];
  type?: string; items?: Schema; properties?: Record<string, Schema>; required?: string[];
  additionalProperties?: boolean | Schema; [key: string]: unknown;
}
export const contractSource = source as unknown as {
  definitions: Record<string, Schema>; wireModels: string[]; exports: Record<string, string>;
  metadata: { questionKindModes: Record<string, string>; documentSourceTypes: string[]; officeModes: string[];
    importSourceTypes: string[]; compositeModes: string[]; filterModes: string[] };
};

/** Resolve only repository-owned definitions, never remote schema URLs. */
export function schemaFor(name: string): Schema {
  const root = Object.hasOwn(contractSource.definitions, name) ? contractSource.definitions[name] : undefined;
  if (!root) throw new Error(`Unknown contract: ${name}`);
  const referenced = new Set<string>();
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if ("$ref" in value) {
      const ref = value.$ref;
      if (typeof ref !== "string" || !/^#\/\$defs\/[A-Za-z][A-Za-z0-9]*$/.test(ref)) throw new Error("Unsupported schema reference");
      const dependency = ref.split("/").at(-1)!;
      if (!Object.hasOwn(contractSource.definitions, dependency)) throw new Error("Missing schema definition");
      if (!referenced.has(dependency)) { referenced.add(dependency); visit(contractSource.definitions[dependency]); }
    }
    for (const nested of Object.values(value)) visit(nested);
  }
  visit(root);
  return referenced.size ? { $defs: Object.fromEntries([...referenced].sort().map(key => [key, contractSource.definitions[key]])), ...root } : { ...root };
}
