import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../../shared/cloud/App";
import { ErrorBoundary } from "../../shared/error-boundary";
import { RenderFailure } from "../../shared/cloud/RenderFailure";
import "./index.css";

createRoot(document.getElementById("root")!).render(<StrictMode><ErrorBoundary fallback={<RenderFailure />}><div className="cloud-portal"><App /></div></ErrorBoundary></StrictMode>);
