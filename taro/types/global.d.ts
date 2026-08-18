/// <reference types="@tarojs/taro" />

declare module "*.css";

declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV: "development" | "production";
    TARO_ENV: "weapp";
    TARO_APP_API_URL?: string;
  }
}
