// Development-only acceptance page: actual renderer, deterministic native asset response.
import ReactDOM from "react-dom/client";
import { Content, Markdown } from "../../src/Content";
import type { Snapshot } from "../../src/api";
import "../../src/index.css";
import fixture from "./expected.json";
const visual = fixture.visualElements[0];
const bytes = await fetch(`./resources/${visual.imageRef.objectKey}`).then(r => r.arrayBuffer());
window.practiq = {
  request: async input => {
    const request = input as {type: string; hash: string};
    if (request.type !== "asset" || request.hash !== visual.imageRef.sha256) return {ok:false,error:{code:"OPERATION_FAILED",message:"Unexpected native request"}};
    return {ok:true,value:bytes};
  },
  close: async () => {}, onCloseRequested: () => () => {},
};
const snapshot = {question: fixture.questions[0], groups: [], sources: [], warnings: [], missingAssets: false, visuals: [{...visual, id: "visual", questionIds: ["q"]}]} as unknown as Snapshot;
ReactDOM.createRoot(document.getElementById("root")!).render(<main style={{maxWidth: 1000, margin: "24px auto", padding: 24}}><h1>Rich content acceptance fixture</h1><Content snapshot={snapshot}/><Markdown>{fixture.questions[0].analysis}</Markdown><p>Answer: The supplied determinant is -2.</p></main>);
