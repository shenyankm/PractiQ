import { Button, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import { apiClient } from "../api";
import { createApi } from "../api/modules";
import { sessionStore } from "./session";
import { PageValidation, viewAccess } from "./view-access";

export function usePageClient() {
  const generation = sessionStore.getGeneration();
  return useMemo(() => apiClient.scoped(generation), [generation]);
}
export function usePageApi() {
  const client = usePageClient();
  return useMemo(() => createApi(client), [client]);
}

const PageVisible = createContext(false);
export const usePageVisible = (): boolean => useContext(PageVisible);

type Loader = () => Promise<unknown>;
const Loaders = createContext<(loader: Loader) => () => void>(
  () => () => undefined,
);

// Called on first mount and every foreground return, including file chooser/payment returns.
export function usePageLoad(loader: Loader): void {
  const register = useContext(Loaders);
  const latest = useRef(loader);
  latest.current = loader;
  useEffect(() => register(() => latest.current()), [register]);
}

export function protectedPage(Content: ComponentType): () => JSX.Element {
  return function ProtectedPage(): JSX.Element {
    const session = useSyncExternalStore(
      sessionStore.subscribe,
      sessionStore.getSnapshot,
    );
    const generation = sessionStore.getGeneration();
    const loaders = useRef(new Set<Loader>());
    const gate = useRef(new PageValidation());
    const active = useRef(true);
    const [visible, setVisible] = useState(false);
    const [mounted, setMounted] = useState(true);
    const [cycle, setCycle] = useState(0);
    const [error, setError] = useState(false);
    const register = useMemo(
      () => (loader: Loader) => {
        loaders.current.add(loader);
        return () => {
          loaders.current.delete(loader);
        };
      },
      [],
    );
    const hide = () => {
      gate.current.hide();
      setVisible(false);
    };
    const retry = () => {
      hide();
      setError(false);
      setMounted(true);
      setCycle((value) => value + 1);
    };
    Taro.useDidHide(() => {
      active.current = false;
      viewAccess.invalidate("suspend");
      hide();
    });
    Taro.useDidShow(() => {
      active.current = true;
      viewAccess.invalidate("revalidate");
    });
    useEffect(
      () =>
        viewAccess.subscribe((event) => {
          hide();
          if (event === "permission" || event === "session") setMounted(false);
          if (event === "permission" || event === "offline") setError(true);
          if (event === "revalidate" && active.current) retry();
        }),
      [],
    );
    useEffect(() => {
      if (!session) {
        hide();
        void Taro.reLaunch({ url: "/pages/login/index" });
        return;
      }
      if (!mounted || !active.current) return;
      const epoch = viewAccess.readEpoch();
      const current = () =>
        active.current &&
        sessionStore.getGeneration() === generation &&
        viewAccess.readEpoch() === epoch;
      void gate.current
        .validate(async () => {
          const user = await apiClient.getCurrentUser();
          if (!current()) throw new Error("View changed");
          sessionStore.updateUser(user);
          await Promise.all([...loaders.current].map((load) => load()));
        }, current)
        .then((allowed) => {
          if (current()) {
            setVisible(allowed);
            setError(!allowed);
          }
        });
      return () => {
        gate.current.hide();
      };
    }, [cycle, generation, mounted, Boolean(session)]);
    if (!session) return <View />;
    return (
      <PageVisible.Provider value={visible}>
        <Loaders.Provider value={register}>
          {/* Keep only same-account in-memory drafts across ordinary hide; no interaction before online validation. */}
          {mounted ? (
            <View style={{ display: visible ? "block" : "none" }}>
              <Content key={generation} />
            </View>
          ) : null}
          {visible ? null : (
            <View className="page-shell">
              <Text>
                {error
                  ? "内容不可访问或网络不可用，旧内容已隐藏。"
                  : "正在联网验证访问权限…"}
              </Text>
              {error ? <Button onClick={retry}>重新验证</Button> : null}
            </View>
          )}
        </Loaders.Provider>
      </PageVisible.Provider>
    );
  };
}
