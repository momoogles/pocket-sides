export function formatPageRange(start: number, end: number): string {
  return start === end ? `${start}ページ目` : `${start}〜${end}ページ目`;
}
