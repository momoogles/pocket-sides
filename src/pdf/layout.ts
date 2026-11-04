export function isMarginalPageNumber(
  text: string,
  x: number,
  y: number,
  pageWidth: number,
  pageHeight: number,
  pageNumber: number,
): boolean {
  const normalized = text.normalize("NFKC").replace(/[\s\u3000]/gu, "");
  if (!/^\d{1,4}$/u.test(normalized) || Number(normalized) !== pageNumber)
    return false;

  const horizontalMargin = pageWidth * 0.15;
  const verticalMargin = pageHeight * 0.15;
  const nearHorizontalEdge =
    x <= horizontalMargin || x >= pageWidth - horizontalMargin;
  const nearVerticalEdge =
    y <= verticalMargin || y >= pageHeight - verticalMargin;
  return nearHorizontalEdge || nearVerticalEdge;
}
