import http from 'http';
import path from 'path';
import { promises as fs } from 'fs';
import { WebSocketServer } from 'ws';

const PORT = 3000;

const server = http.createServer(async (req, res) => {
  let filePath = path.join(process.cwd(), 'src', 'client', req.url === '/' ? 'index.html' : req.url);
  
  if (!filePath.startsWith(path.join(process.cwd(), 'src', 'client'))) {
    res.writeHead(403);
    res.end('Access denied');
    return;
  }

  try {
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    const data = await fs.readFile(filePath);
    
    let contentType = 'text/html';
    if (filePath.endsWith('.css')) contentType = 'text/css';
    if (filePath.endsWith('.js')) contentType = 'application/javascript';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Новий користувач підключився по WebSocket');

  ws.on('message', (message) => {
    console.log(`Отримано повідомлення: ${message}`);
    // Тут згодом буде логіка кімнат та ефемерних повідомлень
  });

  ws.on('close', () => {
    console.log('Користувач відключився');
  });
});

server.listen(PORT, () => {
  console.log(`Сервер запущено! http://localhost:${PORT}`);
});