// SSE registry: id -> { res, ip, ua, since }
const clients = new Map();

function safeRemove(id) {
  const c = clients.get(id);
  if (!c) return;
  try {
    c.res.end();
  } catch {}
  clients.delete(id);
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  console.log("Data", data);
  for (const [id, c] of clients) {
    try {
      c.res.write("event: message\n");
      c.res.write(data);
    } catch (e) {
      console.error("SSE writer error, отключаю клиента:", id, e?.message);
      safeRemove(id);
    }
  }
  console.log(`📡 SSE: отправлено ${clients.size} клиентам`);
  dumpClients(50);
}

// Временная отладка: вывести список активных клиентов (первые max штук)
function dumpClients(max = 50) {
  // console.log(`[SSE] Активных клиентов: ${clients.size}`);
  let i = 0;
  for (const [id, c] of clients) {
    if (i++ >= max) {
      // console.log(`[SSE] ...и ещё ${clients.size - max} клиентов`);
      break;
    }
    const sinceIso = new Date(c.since).toISOString();
    // user-agent длинный — чуть укоротим
    const uaShort = (c.ua || "").slice(0, 90);
    // console.log(`[SSE] id=${id} ip=${c.ip} since=${sinceIso} ua="${uaShort}"`);
  }
}

function sseHandler(req, res) {
  // Заголовки SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders && res.flushHeaders();

  // Метаданные клиента
  const id = Date.now() + Math.random();
  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "";
  const ua = req.headers["user-agent"] || "";

  clients.set(id, { res, ip, ua, since: Date.now() });
  console.log(
    `📡 SSE: клиент подключен (${id}, ip=${ip}). Всего: ${clients.size}`
  );

  // Приветственное сообщение
  res.write("event: message\n");
  res.write(`data: ${JSON.stringify({ message: "Подключено к SSE" })}\n\n`);

  // Пульс, чтобы соединение не простаивало и не рвалось прокси
  const HEARTBEAT_MS = 25_000;
  const hb = setInterval(() => {
    try {
      // Комментарий в SSE — не триггерит onmessage на клиенте
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      // Если запись упала — закрываем клиента
      clearInterval(hb);
      safeRemove(id);
    }
  }, HEARTBEAT_MS);

  function onClose(why) {
    clearInterval(hb);
    console.log(
      `📴 SSE: клиент отключен (${id}, причина=${why}). Осталось: ${
        clients.size - 1
      }`
    );
    safeRemove(id);
  }

  // ВАЖНО: удаляем клиента при любых завершениях/ошибках
  req.on("close", () => onClose("req.close"));
  req.on?.("aborted", () => onClose("req.aborted"));
  res.on?.("close", () => onClose("res.close"));
  res.on?.("finish", () => onClose("res.finish"));
  res.on?.("error", (e) => {
    console.warn(`SSE res error (${id}):`, e?.message);
    onClose("res.error");
  });
}

module.exports = { sseHandler, broadcast, dumpClients };
