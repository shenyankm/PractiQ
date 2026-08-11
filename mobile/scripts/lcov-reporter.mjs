// node:test custom reporter: emits LCOV from --experimental-test-coverage data
// (node >= 23 removed the built-in lcov reporter).
export default async function* lcovReporter(source) {
  const files = new Map();
  for await (const event of source) {
    if (event.type !== 'test:coverage') continue;
    for (const file of event.data.summary.files) {
      files.set(file.path, file);
    }
  }
  for (const file of files.values()) {
    yield `SF:${file.path}\n`;
    for (const line of file.lines) {
      yield `DA:${line.line},${line.count}\n`;
    }
    yield 'end_of_record\n';
  }
}
