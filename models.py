from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

class User(db.Model):
    __tablename__ = 'users'
    id = db.Column(db.String(64), primary_key=True)
    name = db.Column(db.String(128), nullable=False)
    expires_at = db.Column(db.BigInteger, nullable=True)
    last_active = db.Column(db.BigInteger, nullable=True)
    fcm_token = db.Column(db.Text, nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "expiresAt": self.expires_at,
            "lastActive": self.last_active
        }

class Message(db.Model):
    __tablename__ = 'messages'
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    chat_key = db.Column(db.String(128), index=True, nullable=False)
    user_id = db.Column(db.String(64), nullable=False)
    target_user_id = db.Column(db.String(64), nullable=False)
    name = db.Column(db.String(128), nullable=False)
    text = db.Column(db.Text, nullable=True)
    image = db.Column(db.Text, nullable=True)
    reply_to = db.Column(db.JSON, nullable=True)
    time = db.Column(db.BigInteger, nullable=False)
    read_by = db.Column(db.JSON, default=list)
    reactions = db.Column(db.JSON, default=dict)
    edited = db.Column(db.Boolean, default=False)
    forwarded = db.Column(db.Boolean, default=False)

    def to_dict(self):
        return {
            "id": self.id,
            "chat_key": self.chat_key,
            "user_id": self.user_id,
            "target_user_id": self.target_user_id,
            "name": self.name,
            "text": self.text,
            "image": self.image,
            "reply_to": self.reply_to,
            "time": self.time,
            "read_by": self.read_by or [],
            "reactions": self.reactions or {},
            "edited": self.edited,
            "forwarded": self.forwarded
        }

class PinnedMessage(db.Model):
    __tablename__ = 'pinned_messages'
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    chat_key = db.Column(db.String(128), unique=True, nullable=False)
    message_id = db.Column(db.Integer, db.ForeignKey('messages.id', ondelete='CASCADE'), nullable=False)

    def to_dict(self):
        return {
            "id": self.id,
            "chat_key": self.chat_key,
            "message_id": self.message_id
        }