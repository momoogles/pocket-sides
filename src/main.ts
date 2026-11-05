// Vite entry point: install styles, connect the app, and start it.
import "@fontsource/ibm-plex-sans-jp/latin-400.css";
import "@fontsource/ibm-plex-sans-jp/latin-500.css";
import "@fontsource/ibm-plex-sans-jp/latin-ext-400.css";
import "@fontsource/ibm-plex-sans-jp/latin-ext-500.css";
import "@fontsource/ibm-plex-sans-jp/japanese-400.css";
import "@fontsource/ibm-plex-sans-jp/japanese-500.css";
import "./styles.css";
import { bindAppEvents } from "./ui/appEvents";
import { appRoot as root } from "./ui/appRoot";
import { bindRenderLifetime, renderApp } from "./ui/renderApp";
import { bindAnalysisContext } from "./ui/screens/analysis/context";
import { bindAppearancesContext } from "./ui/screens/appearances/context";
import { bindHomeContext } from "./ui/screens/home/context";
import { refreshSavedPracticeList } from "./ui/screens/practice/practiceHistory";

root.onAppConnected((signal) => {
  bindRenderLifetime(signal);
  bindAppEvents(signal);
  bindHomeContext(signal);
  bindAnalysisContext(signal);
  bindAppearancesContext(signal);
  renderApp();
  void refreshSavedPracticeList();
});
