// Extract positioned text and group it into reading-order blocks for one PDF page.
import type { PDFPageProxy } from "pdfjs-dist";
import { isMarginalPageNumber } from "./isMarginalPageNumber";
import type {
  ReadingDirection,
  SourceBlock,
  SourceItem,
  SourcePage,
} from "./sourcePage";

interface PdfTextItemLike {
  str: string;
  dir: "ltr" | "rtl" | "ttb";
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

interface PositionedTextItem extends SourceItem {
  fontSize: number;
  sourceItemIds?: string[];
  hasSidewaysHalfwidthKatakana?: boolean;
}

export async function extractSourcePage(
  page: PDFPageProxy,
  pageNumber: number,
): Promise<SourcePage> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: PositionedTextItem[] = [];

  content.items.forEach((entry, contentIndex) => {
    if (!("str" in entry) || typeof entry.str !== "string" || !entry.str)
      return;
    const item = entry as PdfTextItemLike;
    const transform = item.transform;
    const fontSize = Math.max(
      1,
      Math.hypot(transform[2] ?? 0, transform[3] ?? 0),
    );
    items.push({
      id: `p${pageNumber}-i${contentIndex}`,
      pageNumber,
      contentIndex,
      text: item.str,
      direction: item.dir,
      x: transform[4] ?? 0,
      y: transform[5] ?? 0,
      width: item.width,
      height: item.height,
      fontName: item.fontName,
      fontSize,
      ...(/[\uff66-\uff9f]/u.test(item.str) &&
      item.dir !== "ttb" &&
      Math.abs(transform[1] ?? 0) > Math.abs(transform[0] ?? 0)
        ? { hasSidewaysHalfwidthKatakana: true }
        : {}),
    });
  });

  const fallbackDirection =
    viewport.width > viewport.height * 1.1 ? "vertical" : "horizontal";
  const layoutItems = items.filter(
    (item) =>
      !isMarginalPageNumber(
        item.text,
        item.x,
        item.y,
        viewport.width,
        viewport.height,
        pageNumber,
      ),
  );
  const direction = detectDirection(layoutItems, fallbackDirection);
  const blocks = makeBlocks(layoutItems, direction, pageNumber);
  return {
    pageNumber,
    width: viewport.width,
    height: viewport.height,
    rotation: page.rotate,
    direction,
    textSource: "pdf-text",
    items,
    blocks,
  };
}

function detectDirection(
  items: PositionedTextItem[],
  fallbackDirection: ReadingDirection,
): ReadingDirection {
  if (items.length === 0) return fallbackDirection;
  const verticalCount = items.filter((item) => item.direction === "ttb").length;
  if (verticalCount / items.length >= 0.35) return "vertical";

  const tolerance = Math.max(
    2.5,
    median(items.map((item) => item.fontSize)) * 0.48,
  );
  const xBands = countCoordinateBands(
    items.map((item) => item.x),
    tolerance,
  );
  const yBands = countCoordinateBands(
    items.map((item) => item.y),
    tolerance,
  );
  const cjkItems = items.filter((item) =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(item.text),
  );
  const verticalGlyphRatio =
    cjkItems.length === 0
      ? 0
      : cjkItems.filter((item) => {
          if (Array.from(item.text.trim()).length !== 1) return false;
          const width = Math.max(Math.abs(item.width), 1);
          const height = Math.max(Math.abs(item.height), 1);
          return Math.max(width, height) / Math.min(width, height) <= 1.4;
        }).length / cjkItems.length;
  const horizontalRunRatio =
    cjkItems.length === 0
      ? 0
      : cjkItems.filter(
          (item) =>
            Array.from(item.text.trim()).length > 1 ||
            Math.abs(item.width) >
              Math.max(Math.abs(item.height) * 1.4, item.fontSize * 1.4),
        ).length / cjkItems.length;

  if (xBands < yBands * 0.8) return "vertical";
  if (horizontalRunRatio >= 0.6) return "horizontal";

  const coordinateBandsAreBalanced =
    Math.abs(xBands - yBands) <= Math.max(2, Math.max(xBands, yBands) * 0.2);
  if (coordinateBandsAreBalanced && verticalGlyphRatio >= 0.6)
    return "vertical";

  return "horizontal";
}

function makeBlocks(
  items: PositionedTextItem[],
  direction: ReadingDirection,
  pageNumber: number,
): SourceBlock[] {
  if (items.length === 0) return [];
  const typicalFontSize = median(items.map((item) => item.fontSize));
  const tolerance = Math.max(2.5, typicalFontSize * 0.48);

  if (direction === "vertical") {
    const columns: Array<{ x: number; items: PositionedTextItem[] }> = [];
    const inlineLatinItems = groupInlineLatinItems(
      items.filter(isInlineLatinItem),
      typicalFontSize,
    );
    const columnItems = items.filter((item) => !isInlineLatinItem(item));
    for (const item of [...columnItems].sort((a, b) => b.x - a.x)) {
      let column = columns.find(
        (candidate) => Math.abs(candidate.x - item.x) <= tolerance,
      );
      if (!column) {
        column = { x: item.x, items: [] };
        columns.push(column);
      }
      column.items.push(item);
      column.x =
        column.items.reduce((sum, value) => sum + value.x, 0) /
        column.items.length;
    }

    for (const item of inlineLatinItems) {
      const nearbyColumns = columns
        .map((column) => {
          const yDistance = Math.min(
            ...column.items.map((candidate) => Math.abs(candidate.y - item.y)),
          );
          return {
            column,
            yDistance,
            xDistance: Math.abs(column.x - item.x),
          };
        })
        .filter(
          ({ yDistance, xDistance }) =>
            yDistance <= Math.max(tolerance * 3, typicalFontSize * 1.5) &&
            xDistance <= Math.max(tolerance * 3, typicalFontSize * 1.5),
        )
        .sort((a, b) => a.yDistance - b.yDistance || a.xDistance - b.xDistance);
      const nearest = nearbyColumns[0]?.column;
      if (nearest) {
        nearest.items.push(item);
        nearest.x =
          nearest.items.reduce((sum, value) => sum + value.x, 0) /
          nearest.items.length;
      } else {
        columns.push({ x: item.x, items: [item] });
      }
    }

    columns.sort((a, b) => b.x - a.x);
    return columns.map((column, index) => {
      const ordered = [...column.items].sort(
        (a, b) => b.y - a.y || a.contentIndex - b.contentIndex,
      );
      const block = blockFromItems(
        ordered,
        pageNumber,
        index + 1,
        direction,
        column.x,
        typicalFontSize,
      );
      const nextColumn = columns[index + 1];
      if (nextColumn) block.visualGapAfter = Math.abs(column.x - nextColumn.x);
      return block;
    });
  }

  const rows: Array<{ y: number; items: PositionedTextItem[] }> = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    let row = rows.find(
      (candidate) => Math.abs(candidate.y - item.y) <= tolerance,
    );
    if (!row) {
      row = { y: item.y, items: [] };
      rows.push(row);
    }
    row.items.push(item);
    row.y =
      row.items.reduce((sum, value) => sum + value.y, 0) / row.items.length;
  }

  rows.sort((a, b) => b.y - a.y);
  return rows.map((row, index) => {
    const ordered = [...row.items].sort(
      (a, b) => a.x - b.x || a.contentIndex - b.contentIndex,
    );
    const block = blockFromItems(
      ordered,
      pageNumber,
      index + 1,
      direction,
      row.y,
      typicalFontSize,
    );
    const nextRow = rows[index + 1];
    if (nextRow) block.visualGapAfter = Math.abs(row.y - nextRow.y);
    return block;
  });
}

function isInlineLatinItem(item: PositionedTextItem): boolean {
  const text = item.text.trim();
  return text.length > 0 && /^[\p{Script=Latin}\p{Number}０-９]+$/u.test(text);
}

function groupInlineLatinItems(
  items: PositionedTextItem[],
  typicalFontSize: number,
): PositionedTextItem[] {
  const ordered = [...items].sort((a, b) => a.contentIndex - b.contentIndex);
  const groups: PositionedTextItem[] = [];
  let index = 0;

  while (index < ordered.length) {
    const first = ordered[index];
    if (!first) {
      index += 1;
      continue;
    }

    const run = [first];
    let previous = first;
    while (index + 1 < ordered.length) {
      const next = ordered[index + 1];
      if (!next) break;
      if (
        next.contentIndex - previous.contentIndex !== 1 ||
        Math.abs(next.x - previous.x) > typicalFontSize * 2 ||
        Math.abs(next.y - previous.y) > typicalFontSize * 1.25
      )
        break;
      run.push(next);
      previous = next;
      index += 1;
    }

    if (run.length === 1) {
      groups.push(first);
    } else {
      groups.push({
        ...first,
        id: run.map((item) => item.id).join("+"),
        text: run.map((item) => item.text).join(""),
        x: run.reduce((sum, item) => sum + item.x, 0) / run.length,
        y: run.reduce((sum, item) => sum + item.y, 0) / run.length,
        width: run.reduce((sum, item) => sum + item.width, 0),
        height: Math.max(...run.map((item) => item.height)),
        sourceItemIds: run.flatMap((item) => item.sourceItemIds ?? [item.id]),
      });
    }
    index += 1;
  }
  return groups;
}

function blockFromItems(
  items: PositionedTextItem[],
  pageNumber: number,
  orderOnPage: number,
  direction: ReadingDirection,
  axisPosition: number,
  typicalFontSize: number,
): SourceBlock {
  const speakerLabel =
    direction === "vertical"
      ? findSpeakerLabelFromSpacing(items, typicalFontSize)
      : undefined;
  const rawText = items.map((item) => item.text).join("");
  const speechText =
    speakerLabel && rawText.startsWith(speakerLabel)
      ? rawText.slice(speakerLabel.length).trimStart()
      : rawText;
  return {
    id: `p${pageNumber}-b${orderOnPage}`,
    pageNumber,
    orderOnPage,
    direction,
    rawText,
    text: speechText,
    x: direction === "vertical" ? axisPosition : (items[0]?.x ?? 0),
    y: direction === "vertical" ? (items[0]?.y ?? 0) : axisPosition,
    itemIds: items.flatMap((item) => item.sourceItemIds ?? [item.id]),
    fontSize: typicalFontSize,
    ...(direction === "vertical" &&
    items.some((item) => item.hasSidewaysHalfwidthKatakana)
      ? { hasSidewaysHalfwidthKatakana: true }
      : {}),
    ...(speakerLabel ? { speakerLabel } : {}),
  };
}

function findSpeakerLabelFromSpacing(
  items: PositionedTextItem[],
  typicalFontSize: number,
): string | undefined {
  let prefix = "";
  const gapThreshold = Math.max(5, typicalFontSize * 1.8);

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (index > 0) {
      const gap = items[index - 1].y - item.y;
      if (gap > gapThreshold) {
        return isShortRoleLabel(prefix) ? prefix : undefined;
      }
    }

    prefix += item.text;
    if (!isShortRoleLabel(prefix)) return undefined;
  }

  return undefined;
}

function isShortRoleLabel(value: string): boolean {
  const memberPattern =
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\p{Number}々ヶヵー・]{1,8}$/u;
  const members = value
    .trim()
    .split(/[、,，&＆/／\u3400-\u4dbf]/u)
    .map((member) => member.trim());
  return (
    members.length > 0 && members.every((member) => memberPattern.test(member))
  );
}

function countCoordinateBands(values: number[], tolerance: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  let bands = 0;
  let center = Number.NEGATIVE_INFINITY;
  let count = 0;

  for (const value of ordered) {
    if (count === 0 || Math.abs(value - center) > tolerance) {
      bands += 1;
      center = value;
      count = 1;
      continue;
    }
    center += (value - center) / (count + 1);
    count += 1;
  }
  return bands;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
