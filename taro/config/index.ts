import { defineConfig, type UserConfigExport } from "@tarojs/cli";

export default defineConfig<"webpack5">({
  projectName: "PractiQ",
  designWidth: 750,
  deviceRatio: {
    375: 2,
    750: 1,
  },
  sourceRoot: "src",
  outputRoot: "dist",
  framework: "react",
  compiler: "webpack5",
  cache: { enable: false },
  mini: {
    postcss: {
      pxtransform: { enable: true },
      cssModules: { enable: false },
    },
  },
} satisfies UserConfigExport<"webpack5">);
