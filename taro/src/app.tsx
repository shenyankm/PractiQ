import { useEffect, type PropsWithChildren } from "react";
import Taro from "@tarojs/taro";
import { viewAccess } from "./auth/view-access";
import "./app.css";

export default function App({ children }: PropsWithChildren): JSX.Element {
  Taro.useDidHide(() => viewAccess.invalidate("suspend"));
  Taro.useDidShow(() => viewAccess.invalidate("revalidate"));
  useEffect(() => {
    const changed = ({ isConnected }: { isConnected: boolean }) => viewAccess.invalidate(isConnected ? "revalidate" : "offline");
    Taro.onNetworkStatusChange(changed);
    return () => Taro.offNetworkStatusChange(changed);
  }, []);
  return <>{children}</>;
}
