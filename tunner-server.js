const http = require("http");
const WebSocket = require("ws");

const server = http.createServer();
const wss = new WebSocket.Server({ server });

let tunnel = null;

wss.on("connection", (ws) => {
  console.log("Local agent connected");

  tunnel = ws;

  ws.on("close", () => {
    if (tunnel === ws) {
      tunnel = null;
    }

    console.log("Local agent disconnected");
  });

  ws.on("message", (message) => {
    console.log("Received:", message.toString());
  });
});

server.listen(8080, () => {
  console.log("Tunnel server listening on 8080");
});