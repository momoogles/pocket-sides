import "./styles.css";

// 埋め込み画面では、台本の読み取りや端末内の保存領域を初期化しません。
if (window.self === window.top) {
  void import("./main");
} else {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("アプリの表示領域が見つかりません。");

  const main = document.createElement("main");
  main.className = "narrow-page";
  const heading = document.createElement("h1");
  heading.textContent = "アプリを直接開いてください";
  const description = document.createElement("p");
  description.textContent =
    "台本を安全に扱うため、埋め込み画面では利用できません。";
  const link = document.createElement("a");
  link.href = import.meta.env.BASE_URL;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "おぼえる台本を新しいタブで開く";
  main.append(heading, description, link);
  root.replaceChildren(main);
}
