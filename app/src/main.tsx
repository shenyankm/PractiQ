import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "./i18n";
import App from "./App";
import { ErrorBoundary } from "../../shared/error-boundary";
import { RenderFailure } from "./RenderFailure";
import { initializeTheme } from "./theme";
import "./index.css";
if (import.meta.env.DEV && import.meta.env.MODE === "design-preview") {
  document.title = "PractiQ · 主题预览（示例数据）";
}
const PreviewControls = import.meta.env.DEV && import.meta.env.MODE !== "test" && import.meta.env.MODE !== "design-preview" ? React.lazy(() => import("./PreviewControls")) : null;
const initialTheme = initializeTheme();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary fallback={<RenderFailure />}><I18nProvider><App initialTheme={initialTheme} />{PreviewControls && <React.Suspense fallback={null}><PreviewControls /></React.Suspense>}</I18nProvider></ErrorBoundary>
  </React.StrictMode>,
);
