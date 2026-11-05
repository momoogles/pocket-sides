import { blockPosition } from "../../pdf/sourceBlocks";
import type { SourceBlock } from "../../pdf/sourcePage";

export function blockRangePosition(
  first: SourceBlock,
  last: SourceBlock,
): string {
  if (first.orderOnPage === last.orderOnPage) return blockPosition(first);
  return first.direction === "vertical"
    ? `${first.pageNumber}ページ目 · 右から${first.orderOnPage}〜${last.orderOnPage}列目`
    : `${first.pageNumber}ページ目 · 上から${first.orderOnPage}〜${last.orderOnPage}行目`;
}
