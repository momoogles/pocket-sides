import "./styles.css";
import { registerAppElement } from "./appElement";

if (window.self === window.top) {
  startApplication();
} else {
  showOpenAppInNewTabNotice();
}

function startApplication(): void {
  registerAppElement();
  void import("./main");
}

function showOpenAppInNewTabNotice(): void {
  const appRoot = document.querySelector<HTMLElement>("#app");
  if (!appRoot) throw new Error("アプリの表示領域が見つかりません。");

  const noticePage = document.createElement("main");
  noticePage.className = "narrow-page";
  const title = document.createElement("h1");
  title.textContent = "アプリを直接開いてください";
  const explanation = document.createElement("p");
  explanation.textContent =
    "台本を安全に扱うため、埋め込み画面では利用できません。";
  const openAppLink = document.createElement("a");
  openAppLink.href = import.meta.env.BASE_URL;
  openAppLink.target = "_blank";
  openAppLink.rel = "noopener noreferrer";
  openAppLink.textContent = "おぼえる台本を新しいタブで開く";
  noticePage.append(title, explanation, openAppLink);
  appRoot.replaceChildren(noticePage);
}
