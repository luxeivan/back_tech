// Превью-страницы (og:image) для ссылочных аттачей VK + раздача press-картинок.
// Зеркало поста в VK прикрепляет ссылку на /services/vk/preview — VK-краулер
// забирает og:image и рисует карточку с картинкой (нативный photo-upload
// сообществу API VK не даёт — см. диагностику 23.11.2026).
const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const router = express.Router();

// Только простые имена файлов — никаких путей (path traversal).
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ASSETS_DIR = path.join(__dirname, "../assets");
const EXT_CT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function previewBase() {
  return String(process.env.VK_PREVIEW_BASE || "https://jtv.mosoblenergo.ru").replace(
    /\/$/,
    ""
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// GET /services/vk/img/<file>: assets/ (аварийная) или прокси Strapi /uploads (плановая).
router.get("/img/:file", async (req, res) => {
  const file = String(req.params.file || "");
  if (!FILE_RE.test(file)) return res.status(400).send("bad file");
  const contentType = EXT_CT[path.extname(file).toLowerCase()];
  if (!contentType) return res.status(400).send("bad ext");

  const local = path.join(ASSETS_DIR, file);
  if (fs.existsSync(local)) {
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    return fs.createReadStream(local).pipe(res);
  }

  try {
    const base = String(process.env.URL_STRAPI || "").replace(/\/$/, "");
    const upstream = await axios.get(`${base}/uploads/${file}`, {
      responseType: "stream",
      timeout: 20000,
    });
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers["content-type"] || contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    upstream.data.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(404).send("not found");
  }
});

// GET /services/vk/preview?img=<file>&title=<text> — HTML с og:image для VK.
router.get("/preview", (req, res) => {
  const file = String(req.query.img || "");
  const title = String(req.query.title || "Мособлэнерго").slice(0, 200);
  if (!FILE_RE.test(file)) return res.status(400).send("bad file");

  const imageUrl = `${previewBase()}/services/vk/img/${encodeURIComponent(file)}`;
  const t = escapeHtml(title);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${t}</title>
<meta property="og:title" content="${t}">
<meta property="og:type" content="article">
<meta property="og:image" content="${imageUrl}">
</head>
<body>${t}</body>
</html>`
  );
});

module.exports = router;
