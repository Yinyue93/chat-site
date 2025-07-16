// database.js
// ================== MONGODB SETUP ==================
const mongoose = require('mongoose');
require('dotenv').config();

// MongoDB connection
const connectDB = async () => {
    try {
        const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/chat-site';
        await mongoose.connect(mongoURI);
        console.log('MongoDB connected successfully');
    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
};

// ================== SCHEMAS ==================

// User Schema
const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        minlength: 3,
        maxlength: 20
    },
    password: {
        type: String,
        required: function() {
            // Only require password for admin users
            return this.isAdmin;
        },
        default: null
    },
    isAdmin: {
        type: Boolean,
        default: false
    },
    joinDate: {
        type: Date,
        default: Date.now
    },
    lastSeen: {
        type: Date,
        default: Date.now
    },
    ipAddress: {
        type: String,
        required: true
    },
    country: {
        type: String,
        default: '?'
    }
});

// Room Schema
const roomSchema = new mongoose.Schema({
    roomId: {
        type: String,
        required: true,
        unique: true
    },
    name: {
        type: String,
        required: true,
        trim: true,
        minlength: 3,
        maxlength: 30
    },
    maxUsers: {
        type: Number,
        required: true,
        min: 1,
        max: 100
    },
    password: {
        type: String,
        default: null
    },
    isHidden: {
        type: Boolean,
        default: false
    },
    createdBy: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastActivity: {
        type: Date,
        default: Date.now
    }
});

// Message Schema
const messageSchema = new mongoose.Schema({
    roomId: {
        type: String,
        required: true,
        index: true
    },
    type: {
        type: String,
        required: true,
        enum: ['message', 'image', 'join', 'leave', 'system'],
        default: 'message'
    },
    username: {
        type: String,
        required: function() {
            // Username is not required for system messages
            return this.type !== 'system';
        },
        default: 'System'
    },
    isAdmin: {
        type: Boolean,
        default: false
    },
    message: {
        type: String,
        maxlength: 500
    },
    imageUrl: {
        type: String
    },
    timestamp: {
        type: Date,
        default: Date.now,
        index: true
    }
});

// Ban Schema
const banSchema = new mongoose.Schema({
    value: {
        type: String,
        required: true,
        unique: true
    },
    type: {
        type: String,
        required: true,
        enum: ['username', 'ip']
    },
    bannedBy: {
        type: String,
        required: true
    },
    bannedAt: {
        type: Date,
        default: Date.now
    },
    reason: {
        type: String,
        default: ''
    }
});

// Session Schema (for persistent sessions)
const sessionSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true
    },
    username: {
        type: String,
        required: true
    },
    isAdmin: {
        type: Boolean,
        default: false
    },
    ipAddress: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastAccessed: {
        type: Date,
        default: Date.now
    },
    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours from now
    }
});

// Create indexes for better performance
messageSchema.index({ roomId: 1, timestamp: -1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ================== MODELS ==================
const User = mongoose.model('User', userSchema);
const Room = mongoose.model('Room', roomSchema);
const Message = mongoose.model('Message', messageSchema);
const Ban = mongoose.model('Ban', banSchema);
const Session = mongoose.model('Session', sessionSchema);

// ================== DATABASE OPERATIONS ==================

// User operations
const userOps = {
    async create(userData) {
        const user = new User(userData);
        return await user.save();
    },

    async findByUsername(username) {
        return await User.findOne({ username });
    },

    async updateLastSeen(username) {
        return await User.findOneAndUpdate(
            { username },
            { lastSeen: new Date() },
            { new: true }
        );
    },

    async getAll() {
        return await User.find({}).sort({ joinDate: -1 });
    },

    async delete(username) {
        return await User.findOneAndDelete({ username });
    }
};

// Room operations
const roomOps = {
    async create(roomData) {
        const room = new Room(roomData);
        return await room.save();
    },

    async findById(roomId) {
        return await Room.findOne({ roomId });
    },

    async getAll() {
        return await Room.find({}).sort({ lastActivity: -1 });
    },

    async getVisible() {
        return await Room.find({ isHidden: false }).sort({ lastActivity: -1 });
    },

    async update(roomId, updates) {
        return await Room.findOneAndUpdate(
            { roomId },
            { ...updates, lastActivity: new Date() },
            { new: true }
        );
    },

    async delete(roomId) {
        // Also delete all messages in the room
        await Message.deleteMany({ roomId });
        return await Room.findOneAndDelete({ roomId });
    },

    async updateActivity(roomId) {
        return await Room.findOneAndUpdate(
            { roomId },
            { lastActivity: new Date() },
            { new: true }
        );
    }
};

// Message operations
const messageOps = {
    async create(messageData) {
        const message = new Message(messageData);
        return await message.save();
    },

    async getByRoom(roomId, limit = 100) {
        return await Message.find({ roomId })
            .sort({ timestamp: -1 })
            .limit(limit)
            .exec();
    },

    async getRecentByRoom(roomId, limit = 50) {
        const messages = await Message.find({ roomId })
            .sort({ timestamp: -1 })
            .limit(limit)
            .exec();
        return messages.reverse(); // Return in chronological order
    },

    async deleteByRoom(roomId) {
        return await Message.deleteMany({ roomId });
    },

    async countByRoom(roomId) {
        return await Message.countDocuments({ roomId });
    },

    async findOneAndDelete(query) {
        return await Message.findOneAndDelete(query);
    }
};

// Ban operations
const banOps = {
    async create(banData) {
        const ban = new Ban(banData);
        return await ban.save();
    },

    async findByValue(value) {
        return await Ban.findOne({ value });
    },

    async getAll() {
        return await Ban.find({}).sort({ bannedAt: -1 });
    },

    async delete(value) {
        return await Ban.findOneAndDelete({ value });
    },

    async isValueBanned(value) {
        const ban = await Ban.findOne({ value });
        return !!ban;
    },

    async getBannedValues() {
        const bans = await Ban.find({});
        return bans.map(ban => ban.value);
    }
};

// Session operations
const sessionOps = {
    async create(sessionData) {
        const session = new Session(sessionData);
        return await session.save();
    },

    async findById(sessionId) {
        return await Session.findOne({ sessionId });
    },

    async update(sessionId, updates) {
        return await Session.findOneAndUpdate(
            { sessionId },
            { ...updates, lastAccessed: new Date() },
            { new: true }
        );
    },

    async delete(sessionId) {
        return await Session.findOneAndDelete({ sessionId });
    },

    async cleanExpired() {
        return await Session.deleteMany({ expiresAt: { $lt: new Date() } });
    }
};

// ================== UTILITY FUNCTIONS ==================

// Initialize database with default admin user if not exists
const initializeDatabase = async () => {
    try {
        const adminUsername = process.env.ADMIN_USER || 'admin';
        const adminExists = await User.findOne({ username: adminUsername });
        
        if (!adminExists) {
            const bcrypt = require('bcrypt');
            const adminPassword = process.env.ADMIN_PASSWORD || 'password';
            const hashedPassword = await bcrypt.hash(adminPassword, 12);
            
            await User.create({
                username: adminUsername,
                password: hashedPassword,
                isAdmin: true,
                ipAddress: '127.0.0.1',
                country: 'Local'
            });
            console.log(`Default admin user created: ${adminUsername}`);
        }
    } catch (error) {
        console.error('Error initializing database:', error);
    }
};

// Clean up expired sessions periodically
const startSessionCleanup = () => {
    setInterval(async () => {
        try {
            await sessionOps.cleanExpired();
        } catch (error) {
            console.error('Error cleaning expired sessions:', error);
        }
    }, 60 * 60 * 1000); // Clean every hour
};

// ================== EXPORTS ==================
module.exports = {
    connectDB,
    initializeDatabase,
    startSessionCleanup,
    models: {
        User,
        Room,
        Message,
        Ban,
        Session
    },
    operations: {
        user: userOps,
        room: roomOps,
        message: messageOps,
        ban: banOps,
        session: sessionOps
    }
}; 