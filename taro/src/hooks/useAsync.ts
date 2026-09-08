import { useCallback, useEffect, useRef, useState } from "react";

export type AsyncPhase = "idle" | "loading" | "ready" | "error";

export interface AsyncState<T> {
  phase: AsyncPhase;
  data: T | null;
  error: string | null;
}

export function useAsync<T>(loader: () => Promise<T>, message: (error: unknown) => string, immediate = true) {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const sequence = useRef(0);
  const [state, setState] = useState<AsyncState<T>>({ phase: "idle", data: null, error: null });

  const run = useCallback(async (): Promise<T | null> => {
    const current = ++sequence.current;
    setState((previous) => ({ phase: "loading", data: previous.data, error: null }));
    try {
      const data = await loaderRef.current();
      if (current === sequence.current) setState({ phase: "ready", data, error: null });
      return data;
    } catch (error) {
      if (current === sequence.current) setState((previous) => ({ phase: "error", data: previous.data, error: message(error) }));
      return null;
    }
  }, [message]);

  useEffect(() => {
    if (immediate) void run();
    return () => { sequence.current += 1; };
  }, [immediate, run]);

  return { ...state, run, setData: (data: T) => setState({ phase: "ready", data, error: null }) };
}
