import { normalizeScriptText } from "../../../pdf/normalizeScriptText";
import type { PracticeTarget } from "../../../pdf/practiceTarget";
import { cueAtStart } from "../../../pdf/quoteMarkers";
import { splitStageDirectionText } from "../../../pdf/sourceBlocks";
import type { SourceBlock } from "../../../pdf/sourcePage";
import type { SpeakerTurn } from "../../../pdf/speakerTurn";
import { appRoot as root } from "../../appRoot";
import {
  blocks,
  getRecoveredOpeningMarkers,
  usableRoleCandidates,
} from "../../shared/correctedScriptBlocks";
import { currentPracticeTargets } from "../../shared/currentPracticeTargets";
import { escapeHtml } from "../../shared/escapeHtml";
import { formatPageRange } from "../../shared/formatPageRange";
import { renderStepHeader } from "../../shared/renderStepHeader";
import { selectedRole } from "../../shared/scriptRoles";
import { turnsForBlocks } from "../../shared/scriptTurns";
import styles from "./styles.module.css";

export interface AppearanceEntryView {
  index: number;
  pageRange: string;
  openingLine: string;
}

export interface AppearanceGroupView {
  sceneLabel: string;
  entries: AppearanceEntryView[];
}

export interface AppearancesView {
  roleLabel: string | null;
  groups: AppearanceGroupView[];
  targetCount: number;
  practiceHasStarted: boolean;
  currentTargetIndex: number;
  practiceSaveBusy: boolean;
}

function renderAppearances(view: AppearancesView): string {
  const primaryTargetIndex = view.practiceHasStarted
    ? Math.min(view.currentTargetIndex, Math.max(0, view.targetCount - 1))
    : 0;

  return `
    <main class="work-page ${styles.root}">
      ${renderStepHeader("練習シーンを選ぶ", `練習する役：${view.roleLabel ?? "未選択"}`)}
      <div class="scene-explainer">
        <p>台本の区切りごとに練習シーンを表示します。前後に表示する範囲は練習画面で調整できます。</p>
      </div>
      ${view.targetCount === 0 ? renderEmptyAppearances() : renderAppearanceGroups(view.groups, view.practiceSaveBusy)}
      <div class="bottom-actions sticky-action-bar">
        <button class="text-button" data-action="back-to-analysis">読み取り結果に戻る</button>
        <button
          class="primary-button"
          data-action="start-practice"
          data-target-index="${primaryTargetIndex}"
          ${view.targetCount === 0 || view.practiceSaveBusy ? "disabled" : ""}
        >${view.practiceHasStarted ? "前回の練習シーンから始める" : "最初の練習シーンから始める"}</button>
      </div>
    </main>`;
}

function renderEmptyAppearances(): string {
  return `
    <div class="empty-state">
      <strong>この役の練習シーンがありません</strong>
      <p>読み取り結果に戻り、役名とセリフの対応を見直してください。</p>
      <button class="secondary-button" data-action="back-to-analysis">読み取り結果に戻る</button>
    </div>`;
}

function renderAppearanceGroups(
  groups: AppearanceGroupView[],
  practiceSaveBusy: boolean,
): string {
  return `
    <div class="appearance-groups">
      ${groups
        .map(
          (group) => `
        <section class="scene-group">
          <div class="scene-heading">
            <span>台本の区切り</span>
            <h2>${escapeHtml(group.sceneLabel)}</h2>
            <span class="scene-unit-count">練習シーン ${group.entries.length}件</span>
          </div>
          <div class="appearance-list">
            ${group.entries
              .map(
                (entry) => `
              <article class="appearance-row">
                <div class="appearance-copy">
                  <span class="small-label">練習シーン ${entry.index + 1} · ${escapeHtml(entry.pageRange)}</span>
                  <p class="appearance-opening-line">${escapeHtml(entry.openingLine || "前のセリフがありません")}</p>
                </div>
                <button
                  class="secondary-button appearance-start"
                  data-action="start-practice"
                  data-target-index="${entry.index}"
                  ${practiceSaveBusy ? "disabled" : ""}
                >この練習シーンから始める</button>
              </article>`,
              )
              .join("")}
          </div>
        </section>`,
        )
        .join("")}
    </div>`;
}

function appearanceOpeningLine(
  target: PracticeTarget,
  allBlocks: SourceBlock[],
  allTurns: SpeakerTurn[],
): string {
  const selectedStarts = new Set(
    allTurns
      .filter((turn) => turn.roleId === target.turn.roleId)
      .map((turn) => turn.startIndex),
  );
  const openingTurn = allTurns.find(
    (turn) =>
      turn.startIndex < target.turn.startIndex &&
      turn.endIndex >= target.defaultStartIndex &&
      !selectedStarts.has(turn.startIndex),
  );
  if (!openingTurn) return "";

  const utteranceBlocks = allBlocks.slice(
    openingTurn.startIndex,
    openingTurn.endIndex + 1,
  );
  const rawText = utteranceBlocks
    .map((block) => block.text)
    .join(utteranceBlocks[0]?.direction === "vertical" ? "" : "\n");
  const roles = usableRoleCandidates();
  const speechText = splitStageDirectionText(rawText, roles)
    .filter((fragment) => fragment.kind === "speech")
    .map((fragment) => fragment.text)
    .join("")
    .trim();
  const cue = cueAtStart(speechText, getRecoveredOpeningMarkers(), roles);
  let preview = speechText;
  if (cue) {
    const markerIndex = speechText.indexOf(cue.marker, cue.name.length);
    if (markerIndex >= 0) preview = speechText.slice(markerIndex);
  }
  preview = dialogueOnlyPreview(preview);
  const characters = Array.from(normalizeScriptText(preview));
  return characters.length > 88
    ? `${characters.slice(0, 88).join("").trimEnd()}…`
    : characters.join("");
}

function dialogueOnlyPreview(text: string): string {
  const opening = /[「『“"]/u.exec(text);
  if (!opening) return text.trim();

  const closingMark: Record<string, string> = {
    "「": "」",
    "『": "』",
    "“": "”",
    '"': '"',
  };
  const closing = closingMark[opening[0]];
  const closingIndex = closing
    ? text.indexOf(closing, opening.index + opening[0].length)
    : -1;
  return (
    closingIndex >= 0
      ? text.slice(opening.index, closingIndex + closing.length)
      : text.slice(opening.index)
  ).trim();
}

function buildAppearancesView(): AppearancesView {
  const role = selectedRole();
  const targets = currentPracticeTargets();
  const allBlocks = blocks();
  const allTurns = turnsForBlocks(allBlocks);
  const groups = new Map<string, AppearanceGroupView>();
  targets.forEach((target, index) => {
    const group = groups.get(target.sceneLabel) ?? {
      sceneLabel: target.sceneLabel,
      entries: [],
    };
    group.entries.push({
      index,
      pageRange: formatPageRange(target.turn.startPage, target.turn.endPage),
      openingLine: appearanceOpeningLine(target, allBlocks, allTurns),
    });
    groups.set(target.sceneLabel, group);
  });

  return {
    roleLabel: role?.label ?? null,
    groups: [...groups.values()],
    targetCount: targets.length,
    practiceHasStarted: root.pdfWorkspace.practice.practiceHasStarted,
    currentTargetIndex: root.pdfWorkspace.practice.currentTargetIndex,
    practiceSaveBusy: root.pdfWorkspace.practice.practiceSaveBusy,
  };
}

export function renderAppearancesScreen(): string {
  return renderAppearances(buildAppearancesView());
}
