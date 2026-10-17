import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "../../shared/error-boundary";
import { RenderFailure } from "./RenderFailure";
import "./index.css";

createRoot(document.getElementById("root")!).render(<StrictMode><ErrorBoundary fallback={<RenderFailure />}><App /></ErrorBoundary></StrictMode>);
