const express = require('express');
require('dotenv').config();
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 9000;
const SECRET_KEY = process.env.SECRET_KEY || 'anonchat_secret_key_2026';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

const LOG_FILE = path.join(__dirname, 'server.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(message, data = null) {
  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] [SERVER] ${message}`;
  if (data !== null && data !== undefined) {
    try {
      line += ` ${JSON.stringify(data)}`;
    } catch (e) {
      line += ` ${data}`;
    }
  }
  logStream.write(line + '\n');
}

// Redirect console output exclusively to server.log
console.log = (...args) => {
  const timestamp = new Date().toISOString();
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
  logStream.write(`[${timestamp}] ${msg}\n`);
};

console.error = (...args) => {
  const timestamp = new Date().toISOString();
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
  logStream.write(`[${timestamp}] [ERROR] ${msg}\n`);
};

log('====================================================');
log('SERVER STARTUP INITIATED');
log('====================================================');

// ====================================================
// REDIS CLIENT SETUP
// ====================================================
process.on('unhandledRejection', (reason) => {
  log('[PROCESS WARN] Unhandled Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  log('[PROCESS ERROR] Uncaught Exception:', err?.message || err);
});

// ====================================================
// REDIS CLIENT SETUP
// ====================================================
const redisOptions = {
  url: REDIS_URL,
  socket: {
    connectTimeout: 5000,
    reconnectStrategy: (retries) => {
      if (retries > 5) {
        log('[REDIS WARN] Max reconnect attempts reached. Redis fallback mode active.');
        return new Error('Redis connection attempt failed');
      }
      return Math.min(retries * 500, 2000);
    }
  }
};

const redisClient = createClient(redisOptions);
const pubClient = redisClient.duplicate();
const subClient = redisClient.duplicate();

redisClient.on('error', (err) => log('[REDIS ERROR] Main Client:', err.message));
pubClient.on('error', (err) => log('[REDIS ERROR] Pub Client:', err.message));
subClient.on('error', (err) => log('[REDIS ERROR] Sub Client:', err.message));

let isRedisConnected = false;

async function initRedis() {
  try {
    await Promise.all([
      redisClient.connect(),
      pubClient.connect(),
      subClient.connect()
    ]);
    isRedisConnected = true;
    log('[REDIS SUCCESS] Connected to Redis successfully at ' + REDIS_URL);
  } catch (err) {
    log('[REDIS ERROR] Failed to connect to Redis. Operating with fallback logic.', { error: err.message });
  }
}

initRedis();


// ====================================================
// DATABASE SETUP (SQLite)
// ====================================================
const DB_PATH = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    log('Database connection error', { error: err.message });
  } else {
    log('Connected to SQLite database at ' + DB_PATH);
  }
});

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}


async function addOnlineUser(userId, socketId) {
  if (isRedisReady()) {
    try {
      await redisClient.sAdd('online_users', userId);
      await redisClient.hSet('socket_to_user', socketId, userId);
      return;
    } catch (err) {
      log('[REDIS WARN] addOnlineUser fallback to local memory:', err.message);
    }
  }
  if (!onlineUsers.some((x) => x.id === userId)) {
    onlineUsers.push({ id: userId });
  }
  sidToUserId.set(socketId, userId);
}

async function removeOnlineUser(socketId) {
  if (isRedisReady()) {
    try {
      const userId = await redisClient.hGet('socket_to_user', socketId);
      if (userId) {
        await redisClient.hDel('socket_to_user', socketId);
        await redisClient.sRem('online_users', userId);
      }
      return userId;
    } catch (err) {
      log('[REDIS WARN] removeOnlineUser fallback to local memory:', err.message);
    }
  }
  const userId = sidToUserId.get(socketId);
  sidToUserId.delete(socketId);
  onlineUsers = onlineUsers.filter((u) => u.id !== userId);
  return userId;
}

async function getOnlineUsers() {
  if (isRedisReady()) {
    try {
      const users = await redisClient.sMembers('online_users');
      return users.map((id) => ({ id }));
    } catch (err) {
      log('[REDIS WARN] getOnlineUsers fallback to local memory:', err.message);
    }
  }
  return onlineUsers;
}


// Ensure database tables exist
(async () => {
  try {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        expires_at INTEGER,
        last_active INTEGER,
        fcm_token TEXT,
        dp TEXT DEFAULT 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTSuJxruKI4Dzpax96RDs4byyus5J7xpph9moTDEt5DoA&s=10'
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caller_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        call_type TEXT DEFAULT 'video',
        status TEXT DEFAULT 'ringing',
        started_at INTEGER,
        ended_at INTEGER,
        duration INTEGER DEFAULT 0
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS statuses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT,
        media TEXT,
        background TEXT DEFAULT '#111827',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        views TEXT DEFAULT '[]'
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        target_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        text TEXT,
        image TEXT,
        reply_to TEXT,
        time INTEGER NOT NULL,
        read_by TEXT,
        reactions TEXT,
        edited INTEGER DEFAULT 0,
        forwarded INTEGER DEFAULT 0,
        file TEXT,
        file_name TEXT,
        file_type TEXT,
        file_size TEXT
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS pinned_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key TEXT UNIQUE NOT NULL,
        message_id INTEGER NOT NULL
      )
    `);
    log('Database schema verified successfully');
  } catch (e) {
    log('Failed to initialize database schema', { error: e.message });
  }
})();

let firebaseAdmin = null;
let messagingAdmin = null;

const firebaseFile = path.join(PUBLIC_DIR, 'firebase-admin.json');
log('[FCM DEBUG] Looking for Firebase service account file at:', firebaseFile);

if (fs.existsSync(firebaseFile)) {
  try {
    const admin = require('firebase-admin');
    const serviceAccount = require(firebaseFile);
    
    firebaseAdmin = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    messagingAdmin = firebaseAdmin.messaging();
    log('[FCM SUCCESS] Firebase Admin SDK successfully initialized', {
      projectId: serviceAccount.project_id,
      clientEmail: serviceAccount.client_email
    });
  } catch (e) {
    log('[FCM ERROR] Firebase Admin SDK initialization failed', {
      error: e.message,
      stack: e.stack
    });
  }
} else {
  log('[FCM WARN] firebase-admin.json missing in public directory. Push notifications will be disabled.');
}

const ANIMALS = [
  'Lion', 'Tiger', 'Wolf', 'Fox', 'Falcon', 'Panda', 'Bear', 'Eagle',
  'Hawk', 'Jaguar', 'Leopard', 'Otter', 'Rabbit', 'Koala', 'Raven',
  'Shark', 'Whale', 'Dolphin', 'Cobra', 'Python', 'Moose', 'Buffalo'
];

// Memory fallbacks when Redis is not available
let localOnlineUsers = [];
const localSidToUserId = new Map();
const pendingDisconnects = new Map();
const DISCONNECT_GRACE_SEC = 25;

function randomName() {
  return `${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function getChatKey(id1, id2) {
  return [String(id1), String(id2)].sort().join('_');
}

function formatUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    expiresAt: row.expires_at,
    lastActive: row.last_active,
    hasFcmToken: Boolean(row.fcm_token),
    dp: row.dp
  };
}

function formatMessage(row) {
  if (!row) return null;
  let replyTo = null;
  let readBy = [];
  let reactions = {};

  try { replyTo = row.reply_to ? JSON.parse(row.reply_to) : null; } catch (e) {}
  try { readBy = row.read_by ? JSON.parse(row.read_by) : []; } catch (e) {}
  try { reactions = row.reactions ? JSON.parse(row.reactions) : {}; } catch (e) {}

  return {
    id: row.id,
    chat_key: row.chat_key,
    user_id: row.user_id,
    target_user_id: row.target_user_id,
    name: row.name,
    text: row.text,
    image: row.image,
    file: row.file,
    file_name: row.file_name,
    file_type: row.file_type,
    file_size: row.file_size,
    reply_to: replyTo,
    time: row.time,
    read_by: readBy,
    reactions: reactions,
    edited: Boolean(row.edited),
    forwarded: Boolean(row.forwarded)
  };
}

// Redis Helper Functions for Online State & Socket Mapping
async function addOnlineUser(socketId, userId) {
  if (isRedisConnected) {
    await redisClient.hSet('socket_to_user', socketId, userId);
    await redisClient.sAdd('online_users', userId);
  }
  localSidToUserId.set(socketId, userId);
  if (!localOnlineUsers.some((x) => x.id === userId)) {
    localOnlineUsers.push({ id: userId });
  }
}

async function removeOnlineUser(socketId, userId) {
  if (isRedisConnected) {
    await redisClient.hDel('socket_to_user', socketId);
    if (userId) {
      await redisClient.sRem('online_users', userId);
    }
  }
  localSidToUserId.delete(socketId);
  if (userId) {
    localOnlineUsers = localOnlineUsers.filter((u) => u.id !== userId);
  }
}

async function getUserIdBySocketId(socketId) {
  if (isRedisConnected) {
    const uid = await redisClient.hGet('socket_to_user', socketId);
    if (uid) return uid;
  }
  return localSidToUserId.get(socketId);
}

async function getOnlineUsersList() {
  if (isRedisConnected) {
    const onlineIds = await redisClient.sMembers('online_users');
    return onlineIds.map((id) => ({ id }));
  }
  return localOnlineUsers;
}

async function sendPushNotification(token, title, body, data = {}, targetUserId = null) {
  log('[FCM DEBUG] Send push notification requested', {
    targetUserId,
    tokenPreview: token ? `${token.substring(0, 15)}...${token.slice(-5)}` : 'NULL',
    tokenLength: token ? token.length : 0,
    title,
    body,
    customData: data
  });

  if (!messagingAdmin) {
    log('[FCM WARN] Aborting push notification: Firebase Admin Messaging is not initialized');
    return false;
  }

  if (!token || typeof token !== 'string' || token.trim() === '') {
    log('[FCM WARN] Aborting push notification: Invalid or empty FCM token provided', { targetUserId });
    return false;
  }

  try {
    const payload = {};
    for (const [k, v] of Object.entries(data)) {
      payload[String(k)] = String(v);
    }
    payload.title = String(title || 'New Message');
    payload.body = String(body || '');

    const message = {
      token: token.trim(),
      data: payload,
      notification: {
        title: String(title || 'New Message'),
        body: String(body || '')
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'messages',
          priority: 'high'
        }
      }
    };

    const response = await messagingAdmin.send(message);
    log('[FCM SUCCESS] Push notification sent successfully!', {
      messageId: response,
      targetUserId,
      timestamp: new Date().toISOString()
    });
    return true;
  } catch (e) {
    log('[FCM ERROR] Failed to send push notification', {
      targetUserId,
      errorCode: e.code || 'UNKNOWN_ERROR',
      errorMessage: e.message,
      errorDetails: e.errorInfo || null,
      stack: e.stack
    });

    if (
      e.code === 'messaging/invalid-registration-token' ||
      e.code === 'messaging/registration-token-not-registered'
    ) {
      log('[FCM WARN] Removing stale/invalid FCM token from DB for user:', targetUserId);
      if (targetUserId) {
        await dbRun('UPDATE users SET fcm_token = NULL WHERE id = ?', [targetUserId]).catch(() => {});
      }
    }
    return false;
  }
}

async function broadcastUsers() {
  const rows = await dbAll('SELECT * FROM users');
  const allUsers = rows.map(formatUser);
  const onlineUsers = await getOnlineUsersList();

  io.emit('count', allUsers.length);
  io.emit('usersUpdate', allUsers);
  io.emit('onlineUpdate', onlineUsers);
  io.emit('usersLoaded', { allUsers });
}

function getFileIcon(type = '') {
  if (type.startsWith('image/')) return 'fas fa-image';
  if (type.startsWith('video/')) return 'fas fa-video';
  if (type.startsWith('octet-stream')) return 'fas fa-server';
  if (type.startsWith('audio/')) return 'fas fa-music';
  if (type === 'application/pdf') return 'fas fa-file-pdf';
  if (type.includes('word')) return 'fas fa-file-word';
  if (type.includes('text/html')) return 'fab fa-brands fa-html5';
  if (type.includes('text/css')) return 'fas fa-css3';
  if (type.includes('excel') || type.includes('spreadsheet')) return 'fas fa-file-excel';
  if (type.includes('powerpoint') || type.includes('presentation')) return 'fas fa-file-powerpoint';
  if (type.includes('zip') || type.includes('rar') || type.includes('7z')) return 'fas fa-file-zipper';
  if (type.includes('text')) return 'fas fa-file-lines';
  return 'fas fa-file';
}

async function calculateLastMessages(currentUserId) {
  const allUsers = await dbAll('SELECT id FROM users WHERE id != ?', [currentUserId]);
  const lastMsgs = [];

  for (const user of allUsers) {
    const chatKey = getChatKey(currentUserId, user.id);
    const last = await dbGet(
      'SELECT text, file, file_name, file_type FROM messages WHERE chat_key = ? ORDER BY time DESC LIMIT 1',
      [chatKey]
    );

    let text = '';
    if (last) {
      text = last.text || (last.file_type ? getFileIcon(last.file_type) : '');
    }

    lastMsgs.push({
      to: user.id,
      msg: text,
      filename: last ? last.file_name : null
    });
  }

  return lastMsgs;
}

// ====================================================
// SOCKET.IO SETUP WITH REDIS ADAPTER
// ====================================================
const io = new Server(server, {
  adapter: createAdapter(pubClient, subClient),
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e7, // 10MB
  pingInterval: 10000,
  pingTimeout: 20000
});

app.get('/', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  return res.status(404).send('index.html not found in public directory');
});

app.get('/health', async (req, res) => {
  try {
    const userCount = await dbGet('SELECT COUNT(*) as count FROM users');
    const fcmCount = await dbGet('SELECT COUNT(*) as count FROM users WHERE fcm_token IS NOT NULL');
    const onlineUsers = await getOnlineUsersList();
    
    res.json({
      status: 'healthy',
      redis_connected: isRedisConnected,
      online_users: onlineUsers.length,
      total_users: userCount ? userCount.count : 0,
      users_with_fcm_tokens: fcmCount ? fcmCount.count : 0,
      fcm_sdk_initialized: Boolean(messagingAdmin),
      timestamp: Date.now()
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// FCM Token Registration Endpoint
app.post('/api/register-fcm', async (req, res) => {
  const { token, userId } = req.body || {};

  log('[FCM REGISTER API] Received FCM token registration request', {
    userId,
    tokenPreview: token ? `${token.substring(0, 15)}...${token.slice(-5)}` : 'NULL',
    tokenLength: token ? token.length : 0,
    headers: req.headers
  });

  if (!token || !userId) {
    log('[FCM REGISTER API ERROR] Missing required fields', { tokenReceived: Boolean(token), userIdReceived: Boolean(userId) });
    return res.status(400).json({ success: false, message: 'token and userId are required' });
  }

  try {
    const user = await dbGet('SELECT id, name, fcm_token FROM users WHERE id = ?', [userId]);

    if (!user) {
      log('[FCM REGISTER API WARN] User not found during FCM token save attempt', { userId });
      await dbRun('INSERT INTO users (id, name, fcm_token, last_active) VALUES (?, ?, ?, ?)', [
        userId,
        randomName(),
        token,
        Date.now()
      ]);
    } else {
      const tokenChanged = user.fcm_token !== token;
      await dbRun('UPDATE users SET fcm_token = ? WHERE id = ?', [token, userId]);
      log('[FCM REGISTER API SUCCESS] FCM token updated in database', {
        userId,
        userName: user.name,
        tokenChanged
      });
    }

    res.json({ success: true, userId });
  } catch (err) {
    log('[FCM REGISTER API ERROR] Database update failed', { userId, error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

io.on('connection', (socket) => {
  log('[SERVER] Client socket connected', { sid: socket.id });

  socket.on('disconnect', async () => {
    const userId = await getUserIdBySocketId(socket.id);
    if (!userId) return;

    const finalizeDisconnect = async (uid) => {
      await removeOnlineUser(socket.id, uid);
      pendingDisconnects.delete(uid);
      await broadcastUsers();
      log('[SERVER] User disconnected finalized', uid);
    };

    if (pendingDisconnects.has(userId)) {
      clearTimeout(pendingDisconnects.get(userId));
    }

    const timer = setTimeout(() => finalizeDisconnect(userId), DISCONNECT_GRACE_SEC * 1000);
    pendingDisconnects.set(userId, timer);
  });

  socket.on('initSession', async (clientSession = {}) => {
    let userId = clientSession ? clientSession.userId : `usr_${Math.floor(100000 + Math.random() * 900000)}`;

    if (pendingDisconnects.has(userId)) {
      clearTimeout(pendingDisconnects.get(userId));
      pendingDisconnects.delete(userId);
    }

    const nowMs = Date.now();
    let user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);

    if (user) {
      let name = user.name;
      let expiresAt = user.expires_at;

      if (clientSession.name && clientSession.expiresAt && nowMs < clientSession.expiresAt) {
        name = clientSession.name;
        expiresAt = clientSession.expiresAt;
      }

      await dbRun(
        'UPDATE users SET name = ?, expires_at = ?, last_active = ? WHERE id = ?',
        [name, expiresAt, nowMs, userId]
      );
      user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    } else {
      const name = clientSession ? clientSession.name : randomName();
      const expiresAt = clientSession ? clientSession.expiresAt : null;

      await dbRun(
        'INSERT INTO users (id, name, expires_at, last_active) VALUES (?, ?, ?, ?)',
        [userId, name, expiresAt, nowMs]
      );
      user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    }

    await addOnlineUser(socket.id, userId);
    socket.join(userId);

    socket.emit('sessionReady', {
      userId: user.id,
      name: user.name,
      expiresAt: user.expires_at,
      dp: user.dp
    });

    await broadcastUsers();

    socket.emit('lastMessages', {
      lastMessages: await calculateLastMessages(user.id)
    });
  });

  socket.on('loadUsers', async () => {
    const rows = await dbAll('SELECT * FROM users');
    socket.emit('usersLoaded', {
      allUsers: rows.map(formatUser)
    });
  });

  socket.on("loadStatuses", async () => {
    const userId = await getUserIdBySocketId(socket.id);
    if (!userId) return;

    const now = Date.now();

    const rows = await dbAll(`
        SELECT
            s.*,
            u.name
        FROM statuses s
        JOIN users u
            ON u.id = s.user_id
        WHERE s.expires_at > ?
        ORDER BY s.created_at DESC
    `, [now]);

    const grouped = {};

    for (const status of rows) {
        if (!grouped[status.user_id]) {
            grouped[status.user_id] = {
                userId: status.user_id,
                username: status.name,
                statuses: []
            };
        }

        grouped[status.user_id].statuses.push({
          id: status.id,
          user_id: status.user_id,
          username: status.name,
          type: status.type,
          content: status.content,
          media: status.media,
          background: status.background,
          createdAt: status.created_at,
          expiresAt: status.expires_at,
          views: JSON.parse(status.views || "[]"),
          viewed: JSON.parse(status.views || "[]").some(v => v.userId === userId) || status.user_id == userId
      });
    }

    const groups = Object.values(grouped);

    groups.sort((a, b) => {
        if (a.userId === userId) return -1;
        if (b.userId === userId) return 1;
        return b.statuses[0].createdAt - a.statuses[0].createdAt;
    });

    socket.emit("statusesLoaded", groups);
});

  socket.on('updateSession', async (data = {}) => {
    const userId = await getUserIdBySocketId(socket.id);
    if (!userId) return;

    const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return;

    const newName = data.newName || user.name;
    const expiresAt = data.expiresAt !== undefined ? data.expiresAt : user.expires_at;

    await dbRun(
      'UPDATE users SET name = ?, expires_at = ?, last_active = ? WHERE id = ?',
      [newName, expiresAt, Date.now(), userId]
    );

    await broadcastUsers();
  });

  socket.on('requestNewIdentity', async () => {
    const userId = await getUserIdBySocketId(socket.id);
    if (!userId) return;

    const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return;

    const oldName = user.name;
    const newName = randomName();

    await dbRun(
      'UPDATE users SET name = ?, expires_at = NULL WHERE id = ?',
      [newName, userId]
    );

    socket.emit('sessionReady', {
      userId: user.id,
      name: newName,
      expiresAt: null,
      oldName
    });

    await broadcastUsers();
  });

  socket.on('setUsername', async (data = {}) => {
    const userId = await getUserIdBySocketId(socket.id);
    if (!userId) return;

    const username = (data.username || '').trim();

    if (!username) {
      socket.emit('usernameError', { message: 'Username cannot be empty.' });
      return;
    }

    if (username.length > 30) {
      socket.emit('usernameError', { message: 'Username is too long.' });
      return;
    }

    const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return;

    const existing = await dbGet(
      'SELECT id FROM users WHERE name = ? AND id != ?',
      [username, userId]
    );

    if (existing) {
      socket.emit('usernameError', { message: 'Username already taken.' });
      return;
    }

    const oldName = user.name;
    await dbRun('UPDATE users SET name = ? WHERE id = ?', [username, userId]);

    socket.emit('sessionReady', {
      userId: user.id,
      name: username,
      dp: user.dp,
      expiresAt: user.expires_at,
      oldName
    });

    await broadcastUsers();
  });

  socket.on('deleteDp', async (data = {}) => {
    const userId = await getUserIdBySocketId(socket.id);
    if (!userId) return;

    const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return;

    if (user.dp == 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTSuJxruKI4Dzpax96RDs4byyus5J7xpph9moTDEt5DoA&s=10') return;

    await dbRun('UPDATE users SET dp = ? WHERE id = ?', ['https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTSuJxruKI4Dzpax96RDs4byyus5J7xpph9moTDEt5DoA&s=10', userId]);

    socket.emit('dpDeleted', {
      dp: user.dp
    });

    await broadcastUsers();
  });

  socket.on('changeDp', async (data = {}) => {
    const userId = await getUserIdBySocketId(socket.id);
    if (!userId) return;

    const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    const dp = (data.dp || '');

    await dbRun('UPDATE users SET dp = ? WHERE id = ?', [dp, userId]);

    socket.emit('dpChanged', {
      dp: user.dp
    });

    await broadcastUsers();
  });

  socket.on('loadDirectHistory', async (data = {}) => {
    const userId = await getUserIdBySocketId(socket.id);
    const targetUserId = data.targetUserId;

    if (!userId || !targetUserId) return;

    const offset = parseInt(data.offset || 0, 10);
    const limit = parseInt(data.limit || 10, 10);
    const chatKey = getChatKey(userId, targetUserId);

    const totalRow = await dbGet(
      'SELECT COUNT(*) as count FROM messages WHERE chat_key = ?',
      [chatKey]
    );
    const total = totalRow ? totalRow.count : 0;

    const rows = await dbAll(
      'SELECT * FROM messages WHERE chat_key = ? ORDER BY time DESC LIMIT ? OFFSET ?',
      [chatKey, limit, offset]
    );

    const history = rows.map(formatMessage).reverse();

    const pinnedRow = await dbGet(
      'SELECT * FROM pinned_messages WHERE chat_key = ?',
      [chatKey]
    );

    const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return;

    socket.emit('directHistoryLoaded', {
      targetUserId,
      dp: user.dp,
      history,
      pinned: pinnedRow ? { id: pinnedRow.id, chat_key: pinnedRow.chat_key, message_id: pinnedRow.message_id } : null,
      hasMore: offset + limit < total
    });
  });

  socket.on('directMessage', async (payload = {}) => {
    const userId = await getUserIdBySocketId(socket.id);
    if (!userId || !payload) return;

    const targetUserId = payload.targetUserId;
    if (!targetUserId) return;

    const text = (payload.text || '').trim();
    const file = payload.file || null;
    const fileName = payload.fileName || null;
    const fileType = payload.fileType || null;
    const fileSize = payload.fileSize || null;
    const replyTo = payload.replyTo ? JSON.stringify(payload.replyTo) : null;

    if (!text && !file) return;

    const sender = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    const senderName = sender?.name || 'Anonymous';
    const chatKey = getChatKey(userId, targetUserId);
    const nowMs = Date.now();

    const result = await dbRun(
      `INSERT INTO messages
      (chat_key, user_id, target_user_id, name, text, file, file_name, file_type, file_size, reply_to, time, read_by, reactions, edited, forwarded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      [chatKey, userId, targetUserId, senderName, text, file, fileName, fileType, fileSize, replyTo, nowMs, '[]', '{}']
    );

    const oldMessages = await dbAll(
      'SELECT id FROM messages WHERE chat_key = ? ORDER BY time DESC LIMIT -1 OFFSET 100',
      [chatKey]
    );

    for (const oldMsg of oldMessages)
      await dbRun('DELETE FROM messages WHERE id = ?', [oldMsg.id]);

    const msgData = formatMessage(await dbGet('SELECT * FROM messages WHERE id = ?', [result.lastID]));

    socket.emit('directMessage', msgData);
    io.to(targetUserId).emit('directMessage', msgData);

    socket.emit('lastMessages', {
      lastMessages: await calculateLastMessages(userId)
    });

    io.to(targetUserId).emit('lastMessages', {
      lastMessages: await calculateLastMessages(targetUserId)
    });

    const target = await dbGet(
      'SELECT id, name, fcm_token FROM users WHERE id = ?',
      [targetUserId]
    );

    if (target?.fcm_token) {
      await sendPushNotification(
        target.fcm_token,
        senderName,
        text || fileName || '📎 Attachment',
        { type: 'message', userId, chatId: chatKey },
        targetUserId
      );
    }
  });

  socket.on("postStatus", async (data = {}) => {
    const userId = await getUserIdBySocketId(socket.id);
    if (!userId) return;

    const created = Date.now();
    const expires = created + (24 * 60 * 60 * 1000);

    await dbRun(`
        INSERT INTO statuses
        (user_id, type, content, media, background, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
        userId,
        data.type,
        data.content || null,
        data.media || null,
        data.background || "#111827",
        created,
        expires
    ]);

    io.emit("statusUpdated");
  });

  socket.on("viewStatus", async ({ statusId }) => {
    const userId = await getUserIdBySocketId(socket.id);
    if (!userId) return;

    const row = await dbGet(
      "SELECT views FROM statuses WHERE id=?",
      [statusId]
    );

    if (!row) return;

    let views = [];
    try { views = JSON.parse(row.views || "[]"); } catch {}
      
    if (!views.some(v => v.userId === userId)) {
      views.push({
        userId,
        viewedAt: Date.now()
      });

      await dbRun(
        "UPDATE statuses SET views=? WHERE id=?",
        [JSON.stringify(views), statusId]
      );
      log('Status viewed by ' + userId);
    }
  });

  socket.on("deleteStatus", async ({ statusId }) => {
    const userId = await getUserIdBySocketId(socket.id);
    if (!userId) return;

    const status = await dbGet(
      "SELECT user_id FROM statuses WHERE id=?",
      [statusId]
    );

    if (!status) {
      socket.emit("statusError", { message: "Status not found." });
      return;
    }

    if (status.user_id !== userId) {
      socket.emit("statusError", { message: "You cannot delete this status." });
      return;
    }

    await dbRun("DELETE FROM statuses WHERE id=?", [statusId]);
    io.emit("statusUpdated");
  });

  socket.on("getUserStatuses", async ({ userId }) => {
    const rows = await dbAll(`
        SELECT *
        FROM statuses
        WHERE user_id=?
        AND expires_at > ?
        ORDER BY created_at ASC
    `, [userId, Date.now()]);

    socket.emit("userStatuses", rows);
  });

  socket.on("getStatusViews", async ({ statusId }) => {
    const userId = await getUserIdBySocketId(socket.id);

    const row = await dbGet(
      "SELECT user_id, views FROM statuses WHERE id=?",
      [statusId]
    );

    if (!row || row.user_id !== userId) return;

    const views = JSON.parse(row.views || "[]");
    const viewers = [];

    for (const view of views) {
      const user = await dbGet(
        "SELECT name FROM users WHERE id=?",
        [view.userId]
      );

      viewers.push({
        userId: view.userId,
        username: user?.name || "Anonymous",
        viewedAt: view.viewedAt
      });
    }

    viewers.sort((a, b) => b.viewedAt - a.viewedAt);
    socket.emit("statusViews", viewers);
  });

  socket.on('editMessage', async (data = {}) => {
    const userId = await getUserIdBySocketId(socket.id);
    if (!userId) return;

    const msg = await dbGet('SELECT * FROM messages WHERE id = ?', [data.msgId]);
    if (!msg || msg.user_id !== userId) return;

    const newText = (data.newText || '').trim();
    if (!newText) return;

    await dbRun('UPDATE messages SET text = ?, edited = 1 WHERE id = ?', [newText, msg.id]);
    const updated = await dbGet('SELECT * FROM messages WHERE id = ?', [msg.id]);
    const msgData = formatMessage(updated);

    const payload = { chatKey: msg.chat_key, msg: msgData };
    socket.emit('messageUpdated', payload);
    io.to(msg.target_user_id).emit('messageUpdated', payload);
  });

  socket.on('togglePinMessage', async (data = {}) => {
    const userId = await getUserIdBySocketId(socket.id);
    if (!userId) return;

    const chatKey = getChatKey(userId, data.targetUserId);
    const msg = await dbGet('SELECT * FROM messages WHERE id = ?', [data.msgId]);

    if (!msg) return;

    const pinned = await dbGet('SELECT * FROM pinned_messages WHERE chat_key = ?', [chatKey]);

    if (pinned && pinned.message_id === msg.id) {
      await dbRun('DELETE FROM pinned_messages WHERE chat_key = ?', [chatKey]);
    } else {
      if (pinned) {
        await dbRun('DELETE FROM pinned_messages WHERE chat_key = ?', [chatKey]);
      }
      await dbRun('INSERT INTO pinned_messages (chat_key, message_id) VALUES (?, ?)', [chatKey, msg.id]);
    }

    const updatedPinned = await dbGet('SELECT * FROM pinned_messages WHERE chat_key = ?', [chatKey]);
    const payload = {
      chatKey,
      pinned: updatedPinned ? { id: updatedPinned.id, chat_key: updatedPinned.chat_key, message_id: updatedPinned.message_id } : null
    };

    socket.emit('pinnedUpdate', payload);
    io.to(data.targetUserId).emit('pinnedUpdate', payload);
  });

  socket.on('markRead', async (data = {}) => {
    const userId = await getUserIdBySocketId(socket.id);
    const targetUserId = data.targetUserId;
    const msgIds = Array.isArray(data.msgIds) ? data.msgIds : [];

    if (!userId || !targetUserId || !msgIds.length) return;

    const user = await dbGet('SELECT name FROM users WHERE id = ?', [userId]);
    const chatKey = getChatKey(userId, targetUserId);
    let updated = false;

    for (const id of msgIds) {
      const msg = await dbGet('SELECT * FROM messages WHERE id = ? AND chat_key = ?', [id, chatKey]);
      if (!msg || msg.user_id === userId) continue;

      let readBy = [];
      try { readBy = msg.read_by ? JSON.parse(msg.read_by) : []; } catch (e) {}

      if (!readBy.some((r) => r.userId === userId)) {
        readBy.push({
          userId,
          name: user ? user.name : 'Anonymous',
          time: Date.now()
        });
        await dbRun('UPDATE messages SET read_by = ? WHERE id = ?', [JSON.stringify(readBy), id]);
        updated = true;
      }
    }

    if (updated) {
      const readData = {
        byUserId: userId,
        msgIds: msgIds
      };

      socket.emit('messagesRead', { ...readData, targetUserId });
      io.to(targetUserId).emit('messagesRead', { ...readData, targetUserId: userId });
    }
  });

  socket.on('toggleReaction', async (data = {}) => {
    const userId = await getUserIdBySocketId(socket.id);
    if (!userId) return;

    const msg = await dbGet('SELECT * FROM messages WHERE id = ?', [data.msgId]);
    if (!msg) return;

    const emoji = data.emoji;
    if (!emoji) return;

    let reactions = {};
    try { reactions = msg.reactions ? JSON.parse(msg.reactions) : {}; } catch (e) {}

    if (!reactions[emoji]) reactions[emoji] = [];

    const user = await dbGet('SELECT name FROM users WHERE id = ?', [userId]);
    const idx = reactions[emoji].findIndex((r) => r.userId === userId);

    if (idx >= 0) {
      reactions[emoji].splice(idx, 1);
      if (reactions[emoji].length === 0) {
        delete reactions[emoji];
      }
    } else {
      reactions[emoji].push({
        userId,
        name: user ? user.name : 'Anonymous'
      });
    }

    await dbRun('UPDATE messages SET reactions = ? WHERE id = ?', [JSON.stringify(reactions), msg.id]);
    const updated = await dbGet('SELECT * FROM messages WHERE id = ?', [msg.id]);
    const payload = { chatKey: msg.chat_key, msg: formatMessage(updated) };

    socket.emit('messageUpdated', payload);
    io.to(msg.target_user_id).emit('messageUpdated', payload);
  });

  socket.on('deleteMessage', async (data = {}) => {
    const userId = await getUserIdBySocketId(socket.id);
    if (!userId) return;

    const msg = await dbGet('SELECT * FROM messages WHERE id = ?', [data.msgId]);
    if (!msg || msg.user_id !== userId) return;

    await dbRun('DELETE FROM pinned_messages WHERE chat_key = ? AND message_id = ?', [msg.chat_key, msg.id]);
    await dbRun('DELETE FROM messages WHERE id = ?', [msg.id]);

    socket.emit('messageDeleted', { targetUserId: msg.target_user_id, msgId: msg.id });
    io.to(msg.target_user_id).emit('messageDeleted', { targetUserId: userId, msgId: msg.id });
  });

  socket.on('forwardMessage', async (data = {}) => {
    const userId = await getUserIdBySocketId(socket.id);
    const targetUserId = data.targetUserId;
    const message = data.message || {};

    if (!userId || !targetUserId) return;

    const sender = await dbGet('SELECT name FROM users WHERE id = ?', [userId]);
    const chatKey = getChatKey(userId, targetUserId);
    const nowMs = Date.now();
    const replyTo = message.replyTo ? JSON.stringify(message.replyTo) : null;

    const result = await dbRun(
      `INSERT INTO messages 
      (chat_key, user_id, target_user_id, name, text, image, reply_to, time, read_by, reactions, edited, forwarded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
      [chatKey, userId, targetUserId, sender ? sender.name : 'Anonymous', message.text || null, message.image || null, replyTo, nowMs, '[]', '{}']
    );

    const insertedMsg = await dbGet('SELECT * FROM messages WHERE id = ?', [result.lastID]);
    const msgDict = formatMessage(insertedMsg);

    socket.emit('directMessage', msgDict);
    io.to(targetUserId).emit('directMessage', msgDict);

    log('[FCM DEBUG] Forward message push notification check...', { senderUserId: userId, targetUserId });
    const target = await dbGet('SELECT id, name, fcm_token FROM users WHERE id = ?', [targetUserId]);
    if (target && target.fcm_token) {
      await sendPushNotification(
        target.fcm_token,
        sender ? sender.name : 'Anonymous',
        msgDict.text || '[Forwarded Attachment]',
        { type: 'message', userId, chatId: chatKey },
        targetUserId
      );
    } else {
      log('[FCM WARN] Target user has no FCM token for forwarded message.', { targetUserId });
    }
  });

  socket.on('callUser', async (data = {}) => {
    const callerId = await getUserIdBySocketId(socket.id);
    const targetUserId = data.targetUserId;

    if (!callerId || !targetUserId) return;

    const result = await dbRun(
      `
      INSERT INTO calls
      (caller_id, receiver_id, call_type, status, started_at)
      VALUES (?, ?, ?, ?, ?)
      `,
      [
        callerId,
        targetUserId,
        data.callType || 'video',
        'ringing',
        Date.now()
      ]
    );

    io.to(callerId).emit('callId', {
      callId: result.lastID
    });

    io.to(targetUserId).emit('incomingCall', {
      callId: result.lastID,
      fromUserId: callerId,
      fromSocketId: socket.id,
      callerName: data.callerName,
      callType: data.callType || 'video',
      signal: data.signal
    });
  });

  socket.on('acceptCall', async (data = {}) => {
    const userId = await getUserIdBySocketId(socket.id);

    if (!userId || !data.callId) return;

    await dbRun(
      `
      UPDATE calls
      SET status = ?, started_at = ?
      WHERE id = ?
      `,
      [
        'accepted',
        Date.now(),
        data.callId
      ]
    );

    io.to(data.targetUserId).emit('callAccepted', {
      fromUserId: userId,
      fromSocketId: socket.id,
      answererName: data.answererName,
      signal: data.signal
    });
  });

  socket.on('rejectCall', async (data = {}) => {
    if (!data.callId) return;

    await dbRun(
      `
      UPDATE calls
      SET status = ?, ended_at = ?
      WHERE id = ?
      `,
      [
        'rejected',
        Date.now(),
        data.callId
      ]
    );

    io.to(data.targetUserId).emit('callRejected', {
      byName: data.byName
    });
  });

  socket.on('sendIceCandidate', (data = {}) => {
    if (data.targetUserId) {
      io.to(data.targetUserId).emit('iceCandidate', {
        candidate: data.candidate
      });
    }
  });

  socket.on('endCall', async (data = {}) => {
    if (data.callId) {
      const call = await dbGet(
        "SELECT started_at FROM calls WHERE id=?",
        [data.callId]
      );

      const duration = call?.started_at
        ? Math.floor((Date.now() - call.started_at) / 1000)
        : 0;

      await dbRun(
        `
        UPDATE calls
        SET status=?, ended_at=?, duration=?
        WHERE id=?
        `,
        [
          'ended',
          Date.now(),
          duration,
          data.callId
        ]
      );
    }

    if (data.targetUserId) {
      io.to(data.targetUserId).emit('callEnded');
    }
  });

  socket.on('typing', async (data = {}) => {
    const currentUserId = await getUserIdBySocketId(socket.id);
    const user = await dbGet('SELECT id, name FROM users WHERE id = ?', [currentUserId]);
    if (user && data.targetUserId) {
      io.to(data.targetUserId).emit('typing', {
        fromUserId: user.id,
        name: user.name
      });
    }
  });

  socket.on('stopTyping', async (data = {}) => {
    const userId = await getUserIdBySocketId(socket.id);
    if (userId && data.targetUserId) {
      io.to(data.targetUserId).emit('stopTyping', {
        fromUserId: userId
      });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`[SERVER] Node server successfully started and listening on 0.0.0.0:${PORT}`);
});