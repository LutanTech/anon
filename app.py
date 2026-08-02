import os
import json
import random
import logging
import time
from datetime import datetime
from threading import Timer

from flask import Flask, request, jsonify, render_template, send_from_directory
from flask_socketio import SocketIO, emit, join_room

from models import db, User, Message, PinnedMessage

app = Flask(__name__, static_folder="public", template_folder="public")
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "anonchat_secret_key_2026")
app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv("DATABASE_URL", "sqlite:///chat.db")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db.init_app(app)

LOG_FILE = "server.log"


def log(message, data=None):
    line = f"[SERVER] {message}"
    if data:
        line += f" {json.dumps(data)}"
    logging.info(line)
    print(line)

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    max_http_buffer_size=10000000,
    ping_interval=10000,
    ping_timeout=20000
)

log(f"Async mode: {socketio.server.eio.async_mode}")

with app.app_context():
    db.create_all()


logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="[%(asctime)s] %(message)s"
)



log("SERVER LOADED")

messaging_admin = None

try:
    import firebase_admin
    from firebase_admin import credentials, messaging

    firebase_file = os.path.join(os.path.dirname(__file__), "public", "firebase-admin.json")

    if os.path.exists(firebase_file):
        cred = credentials.Certificate(firebase_file)
        firebase_admin.initialize_app(cred)
        messaging_admin = messaging
        log("Firebase Admin SDK initialized")
    else:
        log("Firebase Admin SDK disabled")
except Exception as e:
    log("Firebase error", {"error": str(e)})

ANIMALS = [
    "Lion", "Tiger", "Wolf", "Fox", "Falcon", "Panda", "Bear", "Eagle",
    "Hawk", "Jaguar", "Leopard", "Otter", "Rabbit", "Koala", "Raven",
    "Shark", "Whale", "Dolphin", "Cobra", "Python", "Moose", "Buffalo"
]

sid_to_userid = {}
online_users = []
pending_disconnects = {}
DISCONNECT_GRACE_SEC = 25

def random_name():
    return f"{random.choice(ANIMALS)}-{random.randint(1000, 9999)}"

def get_chat_key(id1, id2):
    return "_".join(sorted([str(id1), str(id2)]))

def broadcast_users():
    all_users = [u.to_dict() for u in User.query.all()]
    socketio.emit("count", len(all_users))
    socketio.emit("usersUpdate", all_users)
    socketio.emit("onlineUpdate", online_users)
    socketio.emit("usersLoaded", {"allUsers": all_users})

def calculate_last_messages(current_user_id):
    last_msgs = []
    for user in User.query.all():
        if user.id == current_user_id:
            continue
        history = Message.query.filter_by(
            chat_key=get_chat_key(current_user_id, user.id)
        ).order_by(Message.time.asc()).all()

        if history:
            last = history[-1]
            text = last.text or ("[Attachment]" if last.image else "Click to Message")
        else:
            text = "Click to Message"

        last_msgs.append({
            "to": user.id,
            "msg": text
        })

    return last_msgs

def send_push_notification(token, title, body, data=None):
    if not messaging_admin or not token:
        return

    try:
        payload = {str(k): str(v) for k, v in (data or {}).items()}
        payload["title"] = str(title)
        payload["body"] = str(body)

        msg = messaging_admin.Message(
            token=token,
            data=payload,
            android=messaging_admin.AndroidConfig(priority="high")
        )

        messaging_admin.send(msg)

    except Exception as e:
        log("Push failed", {"error": str(e)})

@app.route("/")
def index():
    if os.path.exists(os.path.join(app.static_folder, "index.html")):
        return send_from_directory(app.static_folder, "index.html")
    return render_template("index.html")

@app.route("/health")
def health():
    return jsonify({
        "status": "healthy",
        "online_users": len(online_users),
        "total_users": User.query.count(),
        "timestamp": int(time.time() * 1000)
    })

@app.route("/api/register-fcm", methods=["POST"])
def register_fcm():
    data = request.get_json(silent=True) or {}
    token = data.get("token")
    user_id = data.get("userId")

    if not token or not user_id:
        return jsonify({"success": False}), 400

    user = User.query.get(user_id)
    if user:
        user.fcm_token = token
        db.session.commit()

    return jsonify({"success": True})

@socketio.on("connect")
def handle_connect():
    log("Client connected", {"sid": request.sid})

@socketio.on("disconnect")
def handle_disconnect():
    sid = request.sid
    user_id = sid_to_userid.get(sid)

    if not user_id:
        return

    def finalize_disconnect(uid):
        global online_users
        online_users = [u for u in online_users if u["id"] != uid]
        pending_disconnects.pop(uid, None)
        sid_to_userid.pop(sid, None)
        broadcast_users()
        log("Disconnected", uid)

    if user_id in pending_disconnects:
        pending_disconnects[user_id].cancel()

    timer = Timer(DISCONNECT_GRACE_SEC, finalize_disconnect, args=[user_id])
    pending_disconnects[user_id] = timer
    timer.start()

@socketio.on("initSession")
def handle_init_session(client_session=None):
    sid = request.sid
    client_session = client_session or {}

    user_id = client_session.get("userId") or f"usr_{random.randint(100000, 999999)}"

    if user_id in pending_disconnects:
        pending_disconnects[user_id].cancel()
        del pending_disconnects[user_id]

    now_ms = int(time.time() * 1000)
    user = User.query.get(user_id)

    if user:
        if client_session.get("name") and client_session.get("expiresAt") and now_ms < client_session["expiresAt"]:
            user.name = client_session["name"]
            user.expires_at = client_session["expiresAt"]
        user.last_active = now_ms
    else:
        user = User(
            id=user_id,
            name=client_session.get("name") or random_name(),
            expires_at=client_session.get("expiresAt"),
            last_active=now_ms
        )
        db.session.add(user)

    db.session.commit()

    sid_to_userid[sid] = user_id
    join_room(user_id)

    emit("sessionReady", {
        "userId": user.id,
        "name": user.name,
        "expiresAt": user.expires_at
    })

    if not any(x["id"] == user.id for x in online_users):
        online_users.append({"id": user.id})

    broadcast_users()

    # Fixed: Direct targeted emit to avoid leaking last messages to other connected users
    emit("lastMessages", {
        "lastMessages": calculate_last_messages(user.id)
    })

@socketio.on("loadUsers")
def handle_load_users():
    emit("usersLoaded", {
        "allUsers": [u.to_dict() for u in User.query.all()]
    })

@socketio.on("updateSession")
def handle_update_session(data):
    user_id = sid_to_userid.get(request.sid)
    if not user_id:
        return

    user = User.query.get(user_id)
    if not user:
        return

    if data.get("newName"):
        user.name = data["newName"]

    if data.get("expiresAt") is not None:
        user.expires_at = data["expiresAt"]

    user.last_active = int(time.time() * 1000)
    db.session.commit()
    broadcast_users()

@socketio.on("requestNewIdentity")
def handle_request_new_identity():
    user_id = sid_to_userid.get(request.sid)
    if not user_id:
        return

    user = User.query.get(user_id)
    if not user:
        return

    old_name = user.name
    user.name = random_name()
    user.expires_at = None
    db.session.commit()

    emit("sessionReady", {
        "userId": user.id,
        "name": user.name,
        "expiresAt": None,
        "oldName": old_name
    })

    broadcast_users()


@socketio.on("setUsername")
def handle_set_username(data):
    user_id = sid_to_userid.get(request.sid)
    if not user_id:
        return

    username = (data.get("username") or "").strip()

    if not username:
        emit("usernameError", {
            "message": "Username cannot be empty."
        })
        return

    if len(username) > 30:
        emit("usernameError", {
            "message": "Username is too long."
        })
        return

    user = User.query.get(user_id)
    if not user:
        return
    
    existing = User.query.filter(
        User.name == username,
        User.id != user_id
    ).first()

    if existing:
        emit("usernameError", {
            "message": "Username already taken."
        })
        return

    old_name = user.name
    user.name = username
    db.session.commit()

    emit("sessionReady", {
        "userId": user.id,
        "name": user.name,
        "expiresAt": user.expires_at.isoformat() if user.expires_at else None,
        "oldName": old_name
    })

    broadcast_users()

@socketio.on("loadDirectHistory")
def handle_load_direct_history(data):
    user_id = sid_to_userid.get(request.sid)
    target_user_id = data.get("targetUserId")

    if not user_id or not target_user_id:
        return

    offset = int(data.get("offset", 0))
    limit = int(data.get("limit", 10))

    chat_key = get_chat_key(user_id, target_user_id)

    total = Message.query.filter_by(chat_key=chat_key).count()

    history = (
        Message.query.filter_by(chat_key=chat_key)
        .order_by(Message.time.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    history.reverse()  # oldest -> newest

    pinned = PinnedMessage.query.filter_by(chat_key=chat_key).first()

    emit("directHistoryLoaded", {
        "targetUserId": target_user_id,
        "history": [m.to_dict() for m in history],
        "pinned": pinned.to_dict() if pinned else None,
        "hasMore": offset + limit < total
    })

@socketio.on("directMessage")
def handle_direct_message(payload):
    user_id = sid_to_userid.get(request.sid)
    if not user_id or not payload:
        return

    target_user_id = payload.get("targetUserId")
    if not target_user_id:
        return

    text = (payload.get("text") or "").strip()
    image = payload.get("image")
    reply_to = payload.get("replyTo")

    if not text and not image:
        return

    sender = User.query.get(user_id)

    msg = Message(
        chat_key=get_chat_key(user_id, target_user_id),
        user_id=user_id,
        target_user_id=target_user_id,
        name=sender.name if sender else "Anonymous",
        text=text,
        image=image,
        reply_to=reply_to,
        time=int(time.time() * 1000),
        read_by=[],
        reactions={},
        edited=False,
        forwarded=False
    )

    db.session.add(msg)
    
    # Trim old message history beyond 100 entries per chat
    old_messages = Message.query.filter_by(chat_key=msg.chat_key).order_by(Message.time.desc()).offset(100).all()
    for item in old_messages:
        db.session.delete(item)

    db.session.commit()

    msg_data = msg.to_dict()

    # Emit to sender
    emit("directMessage", msg_data)
    # Emit to recipient room
    emit("directMessage", msg_data, room=target_user_id)

    # Update last message cards for sender and recipient individually
    emit("lastMessages", {"lastMessages": calculate_last_messages(user_id)})
    emit("lastMessages", {"lastMessages": calculate_last_messages(target_user_id)}, room=target_user_id)

    target = User.query.get(target_user_id)
    if target and target.fcm_token:
        send_push_notification(
            target.fcm_token,
            sender.name if sender else "Anonymous",
            text or "Attachment",
            {"type": "message", "userId": user_id}
        )

@socketio.on("editMessage")
def handle_edit_message(data):
    user_id = sid_to_userid.get(request.sid)
    if not user_id:
        return

    msg = Message.query.get(data.get("msgId"))
    if not msg or msg.user_id != user_id:
        return

    new_text = (data.get("newText") or "").strip()
    if not new_text:
        return

    msg.text = new_text
    msg.edited = True
    db.session.commit()

    payload = {"chatKey": msg.chat_key, "msg": msg.to_dict()}
    emit("messageUpdated", payload)
    emit("messageUpdated", payload, room=msg.target_user_id)

@socketio.on("togglePinMessage")
def handle_toggle_pin_message(data):
    user_id = sid_to_userid.get(request.sid)
    if not user_id:
        return

    chat_key = get_chat_key(user_id, data.get("targetUserId"))
    msg = Message.query.get(data.get("msgId"))

    if not msg:
        return

    pinned = PinnedMessage.query.filter_by(chat_key=chat_key).first()

    if pinned and pinned.message_id == msg.id:
        db.session.delete(pinned)
    else:
        if pinned:
            db.session.delete(pinned)
        db.session.add(PinnedMessage(chat_key=chat_key, message_id=msg.id))

    db.session.commit()

    pinned = PinnedMessage.query.filter_by(chat_key=chat_key).first()
    payload = {"chatKey": chat_key, "pinned": pinned.to_dict() if pinned else None}

    emit("pinnedUpdate", payload)
    emit("pinnedUpdate", payload, room=data.get("targetUserId"))

@socketio.on("markRead")
def handle_mark_read(data):
    user_id = sid_to_userid.get(request.sid)
    target_user_id = data.get("targetUserId")
    msg_ids = data.get("msgIds", [])

    if not user_id or not target_user_id or not isinstance(msg_ids, list):
        return

    user = User.query.get(user_id)
    updated = False

    for msg in Message.query.filter(
        Message.chat_key == get_chat_key(user_id, target_user_id),
        Message.id.in_(msg_ids)
    ).all():
        if msg.user_id == user_id:
            continue

        read_by = msg.read_by or []
        if not any(r.get("userId") == user_id for r in read_by):
            read_by.append({
                "userId": user_id,
                "name": user.name if user else "Anonymous",
                "time": int(time.time() * 1000)
            })
            msg.read_by = read_by
            updated = True

    if updated:
        db.session.commit()

        chat_key = get_chat_key(user_id, target_user_id)
        history = Message.query.filter_by(chat_key=chat_key).order_by(Message.time.asc()).all()
        pinned = PinnedMessage.query.filter_by(chat_key=chat_key).first()
        history_list = [m.to_dict() for m in history]
        pinned_dict = pinned.to_dict() if pinned else None

        emit("directHistoryLoaded", {
            "targetUserId": target_user_id,
            "history": history_list,
            "pinned": pinned_dict
        })
        emit("directHistoryLoaded", {
            "targetUserId": user_id,
            "history": history_list,
            "pinned": pinned_dict
        }, room=target_user_id)

@socketio.on("toggleReaction")
def handle_toggle_reaction(data):
    user_id = sid_to_userid.get(request.sid)
    if not user_id:
        return

    msg = Message.query.get(data.get("msgId"))
    if not msg:
        return

    emoji = data.get("emoji")
    reactions = msg.reactions or {}

    if emoji not in reactions:
        reactions[emoji] = []

    user = User.query.get(user_id)
    idx = next((i for i, r in enumerate(reactions[emoji]) if r["userId"] == user_id), -1)

    if idx >= 0:
        reactions[emoji].pop(idx)
        if not reactions[emoji]:
            del reactions[emoji]
    else:
        reactions[emoji].append({
            "userId": user_id,
            "name": user.name if user else "Anonymous"
        })

    msg.reactions = reactions
    db.session.commit()

    payload = {"chatKey": msg.chat_key, "msg": msg.to_dict()}
    emit("messageUpdated", payload)
    emit("messageUpdated", payload, room=msg.target_user_id)

@socketio.on("deleteMessage")
def handle_delete_message(data):
    user_id = sid_to_userid.get(request.sid)
    if not user_id:
        return

    msg = Message.query.get(data.get("msgId"))
    if not msg or msg.user_id != user_id:
        return

    PinnedMessage.query.filter_by(chat_key=msg.chat_key, message_id=msg.id).delete()
    db.session.delete(msg)
    db.session.commit()

    emit("messageDeleted", {"targetUserId": msg.target_user_id, "msgId": msg.id})
    emit("messageDeleted", {"targetUserId": user_id, "msgId": msg.id}, room=msg.target_user_id)

@socketio.on("forwardMessage")
def handle_forward_message(data):
    user_id = sid_to_userid.get(request.sid)
    target_user_id = data.get("targetUserId")
    message = data.get("message", {})

    if not user_id or not target_user_id:
        return

    sender = User.query.get(user_id)

    msg = Message(
        chat_key=get_chat_key(user_id, target_user_id),
        user_id=user_id,
        target_user_id=target_user_id,
        name=sender.name if sender else "Anonymous",
        text=message.get("text"),
        image=message.get("image"),
        reply_to=message.get("replyTo"),
        time=int(time.time() * 1000),
        read_by=[],
        reactions={},
        forwarded=True
    )

    db.session.add(msg)
    db.session.commit()

    msg_dict = msg.to_dict()
    emit("directMessage", msg_dict)
    emit("directMessage", msg_dict, room=target_user_id)

    target = User.query.get(target_user_id)
    if target and target.fcm_token:
        send_push_notification(
            target.fcm_token,
            sender.name if sender else "Anonymous",
            msg.text or "Attachment",
            {"type": "message", "userId": user_id}
        )

@socketio.on("callUser")
def handle_call_user(data):
    target_user_id = data.get("targetUserId")
    if target_user_id:
        emit("incomingCall", {
            "fromUserId": sid_to_userid.get(request.sid),
            "fromSocketId": request.sid,
            "callerName": data.get("callerName"),
            "callType": data.get("callType", "video"),
            "signal": data.get("signal")
        }, room=target_user_id)

@socketio.on("acceptCall")
def handle_accept_call(data):
    emit("callAccepted", {
        "fromUserId": sid_to_userid.get(request.sid),
        "fromSocketId": request.sid,
        "answererName": data.get("answererName"),
        "signal": data.get("signal")
    }, room=data.get("targetUserId"))

@socketio.on("rejectCall")
def handle_reject_call(data):
    emit("callRejected", {
        "byName": data.get("byName")
    }, room=data.get("targetUserId"))

@socketio.on("sendIceCandidate")
def handle_send_ice_candidate(data):
    emit("iceCandidate", {
        "candidate": data.get("candidate")
    }, room=data.get("targetUserId"))

@socketio.on("endCall")
def handle_end_call(data):
    emit("callEnded", room=data.get("targetUserId"))

@socketio.on("typing")
def handle_typing(data):
    user = User.query.get(sid_to_userid.get(request.sid))
    if user:
        emit("typing", {
            "fromUserId": user.id,
            "name": user.name
        }, room=data.get("targetUserId"))

@socketio.on("stopTyping")
def handle_stop_typing(data):
    user_id = sid_to_userid.get(request.sid)
    if user_id:
        emit("stopTyping", {
            "fromUserId": user_id
        }, room=data.get("targetUserId"))

if __name__ == "__main__":
    port = int(os.getenv("PORT", 9000))
    log(f"Server listening on {port}")
    socketio.run(app, host="0.0.0.0", port=port, debug=True)