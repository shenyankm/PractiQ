import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "./i18n";
import App from "./App";
import { initializeTheme } from "./theme";
import "./index.css";
const initialTheme = initializeTheme();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider><App initialTheme={initialTheme} /></I18nProvider>
  </React.StrictMode>,
);
