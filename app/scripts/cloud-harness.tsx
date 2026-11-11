// Development-only browser harness; not an application build input.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Portal from "../../shared/cloud/App";
import "../src/index.css";
import "../../shared/cloud/style.css";
createRoot(document.getElementById("root")!).render(<StrictMode><div className="cloud-portal"><Portal/></div></StrictMode>);
