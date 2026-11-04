import { blockPosition } from "../../pdf/segments";
import type { SourceBlock } from "../../pdf/types";

export function formatPageRange(start: number, end: number): string {
  return start === end ? `${start}ページ目` : `${start}〜${end}ページ目`;
}

export function blockRangePosition(
  first: SourceBlock,
  last: SourceBlock,
): string {
  if (first.orderOnPage === last.orderOnPage) return blockPosition(first);
  return first.direction === "vertical"
    ? `${first.pageNumber}ページ目 · 右から${first.orderOnPage}〜${last.orderOnPage}列目`
    : `${first.pageNumber}ページ目 · 上から${first.orderOnPage}〜${last.orderOnPage}行目`;
}
