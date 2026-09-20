// Development-only acceptance page: actual renderer, deterministic native asset response.
import ReactDOM from "react-dom/client";
import { Content, Markdown } from "../../src/Content";
import type { Snapshot } from "../../src/api";
import "../../src/index.css";
import fixture from "./expected.json";
const visual = fixture.visualElements[0];
const bytes = await fetch(`./resources/${visual.imageRef.objectKey}`).then(r => r.arrayBuffer());
const data = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.readAsDataURL(new Blob([bytes], {type: visual.imageRef.mediaType})); });
Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (_: string, args: {request: {type: string; hash: string}}) => {
  if (args.request.type !== "asset" || args.request.hash !== visual.imageRef.sha256) throw Error("Unexpected native request");
  return data;
}}});
const snapshot = {question: fixture.questions[0], groups: [], sources: [], warnings: [], missingAssets: false, visuals: [{...visual, id: "visual", questionIds: ["q"]}]} as unknown as Snapshot;
ReactDOM.createRoot(document.getElementById("root")!).render(<main style={{maxWidth: 1000, margin: "24px auto", padding: 24}}><h1>Rich content acceptance fixture</h1><Content snapshot={snapshot}/><Markdown>{fixture.questions[0].analysis}</Markdown><p>Answer: The supplied determinant is -2.</p></main>);
