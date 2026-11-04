// Vite entry point: install styles, connect the app, and start it.
import "@fontsource/ibm-plex-sans-jp/latin-400.css";
import "@fontsource/ibm-plex-sans-jp/latin-500.css";
import "@fontsource/ibm-plex-sans-jp/latin-ext-400.css";
import "@fontsource/ibm-plex-sans-jp/latin-ext-500.css";
import "@fontsource/ibm-plex-sans-jp/japanese-400.css";
import "@fontsource/ibm-plex-sans-jp/japanese-500.css";
import "./styles.css";
import { refreshSavedPracticeList } from "./app/actions";
import { bindAppEvents } from "./app/events";
import { renderApp } from "./ui/render";

bindAppEvents();
renderApp();

void refreshSavedPracticeList();
