// Normalize text extracted from PDF and OCR.

const SMALL_YOON_FOR_FULL: Record<string, string> = {
  や: "ゃ",
  ゆ: "ゅ",
  よ: "ょ",
  ヤ: "ャ",
  ユ: "ュ",
  ヨ: "ョ",
};

export function normalizeScriptText(value: string): string {
  return value
    .trim()
    .replace(/([\uff66-\uff9f])\s+(?=[\uff66-\uff9f])/gu, "$1")
    .replace(
      /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵー0-9０-９])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵー0-9０-９])/gu,
      "$1",
    )
    .replace(
      /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵー・]{1,8})\s+([\p{Script=Latin}\p{Number}０-９]{1,3})(?=\s*[「『（(【])/gu,
      "$1$2",
    )
    .replace(
      /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵー・]{1,8}[\p{Script=Latin}\p{Number}０-９]{1,3})\s+(?=[「『（(【])/gu,
      "$1",
    )
    .replace(
      /(?<![\p{Script=Latin}])\p{Script=Latin}(?:\s+\p{Script=Latin}){1,}(?![\p{Script=Latin}])/gu,
      (letters) => letters.replace(/\s+/gu, ""),
    )
    .replace(
      /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵー])\s+(?=[\p{Script=Latin}\p{Number}０-９])/gu,
      "$1",
    )
    .replace(
      /([\p{Script=Latin}\p{Number}０-９])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵー])/gu,
      "$1",
    )
    .replace(/\s+([」』）)】、。，．,!?！？:：…])/gu, "$1")
    .replace(/([「『（(【])\s+/gu, "$1")
    .replace(
      /([。．.!！?？、，…」』）)\]】：:；;])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵー0-9０-９])/gu,
      "$1",
    )
    .replace(/[?？](?:\s*[?？])+/gu, "？")
    .replace(/[!！](?:\s*[!！])+/gu, "！")
    .replace(
      /([きぎしじちぢにひびぴみりキギシジチヂニヒビピミリ])ー([ゃゅょャュョ])/gu,
      "$1$2ー",
    )
    .replace(
      /\(([^()\n]*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][^()\n]*)\)/gu,
      "（$1）",
    )
    .replace(/[.．]\s*(?=[…⋯])/gu, "")
    .replace(
      /([きしちにひみりぎじぢびぴキシチニヒミリギジヂビピ])([ゃゅょャュョ])([ー〜])\1([やゆよヤユヨ])\3/gu,
      (
        match,
        firstBase: string,
        firstSmall: string,
        mark: string,
        secondFull: string,
      ) => {
        return SMALL_YOON_FOR_FULL[secondFull] === firstSmall
          ? `${firstBase}${firstSmall}${mark}${firstBase}${firstSmall}${mark}`
          : match;
      },
    )
    .replace(
      /([きしちにひみりぎじぢびぴキシチニヒミリギジヂビピ])([やゆよヤユヨ])([ー〜])\1([ゃゅょャュョ])\3/gu,
      (
        match,
        firstBase: string,
        firstFull: string,
        mark: string,
        secondSmall: string,
      ) => {
        return SMALL_YOON_FOR_FULL[firstFull] === secondSmall
          ? `${firstBase}${secondSmall}${mark}${firstBase}${secondSmall}${mark}`
          : match;
      },
    );
}

export function normalizeScriptPunctuation(
  value: string,
  speakerLabel?: string,
): string {
  let normalized = normalizeScriptText(value);
  const label = speakerLabel ? normalizeScriptText(speakerLabel) : "";

  let markerIndex = label && normalized.startsWith(label) ? label.length : 0;
  while (/\s/u.test(normalized[markerIndex] ?? "")) markerIndex += 1;
  const marker = Array.from(normalized.slice(markerIndex))[0] ?? "";
  if (label && isAmbiguousSpeakerQuoteMarker(marker)) {
    normalized = `${normalized.slice(0, markerIndex)}「${normalized.slice(markerIndex + marker.length)}`;
  }

  const japaneseCharacter = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵ]`;
  const verticalStrokes = `[|｜│┃︱︳∣丨]`;
  return normalized
    .replace(/[~～]/gu, "〜")
    .replace(
      /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵ])\s+(?=〜)/gu,
      "$1",
    )
    .replace(
      /〜\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵ])/gu,
      "〜",
    )
    .replace(
      new RegExp(
        `(${japaneseCharacter})\\s*${verticalStrokes}\\s*(?=${japaneseCharacter})`,
        "gu",
      ),
      "$1ー",
    )
    .replace(
      new RegExp(
        `(${japaneseCharacter})\\s*${verticalStrokes}\\s*(?=[…⋯])`,
        "gu",
      ),
      "$1ー",
    )
    .replace(new RegExp(`(ー)\\s*${verticalStrokes}\\s*(?=[…⋯])`, "gu"), "$1")
    .replace(
      /([きぎしじちぢにひびぴみりキギシジチヂニヒビピミリ])ー([ゃゅょャュョ])/gu,
      "$1$2ー",
    );
}

function isAmbiguousSpeakerQuoteMarker(character: string): boolean {
  return /[「『“"|｜│┃︱︳∣丨:：－―—–‐‑−─━-]/u.test(character);
}
