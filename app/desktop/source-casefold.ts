import data from "./source-casefold.json" with { type: "json" };

// Freeze the reference runtime's Unicode folding; Node versions can use different Unicode data.
const mapping: Record<string, string> = data.mapping;
export const sourceCasefold = (value: string): string => [...value].map(char => mapping[char] ?? char).join("");
