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
   users: new Map(),
   messages: new Map(),
   pinned: new Map(),
   lastMessages: new Map(),
   statuses: new Map(),
   histories: new Map(),
   calls: null,
   contacts: new Map(),
   groups:new Map(),
   groupMembers:new Map(),
   groupHistories:new Map(),
   groupLastMessages:new Map()
   
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

const DB_PATH = path.join(__dirname,'chat.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
   if (err) {
      log('Database connection error', {
         error: err.message
      });
   } else {
      log('Connected to SQLite database');
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

async function addColumn(table,column,definition){
   try{
       await dbRun(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
   }catch(err){
       if(!err.message.includes('duplicate column name')) throw err;
   }
}

function dbAll(sql, params = []) {
   return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
         if (err) reject(err);
         else resolve(rows || []);
      });
   });
}

async function createTables(){
    try{
        await dbRun(`
            CREATE TABLE IF NOT EXISTS users(
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                expires_at INTEGER,
                last_active INTEGER,
                fcm_token TEXT,
                dp TEXT DEFAULT '/alt-user.png',
                banned BOOLEAN DEFAULT 0
            )
        `);

        await dbRun(`
            CREATE TABLE IF NOT EXISTS contacts(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                contact_user_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                name TEXT,
				UNIQUE(user_id,contact_user_id)
            )
        `);

        await dbRun(`
            CREATE TABLE IF NOT EXISTS calls(
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
            CREATE TABLE IF NOT EXISTS statuses(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                type TEXT NOT NULL,
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
            CREATE TABLE IF NOT EXISTS messages(
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
                file_size TEXT,
                deleted INTEGER DEFAULT 0,
                group_id INTEGER,
                group_name TEXT,
                type TEXT DEFAULT 'message'
            )
        `);

        await dbRun(`
            CREATE TABLE IF NOT EXISTS pinned_messages(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_key TEXT UNIQUE NOT NULL,
                message_id INTEGER NOT NULL,
				pinned_at INTEGER NOT NULL
            )
        `);

        await dbRun(`
            INSERT OR IGNORE INTO users(id,name)
            VALUES(?,?)
        `,['admin','Admin']);

      //   Groups

      await dbRun(`
         CREATE TABLE IF NOT EXISTS groups(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             name TEXT NOT NULL,
             description TEXT,
             image TEXT,
             type TEXT NOT NULL DEFAULT 'private',
             owner_id TEXT NOT NULL,
             created_at INTEGER NOT NULL
         )
     `);
     
     await dbRun(`
         CREATE TABLE IF NOT EXISTS group_members(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             group_id INTEGER NOT NULL,
             user_id TEXT NOT NULL,
             role TEXT NOT NULL DEFAULT 'member',
             joined_at INTEGER NOT NULL,
             UNIQUE(group_id,user_id)
         )
     `);

     await dbRun(`
      CREATE TABLE IF NOT EXISTS group_invites (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER NOT NULL,
          inviter_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          created_at INTEGER NOT NULL
      )
      `);
     
     await dbRun(`
         CREATE TABLE IF NOT EXISTS group_messages(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             group_id INTEGER NOT NULL,
             user_id TEXT NOT NULL,
             name TEXT,
             text TEXT,
             file TEXT,
             file_name TEXT,
             file_type TEXT,
             file_size INTEGER,
             reply_to TEXT,
             time INTEGER NOT NULL,
             read_by TEXT DEFAULT '[]',
             reactions TEXT DEFAULT '{}',
             edited INTEGER DEFAULT 0,
             deleted INTEGER DEFAULT 0
         )
     `);

    }catch(e){
        console.error('[DB] CREATE TABLE ERROR:',e);
        throw e;
    }
}


let firebaseAdmin = null;
let messagingAdmin = null;

const firebaseFile = path.join(PUBLIC_DIR, 'firebase-admin.json');

if (fs.existsSync(firebaseFile)) {
   try {
      const admin = require('firebase-admin');
      const serviceAccount = require(firebaseFile);
      
      firebaseAdmin = admin.initializeApp({
         credential: admin.credential.cert(serviceAccount)
      });
      messagingAdmin = firebaseAdmin.messaging();
      log('[FCM SUCCESS] Firebase Admin SDK successfully initialized');
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

async function getUsersForClient(userId) {
   const users = Array.from(cache.users.values());
   
   const contacts = await dbAll(`
        SELECT contact_user_id,name
        FROM contacts
        WHERE user_id=?
    `, [userId]);
   
   const contactNames = new Map(
      contacts.map(c => [c.contact_user_id, c.name])
   );
   
   return users.map(user => ({
      ...user,
      name: contactNames.get(user.id) || user.name
   }));
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
      dp: row.dp,
      saved: Boolean(row.saved)
   };
}

function parseJSON(value, fallback=[]){
    if(Array.isArray(value)||typeof value==='object'&&value!==null)return value;
    try{return JSON.parse(value||JSON.stringify(fallback));}
    catch{return fallback;}
}


async function loadHistoryCache(chatKey,userId){
    const rows=await dbAll(
        'SELECT * FROM messages WHERE chat_key=? ORDER BY time ASC',
        [chatKey]
    );

    const history=[];

    for(const row of rows){
        const msg=await formatMessage(row,userId);
        if(msg)history.push(msg);
    }

    cache.histories.set(chatKey,history);
    return history;
}

function setCachedContacts(userId, contacts) {
   cache.contacts.set(userId, contacts);
}

function getCachedContacts(userId) {
   return cache.contacts.get(userId);
}

function invalidateContacts(userId) {
   cache.contacts.delete(userId);
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

async function formatMessage(row,userId){
    if(!row)return null;

    const contact=await dbGet(
        `SELECT name FROM contacts WHERE user_id=? AND contact_user_id=?`,
        [userId,row.user_id]
    );

    let replyTo=null,readBy=[],reactions={};

    try{
        replyTo=row.reply_to?JSON.parse(row.reply_to):null;

        if(replyTo?.id){
            const replyMsg=await getCachedMessage(replyTo.id);

            if(replyMsg){
                const replyContact=await dbGet(
                    `SELECT name FROM contacts WHERE user_id=? AND contact_user_id=?`,
                    [userId,replyMsg.user_id]
                );

                replyTo={
                    ...replyTo,
                    name:replyContact?.name||replyMsg.name||'Unknown'
                };
            }
        }
    }catch{}

    try{readBy=row.read_by?JSON.parse(row.read_by):[]}catch{}
    try{reactions=row.reactions?JSON.parse(row.reactions):{}}catch{}

    return{
      id:row.id,
      chat_key:row.chat_key,
      user_id:row.user_id,
      target_user_id:row.target_user_id,
      name:contact?.name||row.name||'Unknown',
      type:row.type||'message',
      groupId:row.group_id||null,
      groupName:row.group_name||null,
      text:row.deleted?null:row.text,
      image:row.deleted?null:row.image,
      file:row.deleted?null:row.file,
      file_name:row.deleted?null:row.file_name,
      file_type:row.deleted?null:row.file_type,
      file_size:row.deleted?null:row.file_size,
      reply_to:replyTo,
      time:row.time,
      read_by:readBy,
      reactions:row.deleted?null:reactions,
      edited:row.deleted?null:Boolean(row.edited),
      forwarded:Boolean(row.forwarded),
      deleted:row.deleted===1
  };
}

function formatCall(row) {
   return {
      id: row.id,
      caller_id: row.caller_id,
      receiver_id: row.receiver_id,
      call_type: row.call_type,
      status: row.status,
      started_at: row.started_at,
      ended_at: row.ended_at,
      duration: row.duration || 0
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

async function getCachedGroup(groupId){
   if(cache.groups.has(groupId))
       return cache.groups.get(groupId);

   const group=await dbGet(
       `SELECT * FROM groups WHERE id=?`,
       [groupId]
   );

   if(group)
       cache.groups.set(groupId,group);

   return group||null;
}

async function getCachedGroupMembers(groupId){
   if(cache.groupMembers.has(groupId))
       return cache.groupMembers.get(groupId);

   const rows=await dbAll(`
       SELECT *
       FROM group_members
       WHERE group_id=?
   `,[groupId]);

   const members=new Map(
       rows.map(m=>[m.user_id,m])
   );

   cache.groupMembers.set(groupId,members);

   return members;
}

async function getCachedGroupHistory(groupId,userId){
   const rows=await dbAll(`
       SELECT *
       FROM group_messages
       WHERE group_id=?
       ORDER BY time ASC
       LIMIT 100
   `,[groupId]);

   const userIds=[
       ...new Set(
           rows.map(row=>row.user_id).filter(Boolean)
       )
   ];

   let contacts=new Map();

   if(userIds.length){
       const placeholders=userIds.map(()=>'?').join(',');

       const contactRows=await dbAll(`
           SELECT contact_user_id,name
           FROM contacts
           WHERE user_id=?
           AND contact_user_id IN (${placeholders})
       `,[userId,...userIds]);

       contacts=new Map(
           contactRows.map(row=>[
               row.contact_user_id,
               row.name
           ])
       );
   }

   const messages=rows.map(row=>{
       let replyTo=null;
       let readBy=[];
       let reactions={};

       try{
           replyTo=row.reply_to?JSON.parse(row.reply_to):null;
       }catch{}

       try{
           readBy=row.read_by?JSON.parse(row.read_by):[];
       }catch{}

       try{
           reactions=row.reactions?JSON.parse(row.reactions):{};
       }catch{}

       return{
           id:row.id,
           group_id:row.group_id,
           user_id:row.user_id,
           name:contacts.get(row.user_id)||row.name||'Unknown',
           text:row.deleted?null:row.text,
           file:row.deleted?null:row.file,
           file_name:row.deleted?null:row.file_name,
           file_type:row.deleted?null:row.file_type,
           file_size:row.deleted?null:row.file_size,
           reply_to:replyTo,
           time:row.time,
           read_by:readBy,
           reactions:row.deleted?null:reactions,
           edited:row.deleted?false:Boolean(row.edited),
           deleted:Boolean(row.deleted)
       };
   });

   cache.groupHistories.set(groupId,messages);

   cache.groupLastMessages.set(
       groupId,
       messages[messages.length-1]||null
   );

   return messages;
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


async function getUserCalls(userId) {
   if (!cache.calls) cache.calls = new Map();
   
   if (cache.calls.has(userId))
      return cache.calls.get(userId);
   
   const rows = await dbAll(
      `SELECT * FROM calls
       WHERE caller_id=? OR receiver_id=?
       ORDER BY COALESCE(ended_at,started_at) DESC`,
      [userId, userId]
   );
   
   const calls = rows.map(formatCall);
   cache.calls.set(userId, calls);
   
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

async function getCachedPinned(chatKey){

    if(cache.pinned.has(chatKey)){
        const cached=cache.pinned.get(chatKey);
        return cached;
    }


    const row=await dbGet(
        'SELECT * FROM pinned_messages WHERE chat_key=?',
        [chatKey]
    );


    const pinned=row?{
		id:row.id,
		chat_key:row.chat_key,
		message_id:row.message_id,
		pinned_at:row.pinned_at,
		pinned_by:row.pinned_by
	}:null;

    cache.pinned.set(chatKey,pinned);


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
   const baseUsers = getAllUsers();
   
   for (const [socketId, userId] of sidToUserId) {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) continue;
      
      const rows = await dbAll(`
            SELECT
                u.*,
                COALESCE(c.name,u.name) AS name,
                CASE
                    WHEN c.contact_user_id IS NOT NULL THEN 1
                    ELSE 0
                END AS saved
            FROM users u
            LEFT JOIN contacts c
                ON c.contact_user_id=u.id
                AND c.user_id=?
        `, [userId]);
      
      const allUsers = rows.map(formatUser);
      
      socket.emit('usersUpdate', allUsers);
      
      socket.emit('usersLoaded', {
         allUsers
      });
   }
   
   io.emit('count', baseUsers.length);
   io.emit('onlineUpdate', onlineUsers);
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
   if (type.includes('text/css')) return 'fas fa-css3';
   if (type.includes('excel') || type.includes('spreadsheet')) return 'fas fa-file-excel';
   if (type.includes('powerpoint') || type.includes('presentation')) return 'fas fa-file-powerpoint';
   if (type.includes('zip') || type.includes('rar') || type.includes('7z')) return 'fas fa-file-zipper';
   if (type.includes('text')) return 'fas fa-file-lines';
   return 'fas fa-file';
}

async function calculateLastMessages(currentUserId){
    const allUsers=getAllUsers();
    const calls=await getUserCalls(currentUserId);
    const lastMsgs=[];

    for(const user of allUsers){
        if(user.id===currentUserId)continue;

        const chatKey=getChatKey(currentUserId,user.id);
        const last=cache.lastMessages.get(chatKey);
        const pinned=await getCachedPinned(chatKey);

        const call=calls.find(c=>
            c.caller_id===user.id||c.receiver_id===user.id
        );

        const callTime=call?.ended_at||call?.started_at||0;
        const pinTime=pinned?.pinned_at||0;

        let latestTime=last?.time||0;
        let latestType='message';

        if(call&&callTime>latestTime){
            latestTime=callTime;
            latestType='call';
        }

        if(pinned&&pinTime>latestTime){
            const pinnedMsg=await getCachedMessage(pinned.message_id);

            if(pinnedMsg){
                latestTime=pinTime;
                latestType='pinned';
            }
        }

        if(!latestTime)continue;

        if(latestType==='call'){
            lastMsgs.push({
                id:`call_${call.id}`,
                peerId:user.id,
                by:call.caller_id,
                to:call.receiver_id,
                msg:call.status==='rejected'?'📞 Call rejected':
                    call.status==='missed'?'📞 Missed call':'📞 Call',
                filename:null,
                at:callTime,
                read_by:[]
            });
            continue;
        }

		if(latestType==='pinned'){
			const pinnedMsg=await getCachedMessage(pinned.message_id);
			if(!pinnedMsg)continue;
		
			const pinUser=await getCachedUser(pinned.pinned_by);
			const contact=await dbGet(
				`SELECT name FROM contacts WHERE user_id=? AND contact_user_id=?`,
				[currentUserId,pinned.pinned_by]
			);
		
			const pinName=contact?.name||pinUser?.name||'Someone';
		
			lastMsgs.push({
				id:`pin_${pinned.message_id}`,
				peerId:user.id,
				by:pinned.pinned_by,
				deleted:false,
				to:user.id,
				msg:`${pinName} pinned a message`,
				filename:null,
				at:pinned.pinned_at,
				read_by:[]
			});
		
			continue;
		}

        lastMsgs.push({
            id:last.id,
            peerId:user.id,
            by:last.user_id,
            to:last.target_user_id,
            deleted:last.deleted == 1 ? true : false,
            msg:last.deleted?'🚫 Message Deleted':
                (last.text||(last.file_type?
                getFileIcon(last.file_type):'')),
            filename:last.deleted?null:last.file_name,
            at:last.time,
            read_by:Array.isArray(last.read_by)?
                last.read_by:
                JSON.parse(last.read_by||'[]')
        });
    }

    return lastMsgs.sort((a,b)=>b.at-a.at);
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

app.use('/ffmpeg', express.static(path.join(PUBLIC_DIR, 'ffmpeg'), {
   maxAge: '30d',
   immutable: true
}));

app.get("/admin", (req, res) => {
   res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
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
      const userId = sidToUserId.get(socket.id);
      if (!userId) return;
      
      const rows = await dbAll(`
			SELECT
				u.*,
				COALESCE(c.name,u.name) AS name,
				CASE
					WHEN c.contact_user_id IS NOT NULL THEN 1
					ELSE 0
				END AS saved
			FROM users u
			LEFT JOIN contacts c
				ON c.contact_user_id=u.id
				AND c.user_id=?
		`, [userId]);
      
      const allUsers = rows.map(formatUser);
      
      socket.emit('usersLoaded', {
         allUsers
      });
   });
   
   socket.on('loadCalls', async () => {
      const userId = sidToUserId.get(socket.id);
      if (!userId) return;
      
      socket.emit('callsLoaded', {
         allCalls: await getUserCalls(userId)
      });
   });
   
   socket.on("loadContacts", async () => {
      const userId = sidToUserId.get(socket.id);
      if (!userId) return;
      
      let contacts = getCachedContacts(userId);
      
      if (!contacts) {
         contacts = await dbAll(`
            SELECT
                u.id,
                u.name AS original_name,
                u.dp,
                u.last_active,
                COALESCE(c.name,u.name) AS name
            FROM contacts c
            JOIN users u ON u.id=c.contact_user_id
            WHERE c.user_id=?
            ORDER BY name COLLATE NOCASE
        `, [userId]);
         
         setCachedContacts(userId, contacts);
      }
      
      socket.emit("contacts", contacts);
   });
   
   
   socket.on("loadStatuses", async () => {
      const userId = sidToUserId.get(socket.id);
      
      if (!userId)
         return;

	  await loadStatusCache(userId);
      
      const now = Date.now();
      const grouped = {};
      
      for (const status of cache.statuses.values()) {
         if (status.expires_at <= now)
            continue;
         
         if (!grouped[status.user_id]) {
            grouped[status.user_id] = {
               userId: status.user_id,
               username: status.name,
               statuses: []
            };
         }
         
         let views = [];
         
         try {
            views = Array.isArray(status.views) ?
               status.views :
               JSON.parse(status.views || "[]");
         } catch {
            views = [];
         }
         
         grouped[status.user_id].statuses.push({
            id: status.id,
            user_id: status.user_id,
            username: status.name,
            type: status.type,
            content: status.content,
            
            media: status.type === "video" ?
               status.thumbnail : status.media,
            
            video: status.type === "video" ?
               status.media : null,
            
            background: status.background,
            createdAt: status.created_at,
            expiresAt: status.expires_at,
            
            views,
            
            viewed: status.user_id === userId ||
               views.some(v => v.userId === userId)
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
      const blocked = ['admin', 'administrator', 'moderator', 'mod', 'owner', 'support', 'staff', 'system', 'official', 'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'pussy', 'whore', 'slut', 'nigger', 'nigga', 'faggot'];
      
      const clean = username.toLowerCase()
         .replace(/[^a-z0-9]/g, '');
      
      if (blocked.some(w => clean.includes(w))) {
         socket.emit('usernameError', {
            message: 'That username is not allowed.'
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

   socket.on('forwardMessage',async(data={})=>{
    const userId=sidToUserId.get(socket.id),targetUserId=data.targetUserId,msg=data.message;
    if(!userId||!targetUserId||!msg)return;

    const user=await getCachedUser(userId),name=user?.name||'Anonymous',chatKey=getChatKey(userId,targetUserId),time=Date.now();

    const r=await dbRun(`INSERT INTO messages
    (chat_key,user_id,target_user_id,name,text,image,reply_to,time,read_by,reactions,edited,forwarded,file,file_name,file_type,file_size,deleted)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [chatKey,userId,targetUserId,name,msg.text||'',msg.image||null,msg.reply_to?JSON.stringify(msg.reply_to):null,time,'[]','{}',0,1,msg.file||null,msg.file_name||null,msg.file_type||null,msg.file_size||null,0]);

    const row={id:r.lastID,chat_key:chatKey,user_id:userId,target_user_id:targetUserId,name,text:msg.text||'',image:msg.image||null,reply_to:msg.reply_to||null,time,read_by:'[]',reactions:'{}',edited:0,forwarded:1,file:msg.file||null,file_name:msg.file_name||null,file_type:msg.file_type||null,file_size:msg.file_size||null,deleted:0};
    const dataOut=formatMessage(row);

    setCachedMessage(dataOut);
    cache.lastMessages.set(chatKey,row);
    if(cache.histories.has(chatKey))cache.histories.get(chatKey).push(dataOut);

    socket.emit('directMessage',dataOut);
    io.to(targetUserId).emit('directMessage',dataOut);
});
   
   socket.on('deleteDp', async (data = {}) => {
      const userId = sidToUserId.get(socket.id);
      if (!userId) return;
      
      const user = await getCachedUser(userId);
      if (!user) return;
      
      const defaultDp =
         '/alt-user.png';
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
   
   socket.on('changeDp',async(data={})=>{
    const userId=sidToUserId.get(socket.id);
    if(!userId||!data.dp)return;

    const old=await dbGet(
        'SELECT dp FROM users WHERE id=?',
        [userId]
    );

    await dbRun(
        'UPDATE users SET dp=? WHERE id=?',
        [data.dp,userId]
    );

    if(old?.dp&&old.dp!==data.dp){
        const oldFile=path.join(
            PUBLIC_DIR,
            old.dp.replace(/^\/+/,'')
        );

        if(fs.existsSync(oldFile)){
            fs.unlink(oldFile,()=>{});
        }
    }

    const row=await dbGet(
        'SELECT * FROM users WHERE id=?',
        [userId]
    );

    const user=formatUser(row);
    setCachedUser(user);

    socket.emit('dpChanged',{dp:user.dp});
    socket.emit('sessionReady');

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
      const calls = await getUserCalls(userId);
      
      const callHistory = calls
         .filter(c => c.caller_id === targetUserId || c.receiver_id === targetUserId)
         .map(c => {
            const otherId = c.caller_id === userId ?
               c.receiver_id :
               c.caller_id;
            
            const otherUser = getAllUsers()
               .find(u => u.id === otherId);
            
            return {
               id: `call_${c.id}`,
               type: 'call',
               peerId: otherId,
               by: c.caller_id,
               callType: c.call_type,
               status: c.status,
               dp: otherUser?.dp || '/alt-user.png',
               name: otherUser?.name || 'Unknown',
               msg: c.status === 'missed' ?
                  '📞 Missed call' : ['rejected', 'declined'].includes(c.status) ?
                  '📞 Declined call' : '📞 Call',
               time: c.ended_at || c.started_at
            };
         });
      
      const combined = [...history, ...callHistory]
         .sort((a, b) => (a.time || 0) - (b.time || 0));
      
      const total = combined.length;
      const start = Math.max(total - offset - limit, 0);
      const end = total - offset;
      const page = combined.slice(start, end);
      
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
   
   socket.on("saveContact", async ({
      contactUserId,
      name
   }) => {
      const userId = sidToUserId.get(socket.id);
      name = (name || "")
         .trim();
      
      if (!userId || !contactUserId || userId === contactUserId || !name) return;
      
      await dbRun(`
			INSERT INTO contacts
			(user_id,contact_user_id,name,created_at)
			VALUES (?,?,?,?)
			ON CONFLICT(user_id,contact_user_id)
			DO UPDATE SET name=excluded.name
		`, [userId, contactUserId, name, Date.now()]);
      
      invalidateContacts(userId);
      
      await broadcastUsers();
      
      socket.emit("contactSaved", {
         contactUserId,
         name
      });
   });
   
   
   socket.on("removeContact", async ({
      contactUserId
   }) => {
      const userId = sidToUserId.get(socket.id);
      if (!userId || !contactUserId) return;
      
      await dbRun(`
			DELETE FROM contacts
			WHERE user_id=? AND contact_user_id=?
		`, [userId, contactUserId]);
      
      invalidateContacts(userId);
      await broadcastUsers();
      
      socket.emit("contactRemoved", {
         contactUserId
      });
   });

   const messageUploadDir = path.join(PUBLIC_DIR, 'uploads', 'messages');

	fs.mkdirSync(messageUploadDir, {
		recursive: true
	});

	const messageStorage = multer.diskStorage({
		destination: (req, file, cb) => {
			cb(null, messageUploadDir);
		},

		filename: (req, file, cb) => {
			cb(
				null,
				`${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`
			);
		}
	});

	const messageUpload = multer({
		storage: messageStorage,
		limits: {
			fileSize: 50 * 1024 * 1024
		}
	});

	app.post('/uploadMessageFile', messageUpload.single('file'), (req, res) => {
		if (!req.file) {
			return res.status(400).json({
				error: 'No file uploaded'
			});
		}

		res.json({
			url: `/uploads/messages/${req.file.filename}`,
			fileName: req.file.originalname,
			fileType: req.file.mimetype,
			fileSize: req.file.size
		});
	});
   
	socket.on('directMessage',async(payload={})=>{
		const userId=sidToUserId.get(socket.id);
		const targetUserId=payload.targetUserId;
		if(!userId||!targetUserId)return;
	
		const text=(payload.text||'').trim();
		const file=payload.file||null;
		if(!text&&!file)return;
	
		const fileName=payload.fileName||null;
		const fileType=payload.fileType||null;
		const fileSize=payload.fileSize||null;
		const replyTo=payload.replyTo?JSON.stringify(payload.replyTo):null;
		const sender=await getCachedUser(userId);
		const senderName=sender?.name||'Anonymous';
		const chatKey=getChatKey(userId,targetUserId);
		const nowMs=Date.now();
	
		const result=await dbRun(
			`INSERT INTO messages
			(chat_key,user_id,target_user_id,name,text,file,file_name,file_type,file_size,reply_to,time,read_by,reactions,edited,forwarded,deleted)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			[chatKey,userId,targetUserId,senderName,text,file,fileName,fileType,
			 fileSize,replyTo,nowMs,'[]','{}',0,0,0]
		);
	
		const insertedRow={
			id:result.lastID,chat_key:chatKey,user_id:userId,
			target_user_id:targetUserId,name:senderName,text,file,
			file_name:fileName,file_type:fileType,file_size:fileSize,
			reply_to:replyTo,time:nowMs,read_by:'[]',reactions:'{}',
			edited:0,forwarded:0,deleted:0
		};
	
		const msgData=await formatMessage(insertedRow,userId);
		const targetMsg=await formatMessage(insertedRow,targetUserId);
	
		setCachedMessage(msgData);
		cache.lastMessages.set(chatKey,insertedRow);
	
		if(cache.histories.has(chatKey))
			cache.histories.get(chatKey).push(msgData);
	
		socket.emit('directMessage',msgData);
		io.to(targetUserId).emit('directMessage',targetMsg);
	
		socket.emit('lastMessages',{
			lastMessages:await calculateLastMessages(userId)
		});
	
		io.to(targetUserId).emit('lastMessages',{
			lastMessages:await calculateLastMessages(targetUserId)
		});
	
		const target=await getCachedUser(targetUserId);
	
		if(target?.fcmToken)
			await sendPushNotification(
				target.fcmToken,senderName,text||fileName||'📎 Attachment',
				{type:'message',userId,chatId:chatKey},targetUserId
			);
	});
   
   socket.on("postStatus", async (data = {}) => {
      const userId = sidToUserId.get(socket.id);
      if (!userId) return;
      
      
      const user = await dbGet(
         "SELECT * FROM users WHERE id=?",
      [userId]
      );
      
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
         views: "[]",
         name: user.name
      };
      
      cache.statuses.set(status.id, status);
      
      io.emit("statusUpdated");
   });
   
   socket.on("viewStatus", async ({
      statusId
   }) => {
      const userId = sidToUserId.get(socket.id);
      
      if (!userId || !statusId)
         return;
      
      const status = cache.statuses.get(Number(statusId)) ||
         cache.statuses.get(statusId);
      
      if (!status)
         return;
      
      const user = await getCachedUser(userId);
      
      if (!user)
         return;
      
      let views = [];
      
      try {
         views = Array.isArray(status.views) ?
            status.views :
            JSON.parse(status.views || "[]");
      } catch {
         views = [];
      }
      
      if (views.some(v => v.userId === userId))
         return;
      
      const viewer = {
         userId,
         name: user.name,
         viewedAt: Date.now(),
         statusId: status.id
      };
      
      views.push(viewer);
      
      /*
       * UPDATE THE ACTUAL CACHE OBJECT
       */
      
      status.views = views;
      
      cache.statuses.set(status.id, status);
      
      console.log(
         "[STATUS VIEW] Cached:",
         status.id,
         status.views
      );
      
      /*
       * DATABASE
       */
      
      await dbRun(
         "UPDATE statuses SET views=? WHERE id=?",
				[
					JSON.stringify(status.views),
					status.id
				]
      );
      
      /*
       * Tell status owner
       */
      
      io.to(status.user_id)
         .emit("statusViewed", {
            statusId: status.id,
            viewer
         });
   });
   
   socket.on("deleteStatus", async ({
      statusId
   }) => {
      const userId = sidToUserId.get(socket.id);
      if (!userId) return;

      const status = await dbGet(
         "SELECT user_id, thumbnail, media, type FROM statuses WHERE id=?",
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
      
		console.log(status.thumbnail, status.type, status.media)
      

	  if(status?.media){
        const oldFile=path.join(
            PUBLIC_DIR,
            status.media.replace(/^\/+/,'')
        );
		
		if(status.type == 'video'){
		const oldThumb=path.join(
            PUBLIC_DIR,
            status.thumbnail.replace(/^\/+/,'')
        );
		if(fs.existsSync(oldThumb)){
		fs.unlink(oldThumb,()=>{});
		}
		}

		if(fs.existsSync(oldFile)){
			console.log(oldFile)
			fs.unlink(oldFile,()=>{});
		}
	
    }
	await dbRun("DELETE FROM statuses WHERE id=?", [statusId]);
      cache.statuses.delete(statusId);
      
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
   
   socket.on("getStatusViews", async (data = {}) => {
      
      const statusId = data ? data.statusId : null
      
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
      
      var payload = {
         viewers,
         show: data.show
      }
      socket.emit("statusViews", payload);
   });
   
   socket.on('editMessage', async (data = {}) => {
      const userId = sidToUserId.get(socket.id);
      if (!userId) return;
      
      const msg = await getCachedMessage(data.msgId);
      if (!msg || msg.user_id !== userId) return;
      
      const newText = (data.newText || '')
         .trim();
      if (!newText) return;
      
      await dbRun(
         'UPDATE messages SET text=?,edited=1 WHERE id=?',
        [newText, msg.id]
      );
      
      const updated = await dbGet(
         'SELECT * FROM messages WHERE id=?',
        [msg.id]
      );
      
      const msgData = formatMessage(updated);
      setCachedMessage(msgData);
      
      const last = cache.lastMessages.get(msg.chat_key);
      
      if (last?.id === msg.id) {
         cache.lastMessages.set(msg.chat_key, msgData);
      }
      
      const payload = {
         chatKey: msg.chat_key,
         msg: msgData
      };
      
      socket.emit('messageUpdated', payload);
      io.to(msg.target_user_id)
         .emit('messageUpdated', payload);
   });
   
   
   socket.on('togglePinMessage', async(data={})=>{

    const userId=sidToUserId.get(socket.id);

    if(!userId||!data.targetUserId||!data.msgId){
        return;
    }

    const chatKey=getChatKey(userId,data.targetUserId);

    const msg=await getCachedMessage(data.msgId);

    if(!msg){
        return;
    }

    const pinned=await getCachedPinned(chatKey);

    if(pinned?.message_id===msg.id){

        await dbRun(
            'DELETE FROM pinned_messages WHERE chat_key=?',
            [chatKey]
        );

        cache.pinned.set(chatKey,null);

    }else{
        const pinnedAt=Date.now();
     
		await dbRun(
			`INSERT OR REPLACE INTO pinned_messages
			(chat_key,message_id,pinned_at,pinned_by)
			VALUES(?,?,?,?)`,
			[chatKey,msg.id,Date.now(),userId]
		);

        cache.pinned.set(chatKey,{
			id:pinned?.id||null,
			chat_key:chatKey,
			message_id:msg.id,
			pinned_at:pinnedAt,
			pinned_by:userId
		});
        
    }

    const payload={
        chatKey,
        pinned:cache.pinned.get(chatKey)
    };

    socket.emit('pinnedUpdate',payload);
    io.to(data.targetUserId).emit('pinnedUpdate',payload);

    socket.emit('lastMessages',{
		lastMessages:await calculateLastMessages(userId)
	});
	
	io.to(data.targetUserId).emit('lastMessages',{
		lastMessages:await calculateLastMessages(data.targetUserId)
	});
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

   socket.on('toggleReaction',async(data={})=>{

      const userId=sidToUserId.get(socket.id);
      
      if(!userId){console.log('[GROUP] No ID'); return};
  
      const msgId=Number(data.msgId);
      const emoji=data.emoji;
  
      if(!msgId||!emoji){console.log('[GROUP] No msgId/emoi'); return};
  
      const user=await getCachedUser(userId);
  
      if(data.groupId){
         const groupId=Number(data.groupId);
     
         if(!groupId){
             return;
         }
     
         const members=await getCachedGroupMembers(groupId);
     
         if(!members.has(userId)){
             return;
         }
     
         const history=cache.groupHistories.get(groupId)||[];
         const msg=history.find(m=>m.id===msgId);
     
         if(!msg){
             return;
         }
     
         const reactions=msg.reactions||{};
     
         if(!reactions[emoji])
             reactions[emoji]=[];
     
         const i=reactions[emoji].findIndex(
             r=>r.userId===userId
         );
     
         if(i>=0){
             reactions[emoji].splice(i,1);
         }else{
             reactions[emoji].push({
                 userId,
                 name:user?.name||'Anonymous'
             });
         }
     
         if(!reactions[emoji].length)
             delete reactions[emoji];
     
         await dbRun(
             `UPDATE group_messages
              SET reactions=?
              WHERE id=? AND group_id=?`,
             [
                 JSON.stringify(reactions),
                 msgId,
                 groupId
             ]
         );
     
         msg.reactions=reactions;
     
         cache.groupHistories.set(
             groupId,
             history
         );
     
         cache.groupLastMessages.set(
             groupId,
             history[history.length-1]||null
         );
     
         console.log('[GROUP] Updated reactions',msg.reactions);
     
         io.to(`group:${groupId}`).emit(
             'groupMessageUpdated',
             {
                 groupId,
                 msg
             }
         );
     
         return;
     }
  
      const msg=await getCachedMessage(msgId);
  
      if(!msg)return;
  
      const reactions=msg.reactions||{};
  
      if(!reactions[emoji])
          reactions[emoji]=[];
  
      const i=reactions[emoji].findIndex(
          r=>r.userId===userId
      );
  
      if(i>=0){
          reactions[emoji].splice(i,1);
      }else{
          reactions[emoji].push({
              userId,
              name:user?.name||'Anonymous'
          });
      }
  
      if(!reactions[emoji].length)
          delete reactions[emoji];
  
      await dbRun(
          'UPDATE messages SET reactions=? WHERE id=?',
          [JSON.stringify(reactions),msg.id]
      );
  
      const msgData={
          ...msg,
          reactions
      };
  
      setCachedMessage(msgData);
  
      const payload={
          chatKey:msg.chat_key,
          msg:msgData
      };
  
      socket.emit('messageUpdated',payload);
      io.to(msg.target_user_id).emit('messageUpdated',payload);
  });
   
   socket.on('deleteMessage', async (data = {}) => {
      const userId = sidToUserId.get(socket.id);
      if (!userId) return;
      
      const msg = await getCachedMessage(data.msgId);
      if (!msg || msg.user_id !== userId) return;
      
      await dbTransaction([
         {
            sql: 'DELETE FROM pinned_messages WHERE chat_key=? AND message_id=?',
            params: [msg.chat_key, msg.id]
			},
         {
            sql: `UPDATE messages
					 SET deleted=1,
						 text='',
						 file=NULL,
						 file_name=NULL
					 WHERE id=?`,
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
      
      const last = cache.lastMessages.get(msg.chat_key);
      
      if (last?.id === msg.id) {
         cache.lastMessages.delete(msg.chat_key);
      }
      
      invalidatePinnedCache(msg.chat_key);
      
      const payload = {
         targetUserId: msg.target_user_id,
         msgId: msg.id
      };
      
      socket.emit('messageDeleted', payload);
      
      io.to(msg.target_user_id)
         .emit('messageDeleted', {
            targetUserId: userId,
            msgId: msg.id
         });
      
      socket.emit('lastMessagesUpdated');
      io.to(msg.target_user_id)
         .emit('lastMessagesUpdated');
   });
   
   socket.on('forwardMessage',async(data={})=>{
    const userId=sidToUserId.get(socket.id);
    const targetUserId=data.targetUserId;
    const message=data.message||{};
    if(!userId||!targetUserId)return;

    const sender=await getCachedUser(userId);
    const chatKey=getChatKey(userId,targetUserId);
    const nowMs=Date.now();
    const replyTo=message.replyTo?JSON.stringify(message.replyTo):null;

    const result=await dbRun(
        `INSERT INTO messages
        (chat_key,user_id,target_user_id,name,text,image,reply_to,time,read_by,reactions,edited,forwarded)
        VALUES(?,?,?,?,?,?,?,?,?,?,0,1)`,
        [chatKey,userId,targetUserId,sender?.name||'Anonymous',
         message.text||null,message.image||null,replyTo,nowMs,'[]','{}']
    );

    const insertedMsg=await dbGet(
        'SELECT * FROM messages WHERE id=?',
        [result.lastID]
    );

    const msgDict=await formatMessage(insertedMsg,userId);
    setCachedMessage(msgDict);
    cache.lastMessages.set(chatKey,insertedMsg);

    socket.emit('directMessage',msgDict);

    const targetMsg=await formatMessage(insertedMsg,targetUserId);
    io.to(targetUserId).emit('directMessage',targetMsg);

    const target=await getCachedUser(targetUserId);

    if(target?.fcmToken){
        await sendPushNotification(
            target.fcmToken,
            sender?.name||'Anonymous',
            msgDict.text||'[Forwarded Attachment]',
            {type:'message',userId,chatId:chatKey},
            targetUserId
        );
    }
});
   
   socket.on("callUser", async (data = {}) => {
      const callerId = sidToUserId.get(socket.id),
         targetUserId = data.targetUserId;
      if (!callerId || !targetUserId) return;
      
      const startedAt = Date.now(),
         callType = data.callType || "video";
      
      const result = await dbRun(`
			INSERT INTO calls
			(caller_id,receiver_id,call_type,status,started_at)
			VALUES(?,?,?,?,?)
		`, [callerId, targetUserId, callType, "ringing", startedAt]);
      
      const callData = formatCall({
         id: result.lastID,
         caller_id: callerId,
         receiver_id: targetUserId,
         call_type: callType,
         status: "ringing",
         started_at: startedAt,
         ended_at: null,
         duration: 0
      });
      
      if (!cache.calls) cache.calls = new Map();
      
      for (const uid of [callerId, targetUserId]) {
         const list = cache.calls.get(uid) || [];
         cache.calls.set(uid, [callData, ...list]);
      }
      
      const contact = await dbGet(`
			SELECT name FROM contacts
			WHERE user_id=? AND contact_user_id=?
			LIMIT 1
		`, [targetUserId, callerId]);
      
      const caller = await getCachedUser(callerId);
      const callerName = contact?.name || caller?.name || data.callerName || "Unknown";
      
      io.to(callerId)
         .emit("callId", {
            callId: result.lastID
         });
      io.to(callerId)
         .emit("callUpdated", callData);
      
      io.to(targetUserId)
         .emit("incomingCall", {
            callId: result.lastID,
            fromUserId: callerId,
            fromSocketId: socket.id,
            callerName,
            callType,
            signal: data.signal
         });
      
      io.to(targetUserId)
         .emit("callUpdated", callData);
   });
   
   socket.on('acceptCall', async (data = {}) => {
      const userId = sidToUserId.get(socket.id);
      
      if (!userId || !data.callId) return;
      
      const startedAt = Date.now();
      
      await dbRun(
         `UPDATE calls
       SET status=?,started_at=?
       WHERE id=?`,
      ['accepted', startedAt, data.callId]
      );
      
      const row = await dbGet(
         'SELECT * FROM calls WHERE id=?',
      [data.callId]
      );
      
      if (row) {
         const callData = formatCall(row);
         
         if (cache.calls) {
            for (const [uid, list] of cache.calls) {
               const i = list.findIndex(c => c.id === callData.id);
               if (i !== -1) list[i] = callData;
            }
         }
         
         io.to(row.caller_id)
            .emit('callUpdated', callData);
         io.to(row.receiver_id)
            .emit('callUpdated', callData);
      }
      
      io.to(data.targetUserId)
         .emit('callAccepted', {
            fromUserId: userId,
            fromSocketId: socket.id,
            answererName: data.answererName,
            signal: data.signal
         });
   });
   
   socket.on('missedCall', async (callId) => {
      
      
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
	['ended', endedAt, callId]
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
   
   
   socket.on('rejectCall', async (data = {}) => {
      const userId = sidToUserId.get(socket.id);
      if (!userId || !data.callId) return;
      
      const contact = await dbGet(`
        SELECT c.name
        FROM contacts c
        WHERE c.user_id=? AND c.contact_user_id=?
    `, [data.targetUserId, userId]);
      
      const byName = contact?.name || data.byName;
      
      await dbRun(`
        UPDATE calls
        SET status=?,ended_at=?,duration=0
        WHERE id=?
    `, ['rejected', Date.now(), data.callId]);
      
      const row = await dbGet(
         'SELECT * FROM calls WHERE id=?',
        [data.callId]
      );
      
      if (row) {
         const callData = formatCall(row);
         
         io.to(row.caller_id)
            .emit('callUpdated', callData);
         io.to(row.receiver_id)
            .emit('callUpdated', callData);
      }
      
      io.to(data.targetUserId)
         .emit('callRejected', {
            byName
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
   
   socket.on('deleteCallLog', async (data = {}) => {
      const userId = sidToUserId.get(socket.id);
      if (!userId || !data.callId) return;
      
      const call = await dbGet(
         `SELECT * FROM calls
         WHERE id=?
         AND (caller_id=? OR receiver_id=?)`,
        [data.callId, userId, userId]
      );
      
      if (!call) return;
      
      await dbRun(
         'DELETE FROM calls WHERE id=?',
        [data.callId]
      );
      
      if (cache.calls) {
         for (const [uid, list] of cache.calls) {
            cache.calls.set(
               uid,
               list.filter(c => c.id !== data.callId)
            );
         }
      }
      
      socket.emit('callDeleted', {
         callId: data.callId
      });
   });
   
   socket.on('deleteCallLogs', async (data = {}) => {
      const userId = sidToUserId.get(socket.id);
      const ids = Array.isArray(data.callIds) ? data.callIds : [];
      
      if (!userId || !ids.length) return;
      
      const deleted = [];
      
      for (const id of ids) {
         const call = await dbGet(
            `SELECT id FROM calls
             WHERE id=?
             AND (caller_id=? OR receiver_id=?)`,
            [id, userId, userId]
         );
         
         if (!call) continue;
         
         await dbRun(
            'DELETE FROM calls WHERE id=?',
            [id]
         );
         
         deleted.push(id);
      }
      
      if (!deleted.length) return;
      
      if (cache.calls) {
         for (const [uid, list] of cache.calls) {
            cache.calls.set(
               uid,
               list.filter(c => !deleted.includes(c.id))
            );
         }
      }
      
      socket.emit('callsDeleted', {
         callIds: deleted
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
   
   
   // ADMIN===============================
   
   const ADMIN_KEY = process.env.ADMIN_KEY || '090909';
   const adminSockets = new Set();
   
   
   
   socket.on("adminRenameUser", async data => {
      if (!isAdmin() || !data?.userId) return;
      
      const name = (data.name || "")
         .trim();
      
      if (!name) return;
      
      await dbRun(
         "UPDATE users SET name=? WHERE id=?",
        [name, data.userId]
      );
      
      const user = cache.users?.get(data.userId);
      
      if (user) {
         user.name = name;
         cache.users.set(data.userId, user);
      }
      
      io.emit("userUpdated", {
         userId: data.userId,
         name
      });
      
      socket.emit("adminResult", {
         ok: true,
         message: `Renamed user to ${name}`
      });
   });
   
   socket.on('adminSendMessage', async (data = {}) => {
      if (!isAdmin()) return;
      
      const targetUserId = data.targetUserId;
      const text = (data.text || '')
         .trim();
      if (!targetUserId || !text) return;
      
      const userId = 'admin';
      const name = 'Admin';
      const chatKey = getChatKey(userId, targetUserId);
      const time = Date.now();
      
      const result = await dbRun(`
        INSERT INTO messages
        (chat_key,user_id,target_user_id,name,text,time,read_by,reactions,edited,forwarded,deleted)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `, [chatKey, userId, targetUserId, name, text, time, '[]', '{}', 0, 0, 0]);
      
      const row = {
         id: result.lastID,
         chat_key: chatKey,
         user_id: userId,
         target_user_id: targetUserId,
         name,
         text,
         time,
         file: null,
         file_name: null,
         file_type: null,
         file_size: null,
         reply_to: null,
         read_by: '[]',
         reactions: '{}',
         edited: 0,
         forwarded: 0,
         deleted: 0
      };
      
      const msg = formatMessage(row);
      setCachedMessage(msg);
      cache.lastMessages.set(chatKey, row);
      if (cache.histories.has(chatKey)) cache.histories.get(chatKey)
         .push(msg);
      
      socket.emit('adminMessageSent', msg);
      io.to(targetUserId)
         .emit('directMessage', msg);
   });
   
   socket.on('adminMessages', async (data = {}) => {
      if (!isAdmin() || !data.userId) return;
      
      const rows = await dbAll(`
        SELECT * FROM messages
        WHERE (user_id='admin' AND target_user_id=?)
        OR (user_id=? AND target_user_id='admin')
        ORDER BY time ASC LIMIT 100
    `, [data.userId, data.userId]);
      
      socket.emit('adminMessages', rows.map(formatMessage));
   });
   
   socket.on("adminAuth", data => {
      if (data?.key !== ADMIN_KEY) {
         socket.emit("adminAuthResult", {
            ok: false
         });
         return;
      }
      
      adminSockets.add(socket.id);
      socket.emit("adminAuthResult", {
         ok: true
      });
   });
   
   const isAdmin = () => adminSockets.has(socket.id);
   
   socket.on("adminUsers", async () => {
      if (!isAdmin()) return;
      
      const online = new Set(sidToUserId.values());
      
      const rows = await dbAll(`
        SELECT id,name
        FROM users
        ORDER BY name COLLATE NOCASE
    `);
      
      socket.emit("adminUsers", rows.map(u => ({
         userId: u.id,
         name: u.name,
         online: online.has(u.id)
      })));
   });
   
   socket.on("adminCalls", async () => {
      if (!isAdmin()) return;
      
      const calls = await dbAll(`
        SELECT *
        FROM calls
        WHERE status IN ('ringing','accepted')
        ORDER BY started_at DESC
    `);
      
      socket.emit("adminCalls", calls);
   });
   
   socket.on("adminStatuses", () => {
      if (!isAdmin()) return;
      
      const now = Date.now();
      
      const statuses = [...cache.statuses.values()]
         .filter(s => s.expires_at > now)
         .sort((a, b) => b.created_at - a.created_at);
      
      socket.emit("adminStatuses", statuses);
   });
   
   socket.on("adminKick", data => {
      if (!isAdmin() || !data?.userId) return;
      
      let kicked = false;
      
      for (const [sid, userId] of sidToUserId.entries()) {
         if (userId === data.userId) {
            io.sockets.sockets.get(sid)
               ?.disconnect(true);
            kicked = true;
         }
      }
      
      socket.emit("adminResult", {
         ok: kicked,
         message: kicked ?
            `Kicked ${data.userId}` : "User is not online"
      });
   });
   
   socket.on("adminBan", async data => {
      if (!isAdmin() || !data?.userId) return;
      
      await dbRun(`
        UPDATE users
        SET banned=1
        WHERE id=?
    `, [data.userId]);
      
      for (const [sid, userId] of sidToUserId.entries()) {
         if (userId === data.userId) {
            io.sockets.sockets.get(sid)
               ?.disconnect(true);
         }
      }
      
      socket.emit("adminResult", {
         ok: true,
         message: `Banned ${data.userId}`
      });
   });
   
   socket.on("adminEndCall", async data => {
      if (!isAdmin() || !data?.callId) return;
      
      const call = await dbGet(
         "SELECT * FROM calls WHERE id=?",
        [data.callId]
      );
      
      if (!call) return;
      
      const endedAt = Date.now();
      
      const duration = call.started_at ?
         Math.max(0, Math.floor(
            (endedAt - call.started_at) / 1000
         )) :
         0;
      
      await dbRun(`
        UPDATE calls
        SET status='ended',
            ended_at=?,
            duration=?
        WHERE id=?
    `, [endedAt, duration, data.callId]);
      
      if (cache.calls) {
         for (const uid of [call.caller_id, call.receiver_id]) {
            const list = cache.calls.get(uid) || [];
            
            const index = list.findIndex(
               c => c.id === call.id
            );
            
            if (index !== -1) {
               list[index] = {
                  ...list[index],
                  status: "ended",
                  ended_at: endedAt,
                  duration
               };
               
               cache.calls.set(uid, list);
            }
         }
      }

	 invalidateCallsCache()

	  socket.emit('callsLoaded', {
		allCalls: await getUserCalls(userId)
	 });
      
      io.to(call.caller_id)
         .emit("callEnded", {
            callId: call.id
         });
      
      io.to(call.receiver_id)
         .emit("callEnded", {
            callId: call.id
         });
      
      socket.emit("adminResult", {
         ok: true,
         message: `Call ${call.id} ended`
      });
   });
   
   socket.on("adminDeleteStatus", async data => {
      if (!isAdmin() || !data?.statusId) return;
      
      const status = cache.statuses.get(data.statusId);
      
      if (!status) {
         socket.emit("adminResult", {
            ok: false,
            message: "Status not found"
         });
         return;
      }
      
      await dbRun(
         "DELETE FROM statuses WHERE id=?",
        [data.statusId]
      );
      
      cache.statuses.delete(data.statusId);
      
      if (status.media) {
         const file = path.join(
            PUBLIC_DIR,
            status.media.replace(/^\/+/, "")
         );
         
         if (fs.existsSync(file)) {
            fs.unlinkSync(file);
         }
      }
      
      if (status.thumbnail) {
         const file = path.join(
            PUBLIC_DIR,
            status.thumbnail.replace(/^\/+/, "")
         );
         
         if (fs.existsSync(file)) {
            fs.unlinkSync(file);
         }
      }
      
      io.emit("statusUpdated");
      
      socket.emit("adminResult", {
         ok: true,
         message: `Status ${data.statusId} deleted`
      });
   });
   
   socket.on("disconnect", () => {
      adminSockets.delete(socket.id);
   });
   // Groups

   socket.on('createGroup',async(data={})=>{
      const userId=sidToUserId.get(socket.id);
      if(!userId||!data.name?.trim())return;
  
      const name=data.name.trim();
      const description=(data.description||'').trim();
      const type=data.type==='public'?'public':'private';
      const image=data.image||null;
      const now=Date.now();
  
      const result=await dbRun(`
          INSERT INTO groups
          (name,description,image,type,owner_id,created_at)
          VALUES(?,?,?,?,?,?)
      `,[name,description,image,type,userId,now]);
  
      const group={
          id:result.lastID,
          name,
          description,
          image,
          type,
          owner_id:userId,
          created_at:now
      };
  
      await dbRun(`
          INSERT INTO group_members
          (group_id,user_id,role,joined_at)
          VALUES(?,?,?,?)
      `,[group.id,userId,'owner',now]);
  
      cache.groups.set(group.id,group);
  
      cache.groupMembers.set(
          group.id,
          new Map([
              [userId,{
                  group_id:group.id,
                  user_id:userId,
                  role:'owner',
                  joined_at:now
              }]
          ])
      );
  
      cache.groupHistories.set(group.id,[]);
      cache.groupLastMessages.set(group.id,null);
  
      socket.join(`group:${group.id}`);
  
      socket.emit('groupCreated',{
          ...group,
          role:'owner',
          memberCount:1
      });
  });

  socket.on('loadGroups',async()=>{
   const userId=sidToUserId.get(socket.id);
   if(!userId)return;

   const rows=await dbAll(`
       SELECT g.*,gm.role
       FROM groups g
       JOIN group_members gm
           ON gm.group_id=g.id
       WHERE gm.user_id=?
       ORDER BY g.created_at DESC
   `,[userId]);

   const groups=[];

   for(const row of rows){
       cache.groups.set(row.id,row);

       const members=await getCachedGroupMembers(row.id);

       if(!cache.groupHistories.has(row.id))
           await getCachedGroupHistory(row.id, userId);

       socket.join(`group:${row.id}`);

       groups.push({
         ...row,
         members: [...members.values()],
         memberCount: members.size,
         lastMessage: cache.groupLastMessages.get(row.id) || null
     });
   }

   socket.emit('groupsLoaded',groups);
});
  
socket.on('loadPublicGroups',async()=>{
   const rows=await dbAll(`
       SELECT g.*
       FROM groups g
       WHERE g.type='public'
       ORDER BY g.created_at DESC
   `);

   const groups=[];

   for(const row of rows){
       cache.groups.set(row.id,row);

       const members=await getCachedGroupMembers(row.id);

       groups.push({
           ...row,
           memberCount:members.size
       });
   }

   socket.emit('publicGroupsLoaded',groups);
});

socket.on('joinGroup', async (data = {}) => {
   const userId = sidToUserId.get(socket.id);
   const groupId = Number(data.groupId);

   if (!userId || !groupId) return;

   const group = await getCachedGroup(groupId);

   if (!group) return;

   let members = await getCachedGroupMembers(groupId);

   if (members.has(userId)) {
       socket.join(`group:${groupId}`);

       const member = members.get(userId);

       socket.emit('groupJoined', {
           ...group,
           role: member.role,
           memberCount: members.size
       });

       return;
   }

   if (group.type !== 'public') {
       return;
   }

   const now = Date.now();

   await dbRun(`
       INSERT INTO group_members
       (group_id,user_id,role,joined_at)
       VALUES(?,?,?,?)
   `, [
       groupId,
       userId,
       'member',
       now
   ]);

   members.set(userId, {
       group_id: groupId,
       user_id: userId,
       role: 'member',
       joined_at: now
   });

   cache.groupMembers.set(groupId, members);

   socket.join(`group:${groupId}`);

});

socket.on('leaveGroup',async(data={})=>{
   const userId=sidToUserId.get(socket.id);
   const groupId=Number(data.groupId);

   if(!userId||!groupId)return;

   const group=await getCachedGroup(groupId);
   if(!group)return;

   if(group.owner_id===userId){
       socket.emit('groupError',{
           message:'The group owner cannot leave the group'
       });
       return;
   }

   await dbRun(`
       DELETE FROM group_members
       WHERE group_id=? AND user_id=?
   `,[groupId,userId]);

   socket.leave(`group:${groupId}`);

   const members=cache.groupMembers.get(groupId);

   if(members){
       members.delete(userId);
       cache.groupMembers.set(groupId,members);
   }

   socket.emit('groupLeft',{
       groupId
   });
});

socket.on('groupMessage',async(data={})=>{
   const userId=sidToUserId.get(socket.id);
   if(!userId||!data.groupId)return;

   const members=await getCachedGroupMembers(data.groupId);
   if(!members.has(userId))return;

   const text=(data.text||'').trim();
   const file=data.file||null;

   if(!text&&!file)return;

   const user=await getCachedUser(userId);
   const name=user?.name||'Anonymous';
   const now=Date.now();

   const replyTo=data.replyTo?
       JSON.stringify(data.replyTo):
       null;

   const result=await dbRun(`
       INSERT INTO group_messages
       (
           group_id,
           user_id,
           name,
           text,
           file,
           file_name,
           file_type,
           file_size,
           reply_to,
           time,
           read_by,
           reactions,
           edited,
           deleted
       )
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   `,[
       data.groupId,
       userId,
       name,
       text,
       file,
       data.fileName||null,
       data.fileType||null,
       data.fileSize||null,
       replyTo,
       now,
       '[]',
       '{}',
       0,
       0
   ]);

   const message={
       id:result.lastID,
       group_id:data.groupId,
       user_id:userId,
       name,
       text,
       file,
       file_name:data.fileName||null,
       file_type:data.fileType||null,
       file_size:data.fileSize||null,
       reply_to:data.replyTo||null,
       time:now,
       read_by:[],
       reactions:{},
       edited:false,
       deleted:false
   };

   let history=cache.groupHistories.get(data.groupId)||[];

   history.push(message);

   if(history.length>100)
       history=history.slice(-100);

   cache.groupHistories.set(
       data.groupId,
       history
   );

   cache.groupLastMessages.set(
       data.groupId,
       message
   );

   io.to(`group:${data.groupId}`)
       .emit('groupMessage',message);

   io.to(`group:${data.groupId}`)
       .emit('groupLastMessage',{
           groupId:data.groupId,
           message
       });
});

socket.on('inviteToGroup',async(data={})=>{
   const userId=sidToUserId.get(socket.id);
   const groupId=Number(data.groupId);
   const targetUserId=data.targetUserId;
   if(!userId||!groupId||!targetUserId)return;



   const group=await dbGet(`SELECT * FROM groups WHERE id=?`,[groupId]);
   if(!group)return;

   const inviter=await getCachedUser(userId);
   const now=Date.now();

   await dbRun(`
       INSERT INTO group_invites
       (group_id,inviter_id,user_id,status,created_at)
       VALUES(?,?,?,?,?)
   `,[groupId,userId,targetUserId,'pending',now]);

   const chatKey=getChatKey(userId,targetUserId);

   const result=await dbRun(`
      INSERT INTO messages
      (chat_key,user_id,target_user_id,name,text,time,read_by,reactions,edited,forwarded,deleted,type,group_id,group_name)
      VALUES(?,?,?,?,?,?,?,'{}',0,0,0,?,?,?)
  `,[chatKey,userId,targetUserId,inviter?.name||'Anonymous','Group Invite',now,'[]','group_invite',groupId,group.name]);
   const row=await dbGet(`SELECT * FROM messages WHERE id=?`,[result.lastID]);
   const msgData=formatMessage(row);

   setCachedMessage(msgData);

   if(cache.histories.has(chatKey))
       cache.histories.get(chatKey).push(msgData);

   socket.emit('directMessage',msgData);
   io.to(targetUserId).emit('directMessage',msgData);
});

socket.on('acceptGroupInvite', async (data = {}) => {
   const userId = sidToUserId.get(socket.id);
   const groupId = Number(data.groupId);

   if (!userId || !groupId) return;

   const invite = await dbGet(`
       SELECT *
       FROM group_invites
       WHERE group_id = ?
       AND user_id = ?
       AND status = 'pending'
       LIMIT 1
   `, [groupId, userId]);

   if (!invite) {
       socket.emit('groupError', {
           message: 'Link expired'
       });
       return;
   }

   const now = Date.now();

   await dbRun(`
       INSERT OR IGNORE INTO group_members
       (group_id, user_id, role, joined_at)
       VALUES (?, ?, 'member', ?)
   `, [groupId, userId, now]);

   await dbRun(`
       UPDATE group_invites
       SET status = 'accepted'
       WHERE id = ?
   `, [invite.id]);

   const members = await getCachedGroupMembers(groupId);

   members.set(userId, {
       group_id: groupId,
       user_id: userId,
       role: 'member',
       joined_at: now
   });

   cache.groupMembers.set(groupId, members);

   const group = await getCachedGroup(groupId);

   socket.join(`group:${groupId}`);

   io.to(userId).emit('groupJoined', {
       ...group,
       role: 'member',
       memberCount: members.size
   });
   io.to(`group:${group.id}`).emit('userJoined', {
      ...group,
      role: 'member',
      memberCount: members.size
  });
   

   socket.emit('loadGroups');
});
socket.on('rejectGroupInvite', async (data = {}) => {
   const userId = sidToUserId.get(socket.id);
   const groupId = Number(data.groupId);

   if (!userId || !groupId) return;

   await dbRun(`
       UPDATE group_invites
       SET status = 'rejected'
       WHERE group_id = ?
       AND user_id = ?
       AND status = 'pending'
   `, [groupId, userId]);

   socket.emit('groupInviteRejected', {
       groupId
   });
});

socket.on('loadGroupHistory', async (data = {}) => {
   const userId = sidToUserId.get(socket.id);
   const groupId = Number(data.groupId);
   const offset = Number(data.offset) || 0;
   const limit = Math.min(Number(data.limit) || 50, 100);

   if (!userId || !groupId) return;

   const members = await getCachedGroupMembers(groupId);

   if (!members.has(userId)) return;

   let history = cache.groupHistories.get(groupId);

   if (!history) {
       history = await getCachedGroupHistory(groupId, userId);
   }

   const messages = history
       .slice()
       .reverse()
       .slice(offset, offset + limit)
       .reverse();

   socket.emit('groupHistoryLoaded', {
       groupId,
       messages,
       hasMore: offset + limit < history.length
   });
});

});

async function loadStatusCache(userId){
    const now=Date.now();

    const rows=await dbAll(`
        SELECT s.*,COALESCE(c.name,u.name) AS name
        FROM statuses s
        JOIN users u ON u.id=s.user_id
        LEFT JOIN contacts c
            ON c.contact_user_id=s.user_id
            AND c.user_id=?
        WHERE s.expires_at>?
        AND (
            s.user_id=?
            OR c.contact_user_id IS NOT NULL
            OR s.user_id='admin'
        )
        ORDER BY s.created_at DESC
    `,[userId,now,userId]);

    cache.statuses.clear();

    for(const status of rows)
        cache.statuses.set(status.id,status);
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

const dpDir=path.join(PUBLIC_DIR,'dps');

if(!fs.existsSync(dpDir))fs.mkdirSync(dpDir,{recursive:true});

const uploadDp=multer({
    storage:multer.diskStorage({
        destination:dpDir,
        filename:(req,file,cb)=>{
            cb(null,`${Date.now()}-${Math.random().toString(36).slice(2,10)}${path.extname(file.originalname)}`);
        }
    }),
    limits:{fileSize:5*1024*1024},
    fileFilter:(req,file,cb)=>{
        cb(null,file.mimetype.startsWith('image/'));
    }
});

app.post('/uploadDp',uploadDp.single('dp'),(req,res)=>{
    if(!req.file)return res.status(400).json({error:'No image uploaded'});

    res.json({
        url:`/dps/${req.file.filename}`
    });
});

server.listen(PORT, '0.0.0.0', async () => {
   await createTables()

   await loadLastMessagesCache();
   await loadLastMessagesCache();
   await loadUserCache();
   log(`[SERVER] Node server successfully started and listening on 0.0.0.0:${PORT}`);
   
});
