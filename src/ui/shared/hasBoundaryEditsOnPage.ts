// Check whether a page has any user-defined speaker boundary.
import { appRoot as root } from "../appRoot";
import { blocks } from "./correctedScriptBlocks";

export function hasBoundaryEditsOnPage(pageNumber: number): boolean {
  const blockIds = new Set(
    blocks(false)
      .filter((block) => block.pageNumber === pageNumber)
      .map((block) => block.id),
  );
  return root.pdfWorkspace.script.boundaryEdits.some((edit) =>
    blockIds.has(edit.blockId),
  );
}
