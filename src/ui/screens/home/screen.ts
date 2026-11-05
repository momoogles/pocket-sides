import { appState as state } from "../../appRoot";
import { escapeHtml } from "../../shared/escapeHtml";
import styles from "./styles.module.css";

export function renderHome(): string {
  const practiceFingerprints = new Set(
    state.savedPractices.map((reading) => reading.fingerprint),
  );
  const recentItems = [
    ...state.savedPractices.map((reading) => ({
      ...reading,
      kind: "practice" as const,
    })),
    ...state.legacySavedReadings
      .filter((reading) => !practiceFingerprints.has(reading.fingerprint))
      .map((reading) => ({
        ...reading,
        roleLabel: "",
        kind: "reading" as const,
      })),
  ].sort((a, b) => b.savedAt - a.savedAt);
  return `
    <main class="${styles.root}">
      <div class="home-grid">
        <section class="hero-copy">
          <h1><span>台本を開いて、</span><span>シーンごとに練習しよう</span></h1>
          <p class="hero-lead">前のセリフやト書きを読みながら、自分のセリフを思い出して答え合わせできます。</p>
        </section>
        <div class="upload-card" id="drop-zone">
          <p class="upload-label">台本PDFを開く</p>
          <p class="upload-description">「PDFを選ぶ」を押すか、ここに台本PDFをドロップしてください。</p>
          <input class="visually-hidden" type="file" id="pdf-input" accept="application/pdf,.pdf" />
          <button class="primary-button choose-button" data-action="choose-pdf">PDFを選ぶ</button>
          <p class="privacy-note">PDFはこの端末内で読み取り、サーバーには送信しません。練習を始めると、読み取り結果と練習設定をこの端末内にのみ保存します。</p>
        </div>
      </div>

      <section class="steps-strip" aria-labelledby="steps-heading">
        <h2 id="steps-heading">使い方</h2>
        <ol class="home-steps">
          <li>台本PDFを選ぶと、文字をブラウザ内で読み取ります。</li>
          <li>文字、読み順、セリフの区切り、役名を元のPDFと見比べ、必要に応じて直します。</li>
          <li>役を選び、「練習を始める」を押します。</li>
          <li>練習シーンを選び、前のセリフやト書きを読みます。</li>
          <li>自分のセリフを声に出してから「答えを確認する」を押します。自分のセリフの原文と次のセリフが表示されます。</li>
        </ol>
      </section>

      ${
        recentItems.length > 0
          ? `<section class="recent-practices" aria-labelledby="saved-readings-heading">
        <div class="recent-practices-heading"><h2 id="saved-readings-heading">最近おぼえようとした台本</h2><button class="text-button" data-action="delete-all-saved-practices" aria-label="保存した練習設定と読み取り結果をすべて削除">すべて削除</button></div>
        <ul class="recent-practices-list">${recentItems.map((reading) => `<li class="recent-practices-item"><span><strong>${escapeHtml(reading.fileName || "ファイル名未登録")}</strong><small>${reading.kind === "practice" ? `練習する役：${escapeHtml(reading.roleLabel)} · ${reading.pageCount}ページ` : `${reading.pageCount}ページ · 練習設定は未保存`}</small></span><div class="recent-practices-actions"><button class="${reading.kind === "practice" ? "primary-button" : "secondary-button"}" data-action="${reading.kind === "practice" ? "resume-saved-practice" : "open-saved-reading"}" data-fingerprint="${escapeHtml(reading.fingerprint)}">${reading.kind === "practice" ? "PDFを選んで練習を再開する" : "PDFを選んで設定を作る"}</button><button class="text-button" data-action="delete-saved-practice-from-home" data-fingerprint="${escapeHtml(reading.fingerprint)}">削除</button></div></li>`).join("")}</ul>
      </section>`
          : ""
      }

    </main>
    <footer class="${styles.footer}">
      <a href="${import.meta.env.BASE_URL}licenses.html">利用・保存とライセンス</a>
    </footer>`;
}
