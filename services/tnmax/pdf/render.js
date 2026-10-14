// Рендер docDefinition → PDF (pdfmake Node-API) и PDF → PNG (pdftoppm/poppler) с обрезкой белых полей.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const pdfmake = require("pdfmake");
const { trimWhiteMargins } = require("./trim");

// pdfmake — синглтон; настраиваем один раз при первом использовании.
let pdfmakeReady = false;
function ensurePdfmake() {
  if (pdfmakeReady) return;

  const fontsDir = path.join(path.dirname(require.resolve("pdfmake")), "..", "fonts", "Roboto");
  pdfmake.addFonts({
    Roboto: {
      normal: path.join(fontsDir, "Roboto-Regular.ttf"),
      bold: path.join(fontsDir, "Roboto-Medium.ttf"),
      italics: path.join(fontsDir, "Roboto-Italic.ttf"),
      bolditalics: path.join(fontsDir, "Roboto-MediumItalic.ttf"),
    },
  });
  pdfmake.setLocalAccessPolicy((p) => p.includes("node_modules"));
  pdfmake.setUrlAccessPolicy(() => false);

  pdfmakeReady = true;
}

async function docToPdfBuffer(docDefinition) {
  ensurePdfmake();
  const doc = { ...docDefinition };
  doc.defaultStyle = { font: "Roboto", ...(doc.defaultStyle || {}) };
  const buffer = await pdfmake.createPdf(doc).getBuffer();
  return Buffer.from(buffer);
}

// PDF → PNG-страницы через pdftoppm (poppler-utils), 150 dpi.
async function pdfToPngs(pdfBuffer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maxpdf-"));
  try {
    const pdfPath = path.join(tmpDir, "in.pdf");
    const outPrefix = path.join(tmpDir, "out");
    fs.writeFileSync(pdfPath, pdfBuffer);

    await new Promise((resolve, reject) => {
      execFile(
        "pdftoppm",
        ["-png", "-r", "150", pdfPath, outPrefix],
        { timeout: 60000 },
        (error) => {
          if (!error) return resolve();
          if (error.code === "ENOENT") {
            return reject(new Error("pdftoppm не установлен (apt/brew install poppler-utils)"));
          }
          return reject(error);
        }
      );
    });

    const names = fs
      .readdirSync(tmpDir)
      .filter((name) => name.startsWith("out-") && name.endsWith(".png"))
      .sort((a, b) => {
        // Числовая сортировка: out-2.png < out-10.png (лексикографическая сломала бы порядок).
        const na = Number(/(\d+)/.exec(a)?.[1] ?? 0);
        const nb = Number(/(\d+)/.exec(b)?.[1] ?? 0);
        return na - nb;
      });

    return names.map((name) => trimWhiteMargins(fs.readFileSync(path.join(tmpDir, name))));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = {
  docToPdfBuffer,
  pdfToPngs,
};
