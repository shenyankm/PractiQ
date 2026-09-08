import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ci from "miniprogram-ci";

const taroRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectPath = resolve(taroRoot, "dist");
const packageJson = JSON.parse(await readFile(resolve(taroRoot, "package.json"), "utf8"));

const appid = required("TARO_APP_ID");
const privateKeyPath = resolve(required("WECHAT_CI_PRIVATE_KEY_PATH"));
const version = process.env.WECHAT_CI_VERSION?.trim() || packageJson.version;
const desc = process.env.WECHAT_CI_DESC?.trim() || `PractiQ ${version}`;
const robot = Number(process.env.WECHAT_CI_ROBOT || "1");

if (!Number.isInteger(robot) || robot < 1 || robot > 30) {
  throw new Error("WECHAT_CI_ROBOT must be an integer from 1 to 30");
}

await access(privateKeyPath, constants.R_OK);
await access(resolve(projectPath, "project.config.json"), constants.R_OK);

const projectConfig = JSON.parse(
  await readFile(resolve(projectPath, "project.config.json"), "utf8"),
);
if (projectConfig.appid !== appid) {
  throw new Error("dist/project.config.json AppID does not match TARO_APP_ID");
}

const project = new ci.Project({
  appid,
  type: "miniProgram",
  projectPath,
  privateKeyPath,
  ignores: ["node_modules/**/*"],
});

const result = await ci.upload({
  project,
  version,
  desc,
  robot,
  setting: {
    es6: true,
    es7: true,
    minify: true,
    minifyJS: true,
    minifyWXML: true,
    minifyWXSS: true,
    codeProtect: false,
    autoPrefixWXSS: true,
  },
  onProgressUpdate: ({ message, status }) => {
    if (message) console.log(`[wechat-ci:${status ?? "progress"}] ${message}`);
  },
});

console.log(`Uploaded WeChat Mini Program ${version} with robot ${robot}.`);
if (result?.subPackageInfo) console.log(JSON.stringify(result.subPackageInfo, null, 2));

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
