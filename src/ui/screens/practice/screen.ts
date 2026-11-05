import type { PracticeRange } from "../../../pdf/pdfWorkspace";
import type { PracticeTarget } from "../../../pdf/practiceTarget";
import { blockPosition } from "../../../pdf/sourceBlocks";
import type { SourceBlock } from "../../../pdf/sourcePage";
import type { SpeakerTurn } from "../../../pdf/speakerTurn";
import { appRoot as root } from "../../appRoot";
import { blockRangePosition } from "../../shared/blockRangePosition";
import { blocks } from "../../shared/correctedScriptBlocks";
import { currentPracticeTargets } from "../../shared/currentPracticeTargets";
import { escapeHtml } from "../../shared/escapeHtml";
import { formatPageRange } from "../../shared/formatPageRange";
import { renderScriptBlocks } from "../../shared/scriptContent";
import { selectedRole } from "../../shared/scriptRoles";
import { turnsForBlocks } from "../../shared/scriptTurns";
import type { PracticeScreenContext } from "./context";
import styles from "./styles.module.css";

export interface PracticeScreenView {
  roleLabel: string;
  sceneLabel: string;
  pageRange: string;
  currentTargetIndex: number;
  targetCount: number;
  targetId: string;
  minimumStartIndex: number;
  turnStartIndex: number;
  defaultEndIndex: number;
  maximumEndIndex: number;
  rangeStart: number;
  rangeEnd: number;
  rangeStartLabel: string;
  rangeEndLabel: string;
  contextHtml: string;
  answerHtml: string;
  revealed: boolean;
  glyphCorrectionsExist: boolean;
  hasNextTurn: boolean;
  showOriginal: boolean;
  originalPage: number;
  pageNumbers: number[];
}

function renderPractice(view: PracticeScreenView | null): string {
  if (!view) {
    return `
      <main class="narrow-page">
        <p>練習シーンを選んでください。</p>
        <button class="secondary-button" data-action="back-to-appearances">練習シーン一覧に戻る</button>
      </main>`;
  }

  const currentNumber = String(view.currentTargetIndex + 1).padStart(2, "0");
  const totalNumber = String(view.targetCount).padStart(2, "0");
  const progressPercent = Math.round(
    ((view.currentTargetIndex + 1) / Math.max(1, view.targetCount)) * 100,
  );
  const isLastTarget = view.currentTargetIndex + 1 >= view.targetCount;

  return `
    <main class="${styles.root}">
      <div class="${styles.topline}">
        <div class="${styles.progressCopy}">
          <span>${currentNumber}</span>
          <span class="${styles.progressSeparator}">/</span>
          <span>${totalNumber}</span>
          <span class="${styles.progressLabel}">シーン</span>
        </div>
      </div>
      <section class="${styles.heading}">
        <div>
          <p class="${styles.meta}">台本の${escapeHtml(view.sceneLabel)} · ${escapeHtml(view.pageRange)}</p>
          <h1>${escapeHtml(view.roleLabel)}の練習シーン <span>${currentNumber}</span></h1>
        </div>
      </section>
      ${view.glyphCorrectionsExist ? `<p class="${styles.correctionReminder}">文字の置換を練習画面に反映しています。</p>` : ""}
      <div class="${styles.layout}">
        <section class="${styles.card}">
          <div class="${styles.cardHeading}">
            <span class="small-label">${view.revealed ? "答え" : "前のセリフとト書き"}</span>
            <span class="${styles.pageTag}">${escapeHtml(view.pageRange)}</span>
          </div>
          ${
            view.contextHtml
              ? `<div class="${styles.scriptStream} ${styles.contextStream}" id="context-stream">${view.contextHtml}</div>`
              : `<div class="${styles.noContext}"><p>この練習シーンの前に表示するセリフやト書きはありません。</p></div>`
          }
          ${
            view.revealed
              ? `<div class="${styles.revealedAnswer}" id="revealed-answer">${view.answerHtml}</div>`
              : `<div class="${styles.answerPrompt}" aria-live="polite"><button class="primary-button ${styles.revealButton}" data-action="reveal">答えを確認する</button></div>`
          }
          <details class="${styles.rangeDetails}">
            <summary>表示する範囲を調整する</summary>
            <div class="${styles.rangeControls}">
              <label class="${styles.rangeControl}">
                <span>前のセリフやト書きをどこから表示するか</span>
                <input class="${styles.rangeSlider}" type="range" min="${view.minimumStartIndex}" max="${view.turnStartIndex}" value="${view.rangeStart}" data-range-start="${escapeHtml(view.targetId)}" />
                <small id="range-start-label">${escapeHtml(view.rangeStartLabel)}</small>
              </label>
              <label class="${styles.rangeControl}">
                <span>答えを確認したあと、どこまで表示するか</span>
                <input class="${styles.rangeSlider}" type="range" min="${view.defaultEndIndex}" max="${Math.max(view.defaultEndIndex, view.maximumEndIndex)}" value="${view.rangeEnd}" data-range-end="${escapeHtml(view.targetId)}" />
                <small id="range-end-label">${escapeHtml(view.rangeEndLabel)}</small>
              </label>
              <button class="text-button ${styles.resetRange}" data-action="reset-range" data-target-id="${escapeHtml(view.targetId)}">練習範囲を初期設定に戻す</button>
            </div>
          </details>
        </section>
        <aside class="${styles.sidePanel}">
          <div class="${styles.sideCard} ${styles.progressCard}">
            <span class="small-label">練習の進捗</span>
            <div class="${styles.miniProgress}"><span style="width:${progressPercent}%"></span></div>
            <p>${view.currentTargetIndex + 1} / ${view.targetCount}シーン</p>
          </div>
          ${renderSourceCard(view)}
        </aside>
      </div>
      ${view.showOriginal ? renderOriginalPdf(view) : ""}
      ${
        !view.hasNextTurn && view.revealed
          ? `<p class="alert alert-warning ${styles.lastUtteranceNote}">${escapeHtml(view.roleLabel)}の次のセリフを見つけられませんでした。読み取り結果で役名やセリフの区切りを確認してください。</p>`
          : ""
      }
      <p class="${styles.keyboardHelp}">キー操作：← 前の練習シーン　→ 確認／次の練習シーン　R もう一度</p>
      <nav class="${styles.navigation}" aria-label="練習の操作">
        <button class="secondary-button" data-action="back-to-appearances">練習シーン一覧に戻る</button>
        <button class="secondary-button" data-action="previous-target" ${view.currentTargetIndex === 0 ? "disabled" : ""}>前の練習シーン</button>
        <button class="secondary-button" data-action="repeat-target">同じ練習シーンをもう一度</button>
        <button class="primary-button" data-action="next-target" ${!view.revealed ? "disabled" : ""}>${isLastTarget ? "練習シーン一覧に戻る" : "次の練習シーン"}</button>
      </nav>
    </main>`;
}

function renderSourceCard(view: PracticeScreenView): string {
  return view.revealed
    ? `
      <div class="${styles.sideCard} ${styles.sourceCard}">
        <span class="small-label">元のPDF</span>
        <p>この練習シーンのページを確認できます。</p>
        <button class="secondary-button" data-action="toggle-source">${view.showOriginal ? "元のPDFを閉じる" : "元のPDFを見る"}</button>
      </div>`
    : `
      <div class="${styles.sideCard} ${styles.sourceCard}">
        <span class="small-label">元のPDF</span>
        <p>答えを確認すると、該当ページを開けます。</p>
        <button class="secondary-button" disabled>答えの確認後に表示</button>
      </div>`;
}

function renderOriginalPdf(view: PracticeScreenView): string {
  return `
    <section class="panel ${styles.sourcePreview}">
      <div class="source-toolbar">
        <div><span class="small-label">${view.originalPage}ページ目</span><h2>元のPDFを確認する</h2></div>
        <label class="select-field">
          <span>表示するページ</span>
          <select class="select-input" id="original-page-select">
            ${view.pageNumbers
              .map(
                (pageNumber) => `
              <option value="${pageNumber}" ${pageNumber === view.originalPage ? "selected" : ""}>${pageNumber}ページ目</option>`,
              )
              .join("")}
          </select>
        </label>
      </div>
      <div class="pdf-canvas-scroll"><canvas id="page-canvas" aria-label="元のPDFのページ"></canvas></div>
    </section>`;
}

export function refreshPracticeDisplay(context: PracticeScreenContext): void {
  const targets = currentPracticeTargets();
  const target = targets[root.pdfWorkspace.practice.currentTargetIndex];
  if (!target) return;

  const allBlocks = blocks();
  const speakerTurns = turnsForBlocks(allBlocks);
  const currentRange = rangeFor(target);
  const stream = document.querySelector<HTMLDivElement>("#context-stream");
  if (stream) {
    stream.innerHTML = renderBlockRange(
      allBlocks,
      currentRange.start,
      target.turn.startIndex - 1,
      speakerTurns,
      styles.contextBlock,
    );
  }

  const startLabel = document.querySelector<HTMLElement>("#range-start-label");
  const endLabel = document.querySelector<HTMLElement>("#range-end-label");
  if (startLabel)
    startLabel.textContent = positionAt(allBlocks, currentRange.start);
  if (endLabel) endLabel.textContent = positionAt(allBlocks, currentRange.end);

  const answer = document.querySelector<HTMLDivElement>("#revealed-answer");
  if (answer && context.revealed) {
    answer.innerHTML = renderAnswer(
      target,
      currentRange,
      allBlocks,
      speakerTurns,
    );
  }
}

function buildPracticeView(
  context: PracticeScreenContext,
): PracticeScreenView | null {
  const targets = currentPracticeTargets();
  const target = targets[root.pdfWorkspace.practice.currentTargetIndex];
  const role = selectedRole();
  if (!target || !role) return null;

  const allBlocks = blocks();
  const speakerTurns = turnsForBlocks(allBlocks);
  const range = rangeFor(target);
  const contextHtml = renderBlockRange(
    allBlocks,
    range.start,
    target.turn.startIndex - 1,
    speakerTurns,
    styles.contextBlock,
  );
  const view: PracticeScreenView = {
    roleLabel: role.label,
    sceneLabel: target.sceneLabel,
    pageRange: formatPageRange(target.turn.startPage, target.turn.endPage),
    currentTargetIndex: root.pdfWorkspace.practice.currentTargetIndex,
    targetCount: targets.length,
    targetId: target.id,
    minimumStartIndex: target.minimumStartIndex,
    turnStartIndex: target.turn.startIndex,
    defaultEndIndex: target.defaultEndIndex,
    maximumEndIndex: allBlocks.length - 1,
    rangeStart: range.start,
    rangeEnd: range.end,
    rangeStartLabel: positionAt(allBlocks, range.start),
    rangeEndLabel: positionAt(allBlocks, range.end),
    contextHtml,
    answerHtml: context.revealed
      ? renderAnswer(target, range, allBlocks, speakerTurns)
      : "",
    revealed: context.revealed,
    glyphCorrectionsExist: Object.values(
      root.pdfWorkspace.script.corrections,
    ).some((value) => value.trim().length > 0),
    hasNextTurn: Boolean(target.nextTurn),
    showOriginal: context.showOriginal,
    originalPage: context.originalPage,
    pageNumbers: root.pdfWorkspace.script.pages.map((page) => page.pageNumber),
  };

  return view;
}

export function renderPracticeScreen(context: PracticeScreenContext): string {
  return renderPractice(buildPracticeView(context));
}

export function renderAnswer(
  target: PracticeTarget,
  range: PracticeRange,
  allBlocks: SourceBlock[],
  speakerTurns: SpeakerTurn[],
): string {
  const own = renderBlockRange(
    allBlocks,
    target.turn.startIndex,
    target.turn.endIndex,
    speakerTurns,
  );
  const next = target.nextTurn
    ? `<section class="${styles.answerSection} ${styles.nextSpeechSection}"><div class="${styles.answerSectionHeading}"><div><span class="small-label">次のセリフ</span><h2>${escapeHtml(roleLabel(target.nextTurn.roleId))}</h2></div></div><div class="${styles.scriptStream}">${renderBlockRange(allBlocks, target.nextTurn.startIndex, target.nextTurn.endIndex, speakerTurns)}</div></section>`
    : `<div class="${styles.nextSpeechMissing}"><span class="small-label">次のセリフ</span><p>次のセリフが見つかりませんでした。</p></div>`;
  const extraStart = target.nextTurn
    ? target.nextTurn.endIndex + 1
    : target.turn.endIndex + 1;
  const extra =
    range.end >= extraStart
      ? `<div class="${styles.afterExtra}"><span class="small-label">その先のセリフ</span><div class="${styles.scriptStream}">${renderBlockRange(allBlocks, extraStart, range.end, speakerTurns, styles.extraBlock)}</div></div>`
      : "";
  return `
    <section class="${styles.answerSection} ${styles.ownSpeechSection}"><div class="${styles.answerSectionHeading}"><div><span class="small-label">原文</span><h2>自分のセリフ</h2></div></div><div class="${styles.scriptStream}">${own}</div></section>
    ${next}
    ${extra}`;
}

export function renderBlockRange(
  allBlocks: SourceBlock[],
  start: number,
  end: number,
  speakerTurns: SpeakerTurn[],
  variantClass?: string,
): string {
  if (end < start) return "";
  const startIndex = Math.max(0, start);
  const endIndex = Math.min(end, allBlocks.length - 1);
  const turnKeyByIndex = new Map<number, string>();
  for (const turn of speakerTurns) {
    const key = `${turn.startIndex}:${turn.endIndex}`;
    for (let index = turn.startIndex; index <= turn.endIndex; index += 1) {
      if (!turnKeyByIndex.has(index)) turnKeyByIndex.set(index, key);
    }
  }

  const groups: Array<{
    key: string;
    startIndex: number;
    endIndex: number;
    blocks: SourceBlock[];
  }> = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const block = allBlocks[index];
    if (!block) continue;
    const turnKey = turnKeyByIndex.get(index);
    const key = turnKey ?? `block:${index}`;
    const current = groups[groups.length - 1];

    if (block.isSpeakerSuffix) {
      if (current?.key === key) current.endIndex = index;
      continue;
    }
    if (turnKey && current?.key === key) {
      current.endIndex = index;
      current.blocks.push(block);
      continue;
    }
    groups.push({ key, startIndex: index, endIndex: index, blocks: [block] });
  }

  return groups
    .map((group) => {
      const firstBlock = group.blocks[0];
      const lastBlock = group.blocks[group.blocks.length - 1];
      if (!firstBlock || !lastBlock) return "";

      return `
      <article class="${styles.scriptBlock}${variantClass ? ` ${variantClass}` : ""}" data-page="${firstBlock.pageNumber}">
        <span class="${styles.scriptPosition}">${escapeHtml(practiceRangePosition(firstBlock, lastBlock))}</span>
        <p dir="auto">${renderScriptBlocks(group.blocks)}</p>
      </article>`;
    })
    .join("");
}

function practiceRangePosition(first: SourceBlock, last: SourceBlock): string {
  if (first.pageNumber === last.pageNumber)
    return blockRangePosition(first, last);
  const location = (block: SourceBlock) =>
    blockPosition(block).split(" · ").at(-1) ?? "";
  return `${formatPageRange(first.pageNumber, last.pageNumber)} · ${location(first)}〜${location(last)}`;
}

export function rangeFor(target: PracticeTarget): PracticeRange {
  return (
    root.pdfWorkspace.practice.ranges[target.id] ?? {
      start: target.defaultStartIndex,
      end: target.defaultEndIndex,
    }
  );
}

export function positionAt(allBlocks: SourceBlock[], index: number): string {
  const block = allBlocks[Math.max(0, Math.min(index, allBlocks.length - 1))];
  return block ? blockPosition(block) : "位置が不明です";
}

function roleLabel(roleId: string): string {
  return (
    root.pdfWorkspace.script.roles.find((role) => role.id === roleId)?.label ??
    "役名不明"
  );
}
