import Database from 'better-sqlite3';
import path from 'path';

const usersDb = new Database(path.join(process.cwd(), 'users.db'));
usersDb.pragma('foreign_keys = ON');

usersDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_path TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL
  );
`);

export const userRepo = {
  createUser(username, email, passwordHash) {
    const stmt = usersDb.prepare(
      'INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)'
    );
    stmt.run(username, email, passwordHash, Date.now());
  },

  getUserById(id) {
    const stmt = usersDb.prepare('SELECT * FROM users WHERE id = ?');
    return stmt.get(id);
  },

  getUserByUsername(username) {
    const stmt = usersDb.prepare('SELECT * FROM users WHERE username = ?');
    return stmt.get(username);
  },
  
  getUserByEmail(email) {
    const stmt = usersDb.prepare('SELECT * FROM users WHERE email = ?');
    return stmt.get(email);
  },

  updateAvatar(userId, avatarPath) {
    const stmt = usersDb.prepare('UPDATE users SET avatar_path = ? WHERE id = ?');
    stmt.run(avatarPath, userId);
  }
};

export default usersDb;