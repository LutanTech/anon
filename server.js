const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const {
	Server
} = require('socket.io');
const sqlite3 = require('sqlite3')
	.verbose();
const multer = require('multer');

const cache = {
	users: new Map(), // userId -> formatted user object
	messages: new Map(), // msgId -> formatted message object
	pinned: new Map(), // chatKey -> pinned object or null
	lastMessages: new Map(), // chatKey -> { to, msg, filename }
	statuses: new Map(),
	histories: new Map(),
	calls: null
	
};

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 9000;
const SECRET_KEY = process.env.SECRET_KEY || 'anonchat_secret_key_2026';
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.json());
app.use(express.urlencoded({
	extended: true
}));
app.use(express.static(PUBLIC_DIR));

const LOG_FILE = path.join(__dirname, 'server.log');
const logStream = fs.createWriteStream(LOG_FILE, {
	flags: 'a'
});

function log(message, data = null) {
	const timestamp = new Date()
		.toISOString();
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
	const timestamp = new Date()
		.toISOString();
	const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a))
		.join(' ');
	logStream.write(`[${timestamp}] ${msg}\n`);
};

console.error = (...args) => {
	const timestamp = new Date()
		.toISOString();
	const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a))
		.join(' ');
	logStream.write(`[${timestamp}] [ERROR] ${msg}\n`);
};

log('====================================================');
log('SERVER STARTUP INITIATED');
log('====================================================');

const DB_PATH = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
	if (err) {
		log('Database connection error', {
			error: err.message
		});
	} else {
		log('Connected to SQLite database at ' + DB_PATH);
	}
});

function dbRun(sql, params = []) {
	return new Promise((resolve, reject) => {
		db.run(sql, params, function(err) {
			if (err) reject(err);
			else resolve(this);
		});
	});
}

function dbTransaction(queries) {
	return new Promise((resolve, reject) => {
		db.serialize(() => {
			db.run('BEGIN TRANSACTION', err => {
				if (err) return reject(err);
				
				let index = 0;
				
				const next = () => {
					if (index >= queries.length) {
						return db.run('COMMIT', err => {
							if (err) reject(err);
							else resolve();
						});
					}
					
					const {
						sql,
						params = []
					} = queries[index++];
					
					db.run(sql, params, err => {
						if (err) {
							return db.run('ROLLBACK', () =>
								reject(err));
						}
						
						next();
					});
				};
				
				next();
			});
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
        type TEXT NOT NULL,          -- text, image, video
        content TEXT,
        media TEXT,
        thumbnail TEXT,
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
        deleted INTEGER DEFAULT 0;
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
		log('Failed to initialize database schema', {
			error: e.message
		});
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

let onlineUsers = [];
const sidToUserId = new Map();
const pendingDisconnects = new Map();
const DISCONNECT_GRACE_SEC = 25;

function randomName() {
	return `${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}-${Math.floor(1000 + Math.random() * 9000)}`;
}

async function loadUserCache() {
	const rows = await dbAll('SELECT * FROM users');
	
	cache.users.clear();
	
	for (const row of rows) {
		cache.users.set(row.id, formatUser(row));
	}
}

function getChatKey(id1, id2) {
	return [String(id1), String(id2)].sort()
		.join('_');
}

function invalidateCallsCache() {
	cache.calls = null;
}


function formatUser(row) {
	if (!row) return null;
	return {
		id: row.id,
		name: row.name,
		expiresAt: row.expires_at,
		lastActive: row.last_active,
		hasFcmToken: Boolean(row.fcm_token),
		fcmToken: row.fcm_token || null,
		dp: row.dp
	};
}

async function loadHistoryCache(chatKey) {
	if (cache.histories.has(chatKey)) {
		return cache.histories.get(chatKey);
	}
	
	const rows = await dbAll(
		'SELECT * FROM messages WHERE chat_key = ? ORDER BY time DESC',
      [chatKey]
	);
	
	const history = rows.map(r => {
			const msg = formatMessage(r);
			setCachedMessage(msg);
			return msg;
		})
		.reverse();
	
	cache.histories.set(chatKey, history);
	
	return history;
}

async function loadLastMessagesCache() {
	const rows = await dbAll(`
      SELECT m.*
      FROM messages m
      INNER JOIN (
          SELECT chat_key, MAX(time) AS max_time
          FROM messages
          GROUP BY chat_key
      ) latest
      ON m.chat_key = latest.chat_key
      AND m.time = latest.max_time
  `);
	
	cache.lastMessages.clear();
	
	for (const row of rows) {
		cache.lastMessages.set(row.chat_key, row);
	}
}

function formatMessage(row) {
	if (!row) return null;
	let replyTo = null;
	let readBy = [];
	let reactions = {};
	
	try {
		replyTo = row.reply_to ? JSON.parse(row.reply_to) : null;
	} catch (e) {}
	try {
		readBy = row.read_by ? JSON.parse(row.read_by) : [];
	} catch (e) {}
	try {
		reactions = row.reactions ? JSON.parse(row.reactions) : {};
	} catch (e) {}
	
	return {
		id: row.id,
		chat_key: row.chat_key,
		user_id: row.user_id,
		target_user_id: row.target_user_id,
		name: row.name,
		text: row.deleted ? null : row.text,
		image: row.deleted ? null : row.image,
		file: row.deleted ? null : row.file,
		file_name: row.deleted ? null : row.file_name,
		file_type: row.deleted ? null : row.file_type,
		file_size: row.deleted ? null : row.file_size,
		reply_to: replyTo,
		time: row.time,
		read_by: readBy,
		reactions: row.deleted ? null : reactions,
		edited: row.deleted ? null : Boolean(row.edited),
		forwarded: Boolean(row.forwarded),
		deleted: row.deleted === 1
	};
}

function formatCall(row){
  return {
      id:row.id,
      caller_id:row.caller_id,
      receiver_id:row.receiver_id,
      call_type:row.call_type,
      status:row.status,
      started_at:row.started_at,
      ended_at:row.ended_at,
      duration:row.duration||0
  };
}

async function getCachedUser(id) {
	if (cache.users.has(id)) {
		return cache.users.get(id);
	}
	const row = await dbGet('SELECT * FROM users WHERE id = ?', [id]);
	const formatted = formatUser(row);
	if (formatted) {
		cache.users.set(id, formatted);
	}
	return formatted;
}

function setCachedUser(userObj) {
	if (userObj && userObj.id) {
		cache.users.set(userObj.id, userObj);
	}
}

function invalidateUserCache(id) {
	cache.users.delete(id);
}

async function getCachedMessage(msgId) {
	if (cache.messages.has(msgId)) {
		return cache.messages.get(msgId);
	}
	const row = await dbGet('SELECT * FROM messages WHERE id = ?', [msgId]);
	const formatted = formatMessage(row);
	if (formatted) {
		cache.messages.set(msgId, formatted);
	}
	return formatted;
}


async function getUserCalls(userId){
  if(!cache.calls) cache.calls=new Map();

  if(cache.calls.has(userId))
      return cache.calls.get(userId);

  const rows=await dbAll(
      `SELECT * FROM calls
       WHERE caller_id=? OR receiver_id=?
       ORDER BY COALESCE(ended_at,started_at) DESC`,
      [userId,userId]
  );

  const calls=rows.map(formatCall);
  cache.calls.set(userId,calls);

  return calls;
}

function setCachedMessage(msgObj) {
	if (msgObj && msgObj.id) {
		cache.messages.set(msgObj.id, msgObj);
	}
}

function invalidateMessageCache(msgId) {
	cache.messages.delete(msgId);
}

async function getCachedPinned(chatKey) {
	if (cache.pinned.has(chatKey)) {
		return cache.pinned.get(chatKey);
	}
	const row = await dbGet('SELECT * FROM pinned_messages WHERE chat_key = ?', [chatKey]);
	const pinned = row ? {
		id: row.id,
		chat_key: row.chat_key,
		message_id: row.message_id
	} : null;
	cache.pinned.set(chatKey, pinned);
	return pinned;
}

function setCachedPinned(chatKey, pinnedObj) {
	cache.pinned.set(chatKey, pinnedObj);
}

function invalidatePinnedCache(chatKey) {
	cache.pinned.delete(chatKey);
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
		log('[FCM WARN] Aborting push notification: Invalid or empty FCM token provided', {
			targetUserId
		});
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
		
		log('[FCM DEBUG] Sending payload to Firebase API...', {
			messageStructure: message
		});
		
		const response = await messagingAdmin.send(message);
		log('[FCM SUCCESS] Push notification sent successfully!', {
			messageId: response,
			targetUserId,
			timestamp: new Date()
				.toISOString()
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
		
		// Handle invalid registration tokens by clearing them from DB & Cache
		if (
			e.code === 'messaging/invalid-registration-token' ||
			e.code === 'messaging/registration-token-not-registered'
		) {
			log('[FCM WARN] Removing stale/invalid FCM token from DB for user:', targetUserId);
			if (targetUserId) {
				await dbRun('UPDATE users SET fcm_token = NULL WHERE id = ?', [targetUserId])
					.catch(() => {});
				const cached = cache.users.get(targetUserId);
				if (cached) {
					cached.hasFcmToken = false;
					cached.fcmToken = null;
				}
			}
		}
		return false;
	}
}

function getAllUsers() {
	return Array.from(cache.users.values());
}

async function broadcastUsers() {
	const allUsers = getAllUsers();
	
	io.emit('count', allUsers.length);
	io.emit('usersUpdate', allUsers);
	io.emit('onlineUpdate', onlineUsers);
	io.emit('usersLoaded', {
		allUsers
	});
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
	const allUsers = getAllUsers(),
		lastMsgs = [];
	
	for (const user of allUsers) {
		if (user.id === currentUserId) continue;
		
		const chatKey = getChatKey(currentUserId, user.id);
		const last = cache.lastMessages.get(chatKey);
		
		if (!last) continue;
		
		lastMsgs.push({
			id: last.id,
			peerId: user.id,
			by: last.user_id,
			to: last.target_user_id,
			msg: last.deleted ? ' 🚫 Message Deleted' : (last.text || (last.file_type ? getFileIcon(last.file_type) : '')),
			filename: last.deleted ? null : last.file_name,
			at: last.time,
			read_by: JSON.parse(last.read_by || '[]')
		});
	}
	
	return lastMsgs;
}

const io = new Server(server, {
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
	return res.status(404)
		.send('index.html not found in public directory');
});

app.use('/statuses', express.static(path.join(PUBLIC_DIR, 'statuses')));

app.get('/health', async (req, res) => {
	try {
		const userCount = await dbGet('SELECT COUNT(*) as count FROM users');
		const fcmCount = await dbGet('SELECT COUNT(*) as count FROM users WHERE fcm_token IS NOT NULL');
		res.json({
			status: 'healthy',
			online_users: onlineUsers.length,
			total_users: userCount ? userCount.count : 0,
			users_with_fcm_tokens: fcmCount ? fcmCount.count : 0,
			fcm_sdk_initialized: Boolean(messagingAdmin),
			cached_users_count: cache.users.size,
			cached_messages_count: cache.messages.size,
			timestamp: Date.now()
		});
	} catch (err) {
		res.status(500)
			.json({
				status: 'error',
				error: err.message
			});
	}
});

app.post('/api/register-fcm', async (req, res) => {
	const {
		token,
		userId
	} = req.body || {};
	
	log('[FCM REGISTER API] Received FCM token registration request', {
		userId,
		tokenPreview: token ? `${token.substring(0, 15)}...${token.slice(-5)}` : 'NULL',
		tokenLength: token ? token.length : 0,
		headers: req.headers
	});
	
	if (!token || !userId) {
		log('[FCM REGISTER API ERROR] Missing required fields', {
			tokenReceived: Boolean(token),
			userIdReceived: Boolean(userId)
		});
		return res.status(400)
			.json({
				success: false,
				message: 'token and userId are required'
			});
	}
	
	try {
		let user = await getCachedUser(userId);
		
		if (!user) {
			log('[FCM REGISTER API WARN] User not found during FCM token save attempt', {
				userId
			});
			// Create user row if missing
			await dbRun('INSERT INTO users (id, name, fcm_token, last_active) VALUES (?, ?, ?, ?)', [
        userId,
        randomName(),
        token,
        Date.now()
      ]);
		} else {
			const tokenChanged = user.fcmToken !== token;
			await dbRun('UPDATE users SET fcm_token = ? WHERE id = ?', [token, userId]);
			log('[FCM REGISTER API SUCCESS] FCM token updated in database', {
				userId,
				userName: user.name,
				tokenChanged
			});
		}
		
		// Refresh memory cache for user
		const updatedRow = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
		setCachedUser(formatUser(updatedRow));
		
		res.json({
			success: true,
			userId
		});
	} catch (err) {
		log('[FCM REGISTER API ERROR] Database update failed', {
			userId,
			error: err.message
		});
		res.status(500)
			.json({
				success: false,
				error: err.message
			});
	}
});

io.on('connection', (socket) => {
	log('[SERVER] Client socket connected', {
		sid: socket.id
	});
	
	socket.on('disconnect', () => {
		const userId = sidToUserId.get(socket.id);
		if (!userId) return;
		
		const finalizeDisconnect = async (uid) => {
			onlineUsers = onlineUsers.filter((u) => u.id !== uid);
			pendingDisconnects.delete(uid);
			sidToUserId.delete(socket.id);
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
		let userId = clientSession ? clientSession.userId :
			`usr_${Math.floor(100000 + Math.random() * 900000)}`;
		
		if (pendingDisconnects.has(userId)) {
			clearTimeout(pendingDisconnects.get(userId));
			pendingDisconnects.delete(userId);
		}
		
		const nowMs = Date.now();
		let user = await getCachedUser(userId);
		
		if (user) {
			let name = user.name;
			let expiresAt = user.expiresAt;
			
			if (clientSession.name && clientSession.expiresAt && nowMs < clientSession.expiresAt) {
				name = clientSession.name;
				expiresAt = clientSession.expiresAt;
			}
			
			await dbRun(
				'UPDATE users SET name = ?, expires_at = ?, last_active = ? WHERE id = ?',
        [name, expiresAt, nowMs, userId]
			);
			const updatedRow = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
			user = formatUser(updatedRow);
			setCachedUser(user);
		} else {
			const name = clientSession ? clientSession.name : randomName();
			const expiresAt = clientSession ? clientSession.expiresAt : null;
			
			await dbRun(
				'INSERT INTO users (id, name, expires_at, last_active) VALUES (?, ?, ?, ?)',
        [userId, name, expiresAt, nowMs]
			);
			const newRow = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
			user = formatUser(newRow);
			setCachedUser(user);
		}
		
		sidToUserId.set(socket.id, userId);
		socket.join(userId);
		
		socket.emit('sessionReady', {
			userId: user.id,
			name: user.name,
			expiresAt: user.expiresAt,
			dp: user.dp
		});
		
		if (!onlineUsers.some((x) => x.id === user.id)) {
			onlineUsers.push({
				id: user.id
			});
		}
		
		await broadcastUsers();
		
		socket.emit('lastMessages', {
			lastMessages: await calculateLastMessages(user.id)
		});
	});
	
	socket.on('loadUsers', async () => {
		const allUsers = getAllUsers();
		socket.emit('usersLoaded', {
			allUsers
		});
	});
	
	socket.on('loadCalls',async()=>{
    const userId=sidToUserId.get(socket.id);
    if(!userId)return;

    socket.emit('callsLoaded',{
        allCalls:await getUserCalls(userId)
    });
});

	
	socket.on("loadStatuses", async () => {
		const userId = sidToUserId.get(socket.id);
		if (!userId) return;
		
		const now = Date.now();
		const grouped = {};
		
		for (const status of cache.statuses.values()) {
			
			if (status.expires_at <= now) {
				continue;
			}
			
			if (!grouped[status.user_id]) {
				grouped[status.user_id] = {
					userId: status.user_id,
					username: status.name,
					statuses: []
				};
			}
			
			let views = [];
			
			try {
				views = JSON.parse(status.views || "[]");
			} catch {
				views = [];
			}
			
			grouped[status.user_id].statuses.push({
				id: status.id,
				user_id: status.user_id,
				username: status.name,
				type: status.type,
				content: status.content,
				media: status.type === "video" ? status.thumbnail : status.media,
				video: status.type === "video" ? status.media : null,
				background: status.background,
				createdAt: status.created_at,
				expiresAt: status.expires_at,
				views,
				viewed: views.some(v => v.userId === userId) || status.user_id == userId
			});
		}
		
		const groups = Object.values(grouped);
		
		groups.sort((a, b) => {
			if (a.userId === userId) return -1;
			if (b.userId === userId) return 1;
			
			return b.statuses[0].createdAt -
				a.statuses[0].createdAt;
		});
		
		socket.emit("statusesLoaded", groups);
	});
	
	socket.on('updateSession', async (data = {}) => {
		const userId = sidToUserId.get(socket.id);
		if (!userId) return;
		
		const user = await getCachedUser(userId);
		if (!user) return;
		
		const newName = data.newName || user.name;
		const expiresAt = data.expiresAt !== undefined ? data.expiresAt : user.expiresAt;
		
		await dbRun(
			'UPDATE users SET name = ?, expires_at = ?, last_active = ? WHERE id = ?',
      [newName, expiresAt, Date.now(), userId]
		);
		
		const updatedRow = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
		setCachedUser(formatUser(updatedRow));
		
		await broadcastUsers();
	});
	
	socket.on('requestNewIdentity', async () => {
		const userId = sidToUserId.get(socket.id);
		if (!userId) return;
		
		const user = await getCachedUser(userId);
		if (!user) return;
		
		const oldName = user.name;
		const newName = randomName();
		
		await dbRun(
			'UPDATE users SET name = ?, expires_at = NULL WHERE id = ?',
      [newName, userId]
		);
		
		const updatedRow = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
		setCachedUser(formatUser(updatedRow));
		
		socket.emit('sessionReady', {
			userId: user.id,
			name: newName,
			expiresAt: null,
			oldName
		});
		
		await broadcastUsers();
	});
	
	socket.on('setUsername', async (data = {}) => {
		const userId = sidToUserId.get(socket.id);
		if (!userId) return;
		
		const username = (data.username || '')
			.trim();
		
		if (!username) {
			socket.emit('usernameError', {
				message: 'Username cannot be empty.'
			});
			return;
		}
		
		if (username.length > 30) {
			socket.emit('usernameError', {
				message: 'Username is too long.'
			});
			return;
		}
		
		const user = await getCachedUser(userId);
		if (!user) return;
		
		const existing = await dbGet(
			'SELECT id FROM users WHERE name = ? AND id != ?',
      [username, userId]
		);
		
		if (existing) {
			socket.emit('usernameError', {
				message: 'Username already taken.'
			});
			return;
		}
		
		const oldName = user.name;
		await dbRun('UPDATE users SET name = ? WHERE id = ?', [username, userId]);
		
		const updatedRow = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
		setCachedUser(formatUser(updatedRow));
		
		socket.emit('sessionReady', {
			userId: user.id,
			name: username,
			dp: user.dp,
			expiresAt: user.expiresAt,
			oldName
		});
		
		await broadcastUsers();
	});
	
	socket.on('deleteDp', async (data = {}) => {
		const userId = sidToUserId.get(socket.id);
		if (!userId) return;
		
		const user = await getCachedUser(userId);
		if (!user) return;
		
		const defaultDp =
			'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTSuJxruKI4Dzpax96RDs4byyus5J7xpph9moTDEt5DoA&s=10';
		if (user.dp === defaultDp) return;
		
		await dbRun('UPDATE users SET dp = ? WHERE id = ?', [defaultDp, userId]);
		
		const updatedRow = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
		const updatedUser = formatUser(updatedRow);
		setCachedUser(updatedUser);
		
		socket.emit('dpDeleted', {
			dp: updatedUser.dp
		});
		
		socket.emit('reloadUI', {});
		
		await broadcastUsers();
	});
	
	socket.on('changeDp', async (data = {}) => {
		const userId = sidToUserId.get(socket.id);
		if (!userId) return;
		
		const dp = (data.dp || '');
		
		await dbRun('UPDATE users SET dp = ? WHERE id = ?', [dp, userId]);
		
		const updatedRow = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
		const updatedUser = formatUser(updatedRow);
		setCachedUser(updatedUser);
		
		socket.emit('dpChanged', {
			dp: updatedUser.dp
		});
		
		socket.emit('sessionReady')
		
		await broadcastUsers();
	});
	
	socket.on('loadDirectHistory', async (data = {}) => {
		const userId = sidToUserId.get(socket.id);
		const targetUserId = data.targetUserId;
		
		if (!userId || !targetUserId) return;
		
		const offset = parseInt(data.offset || 0, 10);
		const limit = parseInt(data.limit || 10, 10);
		const chatKey = getChatKey(userId, targetUserId);
		
		const history = await loadHistoryCache(chatKey);
		
		const total = history.length;
		const start = Math.max(total - offset - limit, 0);
		const end = total - offset;
		
		const page = history.slice(start, end);
		
		const pinnedObj = await getCachedPinned(chatKey);
		const user = await getCachedUser(userId);
		
		if (!user) return;
		
		socket.emit('directHistoryLoaded', {
			targetUserId,
			dp: user.dp,
			history: page,
			pinned: pinnedObj,
			hasMore: start > 0
		});
	});

	socket.on('directMessage', async (payload = {}) => {
		const userId = sidToUserId.get(socket.id);
		if (!userId || !payload) return;
		
		const targetUserId = payload.targetUserId;
		if (!targetUserId) return;
		
		const text = (payload.text || '')
			.trim();
		const file = payload.file || null;
		const fileName = payload.fileName || null;
		const fileType = payload.fileType || null;
		const fileSize = payload.fileSize || null;
		const replyTo = payload.replyTo ? JSON.stringify(payload.replyTo) : null;
		
		if (!text && !file) return;
		
		const sender = await getCachedUser(userId);
		const senderName = sender?.name || 'Anonymous';
		const chatKey = getChatKey(userId, targetUserId);
		const nowMs = Date.now();
		
		const result = await dbRun(`INSERT INTO messages
    (chat_key,user_id,target_user_id,name,text,file,file_name,file_type,file_size,reply_to,time,read_by,reactions,edited,forwarded,deleted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [chatKey, userId, targetUserId, senderName, text, file, fileName, fileType, fileSize, replyTo, nowMs, '[]', '{}', 0, 0, 0]);
		
		const insertedRow = {
			id: result.lastID,
			chat_key: chatKey,
			user_id: userId,
			target_user_id: targetUserId,
			name: senderName,
			text,
			file,
			file_name: fileName,
			file_type: fileType,
			file_size: fileSize,
			reply_to: replyTo,
			time: nowMs,
			read_by: '[]',
			reactions: '{}',
			edited: 0,
			forwarded: 0,
			deleted: 0
		};
		
		const msgData = formatMessage(insertedRow);
		
		setCachedMessage(msgData);
		
		cache.lastMessages.set(chatKey, insertedRow);
		
		if (cache.histories.has(chatKey)) {
			cache.histories.get(chatKey)
				.push(msgData);
		}
		
		socket.emit('directMessage', msgData);
		io.to(targetUserId)
			.emit('directMessage', msgData);
		
		socket.emit('lastMessages', {
			lastMessages: await calculateLastMessages(userId)
		});
		
		io.to(targetUserId)
			.emit('lastMessages', {
				lastMessages: await calculateLastMessages(targetUserId)
			});
		
		const target = await getCachedUser(targetUserId);
		
		if (target?.fcmToken) {
			await sendPushNotification(
				target.fcmToken,
				senderName,
				text || fileName || '📎 Attachment', {
					type: 'message',
					userId,
					chatId: chatKey
				},
				targetUserId
			);
		}
	});
	
	socket.on("postStatus", async (data = {}) => {
		const userId = sidToUserId.get(socket.id);
		if (!userId) return;
		
		const created = Date.now();
		const expires = created + 24 * 60 * 60 * 1000;
		
		const result = await dbRun(`
      INSERT INTO statuses
      (user_id,type,content,media, thumbnail, background,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?)
  `, [
      userId,
      data.type,
      data.content || null,
      data.media || null,
      data.thumbnail || null,
      data.background || "#111827",
      created,
      expires
  ]);
		
		const status = {
			id: result.lastID,
			user_id: userId,
			type: data.type,
			content: data.content || null,
			media: data.media || null,
			thumbnail: data.thumbnail || null,
			background: data.background || "#111827",
			created_at: created,
			expires_at: expires,
			views: "[]"
		};
		
		cache.statuses.set(status.id, status);
		
		io.emit("statusUpdated");
	});
	
	socket.on("viewStatus", async ({
		statusId
	}) => {
		const userId = sidToUserId.get(socket.id);
		if (!userId) return;
		
		const status = cache.statuses.get(statusId);
		if (!status) return;
		
		const user = await getCachedUser(userId);
		if (!user) return;
		
		const views = Array.isArray(status.views) ?
			status.views :
			JSON.parse(status.views || "[]");
		
		if (views.some(v => v.userId === userId)) return;
		
		const viewedAt = Date.now();
		
		const viewer = {
			userId,
			name: user.name,
			viewedAt,
			statusId: status.id
		};
		
		views.push(viewer);
		status.views = views;
		
		cache.statuses.set(statusId, status);
		
		await dbRun(
			"UPDATE statuses SET views=? WHERE id=?",
      [JSON.stringify(views), statusId]
		);
		
		io.to(status.user_id)
			.emit("statusViewed", {
				statusId,
				viewer
			});
	});
	
	socket.on("deleteStatus", async ({
		statusId
	}) => {
		const userId = sidToUserId.get(socket.id);
		if (!userId) return;
		
		const status = await dbGet(
			"SELECT user_id FROM statuses WHERE id=?",
      [statusId]
		);
		
		if (!status) {
			socket.emit("statusError", {
				message: "Status not found."
			});
			return;
		}
		
		if (status.user_id !== userId) {
			socket.emit("statusError", {
				message: "You cannot delete this status."
			});
			return;
		}
		
		await dbRun("DELETE FROM statuses WHERE id=?", [statusId]);
		io.emit("statusUpdated");
	});
	
	socket.on("getUserStatuses", async ({
		userId
	}) => {
		const rows = await dbAll(`
        SELECT *
        FROM statuses
        WHERE user_id=?
        AND expires_at > ?
        ORDER BY created_at ASC
    `, [userId, Date.now()]);
		
		socket.emit("userStatuses", rows);
	});
	
	socket.on("getStatusViews", async ({
		statusId
	}) => {
		const userId = sidToUserId.get(socket.id);
		
		const row = await dbGet(
			"SELECT user_id, views FROM statuses WHERE id=?",
      [statusId]
		);
		
		if (!row || row.user_id !== userId) return;
		
		const views = JSON.parse(row.views || "[]");
		const viewers = [];
		
		for (const view of views) {
			const user = await getCachedUser(view.userId);
			
			viewers.push({
				userId: view.userId,
				username: user?.name || "Anonymous",
				viewedAt: view.viewedAt,
				dp: user?.dp || null
			});
		}
		
		viewers.sort((a, b) => b.viewedAt - a.viewedAt);
		socket.emit("statusViews", viewers);
	});
	
  socket.on('editMessage',async(data={})=>{
    const userId=sidToUserId.get(socket.id);
    if(!userId)return;

    const msg=await getCachedMessage(data.msgId);
    if(!msg||msg.user_id!==userId)return;

    const newText=(data.newText||'').trim();
    if(!newText)return;

    await dbRun(
        'UPDATE messages SET text=?,edited=1 WHERE id=?',
        [newText,msg.id]
    );

    const updated=await dbGet(
        'SELECT * FROM messages WHERE id=?',
        [msg.id]
    );

    const msgData=formatMessage(updated);
    setCachedMessage(msgData);

    const last=cache.lastMessages.get(msg.chat_key);

    if(last?.id===msg.id){
        cache.lastMessages.set(msg.chat_key,msgData);
    }

    const payload={
        chatKey:msg.chat_key,
        msg:msgData
    };

    socket.emit('messageUpdated',payload);
    io.to(msg.target_user_id).emit('messageUpdated',payload);
});


socket.on('togglePinMessage',async(data={})=>{
    const userId=sidToUserId.get(socket.id);
    if(!userId)return;

    const chatKey=getChatKey(userId,data.targetUserId);
    const msg=await getCachedMessage(data.msgId);

    if(!msg)return;

    const pinned=await getCachedPinned(chatKey);

    if(pinned?.message_id===msg.id){
        await dbRun(
            'DELETE FROM pinned_messages WHERE chat_key=?',
            [chatKey]
        );
    }else{
        if(pinned){
            await dbRun(
                'DELETE FROM pinned_messages WHERE chat_key=?',
                [chatKey]
            );
        }

        await dbRun(
            'INSERT INTO pinned_messages (chat_key,message_id) VALUES (?,?)',
            [chatKey,msg.id]
        );
    }

    invalidatePinnedCache(chatKey);

    const updatedPinned=await getCachedPinned(chatKey);

    const payload={
        chatKey,
        pinned:updatedPinned
    };

    socket.emit('pinnedUpdate',payload);
    io.to(data.targetUserId).emit('pinnedUpdate',payload);
});
	
	socket.on('markRead', async (data = {}) => {
		const userId = sidToUserId.get(socket.id);
		const targetUserId = data.targetUserId;
		const msgIds = Array.isArray(data.msgIds) ? data.msgIds : [];
		
		if (!userId || !targetUserId || !msgIds.length) return;
		
		const user = await getCachedUser(userId);
		let updated = false;
		
		for (const id of msgIds) {
			const msg = await getCachedMessage(id);
			if (!msg || msg.user_id === userId) continue;
			
			const readBy = Array.isArray(msg.read_by) ?
				msg.read_by :
				JSON.parse(msg.read_by || '[]');
			
			if (readBy.some(r => r.userId === userId)) continue;
			
			readBy.push({
				userId,
				name: user?.name || 'Anonymous',
				time: Date.now()
			});
			
			await dbRun(
				'UPDATE messages SET read_by = ? WHERE id = ?',
            [JSON.stringify(readBy), id]
			);
			
			msg.read_by = readBy;
			setCachedMessage(msg);
			
			const last = cache.lastMessages.get(msg.chat_key);
			
			if (last?.id === msg.id) {
				last.read_by = JSON.stringify(readBy);
				cache.lastMessages.set(msg.chat_key, last);
			}
			
			updated = true;
		}
		
		if (!updated) return;
		
		const readData = {
			byUserId: userId,
			msgIds
		};
		
		socket.emit('messagesRead', {
			...readData,
			targetUserId
		});
		
		io.to(targetUserId)
			.emit('messagesRead', {
				...readData,
				targetUserId: userId
			});
	});
	
	socket.on('toggleReaction', async (data = {}) => {
		const userId = sidToUserId.get(socket.id);
		if (!userId) return;
		
		const msg = await getCachedMessage(data.msgId);
		if (!msg) return;
		
		const emoji = data.emoji;
		if (!emoji) return;
		
		let reactions = msg.reactions || {};
		
		if (!reactions[emoji]) reactions[emoji] = [];
		
		const user = await getCachedUser(userId);
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
		const msgData = formatMessage(updated);
		setCachedMessage(msgData);
		
		const payload = {
			chatKey: msg.chat_key,
			msg: msgData
		};
		
		socket.emit('messageUpdated', payload);
		io.to(msg.target_user_id)
			.emit('messageUpdated', payload);
	});
	
	socket.on('deleteMessage', async (data = {}) => {
		const userId = sidToUserId.get(socket.id);
		if (!userId) return;
		
		const msg = await getCachedMessage(data.msgId);
		if (!msg || msg.user_id !== userId) return;
		
		await dbTransaction([
			{
				sql: 'DELETE FROM pinned_messages WHERE chat_key = ? AND message_id = ?',
				params: [msg.chat_key, msg.id]
        },
			{
				sql: `UPDATE messages
                  SET deleted = 1,
                      text = '',
                      file = NULL,
                      file_name = NULL
                  WHERE id = ?`,
				params: [msg.id]
        }
    ]);
		
		msg.deleted = 1;
		msg.text = '';
		msg.file = null;
		msg.file_name = null;
		
		setCachedMessage(msg);
		
		const history = cache.histories.get(msg.chat_key);
		
		if (history) {
			const cached = history.find(m => m.id === msg.id);
			
			if (cached) {
				cached.deleted = 1;
				cached.text = '';
				cached.file = null;
				cached.file_name = null;
			}
		}
		
		invalidatePinnedCache(msg.chat_key);
		
		socket.emit('messageDeleted', {
			targetUserId: msg.target_user_id,
			msgId: msg.id
		});
		
		io.to(msg.target_user_id)
			.emit('messageDeleted', {
				targetUserId: userId,
				msgId: msg.id
			});
	});
	
	socket.on('forwardMessage', async (data = {}) => {
		const userId = sidToUserId.get(socket.id);
		const targetUserId = data.targetUserId;
		const message = data.message || {};
		
		if (!userId || !targetUserId) return;
		
		const sender = await getCachedUser(userId);
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
		setCachedMessage(msgDict);
		cache.lastMessages.set(chatKey, insertedMsg);
		
		socket.emit('directMessage', msgDict);
		io.to(targetUserId)
			.emit('directMessage', msgDict);
		
		log('[FCM DEBUG] Forward message push notification check...', {
			senderUserId: userId,
			targetUserId
		});
		const target = await getCachedUser(targetUserId);
		
		if (target && target.fcmToken) {
			await sendPushNotification(
				target.fcmToken,
				sender ? sender.name : 'Anonymous',
				msgDict.text || '[Forwarded Attachment]', {
					type: 'message',
					userId,
					chatId: chatKey
				},
				targetUserId
			);
		} else {
			log('[FCM WARN] Target user has no FCM token for forwarded message.', {
				targetUserId
			});
		}
	});
	
	socket.on('callUser',async(data={})=>{
    const callerId=sidToUserId.get(socket.id);
    const targetUserId=data.targetUserId;

    if(!callerId||!targetUserId)return;

    const startedAt=Date.now();

    const result=await dbRun(
        `INSERT INTO calls
        (caller_id,receiver_id,call_type,status,started_at)
        VALUES(?,?,?,?,?)`,
        [
            callerId,
            targetUserId,
            data.callType||'video',
            'ringing',
            startedAt
        ]
    );

    const call={
        id:result.lastID,
        caller_id:callerId,
        receiver_id:targetUserId,
        call_type:data.callType||'video',
        status:'ringing',
        started_at:startedAt,
        ended_at:null,
        duration:0
    };

    const callData=formatCall(call);

    if(!cache.calls)cache.calls=new Map();

    for(const uid of [callerId,targetUserId]){
        const list=cache.calls.get(uid)||[];
        cache.calls.set(uid,[callData,...list]);
    }

    io.to(callerId).emit('callId',{
        callId:result.lastID
    });

    io.to(callerId).emit('callUpdated',callData);

    io.to(targetUserId).emit('incomingCall',{
        callId:result.lastID,
        fromUserId:callerId,
        fromSocketId:socket.id,
        callerName:data.callerName,
        callType:data.callType||'video',
        signal:data.signal
    });

    io.to(targetUserId).emit('callUpdated',callData);
});
socket.on('acceptCall',async(data={})=>{
  const userId=sidToUserId.get(socket.id);

  if(!userId||!data.callId)return;

  const startedAt=Date.now();

  await dbRun(
      `UPDATE calls
       SET status=?,started_at=?
       WHERE id=?`,
      ['accepted',startedAt,data.callId]
  );

  const row=await dbGet(
      'SELECT * FROM calls WHERE id=?',
      [data.callId]
  );

  if(row){
      const callData=formatCall(row);

      if(cache.calls){
          for(const [uid,list] of cache.calls){
              const i=list.findIndex(c=>c.id===callData.id);
              if(i!==-1)list[i]=callData;
          }
      }

      io.to(row.caller_id).emit('callUpdated',callData);
      io.to(row.receiver_id).emit('callUpdated',callData);
  }

  io.to(data.targetUserId).emit('callAccepted',{
      fromUserId:userId,
      fromSocketId:socket.id,
      answererName:data.answererName,
      signal:data.signal
  });
});

socket.on('missedCall', async(callId) =>{

	console.log('missed call recorded', + callId)

	const userId = sidToUserId.get(socket.id);

	const call = await dbGet(
		'SELECT * FROM calls WHERE id=?',
	[callId]
	);
	
	if (!call) return;
	
	const endedAt = Date.now();

	await dbRun(
		`UPDATE calls
	 SET status=?,ended_at=?
	 WHERE id=?`,
	['ended', endedAt,  callId]
	);
	
	const updated = formatCall({
		...call,
		status: 'missed',
		ended_at: endedAt,
	});
	
	if (cache.calls) {
		for (const [uid, list] of cache.calls) {
			const i = list.findIndex(c => c.id === updated.id);
			if (i !== -1) list[i] = updated;
		}
	}

	socket.emit('callUpdated', updated);

	if (call.receiver_id)
		io.to(call.receiver_id)
		.emit('callUpdated', updated);


})


socket.on('rejectCall',async(data={})=>{
  const userId=sidToUserId.get(socket.id);

  if(!userId||!data.callId)return;

  const endedAt=Date.now();

  await dbRun(
      `UPDATE calls
       SET status=?,ended_at=?,duration=0
       WHERE id=?`,
      ['rejected',endedAt,data.callId]
  );

  const row=await dbGet(
      'SELECT * FROM calls WHERE id=?',
      [data.callId]
  );

  if(row){
      const callData=formatCall(row);

      if(cache.calls){
          for(const [uid,list] of cache.calls){
              const i=list.findIndex(c=>c.id===callData.id);
              if(i!==-1)list[i]=callData;
          }
      }

      io.to(row.caller_id).emit('callUpdated',callData);
      io.to(row.receiver_id).emit('callUpdated',callData);
  }

  io.to(data.targetUserId).emit('callRejected',{
      byName:data.byName
  });
});
	socket.on('sendIceCandidate', (data = {}) => {
		if (data.targetUserId) {
			io.to(data.targetUserId)
				.emit('iceCandidate', {
					candidate: data.candidate
				});
		}
	});

	socket.on('endCall', async (data = {}) => {
		const userId = sidToUserId.get(socket.id);
		if (!userId || !data.callId) return;
		
		const call = await dbGet(
			'SELECT * FROM calls WHERE id=?',
        [data.callId]
		);
		
		if (!call) return;
		
		const endedAt = Date.now();
		const duration = call.started_at ?
			Math.floor((endedAt - call.started_at) / 1000) :
			0;
		
		await dbRun(
			`UPDATE calls
         SET status=?,ended_at=?,duration=?
         WHERE id=?`,
        ['ended', endedAt, duration, data.callId]
		);
		
		const updated = formatCall({
			...call,
			status: 'ended',
			ended_at: endedAt,
			duration
		});
		
		if (cache.calls) {
			for (const [uid, list] of cache.calls) {
				const i = list.findIndex(c => c.id === updated.id);
				if (i !== -1) list[i] = updated;
			}
		}
		
		socket.emit('callUpdated', updated);
		
		if (data.targetUserId)
			io.to(data.targetUserId)
			.emit('callUpdated', updated);
	});

  socket.on('deleteCallLog',async(data={})=>{
    const userId=sidToUserId.get(socket.id);
    if(!userId||!data.callId)return;

    const call=await dbGet(
        `SELECT * FROM calls
         WHERE id=?
         AND (caller_id=? OR receiver_id=?)`,
        [data.callId,userId,userId]
    );

    if(!call)return;

    await dbRun(
        'DELETE FROM calls WHERE id=?',
        [data.callId]
    );

    if(cache.calls){
        for(const [uid,list] of cache.calls){
            cache.calls.set(
                uid,
                list.filter(c=>c.id!==data.callId)
            );
        }
    }

    socket.emit('callDeleted',{
        callId:data.callId
    });
});

socket.on('deleteCallLogs',async(data={})=>{
    const userId=sidToUserId.get(socket.id);
    const ids=Array.isArray(data.callIds)?data.callIds:[];

    if(!userId||!ids.length)return;

    const deleted=[];

    for(const id of ids){
        const call=await dbGet(
            `SELECT id FROM calls
             WHERE id=?
             AND (caller_id=? OR receiver_id=?)`,
            [id,userId,userId]
        );

        if(!call)continue;

        await dbRun(
            'DELETE FROM calls WHERE id=?',
            [id]
        );

        deleted.push(id);
    }

    if(!deleted.length)return;

    if(cache.calls){
        for(const [uid,list] of cache.calls){
            cache.calls.set(
                uid,
                list.filter(c=>!deleted.includes(c.id))
            );
        }
    }

    socket.emit('callsDeleted',{
        callIds:deleted
    });
});
	
	socket.on('typing', async (data = {}) => {
		const user = await getCachedUser(sidToUserId.get(socket.id));
		if (user && data.targetUserId) {
			io.to(data.targetUserId)
				.emit('typing', {
					fromUserId: user.id,
					name: user.name
				});
		}
	});
	
	socket.on('stopTyping', (data = {}) => {
		const userId = sidToUserId.get(socket.id);
		if (userId && data.targetUserId) {
			io.to(data.targetUserId)
				.emit('stopTyping', {
					fromUserId: userId
				});
		}
	});
});

async function loadStatusCache() {
	const now = Date.now();
	
	const rows = await dbAll(`
      SELECT
          s.*,
          u.name
      FROM statuses s
      JOIN users u
          ON u.id = s.user_id
      WHERE s.expires_at > ?
  `, [now]);
	
	cache.statuses.clear();
	
	for (const status of rows) {
		cache.statuses.set(status.id, status);
	}
}

const statusStorage = multer.diskStorage({
	destination: (req, file, cb) => {
		const dir = path.join(PUBLIC_DIR, 'statuses');
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, {
			recursive: true
		});
		cb(null, dir);
	},
	filename: (req, file, cb) => {
		const ext = path.extname(file.originalname);
		cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
	}
});

const uploadStatus = multer({
	storage: statusStorage,
	limits: {
		fileSize: 5 * 1024 * 1024
	}
});

app.post("/uploadStatusMedia", uploadStatus.fields([
	{
		name: "media",
		maxCount: 1
	},
	{
		name: "thumbnail",
		maxCount: 1
	}
]), (req, res) => {
	if (!req.files?.media?.[0]) {
		return res.status(400)
			.json({
				error: "No media uploaded"
			});
	}
	
	const media = req.files.media[0];
	const thumbnail = req.files.thumbnail?.[0];
	
	res.json({
		url: `/statuses/${media.filename}`,
		thumbnail: thumbnail ?
			`/statuses/${thumbnail.filename}` : null
	});
});

server.listen(PORT, '0.0.0.0', async () => {
	await loadLastMessagesCache();
	await loadLastMessagesCache();
	await loadUserCache();
	await loadStatusCache()
	
	log(`[SERVER] Node server successfully started and listening on 0.0.0.0:${PORT}`);
	
});
