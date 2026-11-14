import assert from "node:assert/strict";
import { containedFile, digest, object, publicReport, readBytes, strictJson } from "./release-data.ts";

const limit = 16 * 1024 * 1024;
const paths = ["app/.build/reports/desktop.xml", "coverage/desktop/coverage-summary.json", "coverage/desktop/cobertura-coverage.xml", "coverage/desktop/lcov.info"];
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

export async function publicXml(text: string, rootName: string, roots: [string, string][] = []) {
  const { SaxesParser } = await import("saxes"), parser = new SaxesParser({ xmlns: false });
  const parts: string[] = [], elements: { name: string; attributes: Record<string, string> }[] = []; let depth = 0;
  parser.on("doctype", value => assert.ok(rootName === "coverage" && /^\s*coverage SYSTEM "http:\/\/cobertura\.sourceforge\.net\/xml\/coverage-04\.dtd"\s*$/.test(value), "Unexpected report DTD"));
  parser.on("processinginstruction", () => assert.fail("Unexpected report processing instruction"));
  parser.on("opentag", tag => {
    assert.ok(++depth <= 128, "Report XML is too deep"); if (elements.length === 0) assert.equal(tag.name, rootName, "Unexpected report root");
    const attributes = tag.attributes as Record<string, string>; elements.push({ name: tag.name, attributes });
    // Hostnames identify CI machines and are unnecessary in public verification evidence.
    parts.push(`<${tag.name}${Object.entries(attributes).map(([name, value]) => ` ${name}="${escape(name === "hostname" ? "<host>" : publicReport(value, roots))}"`).join("")}${tag.isSelfClosing ? "/" : ""}>`);
  });
  parser.on("closetag", tag => { depth--; if (!tag.isSelfClosing) parts.push(`</${tag.name}>`); });
  parser.on("text", value => parts.push(escape(publicReport(value, roots))));
  parser.on("cdata", value => parts.push(escape(publicReport(value, roots))));
  parser.write(text).close(); assert.ok(elements.length > 0); return { bytes: Buffer.from(parts.join("")), elements };
}

function count(value: unknown): number { assert.ok(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), "Invalid XML report count"); const number = Number(value); assert.ok(Number.isSafeInteger(number)); return number; }
export async function readAiReports(folder: string, roots: [string, string][] = []) {
  const raw = Object.fromEntries(paths.map(path => [path, readBytes(containedFile(folder, path), limit)]));
  const decode = (path: string) => new TextDecoder("utf-8", { fatal: true }).decode(raw[path]);
  const summary = object(strictJson(raw[paths[1]])), total = object(summary.total);
  for (const [name, threshold] of [["statements", 90], ["lines", 90], ["functions", 90], ["branches", 85]] as const) {
    const metric = object(total[name]);
    assert.ok(Number.isSafeInteger(metric.total) && metric.total > 0 && Number.isSafeInteger(metric.covered) && metric.covered >= 0 && metric.covered <= metric.total, "Invalid coverage counts");
    assert.ok(typeof metric.pct === "number" && Number.isFinite(metric.pct) && Math.abs(metric.pct - metric.covered / metric.total * 100) < 0.011 && metric.pct >= threshold, `Required ${name} coverage failed`);
  }
  const junit = await publicXml(decode(paths[0]), "testsuites", roots), tests = count(junit.elements[0].attributes.tests);
  assert.ok(tests > 0); assert.equal(junit.elements.filter(tag => tag.name === "testcase").length, tests, "JUnit test count differs from its cases");
  for (const tag of junit.elements) {
    assert.ok(!["failure", "error"].includes(tag.name), "Failed JUnit evidence");
    if (["testsuites", "testsuite"].includes(tag.name)) for (const key of ["failures", "errors"]) assert.equal(count(tag.attributes[key]), 0, "Failed JUnit evidence");
  }
  assert.ok(junit.elements.filter(tag => tag.name === "skipped").length < tests, "JUnit contains no executed tests");
  const cobertura = await publicXml(decode(paths[2]), "coverage", roots), coverage = cobertura.elements[0].attributes;
  for (const [prefix, metric] of [["line", "lines"], ["branch", "branches"]]) {
    const plural = prefix === "line" ? "lines" : "branches";
    assert.equal(count(coverage[`${plural}-valid`]), total[metric].total); assert.equal(count(coverage[`${plural}-covered`]), total[metric].covered);
    assert.ok(Math.abs(Number(coverage[`${prefix}-rate`]) - total[metric].covered / total[metric].total) < 0.00011, "Coverage XML differs from its JSON summary");
  }
  const lcov = decode(paths[3]), files = lcov.split("\n").filter(line => line.startsWith("SF:")); assert.ok(files.length > 0);
  for (const [key, metric, field] of [["LF", "lines", "total"], ["LH", "lines", "covered"], ["FNF", "functions", "total"], ["FNH", "functions", "covered"], ["BRF", "branches", "total"], ["BRH", "branches", "covered"]]) {
    const values = lcov.split("\n").filter(line => line.startsWith(`${key}:`)).map(line => count(line.slice(key.length + 1))); assert.equal(values.length, files.length); assert.equal(values.reduce((sum, value) => sum + value, 0), total[metric][field], "LCOV differs from its JSON summary");
  }
  const relativeSource = (value: string) => value.replace(/^.*[/\\]app[/\\]desktop[/\\]/, "app/desktop/");
  const publicSummary = Object.fromEntries(Object.entries(summary).map(([key, value]) => [relativeSource(key), value])); assert.equal(Object.keys(publicSummary).length, Object.keys(summary).length, "Coverage paths collide");
  const cleaned = [junit.bytes, Buffer.from(JSON.stringify(publicReport(publicSummary, roots), null, 2) + "\n"), cobertura.bytes, Buffer.from(lcov.split("\n").map(line => line.startsWith("SF:") ? `SF:${publicReport(relativeSource(line.slice(3)), roots)}` : publicReport(line, roots)).join("\n"))];
  return paths.map((path, index) => ({ name: `embedded-ai/${path}`, data: cleaned[index], sourceSha256: digest(raw[path]) }));
}
