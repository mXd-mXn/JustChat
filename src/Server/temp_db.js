import Database from 'better-sqlite3';

const memoryDb = new Database(':memory:');
memoryDb.pragma('foreign_keys = ON');

memoryDb.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    password_hash TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );
`);

export const roomRepo = {
  createRoom(id, name, passwordHash = null) {
    const stmt = memoryDb.prepare(
      'INSERT INTO rooms (id, name, password_hash, created_at) VALUES (?, ?, ?, ?)'
    );
    stmt.run(id, name, passwordHash, Date.now());
  },

  getRoom(id) {
    const stmt = memoryDb.prepare('SELECT id, name, password_hash FROM rooms WHERE id = ?');
    return stmt.get(id);
  },

  getAllRooms() {
    const stmt = memoryDb.prepare(
      'SELECT id, name, (password_hash IS NOT NULL) AS hasPassword FROM rooms ORDER BY created_at ASC'
    );
    return stmt.all().map((row) => ({
      id: row.id,
      name: row.name,
      hasPassword: Boolean(row.hasPassword)
    }));
  },

  deleteRoom(id) {
    const stmt = memoryDb.prepare('DELETE FROM rooms WHERE id = ?');
    stmt.run(id);
  },

  addMessage(roomId, sender, text) {
    const stmt = memoryDb.prepare(
      'INSERT INTO messages (room_id, sender, text, created_at) VALUES (?, ?, ?, ?)'
    );
    stmt.run(roomId, sender, text, Date.now());
  },

  getMessages(roomId) {
    const stmt = memoryDb.prepare(
      'SELECT sender, text, created_at FROM messages WHERE room_id = ? ORDER BY created_at ASC'
    );
    return stmt.all(roomId);
  }
};

export default memoryDb;