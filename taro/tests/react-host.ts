import type { ReactNode } from "react";

interface HostNode { type: string; props: Record<string, unknown>; children: HostNode[]; text?: string }
interface Renderer {
  createContainer(...args: unknown[]): unknown;
  updateContainer(node: ReactNode, root: unknown, parent: null, callback: () => void): void;
  flushPassiveEffects(): boolean;
}
// Use the reconciler already shipped with Taro; no DOM, extra dependency or native service.
const reconciler = require("react-reconciler") as (config: Record<string, unknown>) => Renderer;
export function reactHost() {
  const container: HostNode = { type: "root", props: {}, children: [] };
  const append = (parent: HostNode, child: HostNode) => { parent.children = parent.children.filter((value) => value !== child); parent.children.push(child); };
  const remove = (parent: HostNode, child: HostNode) => { parent.children = parent.children.filter((value) => value !== child); };
  const insert = (parent: HostNode, child: HostNode, before: HostNode) => { remove(parent, child); parent.children.splice(parent.children.indexOf(before), 0, child); };
  const renderer = reconciler({
    now: Date.now, supportsMutation: true, isPrimaryRenderer: true, supportsPersistence: false, supportsHydration: false,
    getRootHostContext: () => ({}), getChildHostContext: () => ({}), getPublicInstance: (node: HostNode) => node,
    prepareForCommit: () => null, resetAfterCommit: () => undefined, shouldSetTextContent: () => false,
    createInstance: (type: string, props: Record<string, unknown>) => ({ type, props, children: [] }),
    createTextInstance: (text: string) => ({ type: "text", text, props: {}, children: [] }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove,
    insertBefore: insert, insertInContainerBefore: insert,
    finalizeInitialChildren: () => false, prepareUpdate: (_node: HostNode, _type: string, _old: unknown, props: unknown) => props,
    commitUpdate: (node: HostNode, props: Record<string, unknown>) => { node.props = props; },
    commitTextUpdate: (node: HostNode, _old: string, text: string) => { node.text = text; },
    clearContainer: (node: HostNode) => { node.children = []; }, detachDeletedInstance: () => undefined,
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1,
    supportsMicrotasks: true, scheduleMicrotask: queueMicrotask, getCurrentEventPriority: () => 16,
  });
  const root = renderer.createContainer(container, 0, null, false, null, "", (error: unknown) => { throw error; }, null);
  const walk = (node: HostNode): string => (node.props.style as { display?: string } | undefined)?.display === "none" ? "" : (node.text ?? "") + node.children.map(walk).join("");
  return {
    render: (node: ReactNode) => renderer.updateContainer(node, root, null, () => undefined),
    text: () => walk(container),
    nodes(type: string) { const visit = (node: HostNode): HostNode[] => [...(node.type === type ? [node] : []), ...node.children.flatMap(visit)]; return visit(container); },
    async flush() { for (let i = 0; i < 50; i++) { renderer.flushPassiveEffects(); await Promise.resolve(); } },
    clickRetry() { const visit = (node: HostNode): HostNode | undefined => node.type === "Button" ? node : node.children.map(visit).find(Boolean); const button = visit(container); (button?.props.onClick as (() => void) | undefined)?.(); },
  };
}
