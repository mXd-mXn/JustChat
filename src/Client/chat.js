const rawSession = sessionStorage.getItem('justchat_session');
if (!rawSession) {
  window.location.href = '/auth.html';
}

const session = JSON.parse(rawSession);
if (!session?.token || !session?.user) {
  sessionStorage.removeItem('justchat_session');
  window.location.href = '/auth.html';
}

let currentUser = session.user;

const avatarBtn = document.getElementById('avatar-btn');
const avatarInput = document.getElementById('avatar-input');
const currentUserLabel = document.getElementById('current-user-label');
const logoutBtn = document.getElementById('logout-btn');

const roomsScreen = document.getElementById('rooms-screen');
const chatScreen = document.getElementById('chat-screen');

const toggleCreateRoomBtn = document.getElementById('toggle-create-room-btn');
const createRoomForm = document.getElementById('create-room-form');
const cancelCreateRoomBtn = document.getElementById('cancel-create-room-btn');
const newRoomNameInput = document.getElementById('new-room-name');
const newRoomPrivateCheckbox = document.getElementById('new-room-private');
const newRoomPasswordWrap = document.getElementById('new-room-password-wrap');
const newRoomPasswordInput = document.getElementById('new-room-password');
const roomsListEl = document.getElementById('rooms-list');
const roomsError = document.getElementById('rooms-error');

const roomPasswordModal = document.getElementById('room-password-modal');
const modalRoomTitle = document.getElementById('modal-room-title');
const roomPasswordForm = document.getElementById('room-password-form');
const joinRoomPasswordInput = document.getElementById('join-room-password');
const cancelRoomPasswordBtn = document.getElementById('cancel-room-password-btn');

const currentRoomTitle = document.getElementById('current-room-title');
const statusBadge = document.getElementById('status-badge');
const leaveRoomBtn = document.getElementById('leave-room-btn');
const messagesBox = document.getElementById('messages-box');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

function renderAvatarContent(container, username, avatarUrl) {
  container.innerHTML = '';
  if (avatarUrl) {
    const img = document.createElement('img');
    img.src = avatarUrl;
    img.alt = username;
    container.appendChild(img);
  } else {
    container.textContent = (username || '?')[0].toUpperCase();
  }
}

function updateProfileUI() {
  currentUserLabel.textContent = `@${currentUser.username}`;
  renderAvatarContent(avatarBtn, currentUser.username, currentUser.avatar_path);
}

updateProfileUI();

let rooms = [];
let pendingRoom = null;
let activeRoom = null;

// Підключаємо WebSocket із токеном сесії
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}?token=${encodeURIComponent(session.token)}`);

ws.addEventListener('open', () => {
  statusBadge.textContent = 'Онлайн';
});

ws.addEventListener('close', (event) => {
  if (event.code === 4001) {
    sessionStorage.removeItem('justchat_session');
    window.location.href = '/auth.html';
    return;
  }
  statusBadge.textContent = 'Відключено';
  if (activeRoom) {
    addSystemMessage("З'єднання з сервером втрачено");
  }
});

ws.addEventListener('message', (event) => {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }

  if (data.type === 'rooms_list') {
    rooms = data.rooms || [];
    renderRooms();
    return;
  }

  if (data.type === 'joined_room') {
    activeRoom = data.room;
    pendingRoom = null;
    roomsError.textContent = '';
    roomPasswordModal.classList.add('hidden');

    roomsScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
    currentRoomTitle.textContent = data.room.name;
    messagesBox.innerHTML = '';

    if (Array.isArray(data.history)) {
      data.history.forEach((m) => addChatMessage(m.sender, m.text, m.avatar));
    }

    messageInput.focus();
    return;
  }

  if (data.type === 'message') {
    addChatMessage(data.sender, data.text, data.avatar);
    return;
  }

  if (data.type === 'system') {
    addSystemMessage(data.text);
    return;
  }

  if (data.type === 'error') {
    roomsError.textContent = data.text || 'Сталася помилка';
  }
});

// Завантаження аватарки при кліку на іконку профілю
avatarBtn.addEventListener('click', () => {
  avatarInput.click();
});

avatarInput.addEventListener('change', () => {
  const file = avatarInput.files?.[0];
  if (!file) return;

  if (file.size > 3 * 1024 * 1024) {
    roomsError.textContent = 'Максимальний розмір аватарки — 3 МБ';
    avatarInput.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const res = await fetch('/api/avatar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`
        },
        body: JSON.stringify({ image: reader.result })
      });

      const data = await res.json();
      if (!res.ok) {
        roomsError.textContent = data.error || 'Помилка завантаження аватарки';
        return;
      }

      currentUser = data.user;
      session.user = data.user;
      sessionStorage.setItem('justchat_session', JSON.stringify(session));
      updateProfileUI();
      roomsError.textContent = '';

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'refresh_profile' }));
      }
    } catch {
      roomsError.textContent = 'Не вдалося завантажити аватарку';
    } finally {
      avatarInput.value = '';
    }
  };
  reader.readAsDataURL(file);
});

logoutBtn.addEventListener('click', () => {
  ws.close();
  sessionStorage.removeItem('justchat_session');
  window.location.href = '/auth.html';
});

// Створення кімнати
toggleCreateRoomBtn.addEventListener('click', () => {
  createRoomForm.classList.toggle('hidden');
  newRoomNameInput.focus();
});

cancelCreateRoomBtn.addEventListener('click', () => {
  createRoomForm.classList.add('hidden');
  createRoomForm.reset();
  newRoomPasswordWrap.classList.add('hidden');
});

newRoomPrivateCheckbox.addEventListener('change', () => {
  newRoomPasswordWrap.classList.toggle('hidden', !newRoomPrivateCheckbox.checked);
});

createRoomForm.addEventListener('submit', (e) => {
  e.preventDefault();
  roomsError.textContent = '';

  const name = newRoomNameInput.value.trim();
  const isPrivate = newRoomPrivateCheckbox.checked;
  const password = newRoomPasswordInput.value;

  if (!name) return;
  if (isPrivate && !password) {
    roomsError.textContent = 'Вкажи пароль для приватної кімнати';
    return;
  }

  if (ws.readyState !== WebSocket.OPEN) {
    roomsError.textContent = 'Немає з’єднання з сервером';
    return;
  }

  ws.send(
    JSON.stringify({
      type: 'create_room',
      name,
      password: isPrivate ? password : null
    })
  );

  createRoomForm.reset();
  newRoomPasswordWrap.classList.add('hidden');
  createRoomForm.classList.add('hidden');
});

// Відображення списку кімнат
function renderRooms() {
  roomsListEl.innerHTML = '';

  if (rooms.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'msg-system';
    empty.textContent = 'Активних кімнат поки немає. Створи першу!';
    roomsListEl.appendChild(empty);
    return;
  }

  rooms.forEach((room) => {
    const item = document.createElement('div');
    item.className = 'room-item';

    const title = document.createElement('span');
    title.textContent = `${room.name} (${room.usersCount || 0})`;

    const badge = document.createElement('span');
    badge.className = `room-badge ${room.hasPassword ? 'locked' : ''}`;
    badge.textContent = room.hasPassword ? '🔒 Пароль' : 'Відкрита';

    item.append(title, badge);
    item.addEventListener('click', () => onRoomClick(room));
    roomsListEl.appendChild(item);
  });
}

function onRoomClick(room) {
  roomsError.textContent = '';
  if (room.hasPassword) {
    pendingRoom = room;
    modalRoomTitle.textContent = `Пароль для кімнати "${room.name}"`;
    joinRoomPasswordInput.value = '';
    roomPasswordModal.classList.remove('hidden');
    joinRoomPasswordInput.focus();
  } else {
    requestJoinRoom(room.id, null);
  }
}

cancelRoomPasswordBtn.addEventListener('click', () => {
  pendingRoom = null;
  roomPasswordModal.classList.add('hidden');
});

roomPasswordForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!pendingRoom) return;
  requestJoinRoom(pendingRoom.id, joinRoomPasswordInput.value);
});

function requestJoinRoom(roomId, password) {
  if (ws.readyState !== WebSocket.OPEN) {
    roomsError.textContent = 'Немає з’єднання з сервером';
    return;
  }

  ws.send(
    JSON.stringify({
      type: 'join_room',
      roomId,
      password
    })
  );
}

// Повідомлення в чаті
function addSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg-system';
  el.textContent = text;
  messagesBox.appendChild(el);
  messagesBox.scrollTop = messagesBox.scrollHeight;
}

function addChatMessage(sender, text, avatar = null) {
  const el = document.createElement('div');
  el.className = 'msg';

  const avatarEl = document.createElement('div');
  avatarEl.className = 'msg-avatar';
  renderAvatarContent(avatarEl, sender, avatar);

  const contentEl = document.createElement('div');
  contentEl.className = 'msg-content';

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = `${sender} • ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  const body = document.createElement('div');
  body.textContent = text;

  contentEl.append(meta, body);
  el.append(avatarEl, contentEl);
  messagesBox.appendChild(el);
  messagesBox.scrollTop = messagesBox.scrollHeight;
}

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || ws.readyState !== WebSocket.OPEN || !activeRoom) return;

  ws.send(
    JSON.stringify({
      type: 'message',
      text
    })  
  );

  messageInput.value = '';
  messageInput.focus();
});

leaveRoomBtn.addEventListener('click', () => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'leave_room' }));
  }
  activeRoom = null;
  chatScreen.classList.add('hidden');
  roomsScreen.classList.remove('hidden');
});