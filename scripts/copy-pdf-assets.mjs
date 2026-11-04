import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/pdfjs-dist");
const publicDir = resolve(root, "public");
const tesseractPackage = resolve(root, "node_modules/tesseract.js");
const tesseractManifest = JSON.parse(
  await readFile(resolve(tesseractPackage, "package.json"), "utf8"),
);
const coreVersion = tesseractManifest.dependencies["tesseract.js-core"].replace(
  /^[^0-9]*/u,
  "",
);
const storeDir = resolve(root, "node_modules/.pnpm");
const coreStoreEntry = (await readdir(storeDir)).find((entry) =>
  entry.startsWith(`tesseract.js-core@${coreVersion}`),
);
if (!coreStoreEntry)
  throw new Error("tesseract.js-core のファイルが見つかりません。");
const tesseractCore = resolve(
  storeDir,
  coreStoreEntry,
  "node_modules/tesseract.js-core",
);

await mkdir(publicDir, { recursive: true });
await Promise.all(
  ["cmaps", "standard_fonts", "iccs", "wasm"].map(async (folder) => {
    const destination = resolve(publicDir, folder);
    await rm(destination, { recursive: true, force: true });
    await cp(resolve(source, folder), destination, { recursive: true });
  }),
);

const licensesDir = resolve(publicDir, "licenses");
await rm(licensesDir, { recursive: true, force: true });
const licenseDir = resolve(licensesDir, "pdfjs");
await mkdir(licenseDir, { recursive: true });
await cp(
  resolve(root, "LICENSE"),
  resolve(licensesDir, "pocket-sides-MIT.txt"),
);
const licenseFiles = [
  ["LICENSE", "LICENSE.txt"],
  ["cmaps/LICENSE", "cmaps-LICENSE.txt"],
  ["iccs/LICENSE", "iccs-LICENSE.txt"],
  ["standard_fonts/LICENSE_FOXIT", "standard-fonts-FOXIT.txt"],
  ["standard_fonts/LICENSE_LIBERATION", "standard-fonts-LIBERATION.txt"],
  ["wasm/LICENSE_JBIG2", "wasm-JBIG2.txt"],
  ["wasm/LICENSE_OPENJPEG", "wasm-OPENJPEG.txt"],
  ["wasm/LICENSE_QCMS", "wasm-QCMS.txt"],
  ["wasm/LICENSE_PDFJS_JBIG2", "wasm-PDFJS-JBIG2.txt"],
  ["wasm/LICENSE_PDFJS_OPENJPEG", "wasm-PDFJS-OPENJPEG.txt"],
  ["wasm/LICENSE_PDFJS_QCMS", "wasm-PDFJS-QCMS.txt"],
];
await Promise.all(
  licenseFiles.map(([from, to]) =>
    cp(resolve(source, from), resolve(licenseDir, to)),
  ),
);

const ocrDir = resolve(publicDir, "ocr");
await rm(ocrDir, { recursive: true, force: true });
const coreDir = resolve(ocrDir, "core");
const languageDir = resolve(ocrDir, "languages");
await Promise.all([
  mkdir(coreDir, { recursive: true }),
  mkdir(languageDir, { recursive: true }),
]);
await cp(
  resolve(tesseractPackage, "dist/worker.min.js"),
  resolve(ocrDir, "worker.min.js"),
);
await cp(
  resolve(tesseractPackage, "dist/worker.min.js.LICENSE.txt"),
  resolve(ocrDir, "worker.min.js.LICENSE.txt"),
);
const coreFiles = [
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-lstm.wasm",
  "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm",
  "tesseract-core-relaxedsimd-lstm.wasm.js",
  "tesseract-core-relaxedsimd-lstm.wasm",
];
await Promise.all(
  coreFiles.map((file) =>
    cp(resolve(tesseractCore, file), resolve(coreDir, file)),
  ),
);
await Promise.all(
  ["jpn.traineddata.gz", "jpn_vert.traineddata.gz"].map((file) =>
    cp(resolve(root, "vendor/ocr/languages", file), resolve(languageDir, file)),
  ),
);

const tesseractLicensesDir = resolve(licenseDir, "tesseract");
await rm(tesseractLicensesDir, { recursive: true, force: true });
await mkdir(tesseractLicensesDir, { recursive: true });
await Promise.all([
  cp(
    resolve(tesseractPackage, "LICENSE.md"),
    resolve(tesseractLicensesDir, "tesseract.js-LICENSE.md"),
  ),
  cp(
    resolve(tesseractCore, "LICENSE"),
    resolve(tesseractLicensesDir, "tesseract.js-core-LICENSE.txt"),
  ),
  cp(
    resolve(root, "vendor/ocr/LICENSE"),
    resolve(tesseractLicensesDir, "tessdata_fast-LICENSE.txt"),
  ),
  cp(
    resolve(tesseractPackage, "dist/tesseract.min.js.LICENSE.txt"),
    resolve(tesseractLicensesDir, "tesseract.js-NOTICES.txt"),
  ),
  cp(
    resolve(
      root,
      "vendor/ocr/licenses",
      `tesseract.js-${tesseractManifest.version}-THIRD-PARTY-NOTICES.txt`,
    ),
    resolve(tesseractLicensesDir, "THIRD-PARTY-NOTICES.txt"),
  ),
]);
