import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const designPreview = import.meta.env.DEV && import.meta.env.MODE === "design-preview";
if (designPreview) {
  document.title = "PractiQ · 温暖紫色主题预览（示例数据）";
  document.documentElement.classList.toggle("dark", new URLSearchParams(location.search).get("theme") === "dark");
}
createRoot(document.getElementById("root")!).render(<StrictMode>{designPreview && <aside className="design-preview-notice" role="status">主题预览 · 模拟数据。使用 preview-only 连接；上传、解析、导出和删除均已隔离。</aside>}<App /></StrictMode>);
