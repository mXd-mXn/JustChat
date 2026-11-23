import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { roomRepo } from './temp_db.js';
import { userRepo } from './accounts_db.js';

const PORT = 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'justchat-local-secret-change-in-prod';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 днів
const AVATARS_DIR = path.join(process.cwd(), 'uploads', 'avatars');

await fs.mkdir(AVATARS_DIR, { recursive: true });

// Хешування паролів кімнат (RAM)
function hashRoomPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Хешування паролів акаунтів (Disk)
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

// Підписані токени сесії (витримують перезапуск сервера під час розробки)
function createSessionToken(userId) {
  const payload = Buffer.from(
    JSON.stringify({ userId, exp: Date.now() + SESSION_TTL_MS })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;

  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.userId || !data.exp || data.exp < Date.now()) return null;
    return userRepo.getUserById(data.userId) || null;
  } catch {
    return null;
  }
}

function getAuthenticatedUserFromRequest(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return verifySessionToken(token);
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatar_path: user.avatar_path
  };
}

function sendHttpJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 1e5) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error('Занадто великий файл або запит'));
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

// 1. HTTP-сервер
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const cleanUrl = parsedUrl.pathname;

  // Реєстрація
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
      const token = createSessionToken(createdUser.id);
      return sendHttpJson(res, 201, { token, user: sanitizeUser(createdUser) });
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

  // Вхід за нікнеймом
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

      const token = createSessionToken(user.id);
      return sendHttpJson(res, 200, { token, user: sanitizeUser(user) });
    } catch (err) {
      return sendHttpJson(res, 400, { error: err.message || 'Помилка входу' });
    }
  }

  // Завантаження аватарки (тільки для авторизованих)
  if (req.method === 'POST' && cleanUrl === '/api/avatar') {
    const user = getAuthenticatedUserFromRequest(req);
    if (!user) {
      return sendHttpJson(res, 401, { error: 'Сесія недійсна. Увійди знову' });
    }

    try {
      // Дозволяємо до ~4.5 МБ Base64 (~3 МБ зображення)
      const body = await readJsonBody(req, 4.5 * 1024 * 1024);
      const imageData = String(body.image || '');

      const match = imageData.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!match) {
        return sendHttpJson(res, 400, { error: 'Підтримуються лише PNG, JPG або WebP' });
      }

      const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      const buffer = Buffer.from(match[2], 'base64');

      if (buffer.length > 3 * 1024 * 1024) {
        return sendHttpJson(res, 400, { error: 'Максимальний розмір аватарки — 3 МБ' });
      }

      const fileName = `user-${user.id}-${Date.now()}.${ext}`;
      const fullPath = path.join(AVATARS_DIR, fileName);
      await fs.writeFile(fullPath, buffer);

      // Видаляємо старий файл аватарки, щоб не засмічувати диск
      if (user.avatar_path && user.avatar_path.startsWith('/uploads/avatars/')) {
        const oldFile = path.join(AVATARS_DIR, path.basename(user.avatar_path));
        await fs.unlink(oldFile).catch(() => {});
      }

      const publicUrl = `/uploads/avatars/${fileName}`;
      userRepo.updateAvatar(user.id, publicUrl);

      const updatedUser = userRepo.getUserById(user.id);
      return sendHttpJson(res, 200, { user: sanitizeUser(updatedUser) });
    } catch (err) {
      return sendHttpJson(res, 400, { error: err.message || 'Не вдалося зберегти аватарку' });
    }
  }

  // Роздача завантажених аватарок
  if (req.method === 'GET' && cleanUrl.startsWith('/uploads/avatars/')) {
    const requestedFile = path.basename(cleanUrl);
    const filePath = path.join(AVATARS_DIR, requestedFile);

    try {
      const data = await fs.readFile(filePath);
      let contentType = 'application/octet-stream';
      if (filePath.endsWith('.png')) contentType = 'image/png';
      if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) contentType = 'image/jpeg';
      if (filePath.endsWith('.webp')) contentType = 'image/webp';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(data);
      return;
    } catch {
      res.writeHead(404);
      res.end('Avatar not found');
      return;
    }
  }

  // Роздача статики клієнта
  const clientDir = path.join(process.cwd(), 'src', 'client');
  let filePath = path.join(clientDir, cleanUrl === '/' ? 'index.html' : cleanUrl);

  if (!filePath.startsWith(clientDir)) {
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

// 2. WebSocket-сервер із перевіркою токена
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
  const username = ws.user?.username;
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

wss.on('connection', (ws, req) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const token = parsedUrl.searchParams.get('token');
  const authenticatedUser = verifySessionToken(token);

  if (!authenticatedUser) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  ws.roomId = null;
  ws.user = sanitizeUser(authenticatedUser);

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

    // Оновлення кешованого профілю в сокеті після зміни аватарки
    if (data.type === 'refresh_profile') {
      const freshUser = userRepo.getUserById(ws.user.id);
      if (freshUser) {
        ws.user = sanitizeUser(freshUser);
      }
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

      // Підтягуємо актуальні аватарки авторів для історії кімнати
      const history = roomRepo.getMessages(room.id).map((m) => ({
        sender: m.sender,
        text: m.text,
        created_at: m.created_at,
        avatar: userRepo.getUserByUsername(m.sender)?.avatar_path || null
      }));

      sendJson(ws, {
        type: 'joined_room',
        room: { id: room.id, name: room.name },
        history
      });

      broadcastToRoom(room.id, {
        type: 'system',
        text: `${ws.user.username} приєднався до кімнати`
      });

      broadcastRoomsList();
      return;
    }

    if (data.type === 'message') {
      if (!ws.roomId || !ws.user) return;
      const text = String(data.text || '').trim();
      if (!text) return;

      // Автор береться виключно із перевіреної сесії ws.user
      roomRepo.addMessage(ws.roomId, ws.user.username, text);
      broadcastToRoom(ws.roomId, {
        type: 'message',
        sender: ws.user.username,
        avatar: ws.user.avatar_path,
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