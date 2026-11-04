// The single DOM root owned by the UI layer.

const foundRoot = document.querySelector<HTMLDivElement>("#app");

if (!foundRoot) throw new Error("アプリの表示領域が見つかりません。");

export const root: HTMLDivElement = foundRoot;
