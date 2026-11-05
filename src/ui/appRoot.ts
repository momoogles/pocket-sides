// The app element owns the UI shell and the currently opened PDF workspace.

import type { AppElement } from "../appElement";

const foundRoot = document.querySelector<AppElement>("#app");

if (!foundRoot) throw new Error("アプリの表示領域が見つかりません。");

export const appRoot: AppElement = foundRoot;
export const appState = appRoot.appState;
