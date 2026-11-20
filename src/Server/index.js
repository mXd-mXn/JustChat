import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { roomRepo } from './temp_db.js';
import { userRepo } from './accounts_db.js';

const PORT = 3000;

// Хешування паролів кімнат (швидке, для RAM)
function hashRoomPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Надійне хешування паролів акаунтів із сіллю (для постійної БД)
function hashAccountPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyAccountPassword(password, storedHash) {
  const [salt, key] = String(storedHash || '').split(':');
  if (!salt || !key) return false;

  const keyBuffer = Buffer.from(key, 'hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  if (keyBuffer.length !== derivedKey.length) return false;

  return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

function sendHttpJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e5) {
        reject(new Error('Занадто великий запит'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Некоректний JSON'));
      }
    });
    req.on('error', reject);
  });
}

// 1. HTTP-сервер (API авторизації + роздача статики)
const server = http.createServer(async (req, res) => {
  const cleanUrl = (req.url || '/').split('?')[0];

  // Реєстрація користувача
  if (req.method === 'POST' && cleanUrl === '/api/register') {
    try {
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (username.length < 2 || username.length > 24) {
        return sendHttpJson(res, 400, { error: 'Нікнейм має містити від 2 до 24 символів' });
      }
      if (!email.endsWith('@proton.me') || email.length <= '@proton.me'.length) {
        return sendHttpJson(res, 400, { error: 'Потрібна пошта у форматі @proton.me' });
      }
      if (password.length < 6) {
        return sendHttpJson(res, 400, { error: 'Пароль має містити щонайменше 6 символів' });
      }

      const passwordHash = hashAccountPassword(password);
      userRepo.createUser(username, email, passwordHash);

      const createdUser = userRepo.getUserByEmail(email);
      return sendHttpJson(res, 201, {
        user: {
          id: createdUser.id,
          username: createdUser.username,
          email: createdUser.email,
          avatar_path: createdUser.avatar_path
        }
      });
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || String(err.message).includes('UNIQUE')) {
        const msg = String(err.message).includes('users.email')
          ? 'Користувач із такою поштою вже існує'
          : 'Цей нікнейм уже зайнятий';
        return sendHttpJson(res, 409, { error: msg });
      }
      return sendHttpJson(res, 400, { error: err.message || 'Помилка реєстрації' });
    }
  }

  // Вхід користувача
  if (req.method === 'POST' && cleanUrl === '/api/login') {
    try {
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');

      if (!username || !password) {
        return sendHttpJson(res, 400, { error: 'Введи нікнейм та пароль' });
      }

        const user = userRepo.getUserByUsername(username);
        if (!user || !verifyAccountPassword(password, user.password_hash)) {
          return sendHttpJson(res, 401, { error: 'Невірний нікнейм або пароль' });
        }

      return sendHttpJson(res, 200, {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          avatar_path: user.avatar_path
        }
      });
    } catch (err) {
      return sendHttpJson(res, 400, { error: err.message || 'Помилка входу' });
    }
  }

  // Роздача статичних файлів із src/client
  let filePath = path.join(
    process.cwd(),
    'src',
    'client',
    cleanUrl === '/' ? 'index.html' : cleanUrl
  );

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

    let contentType = 'text/html; charset=utf-8';
    if (filePath.endsWith('.css')) contentType = 'text/css; charset=utf-8';
    if (filePath.endsWith('.js')) contentType = 'application/javascript; charset=utf-8';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

// 2. WebSocket-сервер і логіка кімнат у RAM
const wss = new WebSocketServer({ server });

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function getRoomUsersCount(roomId) {
  let count = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.roomId === roomId) {
      count++;
    }
  }
  return count;
}

function broadcastRoomsList() {
  const rooms = roomRepo.getAllRooms().map((room) => ({
    ...room,
    usersCount: getRoomUsersCount(room.id)
  }));

  for (const client of wss.clients) {
    sendJson(client, { type: 'rooms_list', rooms });
  }
}

function broadcastToRoom(roomId, payload) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.roomId === roomId) {
      sendJson(client, payload);
    }
  }
}

function leaveCurrentRoom(ws) {
  const prevRoomId = ws.roomId;
  const username = ws.username;
  if (!prevRoomId) return;

  ws.roomId = null;
  const remainingUsers = getRoomUsersCount(prevRoomId);

  if (remainingUsers === 0) {
    roomRepo.deleteRoom(prevRoomId);
    console.log(`🗑️ Кімната ${prevRoomId} видалена з RAM (0 учасників)`);
  } else if (username) {
    broadcastToRoom(prevRoomId, {
      type: 'system',
      text: `${username} вийшов із кімнати`
    });
  }

  broadcastRoomsList();
}

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.username = null;

  const initialRooms = roomRepo.getAllRooms().map((room) => ({
    ...room,
    usersCount: getRoomUsersCount(room.id)
  }));
  sendJson(ws, { type: 'rooms_list', rooms: initialRooms });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.type === 'create_room') {
      const name = String(data.name || '').trim();
      if (!name) return;

      const id = `room-${crypto.randomBytes(4).toString('hex')}`;
      const passwordHash = data.password ? hashRoomPassword(String(data.password)) : null;

      roomRepo.createRoom(id, name, passwordHash);
      broadcastRoomsList();
      return;
    }

    if (data.type === 'join_room') {
      const room = roomRepo.getRoom(data.roomId);
      if (!room) {
        sendJson(ws, { type: 'error', scope: 'rooms', text: 'Кімнату не знайдено або її вже видалено' });
        broadcastRoomsList();
        return;
      }

      if (room.password_hash) {
        const enteredHash = data.password ? hashRoomPassword(String(data.password)) : '';
        if (enteredHash !== room.password_hash) {
          sendJson(ws, { type: 'error', scope: 'rooms', text: 'Невірний пароль кімнати' });
          return;
        }
      }

      leaveCurrentRoom(ws);

      ws.roomId = room.id;
      ws.username = String(data.username || 'anon').trim();

      const history = roomRepo.getMessages(room.id);
      sendJson(ws, {
        type: 'joined_room',
        room: { id: room.id, name: room.name },
        history
      });

      broadcastToRoom(room.id, {
        type: 'system',
        text: `${ws.username} приєднався до кімнати`
      });

      broadcastRoomsList();
      return;
    }

    if (data.type === 'message') {
      if (!ws.roomId || !ws.username) return;
      const text = String(data.text || '').trim();
      if (!text) return;

      roomRepo.addMessage(ws.roomId, ws.username, text);
      broadcastToRoom(ws.roomId, {
        type: 'message',
        sender: ws.username,
        text
      });
      return;
    }

    if (data.type === 'leave_room') {
      leaveCurrentRoom(ws);
    }
  });

  ws.on('close', () => {
    leaveCurrentRoom(ws);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Сервер запущено: http://localhost:${PORT}`);
});