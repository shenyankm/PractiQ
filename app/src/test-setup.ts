if (typeof navigator !== "undefined") {
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["zh-CN"] });
}

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  });
}
