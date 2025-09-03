const clients = new Map();

function safeRemove(id, res) {
  try {
    res.end();
  } catch {}
  clients.delete(id);
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  console.log("Data", data);
  for (const [id, res] of clients) {
    try {
      res.write("event: message\n");
      // res.write(data);
      res.write(123);
    } catch (e) {
      console.error("SSE writer error, отключаю клиента:", id, e?.message);
      safeRemove(id, res);
    }
  }
  console.log(`📡 SSE: отправленоооооооооо ${clients.size} клиентам`);
}

function sseHandler(req, res) {
  // Заголовки SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders && res.flushHeaders();

  const id = Date.now() + Math.random();
  clients.set(id, res);
  console.log(
    `📡 SSE: клиент подключен (${id}). Всего клиентов: ${clients.size}`
  );

  // Приветственное сообщение
  res.write("event: message\n");
  res.write(`data: ${JSON.stringify({ message: "Подключено к SSE" })}\n\n`);

  req.on("close", () => {
    console.log(`📴 SSE: клиент отключен (${id})`);
    safeRemove(id, res);
  });
}

module.exports = { sseHandler, broadcast };
