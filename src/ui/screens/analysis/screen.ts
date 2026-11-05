import {
  applyCharacterCorrections,
  findUnusualCharacters,
} from "../../../pdf/characterCorrections";
import {
  isOcrRecognizedPage,
  mergeRecognizedPage,
} from "../../../pdf/ocrReconciliation";
import type { PdfWorkspaceState } from "../../../pdf/pdfWorkspace";
import { cueAtStart } from "../../../pdf/quoteMarkers";
import type { RoleCandidate } from "../../../pdf/roleCandidate";
import {
  blockPosition,
  hasEnoughText,
  isCastListEntry,
} from "../../../pdf/sourceBlocks";
import type { SourceBlock, SourcePage } from "../../../pdf/sourcePage";
import type { SpeakerTurn } from "../../../pdf/speakerTurn";
import { appRoot as root } from "../../appRoot";
import { blockRangePosition } from "../../shared/blockRangePosition";
import {
  blocks,
  getOcrReconciliationContext,
  getRecoveredOpeningMarkers,
  inferredMarkerCorrections,
  rawBlocks,
  usableRoleCandidates,
} from "../../shared/correctedScriptBlocks";
import { escapeHtml } from "../../shared/escapeHtml";
import { renderStepHeader } from "../../shared/renderStepHeader";
import { renderScriptBlocks } from "../../shared/scriptContent";
import { selectedRole } from "../../shared/scriptRoles";
import { turns } from "../../shared/scriptTurns";
import styles from "./styles.module.css";

export function renderAnalysisScreen(
  renderBoundaryEditor: () => string,
): string {
  const textBlocks = blocks();
  const characterCount = textBlocks.reduce(
    (sum, block) => sum + block.text.length,
    0,
  );
  const allGlyphs = findUnusualCharacters(rawBlocks(), {
    ...inferredMarkerCorrections(),
    ...root.pdfWorkspace.script.corrections,
  });
  const ocrPageCount =
    root.pdfWorkspace.script.pages.filter(isOcrRecognizedPage).length;
  const currentPage =
    root.pdfWorkspace.script.pages[root.pdfWorkspace.analysis.previewPage - 1];
  const foundTurns = turns();
  const selectedTurnCount = foundTurns.filter(
    (turn) => turn.roleId === root.pdfWorkspace.script.selectedRoleId,
  ).length;
  const enoughText = hasEnoughText(textBlocks);
  const blocksById = new Map(textBlocks.map((block) => [block.id, block]));
  const frequentRoles = root.pdfWorkspace.script.roles.filter(
    (role) => role.manual || role.occurrenceCount >= 2,
  );
  const occasionalRoles = root.pdfWorkspace.script.roles.filter(
    (role) => !role.manual && role.occurrenceCount < 2,
  );
  const canContinue = Boolean(
    root.pdfWorkspace.script.selectedRoleId &&
      selectedTurnCount > 0 &&
      !root.pdfWorkspace.analysis.ocrBusy &&
      !root.pdfWorkspace.analysis.layoutPreview &&
      !root.pdfWorkspace.analysis.textOcrPreview &&
      !root.pdfWorkspace.practice.practiceSaveBusy,
  );

  return `
    <main class="work-page ${styles.root}">
      ${renderStepHeader("読み取り結果を確認する", "元のPDFと見比べて文字や区切りを直し、練習する役を選びます。")}
      <section class="file-summary-panel">
        <div class="file-summary-copy"><span class="small-label">開いている台本</span><strong>${escapeHtml(root.pdfWorkspace.file.fileName)}</strong><p>練習を始めると、読み取り結果と練習設定をこの端末内にのみ保存します。サーバーには送信しません。</p></div>
        <div class="file-summary-stats"><span>${root.pdfWorkspace.script.pages.length}ページ</span><span>${characterCount.toLocaleString("ja-JP")}文字</span></div>
      </section>

      ${!enoughText ? `<div class="alert alert-warning notice-box" role="alert"><strong>PDFから文字を読み取れませんでした。</strong><p>「文字の置換」の画像解析で、読めなかった文字を補えます。</p></div>` : ""}

      ${renderReadingWarning(allGlyphs, ocrPageCount)}

      <section class="panel source-review-panel" id="source-review">
        <div class="panel-heading"><div><h2>元のPDFと読み取り結果</h2><p>ページを切り替えて、対応する箇所を見比べられます。</p></div></div>
        <div class="source-toolbar">
          <div class="page-navigation" aria-label="PDFのページ移動">
            <button class="secondary-button page-step-button" data-action="previous-preview-page" aria-label="前のページ" title="前のページ" ${root.pdfWorkspace.analysis.previewPage <= 1 ? "disabled" : ""}><span aria-hidden="true">←</span></button>
            <label class="select-field"><span>表示するページ</span><select class="select-input" id="preview-page-select">${root.pdfWorkspace.script.pages.map((page) => `<option value="${page.pageNumber}" ${page.pageNumber === root.pdfWorkspace.analysis.previewPage ? "selected" : ""}>${page.pageNumber}ページ目</option>`).join("")}</select></label>
            <button class="secondary-button page-step-button" data-action="next-preview-page" aria-label="次のページ" title="次のページ" ${root.pdfWorkspace.analysis.previewPage >= root.pdfWorkspace.script.pages.length ? "disabled" : ""}><span aria-hidden="true">→</span></button>
          </div>
          <div class="zoom-controls"><button class="zoom-button secondary-button" data-action="zoom-out" aria-label="元のPDFを縮小">−</button><span>${Math.round(root.pdfWorkspace.analysis.previewZoom * 100)}%</span><button class="zoom-button secondary-button" data-action="zoom-in" aria-label="元のPDFを拡大">＋</button></div>
        </div>
        <div class="source-compare-grid">
          <div class="pdf-preview-card"><span class="preview-label">元のPDF</span><div class="pdf-canvas-scroll"><canvas id="page-canvas" aria-label="元のPDFのページ"></canvas></div></div>
          <div class="extracted-page-card"><span class="preview-label">読み取り結果</span><div class="extracted-lines">${renderPageBlocks(root.pdfWorkspace.analysis.previewPage)}</div></div>
        </div>
        ${
          currentPage && isOcrRecognizedPage(currentPage)
            ? `
          <div class="image-analysis-actions">
            <button class="text-button" data-action="restore-preview-page-text" ${root.pdfWorkspace.analysis.ocrBusy || root.pdfWorkspace.analysis.layoutPreview ? "disabled" : ""}>このページをPDFからの読み取り結果に戻す</button>
          </div>`
            : ""
        }
        <p class="panel-footnote">セリフは発話ごとにまとめ、位置はページ番号と列・行の番号で示します。</p>
      </section>

      ${renderCorrectionPanel(findUnusualCharacters(rawBlocks(), inferredMarkerCorrections()))}
      ${renderLayoutAdjustment(renderBoundaryEditor)}

      <section class="panel role-panel">
        <div class="panel-heading">
          <div><span class="small-label">自分の役を選ぶ</span><h2>役名の候補</h2><p>候補から練習する役を選びます。同じ役の別表記を登録したり、見つからなかった役を追加したりできます。</p></div>
          <span class="count-pill">候補 ${root.pdfWorkspace.script.roles.length}件</span>
        </div>
        ${frequentRoles.length > 0 ? `<div class="role-grid">${frequentRoles.map((role) => renderRoleCard(role, foundTurns, blocksById)).join("")}</div>` : `<div class="empty-state"><strong>2回以上見つかった役名はありません</strong><p>1回だけ見つかった役名を確認するか、役名を追加してください。「区切りの調整」でセリフに役を指定できます。</p></div>`}
        ${occasionalRoles.length > 0 ? `<details class="occasional-role-details"><summary>1回だけ見つかった役名を確認する（${occasionalRoles.length}件）</summary><p>セリフの一部を役名として読み取っている場合があります。元のPDFと見比べて選んでください。</p><div class="role-grid">${occasionalRoles.map((role) => renderRoleCard(role, foundTurns, blocksById)).join("")}</div></details>` : ""}

        <details class="manual-role-details">
          <summary>見つからない役を追加する</summary>
          <div class="manual-role-form">
            <label>画面に表示する役名<input class="text-input" id="new-role-label" type="text" placeholder="例：役名" maxlength="24" /></label>
            <label>台本での役名<input class="text-input" id="new-role-alias" type="text" placeholder="同じ名前でよければ空欄で構いません" maxlength="48" /></label>
            <button class="secondary-button" data-action="add-role">役名を追加</button>
          </div>
        </details>
      </section>

      <div class="sticky-action-bar">
        <p>${root.pdfWorkspace.script.selectedRoleId ? (selectedTurnCount > 0 ? `「${escapeHtml(selectedRole()?.label ?? "")}」のセリフを ${selectedTurnCount}件見つけました。` : `「${escapeHtml(selectedRole()?.label ?? "")}」のセリフを見つけられませんでした。「区切りの調整」で、セリフが始まる位置と役を指定してください。`) : "練習する役を選んでください。"}</p>
        <button class="primary-button" data-action="continue-to-appearances" ${!canContinue || root.pdfWorkspace.practice.practiceSaveBusy ? "disabled" : ""}>${root.pdfWorkspace.practice.practiceHasStarted ? "練習を再開する" : "練習を始める"}</button>
      </div>
    </main>`;
}

function renderReadingWarning(
  glyphs: ReturnType<typeof findUnusualCharacters>,
  ocrPageCount: number,
): string {
  if (glyphs.length === 0 && ocrPageCount === 0) return "";
  const occurrenceCount = glyphs.reduce((sum, entry) => sum + entry.count, 0);
  return `
    <section class="alert alert-warning correction-warning" role="alert" aria-labelledby="correction-warning-heading">
      <h2 id="correction-warning-heading" class="correction-warning-title">読み取り結果を確認してください</h2>
      <p class="correction-warning-description">${glyphs.length > 0 ? `${occurrenceCount.toLocaleString("ja-JP")}か所に、元のPDFと異なる文字が含まれている可能性があります。` : "画像解析で読み直したページがあります。読み順や役名を元のPDFと見比べてください。"}</p>
    </section>`;
}

function renderImageAnalysisProgress(
  purpose: PdfWorkspaceState["analysis"]["ocrPurpose"],
): string {
  return root.pdfWorkspace.analysis.ocrBusy &&
    root.pdfWorkspace.analysis.ocrPurpose === purpose
    ? `
    <div class="image-analysis-progress" role="status">
      <p id="image-analysis-progress-label" aria-live="polite">${escapeHtml(root.pdfWorkspace.analysis.ocrStatus || "画像解析の準備をしています")}</p>
      <div class="image-analysis-progress-meter">
        <div class="progress-shell" role="progressbar" aria-label="画像解析の進捗" aria-valuemin="0" aria-valuemax="${root.pdfWorkspace.analysis.ocrTotal}" aria-valuenow="${root.pdfWorkspace.analysis.ocrProgress}">
          <div class="progress-bar" id="image-analysis-progress-bar" style="width:${root.pdfWorkspace.analysis.ocrTotal ? Math.round((root.pdfWorkspace.analysis.ocrProgress / root.pdfWorkspace.analysis.ocrTotal) * 100) : 0}%"></div>
        </div>
        <span id="image-analysis-progress-count" aria-hidden="true">処理済み ${root.pdfWorkspace.analysis.ocrProgress} / ${root.pdfWorkspace.analysis.ocrTotal}ページ</span>
      </div>
      <button class="text-button" data-action="cancel-ocr">画像解析を中止する</button>
    </div>`
    : "";
}

function renderLayoutAdjustment(renderBoundaryEditor: () => string): string {
  const previews = root.pdfWorkspace.analysis.layoutPreview;
  const preview =
    previews?.find(
      (page) => page.pageNumber === root.pdfWorkspace.analysis.previewPage,
    ) ?? previews?.[0];
  return `
    <section class="panel layout-adjustment-panel" aria-labelledby="layout-adjustment-heading">
      <div class="panel-heading"><div><h2 id="layout-adjustment-heading">区切りの調整</h2><p>セリフを分ける位置や、話す役を調整します。</p></div></div>
      <div class="image-analysis-section">
        <h3 class="adjustment-mode-title"><span>おすすめ</span>画像解析して調整する</h3>
        <p class="panel-footnote">全ページを画像解析し、読み順やセリフの区切りを判定し直します。</p>
        <div class="image-analysis-actions">
          <button class="secondary-button" data-action="preview-ocr-layout" ${root.pdfWorkspace.analysis.ocrBusy || preview || root.pdfWorkspace.analysis.ocrAnalysisComplete ? "disabled" : ""}>${root.pdfWorkspace.analysis.ocrAnalysisComplete ? "画像解析は完了しました" : "画像解析する"}</button>
          ${root.pdfWorkspace.analysis.ocrAnalysisComplete && !preview ? `<button class="text-button" data-action="preview-ocr-layout" ${root.pdfWorkspace.analysis.ocrBusy ? "disabled" : ""}>解析結果を確認する</button>` : ""}
        </div>
        <p class="panel-footnote">画像解析はこの端末内で行い、PDFや読み取り結果をサーバーに送信しません。</p>
        ${renderImageAnalysisProgress("layout")}
        ${
          preview && previews
            ? `
          <div class="layout-ocr-preview">
            <h3>画像解析の結果（${previews.length}ページ）</h3>
            <label class="select-field"><span>表示するページ</span><select class="select-input" id="layout-ocr-page-select">${previews
              .map(
                (page) =>
                  `<option value="${page.pageNumber}" ${page === preview ? "selected" : ""}>${page.pageNumber}ページ目</option>`,
              )
              .join("")}</select></label>
            <p>元のPDFと見比べ、読み順や役名を確認してから適用してください。</p>
            <div class="layout-preview-lines">${renderPageBlocks(preview.pageNumber, preview)}</div>
            ${root.pdfWorkspace.script.boundaryEdits.length ? "<p>結果を適用したページでは、手動で変更した区切りが解除されます。</p>" : ""}
            ${Object.keys(root.pdfWorkspace.practice.ranges).length ? "<p>適用すると、調整した練習範囲が初期設定に戻ります。</p>" : ""}
            <div class="image-analysis-actions">
              <button class="primary-button" data-action="apply-ocr-layout" ${root.pdfWorkspace.analysis.ocrBusy ? "disabled" : ""}>結果を適用する（${previews.length}ページ）</button>
              <button class="text-button" data-action="discard-ocr-layout">適用せずに閉じる</button>
            </div>
          </div>`
            : ""
        }
        ${root.pdfWorkspace.analysis.ocrErrors.layout ? `<div class="alert alert-warning image-analysis-error" role="alert">${escapeHtml(root.pdfWorkspace.analysis.ocrErrors.layout)}</div>` : ""}
      </div>
      <details id="manual-boundary-editor" class="manual-adjustment">
        <summary>手動で調整する</summary>
        ${renderBoundaryEditor()}
      </details>
    </section>`;
}

function renderTextOcrPreview(): string {
  const preview = root.pdfWorkspace.analysis.textOcrPreview;
  if (!preview) return "";
  const sourcePage = root.pdfWorkspace.script.pages.find(
    (page) => page.pageNumber === root.pdfWorkspace.analysis.previewPage,
  );
  const recognized =
    preview.pages.find((page) => page.pageNumber === sourcePage?.pageNumber) ??
    preview.pages[0];
  const source = root.pdfWorkspace.script.pages.find(
    (page) => page.pageNumber === recognized?.pageNumber,
  );
  if (!recognized || !source) return "";
  const corrections = {
    ...preview.corrections,
    ...root.pdfWorkspace.script.corrections,
  };
  const merged = mergeRecognizedPage(
    source,
    recognized,
    getOcrReconciliationContext(),
    undefined,
    corrections,
  );
  const displayed = {
    ...merged,
    blocks: applyCharacterCorrections(merged.blocks, corrections),
  };
  return `
    <div class="layout-ocr-preview">
      <h3>画像解析の結果（${preview.pages.length}ページ）</h3>
      <label class="select-field"><span>表示するページ</span><select class="select-input" id="text-ocr-page-select">${preview.pages
        .map(
          (page) =>
            `<option value="${page.pageNumber}" ${page.pageNumber === recognized.pageNumber ? "selected" : ""}>${page.pageNumber}ページ目</option>`,
        )
        .join("")}</select></label>
      <p>上の読み取り結果と見比べてから適用してください。</p>
      <div class="layout-preview-lines">${renderPageBlocks(displayed.pageNumber, displayed)}</div>
      ${Object.keys(root.pdfWorkspace.practice.ranges).length ? "<p>適用すると、調整した練習範囲が初期設定に戻ります。</p>" : ""}
      <div class="image-analysis-actions">
        <button class="primary-button" data-action="apply-ocr-text" ${root.pdfWorkspace.analysis.ocrBusy ? "disabled" : ""}>結果を適用する（${preview.pages.length}ページ）</button>
        <button class="text-button" data-action="discard-ocr-text">適用せずに閉じる</button>
      </div>
    </div>`;
}

function renderCorrectionPanel(
  glyphs: ReturnType<typeof findUnusualCharacters>,
): string {
  const unresolved = glyphs.filter(
    (entry) => !root.pdfWorkspace.script.corrections[entry.character]?.trim(),
  ).length;
  const savedCorrectionCount = Object.values(
    root.pdfWorkspace.practice.savedPractice?.settings.corrections ?? {},
  ).filter((value) => value.trim()).length;
  const glyphRows = glyphs
    .map((entry) => {
      const block = rawBlocks().find(
        (item) => item.id === entry.exampleBlockId,
      );
      return `<article class="glyph-row"><div class="glyph-sample"><span class="glyph-character">${escapeHtml(entry.character)}</span><span class="glyph-count">${entry.count.toLocaleString("ja-JP")}回</span></div><div class="glyph-context"><span class="small-label">${entry.examplePage}ページ目の例</span><p>${escapeHtml(entry.example)}</p><button class="text-button" data-action="preview-block" data-block-id="${escapeHtml(entry.exampleBlockId)}">${block ? escapeHtml(blockPosition(block)) : `${entry.examplePage}ページ目`}を元のPDFで見る</button></div><label class="glyph-replacement">正しい文字<input class="text-input" type="text" maxlength="8" data-correction-char="${escapeHtml(entry.character)}" value="${escapeHtml(root.pdfWorkspace.script.corrections[entry.character] ?? "")}" placeholder="PDFを見て入力" /></label></article>`;
    })
    .join("");
  return `
      <section class="panel glyph-panel" aria-labelledby="glyph-panel-heading">
        <div class="panel-heading"><div><h2 id="glyph-panel-heading">文字の置換</h2><p>文字化けや、誤って読み取られた文字を置き換えます。</p></div>${glyphs.length > 0 ? `<span class="count-pill">${glyphs.length}種類 · 未設定 ${unresolved}種類</span>` : ""}</div>
        <div class="image-analysis-section">
          <h3 class="adjustment-mode-title"><span>おすすめ</span>画像解析して置換する</h3>
          <p class="panel-footnote">全ページを画像解析し、文字化けや読み取れなかった箇所を補います。</p>
          <div class="image-analysis-actions">
            <button class="secondary-button" data-action="read-with-ocr" ${root.pdfWorkspace.analysis.ocrBusy || root.pdfWorkspace.analysis.textOcrPreview || root.pdfWorkspace.analysis.textOcrCompletion || root.pdfWorkspace.analysis.ocrAnalysisComplete ? "disabled" : ""}>${root.pdfWorkspace.analysis.ocrAnalysisComplete ? "画像解析は完了しました" : "画像解析する"}</button>
            ${root.pdfWorkspace.analysis.ocrAnalysisComplete && !root.pdfWorkspace.analysis.textOcrPreview && !root.pdfWorkspace.analysis.textOcrCompletion ? `<button class="text-button" data-action="read-with-ocr" ${root.pdfWorkspace.analysis.ocrBusy ? "disabled" : ""}>解析結果を確認する</button>` : ""}
            ${root.pdfWorkspace.script.cachedOcrPages.length > 0 ? `<button class="text-button" data-action="use-previous-image-analysis" ${root.pdfWorkspace.analysis.ocrBusy || root.pdfWorkspace.analysis.layoutPreview ? "disabled" : ""}>前回の画像解析結果を適用する（${root.pdfWorkspace.script.cachedOcrPages.length}ページ）</button>` : ""}
          </div>
          <p class="panel-footnote">画像解析はこの端末内で行い、PDFや読み取り結果をサーバーに送信しません。</p>
          ${renderImageAnalysisProgress("text")}
          ${renderTextOcrPreview()}
          ${
            root.pdfWorkspace.analysis.textOcrCompletion
              ? `
            <div class="image-analysis-completion" role="status">
              <strong>画像解析の結果を適用しました</strong>
              <p>${root.pdfWorkspace.analysis.textOcrCompletion.pageCount}ページの解析結果を適用しました。${root.pdfWorkspace.analysis.textOcrCompletion.replacedPages > 0 ? `${root.pdfWorkspace.analysis.textOcrCompletion.replacedPages}ページの文字を置換しました。` : "置換した文字はありません。"}</p>
            </div>`
              : ""
          }
          ${root.pdfWorkspace.analysis.ocrErrors.text ? `<div class="alert alert-warning image-analysis-error" role="alert">${escapeHtml(root.pdfWorkspace.analysis.ocrErrors.text)}</div>` : ""}
        </div>
        <details id="manual-glyph-editor" class="manual-adjustment">
          <summary>手動で調整する</summary>
        ${savedCorrectionCount > 0 ? `<div class="saved-corrections-option"><p>前回の文字の置換（${savedCorrectionCount}種類）</p><button class="text-button" data-action="restore-saved-corrections">前回の文字の置換を適用する</button></div>` : ""}
        ${glyphs.length > 0 ? `<div class="glyph-list">${glyphRows}</div><p class="glyph-footnote">元のPDFと見比べ、正しい文字を入力してください。入力内容は読み取り結果と練習画面に反映されます。</p>` : `<p class="glyph-empty-state">手動で置換する候補はありません。</p>`}
        </details>
      </section>
  `;
}

function renderRoleCard(
  role: RoleCandidate,
  allTurns: SpeakerTurn[],
  blocksById: Map<string, SourceBlock>,
): string {
  const count = allTurns.filter((turn) => turn.roleId === role.id).length;
  const example = role.exampleBlockIds
    .map((id) => blocksById.get(id))
    .filter((block): block is SourceBlock => Boolean(block))
    .slice(0, 2);
  const selected = root.pdfWorkspace.script.selectedRoleId === role.id;
  const evidenceLabel = role.manual
    ? "手動で追加"
    : role.evidence === "layout"
      ? "文字の配置から検出"
      : role.evidence === "recovered"
        ? "役名の表記を要確認"
        : "役名と記号から検出";
  return `
    <article class="role-card ${selected ? "role-card-selected" : ""}">
      <div class="role-card-top"><span class="role-badge">${evidenceLabel}${role.manual ? "" : ` · ${role.occurrenceCount}回`}</span><button class="secondary-button small-button remove-role-button" data-action="remove-role" data-role-id="${escapeHtml(role.id)}">候補から外す</button></div>
      <label class="field-label">画面に表示する役名<input class="text-input" type="text" data-role-label="${escapeHtml(role.id)}" value="${escapeHtml(role.label)}" maxlength="24" /></label>
      <label class="field-label">台本での役名（複数の表記は「、」で区切る）<input class="text-input" type="text" data-role-aliases="${escapeHtml(role.id)}" value="${escapeHtml(role.aliases.join("、"))}" maxlength="120" /></label>
      <div class="role-card-meta"><span>セリフ <strong>${count}件</strong></span>${example[0] ? `<button class="text-button" data-action="preview-block" data-block-id="${escapeHtml(example[0].id)}">元のPDFで例を見る · ${escapeHtml(blockPosition(example[0]))}</button>` : ""}</div>
      ${example.length > 1 ? `<p class="role-example">例：${escapeHtml(example[1].text.slice(0, 52))}${example[1].text.length > 52 ? "…" : ""}</p>` : ""}
      <button class="role-select-button ${selected ? "primary-button" : "secondary-button"}" data-action="select-role" data-role-id="${escapeHtml(role.id)}" aria-pressed="${selected}">${selected ? "選択中" : "この役を選ぶ"}</button>
    </article>`;
}

function renderPageBlocks(pageNumber: number, preview?: SourcePage): string {
  const page =
    preview ??
    root.pdfWorkspace.script.pages.find(
      (candidate) => candidate.pageNumber === pageNumber,
    );
  if (!page || page.blocks.length === 0)
    return `<p class="muted-copy">このページから文字を読み取れませんでした。</p>`;
  const sourceNote =
    !preview && isOcrRecognizedPage(page)
      ? `<p class="image-analysis-page-note">画像解析の結果を含みます。元のPDFと見比べてください。</p>`
      : "";
  const allBlocks = preview?.blocks ?? blocks();
  const pageBlocks = allBlocks.filter(
    (block) => block.pageNumber === pageNumber,
  );
  const blockIndexById = new Map(
    allBlocks.map((block, index) => [block.id, index]),
  );
  const turnByBlockId = new Map<string, SpeakerTurn>();
  const turnStartsByBlockId = new Set<string>();
  for (const turn of preview ? [] : turns()) {
    const startBlock = allBlocks[turn.startIndex];
    if (startBlock) turnStartsByBlockId.add(startBlock.id);
    for (let index = turn.startIndex; index <= turn.endIndex; index += 1) {
      const block = allBlocks[index];
      if (block) turnByBlockId.set(block.id, turn);
    }
  }

  const groups: Array<{
    blocks: SourceBlock[];
    speech: boolean;
    standalone: boolean;
    turn?: SpeakerTurn;
  }> = [];
  for (const block of pageBlocks) {
    const standalone = isCastListEntry(block);
    const startsSpeech =
      !standalone &&
      block.boundaryRoleId !== null &&
      Boolean(
        block.speakerLabel ||
          cueAtStart(
            block.text,
            getRecoveredOpeningMarkers(),
            usableRoleCandidates(),
          ) ||
          turnStartsByBlockId.has(block.id),
      );
    const turn = standalone ? undefined : turnByBlockId.get(block.id);
    const previousGroup = groups[groups.length - 1];
    const previousBlock = previousGroup?.blocks
      .filter((candidate) => !candidate.isSpeakerSuffix)
      .at(-1);
    const shouldJoin = Boolean(
      !standalone &&
        !startsSpeech &&
        previousGroup &&
        !previousGroup.standalone &&
        previousBlock &&
        canJoinUnassignedPreviewBlocks(
          previousBlock,
          block,
          previousGroup.blocks.length,
          previousGroup.speech,
        ),
    );

    if (shouldJoin) {
      previousGroup?.blocks.push(block);
    } else {
      groups.push({
        blocks: [block],
        speech: startsSpeech,
        standalone,
        ...(turn ? { turn } : {}),
      });
    }
  }

  return (
    sourceNote +
    groups
      .map((group) => {
        const visibleBlocks = group.blocks.filter(
          (block) => !block.isSpeakerSuffix,
        );
        const firstBlock = visibleBlocks[0] ?? group.blocks[0];
        const lastBlock = visibleBlocks[visibleBlocks.length - 1] ?? firstBlock;
        if (!firstBlock) return "";
        const hasText = visibleBlocks.some(
          (block) => block.text.trim() || block.speakerLabel?.trim(),
        );
        const hasSuffix = group.blocks.some((block) => block.isSpeakerSuffix);
        if (!hasText && !hasSuffix) return "";
        const position = blockRangePosition(firstBlock, lastBlock);
        const firstIndex = blockIndexById.get(firstBlock.id);
        const turnStartsHere =
          firstIndex !== undefined && firstIndex === group.turn?.startIndex;
        const cue = cueAtStart(
          firstBlock.text,
          getRecoveredOpeningMarkers(),
          usableRoleCandidates(),
        );
        const sourceSpeakerLabel =
          firstBlock.boundaryRoleId === null
            ? undefined
            : firstBlock.coSpeakers && firstBlock.coSpeakers.length > 1
              ? firstBlock.coSpeakers.join("・")
              : firstBlock.speakerLabel;
        const roleLabel = group.turn
          ? root.pdfWorkspace.script.roles.find(
              (role) => role.id === group.turn?.roleId,
            )?.label
          : undefined;
        const displayLabel = sourceSpeakerLabel
          ? `<strong class="extracted-speaker-label">${escapeHtml(sourceSpeakerLabel)}：</strong>`
          : group.turn && !turnStartsHere
            ? `<span class="extracted-continuation">続き${roleLabel ? ` · ${escapeHtml(roleLabel)}` : ""}</span>`
            : group.speech && !cue && roleLabel
              ? `<span class="extracted-continuation">役名候補 · ${escapeHtml(roleLabel)}</span>`
              : "";
        const content = renderScriptBlocks(visibleBlocks);
        const suffixNotes = group.blocks
          .filter((block) => block.isSpeakerSuffix)
          .map(
            (block) =>
              `<small class="extracted-suffix-note">「${escapeHtml(block.rawText.trim())}」を隣の役名「${escapeHtml(block.speakerAliases?.[0] ?? "")}」の一部として扱っています。</small>`,
          )
          .join("");

        return `<article class="extracted-line"><span>${escapeHtml(position)}</span><div><p>${displayLabel}${content || "（文字なし）"}</p>${suffixNotes}</div></article>`;
      })
      .join("")
  );
}

function canJoinUnassignedPreviewBlocks(
  previous: SourceBlock,
  next: SourceBlock,
  currentBlockCount: number,
  speech: boolean,
): boolean {
  if (
    previous.pageNumber !== next.pageNumber ||
    (!speech && currentBlockCount >= 5)
  )
    return false;
  if (!speech && /[。．.!！?？…」』】]$/u.test(previous.text.trim()))
    return false;
  return next.orderOnPage === previous.orderOnPage + 1;
}
