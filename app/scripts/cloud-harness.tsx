// Development-only browser harness; not an application build input.
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Portal from "../../shared/cloud/App";
import "../src/index.css";
import "../../shared/cloud/style.css";

function Harness() {
  const [settingsOnly, setSettingsOnly] = useState(location.hash === "#settings");
  const flush = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    const change = () => setSettingsOnly(location.hash === "#settings");
    Object.assign(window, {navigateHarness: async (page: string) => {
      if (!document.dispatchEvent(new Event("practiq-cloud-before-leave", {cancelable:true}))) return;
      try { await flush.current(); location.hash = page; } catch { /* Keep invalid or unsaved settings visible. */ }
    }});
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  return <div className="cloud-portal"><Portal settingsOnly={settingsOnly} flushRef={flush}/></div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Harness/></StrictMode>);
