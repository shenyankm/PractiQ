import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type UserConfigExport } from "@tarojs/cli";
import { createStyleImportPlugin } from "vite-plugin-style-import";

const apiUrl = process.env.TARO_APP_API_URL?.trim();
const appId = process.env.TARO_APP_ID?.trim() || "touristappid";

if (process.env.NODE_ENV === "production" && (!apiUrl || !apiUrl.startsWith("https://"))) {
  throw new Error("Production WeChat builds require an HTTPS TARO_APP_API_URL");
}

export default defineConfig<"vite">({
  projectName: "PractiQ",
  designWidth: 750,
  deviceRatio: {
    375: 2,
    750: 1,
  },
  sourceRoot: "src",
  outputRoot: "dist",
  framework: "react",
  compiler: {
    type: "vite",
    vitePlugins: [
      createStyleImportPlugin({
        libs: [
          {
            libraryName: "@taroify/core",
            esModule: true,
            resolveStyle: (name: string) => `@taroify/core/${name}/style/index.js`,
            ensureStyleFile: true,
          },
          {
            libraryName: "@taroify/icons",
            esModule: true,
            resolveStyle: () => "@taroify/icons/style",
          },
        ],
      }),
    ],
  },
  cache: { enable: false },
  defineConstants: {
    __PRACTIQ_API_URL__: JSON.stringify(apiUrl ?? ""),
  },
  onBuildFinish: async ({ error }: { error?: unknown }) => {
    if (error) return;
    await writeFile(
      resolve(process.cwd(), "dist/project.config.json"),
      `${JSON.stringify(
        {
          miniprogramRoot: "./",
          projectname: "practiq-taro",
          description: "PractiQ Taro client",
          appid: appId,
          setting: {
            urlCheck: true,
            es6: false,
            enhance: false,
            compileHotReLoad: false,
            postcss: false,
            minified: false,
          },
          compileType: "miniprogram",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  },
  mini: {
    postcss: {
      pxtransform: { enable: true },
      cssModules: { enable: false },
    },
  },
  h5: {
    esnextModules: ["@taroify"],
  },
} satisfies UserConfigExport<"vite">);
