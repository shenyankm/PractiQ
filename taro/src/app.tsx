import type { PropsWithChildren } from "react";
import "./app.css";

export default function App({ children }: PropsWithChildren): JSX.Element {
  return <>{children}</>;
}
