import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "../../shared/error-boundary";
import { RenderFailure } from "./RenderFailure";
import Purchase from "./Purchase";
import "./index.css";

createRoot(document.getElementById("root")!).render(<StrictMode><ErrorBoundary fallback={<RenderFailure />}>{location.pathname === "/purchase" ? <Purchase /> : <App />}</ErrorBoundary></StrictMode>);
