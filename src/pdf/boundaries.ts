import type { SourceBlock } from "./types";

export interface BoundaryEdit {
  blockId: string;
  text: string;
  offset: number;
  roleId: string | null;
  speakerText?: string;
}

export function applyBoundaryEdits(blocks: SourceBlock[], edits: BoundaryEdit[]): SourceBlock[] {
  if (edits.length === 0) return blocks;
  const editsByBlock = new Map<string, BoundaryEdit[]>();
  for (const edit of edits) {
    const group = editsByBlock.get(edit.blockId) ?? [];
    group.push(edit);
    editsByBlock.set(edit.blockId, group);
  }
  return blocks.flatMap((block) => {
    const matching = editsByBlock.get(block.id)?.filter((edit) =>
      edit.text === block.text && edit.offset < block.text.length,
    );
    if (!matching?.length) return [block];

    const first = { ...block };
    const fragments = [first];
    let offset = 0;
    for (const edit of matching.sort((a, b) => a.offset - b.offset)) {
      if (edit.offset === 0) {
        first.boundaryRoleId = edit.roleId;
        continue;
      }
      if (edit.offset <= offset || !edit.roleId) continue;
      const previous = fragments[fragments.length - 1];
      previous.text = block.text.slice(offset, edit.offset);
      previous.rawText = (previous.speakerLabel ?? "") + previous.text;
      fragments.push({
        ...block,
        id: `${block.id}~boundary-${edit.offset}`,
        text: block.text.slice(edit.offset),
        rawText: block.text.slice(edit.offset),
        speakerLabel: undefined,
        speakerAliases: undefined,
        coSpeakers: undefined,
        boundaryRoleId: edit.roleId,
        boundaryOrigin: { blockId: block.id, text: block.text, offset: edit.offset },
      });
      offset = edit.offset;
    }
    first.boundaryOrigin = { blockId: block.id, text: block.text, offset: 0 };
    for (const fragment of fragments) {
      const edit = matching.find((entry) => entry.offset === fragment.boundaryOrigin?.offset);
      if (edit?.speakerText && fragment.text.startsWith(edit.speakerText)) {
        fragment.speakerLabel = edit.speakerText;
        fragment.text = fragment.text.slice(edit.speakerText.length);
        fragment.boundaryOrigin = {
          ...fragment.boundaryOrigin!,
          labelLength: edit.speakerText.length,
        };
      }
    }
    return fragments;
  });
}
