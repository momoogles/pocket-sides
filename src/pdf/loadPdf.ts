// PDF.js setup and document loading stay together at the file boundary.
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { extractSourcePage } from "./extractSourcePage";
import { fingerprintPdf } from "./fingerprintPdf";
import type { SourcePage } from "./sourcePage";

GlobalWorkerOptions.workerSrc = workerUrl;

export async function loadPdf(
  file: File,
  onProgress: (pageNumber: number, pageCount: number) => void,
): Promise<{
  document: PDFDocumentProxy;
  pages: SourcePage[];
  fingerprint: string | null;
  dispose: () => Promise<void>;
}> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fingerprintPromise = fingerprintPdf(bytes);
  const task = getDocument({
    data: bytes,
    cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
    cMapPacked: true,
    iccUrl: `${import.meta.env.BASE_URL}iccs/`,
    standardFontDataUrl: `${import.meta.env.BASE_URL}standard_fonts/`,
    wasmUrl: `${import.meta.env.BASE_URL}wasm/`,
    useSystemFonts: true,
  });

  const document = await task.promise;
  const pages: SourcePage[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      pages.push(await extractSourcePage(page, pageNumber));
      onProgress(pageNumber, document.numPages);
    }
  } catch (error) {
    await task.destroy();
    throw error;
  }

  return {
    document,
    pages,
    fingerprint: await fingerprintPromise,
    dispose: () => task.destroy(),
  };
}
