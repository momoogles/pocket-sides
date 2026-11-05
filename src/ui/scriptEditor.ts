// Script editing and speaker assignment interactions.
import type { BoundaryEdit } from "../pdf/applyBoundaryEdits";
import { roleIdForName } from "../pdf/roleIdForName";
import type { SourceBlock } from "../pdf/sourcePage";
import { isPlausibleSpeakerLabel, normalizeAlias } from "../pdf/speakerNames";
import { appRoot as root, appState as state } from "./appRoot";
import { notify } from "./notifications";
import { renderStateFor, requestRender } from "./renderState";
import { blocks } from "./shared/correctedScriptBlocks";
import { escapeHtml } from "./shared/escapeHtml";
import { turns } from "./shared/scriptTurns";

export function setBoundaryDraft(draft: {
  source: string;
  text: string;
}): void {
  renderStateFor(state).boundaryDraft = draft;
}

export function resetBoundaryDraft(): void {
  renderStateFor(state).boundaryDraft = null;
}

interface ScriptEditorSpan {
  block: SourceBlock;
  start: number;
  end: number;
  prefixLength: number;
  speakerLength: number;
  roleId?: string;
}

export function scriptEditorModel(): {
  text: string;
  spans: ScriptEditorSpan[];
  breaks: Set<number>;
} {
  const sourceBlocks = blocks();
  const starts = new Map(turns().map((turn) => [turn.startIndex, turn.roleId]));
  const spans: ScriptEditorSpan[] = [];
  const breaks = new Set<number>();
  let text = "";
  let plainOffset = 0;
  let currentRole: string | undefined;
  sourceBlocks.forEach((block, index) => {
    if (block.isSpeakerSuffix || (!block.text && !block.speakerLabel)) return;
    if (starts.has(index)) {
      if (text) {
        text += "\n";
        breaks.add(plainOffset);
      }
      currentRole = starts.get(index);
    }
    const prefix = block.speakerLabel ?? "";
    const content = prefix + block.text;
    const role = root.pdfWorkspace.script.roles.find(
      (candidate) => candidate.id === starts.get(index),
    );
    const speakerLength = starts.has(index)
      ? prefix.length ||
        role?.aliases.find((alias) => content.startsWith(alias))?.length ||
        0
      : 0;
    spans.push({
      block,
      start: plainOffset,
      end: plainOffset + content.length,
      prefixLength: prefix.length,
      speakerLength,
      roleId: currentRole,
    });
    text += content;
    plainOffset += content.length;
  });
  return { text, spans, breaks };
}

function renderEditorHighlights(
  text: string,
  model: ReturnType<typeof scriptEditorModel>,
): string {
  if (text.replace(/\n/g, "") !== model.text.replace(/\n/g, ""))
    return escapeHtml(text);
  const labels = new Map(
    model.spans
      .filter((span) => span.speakerLength > 0)
      .map((span) => [span.start, span.speakerLength]),
  );
  const parts: string[] = [];
  let plainOffset = 0;
  let unmarkedStart = 0;
  let index = 0;
  while (index < text.length) {
    const labelLength =
      text[index] === "\n" ? undefined : labels.get(plainOffset);
    if (labelLength) {
      parts.push(escapeHtml(text.slice(unmarkedStart, index)));
      const start = index;
      let remaining = labelLength;
      while (index < text.length && remaining > 0) {
        if (text[index] !== "\n") {
          remaining -= 1;
          plainOffset += 1;
        }
        index += 1;
      }
      parts.push(
        `<mark class="inline-role-highlight">${escapeHtml(text.slice(start, index))}</mark>`,
      );
      unmarkedStart = index;
    } else {
      if (text[index] !== "\n") plainOffset += 1;
      index += 1;
    }
  }
  parts.push(escapeHtml(text.slice(unmarkedStart)));
  return `${parts.join("")}\n`;
}

export function hideScriptSelectionToolbar(): void {
  const toolbar = root.querySelector<HTMLElement>("#script-selection-toolbar");
  if (toolbar) toolbar.hidden = true;
}

export function showScriptSelectionToolbar(point?: {
  x: number;
  y: number;
}): void {
  const editor = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  const toolbar = root.querySelector<HTMLElement>("#script-selection-toolbar");
  const label = root.querySelector<HTMLElement>("#script-selection-label");
  if (!editor || !toolbar || !label || root.pdfWorkspace.analysis.ocrBusy)
    return;
  const model = scriptEditorModel();
  if (editor.selectionStart === editor.selectionEnd) {
    const plainOffset = editor.value
      .slice(0, editor.selectionStart)
      .replace(/\n/g, "").length;
    const span = model.spans.find(
      (item) =>
        item.speakerLength > 0 &&
        plainOffset >= item.start &&
        plainOffset < item.start + item.speakerLength,
    );
    if (span) {
      let offset = 0;
      let start = 0;
      while (start < editor.value.length && offset < span.start) {
        if (editor.value[start] !== "\n") offset += 1;
        start += 1;
      }
      while (editor.value[start] === "\n") start += 1;
      editor.setSelectionRange(start, start + span.speakerLength);
    }
  }
  const selected = editor.value.slice(
    editor.selectionStart,
    editor.selectionEnd,
  );
  if (
    !selected ||
    selected.includes("\n") ||
    !isPlausibleSpeakerLabel(selected)
  ) {
    hideScriptSelectionToolbar();
    return;
  }
  const plainStart = editor.value
    .slice(0, editor.selectionStart)
    .replace(/\n/g, "").length;
  const selectedSpeaker = model.spans.find(
    (span) =>
      span.start === plainStart &&
      span.speakerLength === selected.length &&
      span.speakerLength > 0,
  );
  const removeButton = toolbar.querySelector<HTMLButtonElement>(
    '[data-action="unassign-selected-speaker"]',
  );
  if (removeButton) removeButton.hidden = !selectedSpeaker;
  label.textContent = `「${selected}」`;
  toolbar.hidden = false;
  const bounds = editor.getBoundingClientRect();
  const toolbarBounds = toolbar.getBoundingClientRect();
  const x = point?.x ?? bounds.left + 12;
  const y = point?.y ?? Math.max(12, bounds.top) + 48;
  toolbar.style.left = `${Math.max(8, Math.min(x, window.innerWidth - toolbarBounds.width - 8))}px`;
  toolbar.style.top = `${Math.max(8, Math.min(y + 12, window.innerHeight - toolbarBounds.height - 8))}px`;
}

export function unassignSelectedSpeaker(): void {
  if (root.pdfWorkspace.analysis.ocrBusy) return;
  const editor = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  if (!editor) return;
  const plainStart = editor.value
    .slice(0, editor.selectionStart)
    .replace(/\n/g, "").length;
  const model = scriptEditorModel();
  const span = model.spans.find(
    (item) =>
      item.start === plainStart &&
      item.speakerLength > 0 &&
      editor.selectionEnd - editor.selectionStart === item.speakerLength,
  );
  if (!span) return;
  root.pdfWorkspace.script.boundaryEdits = setBoundaryEdit(
    root.pdfWorkspace.script.boundaryEdits,
    editorPosition(span, span.start),
    null,
  );
  root.pdfWorkspace.practice.ranges = {};
  root.pdfWorkspace.practice.currentTargetIndex = 0;
  renderStateFor(state).boundaryDraft = null;
  const scroll = editor.scrollTop;
  requestRender();
  const updated = root.querySelector<HTMLTextAreaElement>(
    "#full-script-editor",
  );
  if (updated) updated.scrollTop = scroll;
}

export function renderBoundaryEditor(): string {
  const renderState = renderStateFor(state);
  const model = scriptEditorModel();
  if (
    renderState.boundaryDraft &&
    renderState.boundaryDraft.source !== model.text
  ) {
    renderState.boundaryDraft = null;
    notify(
      "読み取り結果が変わったため、未反映の改行を元に戻しました。",
      "info",
    );
  }
  const text = renderState.boundaryDraft?.text ?? model.text;
  return `
    <p class="panel-footnote">Enterでセリフを分け、改行を消すとつながります。役名はドラッグして指定し、背景色の付いた役名はクリックして解除できます。</p>
    <label class="script-editor-label" for="full-script-editor">台本の全文</label>
    <div class="script-editor-surface">
      <div id="full-script-highlights" class="full-script-highlights" aria-hidden="true"><div class="script-editor-highlight-content">${renderEditorHighlights(text, model)}</div></div>
      <textarea class="text-input full-script-editor" id="full-script-editor" spellcheck="false" ${root.pdfWorkspace.analysis.ocrBusy ? "disabled" : ""}>${escapeHtml(text)}</textarea>
    </div>
    <div id="script-selection-toolbar" class="script-selection-toolbar" role="toolbar" aria-label="選択した文字の役名設定" hidden>
      <strong id="script-selection-label"></strong>
      <button class="primary-button" data-action="assign-selected-speaker">役名にする</button>
      <button class="secondary-button" data-action="unassign-selected-speaker" hidden>役名を解除</button>
    </div>
  `;
}

function editorPosition(
  span: ScriptEditorSpan,
  plainOffset: number,
): Omit<BoundaryEdit, "roleId"> {
  const localOffset = plainOffset - span.start;
  const origin = span.block.boundaryOrigin;
  const offset =
    Math.max(0, localOffset - span.prefixLength) +
    (localOffset >= span.prefixLength ? (origin?.labelLength ?? 0) : 0);
  return {
    blockId: origin?.blockId ?? span.block.id,
    text: origin?.text ?? span.block.text,
    offset: (origin?.offset ?? 0) + offset,
  };
}

function setBoundaryEdit(
  edits: BoundaryEdit[],
  position: Omit<BoundaryEdit, "roleId">,
  roleId: string | null,
): BoundaryEdit[] {
  const remaining = edits.filter(
    (edit) =>
      edit.blockId !== position.blockId || edit.offset !== position.offset,
  );
  return roleId || position.offset === 0
    ? [...remaining, { ...position, roleId }]
    : remaining;
}

export function showScriptEditorError(message: string): void {
  const editor = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  if (!editor) return;
  editor.setCustomValidity(message);
  editor.reportValidity();
}

export function applyScriptEditor(assignSpeaker: boolean): void {
  if (root.pdfWorkspace.analysis.ocrBusy) return;
  const editor = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  if (!editor) return;
  editor.setCustomValidity("");
  const model = scriptEditorModel();
  const plain = editor.value.replace(/\n/g, "");
  if (plain !== model.text.replace(/\n/g, "")) {
    showScriptEditorError(
      "ここでは改行を追加・削除できます。本文の文字を元に戻してから適用してください。",
    );
    return;
  }
  const wantedBreaks = new Set<number>();
  let offset = 0;
  for (const character of editor.value) {
    if (character === "\n") wantedBreaks.add(offset);
    else offset += character.length;
  }
  const findSpan = (position: number) =>
    model.spans.find((span) => position >= span.start && position < span.end);
  let edits = [...root.pdfWorkspace.script.boundaryEdits];
  for (const position of new Set([...model.breaks, ...wantedBreaks])) {
    if (
      model.breaks.has(position) === wantedBreaks.has(position) ||
      position === 0 ||
      position === plain.length
    )
      continue;
    const span = findSpan(position);
    if (!span) continue;
    if (position > span.start && position < span.start + span.prefixLength) {
      showScriptEditorError("役名の途中には改行を入れられません。");
      return;
    }
    const location = editorPosition(span, position);
    if (wantedBreaks.has(position)) {
      const roleId = span.roleId || root.pdfWorkspace.script.selectedRoleId;
      if (!roleId) {
        showScriptEditorError("練習する役を選んでから改行してください。");
        return;
      }
      edits = setBoundaryEdit(edits, location, roleId);
    } else {
      edits = setBoundaryEdit(edits, location, null);
    }
  }

  if (assignSpeaker) {
    const start = editor.value
      .slice(0, editor.selectionStart)
      .replace(/\n/g, "").length;
    const end = editor.value
      .slice(0, editor.selectionEnd)
      .replace(/\n/g, "").length;
    const label = plain.slice(start, end);
    const span = findSpan(start);
    if (
      !span ||
      !label ||
      label !== label.trim() ||
      !isPlausibleSpeakerLabel(label) ||
      end > span.end
    ) {
      showScriptEditorError("役名の文字だけを選択してください。");
      return;
    }
    const withinPrefix =
      start === span.start && end === span.start + span.prefixLength;
    if (start < span.start + span.prefixLength && !withinPrefix) {
      showScriptEditorError("役名は一部ではなく、名前全体を選択してください。");
      return;
    }
    let role = root.pdfWorkspace.script.roles.find((candidate) =>
      candidate.aliases.some(
        (alias) => normalizeAlias(alias) === normalizeAlias(label),
      ),
    );
    if (!role) {
      root.pdfWorkspace.script.manualRoleNumber += 1;
      role = {
        id: `manual-${roleIdForName(label)}-${root.pdfWorkspace.script.manualRoleNumber}`,
        label,
        aliases: [label],
        occurrenceCount: 0,
        exampleBlockIds: [],
        manual: true,
        evidence: "manual",
      };
      root.pdfWorkspace.script.roles.push(role);
    } else if (!role.aliases.includes(label)) {
      role.aliases = [...role.aliases, label];
    }
    const location = editorPosition(span, start);
    edits = setBoundaryEdit(
      edits,
      {
        ...location,
        ...(!withinPrefix || span.block.boundaryOrigin?.labelLength
          ? { speakerText: label }
          : {}),
      },
      role.id,
    );
  }
  root.pdfWorkspace.script.boundaryEdits = edits;
  root.pdfWorkspace.practice.ranges = {};
  root.pdfWorkspace.practice.currentTargetIndex = 0;
  renderStateFor(state).boundaryDraft = null;
  const caret = editor.selectionStart;
  const scrollTop = editor.scrollTop;
  requestRender();
  const updated = root.querySelector<HTMLTextAreaElement>(
    "#full-script-editor",
  );
  if (updated) {
    updated.focus({ preventScroll: true });
    updated.setSelectionRange(
      Math.min(caret, updated.value.length),
      Math.min(caret, updated.value.length),
    );
    updated.scrollTop = scrollTop;
  }
}
