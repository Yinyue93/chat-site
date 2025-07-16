// server.js
// ================== REQUIRES ==================
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const geoip = require('geoip-lite');
const bcrypt = require('bcrypt');
require('dotenv').config();

// ================== MONGODB SETUP ==================
const { connectDB, initializeDatabase, startSessionCleanup, operations } = require('./database');

// Initialize MongoDB connection
connectDB().then(() => {
    initializeDatabase();
    loadRoomsFromDatabase();
    startSessionCleanup();
}).catch(error => {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
});

// Load existing rooms from database on startup
async function loadRoomsFromDatabase() {
    try {
        const dbRooms = await operations.room.getAll();
        for (const dbRoom of dbRooms) {
            // Only load rooms that don't already exist in memory
            if (!rooms[dbRoom.roomId]) {
                rooms[dbRoom.roomId] = {
                    name: dbRoom.name,
                    maxUsers: dbRoom.maxUsers,
                    password: dbRoom.password,
                    users: new Map(),
                    logs: [],
                    isHidden: dbRoom.isHidden,
                    createdBy: dbRoom.createdBy,
                    createdAt: dbRoom.createdAt
                };
                
                // Load recent messages from MongoDB
                const recentMessages = await operations.message.getRecentByRoom(dbRoom.roomId);
                rooms[dbRoom.roomId].logs = recentMessages.map(msg => ({
                    type: msg.type,
                    username: msg.username,
                    isAdmin: msg.isAdmin,
                    message: msg.message,
                    url: msg.imageUrl,
                    timestamp: msg.timestamp.getTime()
                }));
            }
        }
        console.log(`Loaded ${dbRooms.length} rooms from database`);
    } catch (error) {
        console.error('Error loading rooms from database:', error);
    }
}

// ================== PASSWORD UTILITIES ==================
const SALT_ROUNDS = 12;

/**
 * Hash a password using bcrypt
 * @param {string} password - Plain text password
 * @returns {Promise<string>} - Hashed password
 */
async function hashPassword(password) {
    try {
        return await bcrypt.hash(password, SALT_ROUNDS);
    } catch (error) {
        console.error('Error hashing password:', error);
        throw error;
    }
}

/**
 * Compare a plain text password with a hashed password
 * @param {string} password - Plain text password
 * @param {string} hashedPassword - Hashed password
 * @returns {Promise<boolean>} - True if passwords match
 */
async function comparePassword(password, hashedPassword) {
    try {
        return await bcrypt.compare(password, hashedPassword);
    } catch (error) {
        console.error('Error comparing password:', error);
        return false;
    }
}

// ================== APP/SERVER/SOCKET.IO SETUP ==================
const app = express();
const server = http.createServer(app); // Crucial: Create server from Express app
const io = new Server(server);       // Crucial: Attach Socket.IO to the HTTP server

// ================== MIDDLEWARE ==================
app.set('view engine', 'ejs'); // Set EJS as the template engine
app.set('trust proxy', true); // Enable reading of X-Forwarded-For headers for real IP addresses
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files (CSS, client JS)
app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); // Serve uploaded images
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded form data
app.use(express.json()); // Parse JSON request bodies

// --- Session Middleware ---
// !! IMPORTANT: Make sure SESSION_SECRET is set in your .env file !!
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
    console.error("FATAL ERROR: SESSION_SECRET is not set in the .env file. Sessions will not work securely.");
    // Provide a default for Glitch Remix/Demo purposes, but strongly advise setting it
    // process.exit(1); // Optionally exit if secret is missing in production
}

const sessionMiddleware = session({
    secret: sessionSecret || 'unsafe_default_secret_please_set_in_env', // Use env secret or fallback (warn if fallback is used)
    resave: false, // Don't save session if unmodified
    saveUninitialized: false, // Don't create session until something stored
    cookie: {
        secure: false, // Set to true if your Glitch project uses HTTPS consistently (usually does)
        httpOnly: true, // Helps prevent XSS attacks
        maxAge: 24 * 60 * 60 * 1000 // Optional: Cookie expiry (e.g., 1 day)
    }
});
app.use(sessionMiddleware); // Apply session middleware to Express routes

// --- Share session with Socket.IO ---
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next); // Apply session middleware to Socket.IO connections
});

// --- Image Upload Setup (Multer) ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, 'uploads');
        fs.mkdirSync(uploadPath, { recursive: true }); // Ensure directory exists
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        // Ensure unique filenames
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: function (req, file, cb) { // Basic image type filter
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'), false);
        }
    }
}).single('image'); // Expect a single file named 'image'

// ================== IN-MEMORY DATA STRUCTURES ==================
// Store rooms and users. For production, consider a database (Redis, etc.).
// rooms: { roomId: { name, maxUsers, password, users: Map<socketId, {username, isAdmin}>, logs: [], isHidden: false } }
let rooms = {};
// userSockets: Map<username, socketId> - For quick lookup (simplistic, assumes unique usernames)
let userSockets = new Map();

// ================== HELPER FUNCTIONS ==================

// Helper function to extract real IP address from request/socket
function getRealIpAddress(req) {
    // For Socket.IO connections, check proxy headers manually
    const xForwardedFor = req.headers['x-forwarded-for'];
    const xRealIp = req.headers['x-real-ip'];
    const cfConnectingIp = req.headers['cf-connecting-ip']; // Cloudflare
    
    let ip = req.connection?.remoteAddress || req.handshake?.address || 'N/A';
    
    // Use proxy headers if available (first IP in X-Forwarded-For chain is the original client)
    if (xForwardedFor) {
        ip = xForwardedFor.split(',')[0].trim();
    } else if (xRealIp) {
        ip = xRealIp.trim();
    } else if (cfConnectingIp) {
        ip = cfConnectingIp.trim();
    }
    
    // Clean up IPv6 localhost representation and IPv6-mapped IPv4 addresses
    if (ip === '::1') {
        ip = '127.0.0.1';
    } else if (ip.startsWith('::ffff:')) {
        // Extract IPv4 from IPv6-mapped format
        ip = ip.substring(7);
    }
    
    return ip;
}

async function getRoomInfoList() {
    try {
        const visibleRooms = await operations.room.getVisible();
        return visibleRooms.map(room => ({
            id: room.roomId,
            name: room.name,
            userCount: rooms[room.roomId] ? rooms[room.roomId].users.size : 0,
            maxUsers: room.maxUsers,
            hasPassword: !!room.password // Boolean flag if password exists
        }));
    } catch (error) {
        console.error('Error getting room info list:', error);
        return [];
    }
}

async function getAdminData() {
    try {
        const allUsers = [];
        // Iterate over connected sockets
        io.sockets.sockets.forEach(socket => {
            // Only include users who have successfully joined (have username/session)
            if (socket.username) {
                 const ip = getRealIpAddress(socket.request);
                 const geo = geoip.lookup(ip); // geoip-lite handles private IPs returning null
                 allUsers.push({
                     socketId: socket.id,
                     username: socket.username,
                     roomId: socket.currentRoom, // The ID of the room the user is currently in
                     roomName: socket.currentRoom && rooms[socket.currentRoom] ? rooms[socket.currentRoom].name : 'Lobby/Main', // Room name or Lobby
                     ipAddress: ip,
                     country: geo ? geo.country : '?', // Display country code or '?'
                     isAdmin: socket.isAdmin || false
                 });
            }
        });
        
        const allRooms = Object.entries(rooms).map(([id, room]) => ({
            id: id,
            name: room.name,
            userCount: room.users.size,
            maxUsers: room.maxUsers,
            isHidden: room.isHidden,
            users: Array.from(room.users.values()).map(u => u.username) // List of usernames in the room
        }));
        
        const bans = await operations.ban.getBannedValues();
        
        return { users: allUsers, rooms: allRooms, bans: bans };
    } catch (error) {
        console.error('Error getting admin data:', error);
        return { users: [], rooms: [], bans: [] };
    }
}

async function addLog(roomId, logEntry) {
    try {
        if (!logEntry.timestamp) logEntry.timestamp = Date.now(); // Ensure timestamp
        
        // Always persist to MongoDB first
        const messageData = {
            roomId: roomId,
            type: logEntry.type,
            username: logEntry.type === 'system' ? 'System' : (logEntry.username || 'Unknown'),
            isAdmin: logEntry.isAdmin || false,
            message: logEntry.message,
            imageUrl: logEntry.url, // For image logs
            timestamp: new Date(logEntry.timestamp)
        };
        
        await operations.message.create(messageData);
        
        // Update room activity in MongoDB
        await operations.room.updateActivity(roomId);
        
        // Add to in-memory logs if room exists in memory
        if (rooms[roomId]) {
            rooms[roomId].logs.push(logEntry);
            
            // Limit in-memory log size to prevent memory issues
            if (rooms[roomId].logs.length > 150) { // Keep last 150 entries
                rooms[roomId].logs.shift();
            }
        } else {
            console.warn(`Room ${roomId} not in memory, but log saved to database`);
        }
    } catch (error) {
        console.error('Error adding log:', error);
    }
}

// Simple middleware to require login for protected routes
function requireLogin(req, res, next) {
    if (req.session && req.session.username) {
        next();
    } else {
         // Optional: Add a flash message explaining why they were redirected
        res.redirect('/');
    }
}


// ================== ROUTES ==================

// --- Login/Logout ---
app.get('/', (req, res) => {
    if (req.session.username) {
        res.redirect('/main'); // Already logged in
    } else {
        res.render('login', { error: null }); // Pass null error initially
    }
});

app.post('/login', async (req, res) => {
    const username = req.body.username?.trim();
    const ip = req.ip; // Get user's IP address

    if (!username || username.length < 3 || username.length > 20) { // Add max length
        return res.render('login', { error: 'Username must be 3-20 characters.' });
    }

    try {
        // Check if user or IP is banned
        const isUsernameBanned = await operations.ban.isValueBanned(username);
        const isIpBanned = await operations.ban.isValueBanned(ip);
        
        if (isUsernameBanned || isIpBanned) {
            return res.render('login', { error: 'You are banned from this service.' });
        }

        // Find or create user
        let user = await operations.user.findByUsername(username);
        const geo = geoip.lookup(ip);
        
        if (!user) {
            // Create new user (no password required for regular users)
            user = await operations.user.create({
                username: username,
                isAdmin: false,
                ipAddress: ip,
                country: geo ? geo.country : '?'
            });
        } else {
            // Update last seen and IP
            await operations.user.updateLastSeen(username);
        }

        // Store user info in session
        req.session.username = username;
        req.session.isAdmin = user.isAdmin;
        req.session.save(err => { // Ensure session is saved before redirecting
             if (err) {
                  return res.render('login', { error: 'Login failed, please try again.' });
             }
            
            // Get the current number of connected users
            const connectedUsers = io.sockets.sockets.size;

            // Broadcast both events - this ensures all clients get both updates
            getRoomInfoList().then(roomList => {
                io.to('main_lobby').emit('roomListUpdate', {
                    rooms: roomList,
                    connectedUsers: connectedUsers
                });
            }).catch(error => {
                console.error('Error getting room list for login broadcast:', error);
            });
            
            // Add this explicit userCountUpdate broadcast 
            io.to('main_lobby').emit('userCountUpdate', connectedUsers);
            
            res.redirect('/main');
        });
    } catch (error) {
        console.error('Login error:', error);
        res.render('login', { error: 'Login failed, please try again.' });
    }
});

app.post('/logout', (req, res) => {
    const username = req.session.username;

    req.session.destroy(err => {
        if (err) {
            console.error("Error destroying session:", err);
        }
        // Clear the cookie explicitly associated with express-session
        res.clearCookie('connect.sid'); // Default cookie name, adjust if changed in config

        // Remove setTimeout and broadcast immediately
        const connectedUsers = io.sockets.sockets.size;
        io.to('main_lobby').emit('userCountUpdate', connectedUsers);
        getRoomInfoList().then(roomList => {
            io.to('main_lobby').emit('roomListUpdate', {
                rooms: roomList,
                connectedUsers: connectedUsers
            });
        }).catch(error => {
            console.error('Error getting room list for logout broadcast:', error);
        });

        res.redirect('/'); // Redirect to login page
    });
});

// --- Main Room List ---
app.get('/main', requireLogin, async (req, res) => {
    try {
        const connectedUsers = io.sockets.sockets.size;
        const roomList = await getRoomInfoList();
        
        res.render('main', {
            username: req.session.username,
            rooms: roomList,
            isAdmin: req.session.isAdmin || false,
            connectedUsers: connectedUsers // Add initial user count
        });
    } catch (error) {
        console.error('Error loading main page:', error);
        res.render('main', {
            username: req.session.username,
            rooms: [],
            isAdmin: req.session.isAdmin || false,
            connectedUsers: io.sockets.sockets.size
        });
    }
});

// --- Room Creation ---
app.post('/create-room', requireLogin, async (req, res) => {
    const { roomName, maxUsers, password } = req.body;
    const creator = req.session.username;

    if (!roomName || roomName.length < 3 || roomName.length > 30) {
        // TODO: Add flash error message back to /main
        console.log(`Room creation failed: Invalid name '${roomName}' by ${creator}`);
        return res.redirect('/main');
    }
    const max = parseInt(maxUsers, 10);
    if (isNaN(max) || max < 1 || max > 100) { // Set reasonable limits
         // TODO: Add flash error message back to /main
        console.log(`Room creation failed: Invalid max users '${maxUsers}' by ${creator}`);
        return res.redirect('/main');
    }

    try {
        const roomId = uuidv4(); // Generate unique ID
        
        // Hash password if provided
        let hashedPassword = null;
        if (password && password.trim()) {
            hashedPassword = await hashPassword(password.trim());
            console.log(`Password set and hashed for room '${roomName}' by ${creator}`);
        }
        
        // Create room in MongoDB
        await operations.room.create({
            roomId: roomId,
            name: roomName,
            maxUsers: max,
            password: hashedPassword,
            isHidden: false,
            createdBy: creator
        });
        
        // Create in-memory room structure for active connections
        rooms[roomId] = {
            name: roomName,
            maxUsers: max,
            password: hashedPassword, // Store hashed password securely
            users: new Map(), // Map<socketId, {username, isAdmin}>
            logs: [],
            isHidden: false,
            createdBy: creator, // Track who created it
            createdAt: Date.now()
        };
        
        console.log(`Room created: '${roomName}' (${roomId}) by ${creator}`);    
        
        // Grant access to the creator if a password was set
        if (hashedPassword) {
            req.session[`room_${roomId}_access`] = true; // Grant access for this session
            console.log(`Granted automatic access to room creator ${creator} for room ${roomId}`);
            // Ensure session is saved before redirect
            req.session.save(err => {
                if (err) console.error("Session save error while granting room access:", err);
                // Add initial log entry
                addLog(roomId, { type: 'system', message: `Room created by ${creator}`});

                res.redirect(`/room/${roomId}`);
            });
        } else {
            // No password, no need to grant special access
            addLog(roomId, { type: 'system', message: `Room created by ${creator}`});
            res.redirect(`/room/${roomId}`);
        }
    } catch (error) {
        console.error('Error creating room:', error);
        // TODO: Add flash error message
        res.redirect('/main');
    }
});

// --- Room Access ---
app.get('/room/:roomId', requireLogin, async (req, res) => {
    const roomId = req.params.roomId;
    const session = req.session;

    try {
        // Check if room exists in MongoDB
        const dbRoom = await operations.room.findById(roomId);
        if (!dbRoom) {
            console.log(`User ${session.username} tried to access non-existent room: ${roomId}`);
            // TODO: Add flash message 'Room not found'
            return res.redirect('/main');
        }

        // Create in-memory room structure if it doesn't exist
        if (!rooms[roomId]) {
            rooms[roomId] = {
                name: dbRoom.name,
                maxUsers: dbRoom.maxUsers,
                password: dbRoom.password,
                users: new Map(),
                logs: [],
                isHidden: dbRoom.isHidden,
                createdBy: dbRoom.createdBy,
                createdAt: dbRoom.createdAt
            };
            
            // Load recent messages from MongoDB
            const recentMessages = await operations.message.getRecentByRoom(roomId);
            rooms[roomId].logs = recentMessages.map(msg => ({
                type: msg.type,
                username: msg.username,
                isAdmin: msg.isAdmin,
                message: msg.message,
                url: msg.imageUrl,
                timestamp: msg.timestamp.getTime()
            }));
        }

        const room = rooms[roomId];

        // Check password requirement
        // Admins bypass password requirement
        if (room.password && !session.isAdmin && !session[`room_${roomId}_access`]) {
            // console.log(`User ${session.username} needs password for room: ${roomId}`);
            return res.render('password_prompt', { roomId: roomId, roomName: room.name, error: null });
        }

        // User is allowed, render the room page
        res.render('room', {
            username: session.username,
            roomId: roomId,
            roomName: room.name,
            isAdmin: session.isAdmin || false // Pass admin status
        });
    } catch (error) {
        console.error('Error accessing room:', error);
        res.redirect('/main');
    }
});

app.post('/room/:roomId/password', requireLogin, async (req, res) => {
     const roomId = req.params.roomId;
     const { password } = req.body;
     const session = req.session;

     try {
         // Check if room exists in MongoDB
         const dbRoom = await operations.room.findById(roomId);
         if (!dbRoom) return res.redirect('/main'); // Room disappeared?

         // Check password using bcrypt
         if (dbRoom.password && await comparePassword(password, dbRoom.password)) {
             session[`room_${roomId}_access`] = true; // Grant access for this session
             session.save(err => { // Save session before redirect
                 if (err) console.error("Session save error on password grant:", err);
                 console.log(`User ${session.username} granted access to room ${roomId}`);
                 res.redirect(`/room/${roomId}`);
             });
         } else {
             console.log(`User ${session.username} failed password attempt for room ${roomId}`);
             res.render('password_prompt', { roomId: roomId, roomName: dbRoom.name, error: 'Incorrect password' });
         }
     } catch (error) {
         console.error('Error verifying room password:', error);
         res.render('password_prompt', { roomId: roomId, roomName: 'Unknown', error: 'Password verification failed, please try again.' });
     }
});

// --- Image Upload ---
app.post('/upload/:roomId', requireLogin, (req, res) => {
    // Use multer middleware first to handle the upload
    upload(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            // A Multer error occurred (e.g., file size limit)
            // console.error(`Multer error during upload for room ${req.params.roomId}:`, err.message);
            return res.status(400).json({ success: false, message: `Upload error: ${err.message}` });
        } else if (err) {
            // An unknown error occurred (e.g., file filter rejection)
            // console.error(`Unknown error during upload for room ${req.params.roomId}:`, err.message);
             return res.status(400).json({ success: false, message: err.message || 'Upload failed.' });
        }

        // If upload via multer was successful (or no file was provided, which is also ok here)
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No image file provided.' });
        }

        // File should be uploaded at this point, proceed with Socket.IO notification
        const roomId = req.params.roomId;
        const session = req.session;

        if (!rooms[roomId]) {
            // Clean up uploaded file if room doesn't exist anymore
            // console.warn(`Upload to non-existent room ${roomId}, deleting file ${req.file.filename}`);
            fs.unlink(req.file.path, (unlinkErr) => { // Use async unlink
                if (unlinkErr) console.error("Error deleting orphaned upload:", unlinkErr);
            });
            return res.status(404).json({ success: false, message: 'Room not found.' });
        }

        const imageUrl = `/uploads/${req.file.filename}`;
        // Include isAdmin status in the log entry
        const logEntry = {
            type: 'image',
            username: session.username,
            isAdmin: session.isAdmin || false,
            url: imageUrl,
            timestamp: Date.now()
        };
        addLog(roomId, logEntry);
        io.to(roomId).emit('newImage', logEntry); // Broadcast log entry

        // console.log(`User ${session.username} uploaded image to room ${roomId}: ${imageUrl}`);
        res.status(200).json({ success: true, imageUrl: imageUrl });
    });
});


// ================== ADMIN ROUTES ==================

app.get('/admin-login', (req, res) => {
    if (req.session.isAdmin) return res.redirect('/admin'); // Redirect if already logged in as admin
    res.render('admin_login', { error: null });
});

app.post('/admin-login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        // Find admin user in MongoDB
        const adminUser = await operations.user.findByUsername(username);
        
        if (!adminUser || !adminUser.isAdmin) {
            console.log(`Failed admin login attempt: User '${username}' not found or not admin`);
            return res.render('admin_login', { error: 'Invalid admin credentials' });
        }
        
        // Check password using bcrypt
        const isValidPassword = await comparePassword(password, adminUser.password);
        
        if (isValidPassword) {
            // Regenerate session ID upon login for security
            req.session.regenerate(err => {
                if (err) {
                    console.error("Session regeneration error on admin login:", err);
                    return res.render('admin_login', { error: 'Admin login failed, please try again.' });
                }
                // Set admin-specific session data
                req.session.username = username;
                req.session.isAdmin = true;
                console.log("Admin logged in:", username);
                
                // Update last seen for admin user
                operations.user.updateLastSeen(username);
                
                res.redirect('/admin');
            });
        } else {
            console.log(`Failed admin login attempt: Incorrect password for user '${username}'`);
            res.render('admin_login', { error: 'Invalid admin credentials' });
        }
    } catch (error) {
        console.error('Error during admin login:', error);
        res.render('admin_login', { error: 'Login failed, please try again.' });
    }
});

// Middleware to protect admin routes
function requireAdmin(req, res, next) {
    if (req.session && req.session.isAdmin) {
        next();
    } else {
        // console.log(`Unauthorized attempt to access admin panel by ${req.session.username || 'non-logged-in user'}`);
        res.status(403).redirect('/admin-login'); // Forbidden, redirect to admin login
    }
}

// Admin Panel Dashboard
app.get('/admin', requireAdmin, async (req, res) => {
    try {
        const adminData = await getAdminData();
        res.render('admin_panel', adminData); // Pass current user/room/ban data
    } catch (error) {
        console.error('Error loading admin panel:', error);
        res.render('admin_panel', { users: [], rooms: [], bans: [] });
    }
});

// Admin Action: Download Room Log
app.get('/admin/download-log/:roomId', requireAdmin, async (req, res) => {
    const roomId = req.params.roomId;
    
    try {
        // Get room from database
        const room = await operations.room.findById(roomId);
        if (!room) {
            return res.status(404).send('Room not found');
        }

        // Get all messages for this room from MongoDB
        const messages = await operations.message.getByRoom(roomId, 1000); // Get up to 1000 messages
        
        // Set headers for a .txt file download
        res.setHeader('Content-Disposition', `attachment; filename="log_${room.name.replace(/[^a-z0-9]/gi, '_')}_${roomId}.txt"`);
        res.setHeader('Content-Type', 'text/plain');

        // Get timezone offset from query parameter (in minutes)
        const timezoneOffset = parseInt(req.query.tz) || 0;

        // Format logs into a human-readable string
        const logString = messages.reverse().map(entry => {
            // Apply timezone offset to get local time
            const localTime = new Date(entry.timestamp.getTime() - (timezoneOffset * 60000));
            const time = localTime.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'medium' });
            const user = entry.username || 'System';
            let messageDetails = '';

            switch (entry.type) {
                case 'message':
                    messageDetails = `${user}: ${entry.message}`;
                    break;
                case 'image':
                    messageDetails = `${user} uploaded an image: ${entry.imageUrl}`;
                    break;
                case 'join':
                    messageDetails = `${user} joined.`;
                    break;
                case 'leave':
                    messageDetails = `${user} left.`;
                    break;
                case 'system':
                    // For system messages, the 'message' field contains the full text
                    messageDetails = `SYSTEM: ${entry.message}`;
                    break;
                default:
                    // Fallback for any other or future log types
                    messageDetails = `[${entry.type.toUpperCase()}] ${JSON.stringify(entry)}`;
                    break;
            }
            return `[${time}] ${messageDetails}`;
        }).join('\n');

        res.send(logString);
    } catch (error) {
        console.error('Error downloading room log:', error);
        res.status(500).send('Error retrieving room log');
    }
});

// Admin Action: Get Banned IPs/Usernames
app.get('/admin/bans', requireAdmin, (req, res) => {
    // ... existing code ...
});


// ================== SOCKET.IO LOGIC ==================
io.on('connection', (socket) => {
    // console.log(`Socket connected: ${socket.id}`);
    const session = socket.request.session; // Access session data attached by middleware

    // --- Assign user details to socket ---
    socket.username = session?.username;
    socket.isAdmin = session?.isAdmin || false;
    socket.currentRoom = null; // Track which room the socket is currently in

    if (!socket.username) {
        // This might happen if session expired or wasn't established correctly
        console.warn(`Socket ${socket.id} connected without valid session/username. Disconnecting.`);
        socket.disconnect(true);
        return; // Stop further processing for this socket
    }

    // Add user to the lookup map
    userSockets.set(socket.username, socket.id);
    // console.log(`User associated with socket: ${socket.username} (Admin: ${socket.isAdmin})`);

    // Notify admin panel about the new connection immediately
    if (io.sockets.adapter.rooms.has('admin_room')) {
        io.to('admin_room').emit('adminUpdate', getAdminData());
    }

    if (io.sockets.adapter.rooms.has('main_lobby')) {
        io.to('main_lobby').emit('userCountUpdate', io.sockets.sockets.size);
    }

    // Auto-join main_lobby on connection unless specifically in a room
    if (socket.username) {
        // Auto-join main_lobby on connection unless specifically in a room
        if (!socket.currentRoom) {
            socket.join('main_lobby');
            
            // Notify everyone about updated user count immediately
            const connectedUsers = io.sockets.sockets.size;
            io.to('main_lobby').emit('userCountUpdate', connectedUsers);
        }
    }

    // --- Handle Main Lobby Join ---
    socket.on('joinMainLobby', async () => {
         // Make sure we're tracking 'main_lobby' joins
         socket.join('main_lobby');

         // Send current room list
         try {
             const roomList = await getRoomInfoList();
             socket.emit('roomListUpdate', {
                 rooms: roomList,
                 connectedUsers: io.sockets.sockets.size // Total connected users
             });
         } catch (error) {
             console.error('Error getting room list for main lobby join:', error);
             socket.emit('roomListUpdate', {
                 rooms: [],
                 connectedUsers: io.sockets.sockets.size
             });
         }
    });

    // --- Handle Room Joining ---
    socket.on('joinRoom', async ({ roomId }) => {
        if (!socket.username) return; // Should not happen due to check above

        const room = rooms[roomId];
        const currentSession = socket.request.session; // Re-access session for latest data

        // 1. Check if room exists
        if (!room) {
            // console.warn(`User ${socket.username} failed to join non-existent room: ${roomId}`);
            return socket.emit('errorMsg', 'Room does not exist anymore.');
        }

        // 2. Check password (admins bypass)
        if (room.password && !socket.isAdmin && !currentSession[`room_${roomId}_access`]) {
            //  console.log(`User ${socket.username} needs password for room ${roomId}, denied join via socket.`);
             return socket.emit('errorMsg', 'Password required.');
        }

        // 3. Check room capacity (admins bypass)
        if (room.users.size >= room.maxUsers && !socket.isAdmin) {
            // console.log(`User ${socket.username} denied joining full room ${roomId} (${room.name})`);
            return socket.emit('errorMsg', 'Room is full.');
        }

        // 4. Check for bans
        const ip = getRealIpAddress(socket.request);
        const isUsernameBanned = await operations.ban.isValueBanned(socket.username);
        const isIpBanned = await operations.ban.isValueBanned(ip);
        
        if (isUsernameBanned || isIpBanned) {
            //  console.log(`Banned user ${socket.username} or IP ${ip} denied joining room ${roomId}`);
             socket.emit('errorMsg', 'You are banned.');
             return socket.disconnect(true);
        }

        // --- Leave previous room if necessary ---
        if (socket.currentRoom && socket.currentRoom !== roomId && rooms[socket.currentRoom]) {
            const prevRoomId = socket.currentRoom;
            const prevRoom = rooms[prevRoomId];
            if (prevRoom.users.has(socket.id)) {
                const leavingUsername = prevRoom.users.get(socket.id).username;
                const wasAdmin = prevRoom.users.get(socket.id).isAdmin;
                prevRoom.users.delete(socket.id);
                socket.leave(prevRoomId); // Leave the Socket.IO room
                // console.log(`${leavingUsername} left room ${prevRoom.name} (${prevRoomId}) to join another.`);

                // Log and notify previous room
                const leaveLog = { type: 'leave', username: leavingUsername, isAdmin: wasAdmin, timestamp: Date.now() };
                addLog(prevRoomId, leaveLog);
                io.to(prevRoomId).emit('userLeft', leaveLog);
                io.to(prevRoomId).emit('updateUserList', Array.from(prevRoom.users.values()).map(u => u.username));

                // Check if previous room became empty
                if (prevRoom.users.size === 0) {
                    console.log(`Deleting empty room after user left: ${prevRoom.name} (${prevRoomId})`);
                    
                    // Delete from MongoDB
                    operations.room.delete(prevRoomId).catch(error => {
                        console.error('Error deleting empty room from database:', error);
                    });
                    
                    // Delete from memory
                    delete rooms[prevRoomId];
                    
                    // Notify admin panel about room deletion
                    if (io.sockets.adapter.rooms.has('admin_room')) {
                        getAdminData().then(adminData => {
                            io.to('admin_room').emit('adminUpdate', adminData);
                        }).catch(error => {
                            console.error('Error getting admin data for room deletion:', error);
                        });
                    }
                    
                    // Notify main lobby about room deletion
                    if (io.sockets.adapter.rooms.has('main_lobby')) {
                        io.to('main_lobby').emit('roomDeleted', prevRoomId);
                        getRoomInfoList().then(roomList => {
                            io.to('main_lobby').emit('roomListUpdate', {
                                rooms: roomList,
                                connectedUsers: io.sockets.sockets.size
                            });
                        }).catch(error => {
                            console.error('Error getting room list for room deletion:', error);
                        });
                    }
                }
            }
        }
         // Also leave the main lobby if joining a specific room
         if (socket.rooms.has('main_lobby')) {
             socket.leave('main_lobby');
            //  console.log(`User ${socket.username} left main lobby to join room ${roomId}`);
         }

        // --- Join the new room ---
        socket.join(roomId);
        socket.currentRoom = roomId;
        room.users.set(socket.id, { username: socket.username, isAdmin: socket.isAdmin }); // Add user to room map
        userSockets.set(socket.username, socket.id); // Update lookup map (might overwrite if user has multiple tabs)

        // console.log(`${socket.username} ${socket.isAdmin ? '(Admin)' : ''} successfully joined room: ${room.name} (${roomId})`);

        // Send recent chat history (logs) to the joining user
        socket.emit('loadLogs', room.logs);

        // Notify everyone in the room about the new user
        const joinMsg = { type: 'join', username: socket.username, isAdmin: socket.isAdmin, timestamp: Date.now() };
        addLog(roomId, joinMsg);
        io.to(roomId).emit('userJoined', joinMsg); // Send specific join message
        io.to(roomId).emit('updateUserList', Array.from(room.users.values()).map(u => u.username)); // Send updated user list

        // Notify admin panel about user joining the room
         if (io.sockets.adapter.rooms.has('admin_room')) {
            io.to('admin_room').emit('adminUpdate', getAdminData());
         }

        // This sends room info to the joining user
        socket.emit('roomInfo', {
             name: room.name,
             maxUsers: room.maxUsers,
             currentUsers: room.users.size,
             isHidden: room.isHidden,
             createdBy: room.createdBy
        });

        // Send current room list
        getRoomInfoList().then(roomList => {
            io.emit('roomListUpdate', {
                rooms: roomList,
                connectedUsers: io.sockets.sockets.size // Total connected users
            });
        }).catch(error => {
            console.error('Error getting room list for join room broadcast:', error);
        });
    });

    // --- Handle Incoming Messages ---
    socket.on('sendMessage', ({ message }) => {
        if (!socket.username || !socket.currentRoom || !message || typeof message !== 'string') return;

        const room = rooms[socket.currentRoom];
        const trimmedMessage = message.trim(); // Trim whitespace
        if (room && trimmedMessage.length > 0 && trimmedMessage.length <= 500) { // Check length
            // Create log entry including admin status
            const logEntry = {
                type: 'message',
                username: socket.username,
                isAdmin: socket.isAdmin,
                message: trimmedMessage, // Use trimmed message
                timestamp: Date.now()
            };
            addLog(socket.currentRoom, logEntry);
            io.to(socket.currentRoom).emit('newMessage', logEntry); // Broadcast message to the room
        } else if (trimmedMessage.length > 500) {
            socket.emit('errorMsg', 'Message is too long (max 500 characters).');
        }
    });

    // Handle typing indicators
    socket.on('userTyping', () => {
        if (!socket.username || !socket.currentRoom) return;
        
        // Broadcast to all other users in the room that this user is typing
        socket.to(socket.currentRoom).emit('userTyping', {
            username: socket.username
        });
    });

    socket.on('userStoppedTyping', () => {
        if (!socket.username || !socket.currentRoom) return;
        
        // Broadcast to all other users in the room that this user stopped typing
        socket.to(socket.currentRoom).emit('userStoppedTyping', {
            username: socket.username
        });
    });

    // --- Handle Room Settings Update ---
    socket.on('updateRoomSettings', async ({ roomId, roomName, maxUsers }) => {
        // console.log(`[Server] Received room settings update for ${roomId}`);

        // Safety checks
        if (!socket.username || !socket.currentRoom) {
            return socket.emit('roomSettingsUpdated', {
                success: false,
                message: 'You must be in a room to update settings'
            });
        }

        // Check if this is the user's current room
        if (socket.currentRoom !== roomId) {
            return socket.emit('roomSettingsUpdated', {
                success: false,
                message: 'You can only update settings for your current room'
            });
        }

        const room = rooms[roomId];
        if (!room) {
            return socket.emit('roomSettingsUpdated', {
                success: false,
                message: 'Room not found'
            });
        }

        // Check if user is admin or room creator
        const isCreator = room.createdBy === socket.username;
        if (!socket.isAdmin && !isCreator) {
            return socket.emit('roomSettingsUpdated', {
                success: false,
                message: 'You do not have permission to change room settings'
            });
        }

        // Validate input
        if (!roomName || roomName.length < 3 || roomName.length > 30) {
            return socket.emit('roomSettingsUpdated', {
                success: false,
                message: 'Room name must be between 3 and 30 characters'
            });
        }

        const max = parseInt(maxUsers, 10);
        if (isNaN(max) || max < 1 || max > 100) {
            return socket.emit('roomSettingsUpdated', {
                success: false,
                message: 'Maximum users must be between 1 and 100'
            });
        }

        // Check if new max users is less than current user count
        if (max < room.users.size) {
            return socket.emit('roomSettingsUpdated', {
                success: false,
                message: `Cannot set max users to ${max} when room has ${room.users.size} users`
            });
        }

        // All checks passed, update the room
        const oldName = room.name;
        
        try {
            // Update room in MongoDB
            await operations.room.update(roomId, {
                name: roomName,
                maxUsers: max
            });
            
            // Update in-memory room
            room.name = roomName;
            room.maxUsers = max;

            console.log(`Room ${roomId} updated: Name changed from "${oldName}" to "${roomName}", Max users set to ${max}`);

            // Add a system log entry
            await addLog(roomId, {
                type: 'system',
                message: `Room settings updated by ${socket.username}${socket.isAdmin ? ' (Admin)' : ''}. Name: "${oldName}" → "${roomName}", Max users: ${max}`
            });
        } catch (error) {
            console.error('Error updating room settings:', error);
            return socket.emit('roomSettingsUpdated', {
                success: false,
                message: 'Failed to update room settings'
            });
        }

        // Notify all users in the room
        io.to(roomId).emit('roomSettingsUpdated', {
            success: true,
            roomName: roomName,
            maxUsers: max
        });

        // Send system message to chat
        io.to(roomId).emit('newMessage', {
            type: 'system',
            username: 'System',
            message: `Room settings updated by ${socket.username}${socket.isAdmin ? ' (Admin)' : ''}`,
            timestamp: Date.now()
        });

        // Notify admin panel if needed
        if (io.sockets.adapter.rooms.has('admin_room')) {
            io.to('admin_room').emit('adminUpdate', getAdminData());
        }

        // Notify users in the main lobby about the updated room
        // First, find if there's an active lobby room
        if (io.sockets.adapter.rooms.has('main_lobby')) {
             // Create a simplified room object for the lobby
             const lobbyRoomInfo = {
                 id: roomId,
                 name: roomName,
                 userCount: room.users.size,
                 maxUsers: max,
                 hasPassword: !!room.password
             };

             // Send update to all users in the main lobby
             io.to('main_lobby').emit('roomSettingsChanged', lobbyRoomInfo);
            //  console.log(`[Server] Notified main lobby of room changes for ${roomId}`);
        }
    });

    // --- Admin Socket Actions ---
    socket.on('adminJoin', async () => { // For when admin panel page loads/connects
         if (socket.isAdmin) {
             socket.join('admin_room'); // Join a dedicated room for admin updates
             try {
                 const adminData = await getAdminData();
                 socket.emit('adminUpdate', adminData); // Send initial data
             } catch (error) {
                 console.error('Error getting admin data for admin join:', error);
                 socket.emit('adminUpdate', { users: [], rooms: [], bans: [] });
             }
         }
    });

    socket.on('adminKickUser', ({ socketIdToKick }) => {
        if (!socket.isAdmin) return socket.emit('errorMsg', 'Permission denied.');
        const targetSocket = io.sockets.sockets.get(socketIdToKick);
        if (targetSocket && !targetSocket.isAdmin) { // Prevent kicking self or other admins
            // console.log(`Admin ${socket.username} kicking user ${targetSocket.username} (${socketIdToKick})`);
            targetSocket.emit('kicked', 'You have been kicked by an admin.');
            targetSocket.disconnect(true); // Force disconnect
             // Update admin panel shortly after disconnect
             setTimeout(async () => {
                  if (io.sockets.adapter.rooms.has('admin_room')) {
                     try {
                         const adminData = await getAdminData();
                         io.to('admin_room').emit('adminUpdate', adminData);
                     } catch (error) {
                         console.error('Error getting admin data for kick update:', error);
                     }
                  }
             }, 500);
        } else {
            //  console.warn(`Admin ${socket.username} failed kick: Target ${socketIdToKick} not found or is admin.`);
             socket.emit('errorMsg', 'Cannot kick user (not found or is admin).');
        }
    });

    socket.on('adminBanUser', async ({ socketIdToBan, banUsername, banIp }) => {
        if (!socket.isAdmin) return socket.emit('errorMsg', 'Permission denied.');
        const targetSocket = io.sockets.sockets.get(socketIdToBan);

        if (targetSocket && !targetSocket.isAdmin) { // Prevent banning self or other admins
            const ip = getRealIpAddress(targetSocket.request);
            const username = targetSocket.username;
            let changed = false;
            let bannedValue = '';

            try {
                if (banUsername && username && !(await operations.ban.isValueBanned(username))) {
                    await operations.ban.create({
                        value: username,
                        type: 'username',
                        bannedBy: socket.username,
                        reason: 'Admin ban'
                    });
                    console.log(`Admin ${socket.username} banning username: ${username}`);
                    bannedValue = username;
                    changed = true;
                }
                if (banIp && ip && !(await operations.ban.isValueBanned(ip))) {
                    await operations.ban.create({
                        value: ip,
                        type: 'ip',
                        bannedBy: socket.username,
                        reason: 'Admin ban'
                    });
                    console.log(`Admin ${socket.username} banning IP: ${ip}`);
                    bannedValue = ip; // IP takes precedence for message if both banned
                    changed = true;
                }

                if (changed) {
                   targetSocket.emit('banned', `You have been banned (${bannedValue}).`);
                   targetSocket.disconnect(true);
                    // Update admin panel shortly after disconnect
                     setTimeout(async () => {
                        if (io.sockets.adapter.rooms.has('admin_room')) {
                            const adminData = await getAdminData();
                            io.to('admin_room').emit('adminUpdate', adminData);
                        }
                     }, 500);
                } else {
                    console.log(`Admin ${socket.username} ban attempt resulted in no change for ${username}`);
                    socket.emit('errorMsg', 'User/IP already banned or no option selected.');
                }
            } catch (error) {
                console.error('Error banning user:', error);
                socket.emit('errorMsg', 'Error banning user.');
            }
        } else {
             console.warn(`Admin ${socket.username} failed ban: Target ${socketIdToBan} not found or is admin.`);
             socket.emit('errorMsg', 'Cannot ban user (not found or is admin).');
        }
    });

    socket.on('adminDeleteRoom', async ({ roomIdToDelete }) => {
        if (!socket.isAdmin) return socket.emit('errorMsg', 'Permission denied.');
        
        try {
            const roomToDelete = await operations.room.findById(roomIdToDelete);

            if (roomToDelete) {
                const roomName = roomToDelete.name;
                console.log(`Admin ${socket.username} deleting room '${roomName}' (${roomIdToDelete})`);

                // Use io.to().emit() to notify users *before* disconnecting them
                 io.to(roomIdToDelete).emit('roomDeleted', 'This room has been deleted by an admin.');

                // Disconnect sockets associated with that room using io.in().disconnect()
                io.in(roomIdToDelete).disconnectSockets(true); // true = close connection immediately

                // Delete the room from MongoDB and in-memory structure
                await operations.room.delete(roomIdToDelete);
                delete rooms[roomIdToDelete];
                console.log(`Room deleted from database and memory: ${roomIdToDelete}`);

                // Notify main lobby about room deletion
                if (io.sockets.adapter.rooms.has('main_lobby')) {
                    io.to('main_lobby').emit('roomDeleted', roomIdToDelete); // Send ID of deleted room
                    console.log(`Notified main lobby of room deletion: ${roomIdToDelete}`);
                }

                // Update admin panel
                if (io.sockets.adapter.rooms.has('admin_room')) {
                    console.log(' > Emitting adminUpdate after room deletion');
                    const adminData = await getAdminData();
                    io.to('admin_room').emit('adminUpdate', adminData);
                }

            } else {
                console.log(`Admin ${socket.username} tried to delete non-existent room: ${roomIdToDelete}`);
                socket.emit('errorMsg', 'Room not found, cannot delete.');
            }
        } catch (error) {
            console.error('Error deleting room:', error);
            socket.emit('errorMsg', 'Error deleting room.');
        }
    });

    socket.on('adminToggleHideRoom', async ({ roomIdToToggle }) => {
        if (!socket.isAdmin) return socket.emit('errorMsg', 'Permission denied.');
        
        try {
            const roomToToggle = await operations.room.findById(roomIdToToggle);
            if (roomToToggle) {
                const newHiddenStatus = !roomToToggle.isHidden;
                
                // Update room in MongoDB
                await operations.room.update(roomIdToToggle, { isHidden: newHiddenStatus });
                
                // Update in-memory room if it exists
                if (rooms[roomIdToToggle]) {
                    rooms[roomIdToToggle].isHidden = newHiddenStatus;
                }
                
                const status = newHiddenStatus ? 'hidden' : 'visible';
                console.log(`Admin ${socket.username} toggled room ${roomIdToToggle} to ${status}`);
        
                // Notify main lobby with a FULL room list update
                if (io.sockets.adapter.rooms.has('main_lobby')) {
                    // Send a complete room list update instead of individual events
                    const connectedUsers = io.sockets.sockets.size;
                    const roomList = await getRoomInfoList();
                    io.to('main_lobby').emit('roomListUpdate', {
                        rooms: roomList,  // This already filters out hidden rooms
                        connectedUsers: connectedUsers
                    });
                }
        
                // Update admin panel
                if (io.sockets.adapter.rooms.has('admin_room')) {
                    const adminData = await getAdminData();
                    io.to('admin_room').emit('adminUpdate', adminData);
                }
            } else {
                socket.emit('errorMsg', 'Room not found, cannot toggle hidden status.');
            }
        } catch (error) {
            console.error('Error toggling room visibility:', error);
            socket.emit('errorMsg', 'Error toggling room visibility.');
        }
    });

    // --- Handle Disconnection ---
    socket.on('disconnect', (reason) => {
        // console.log(`Socket disconnected: ${socket.id}, User: ${socket.username}, Reason: ${reason}`);

        // Remove from username lookup
        // Simple removal - doesn't handle multiple tabs well if one remains
        if (userSockets.get(socket.username) === socket.id) {
             userSockets.delete(socket.username);
        }

        // If the user was in a room, handle their departure
        if (socket.currentRoom && rooms[socket.currentRoom]) {
            const room = rooms[socket.currentRoom];
            const roomId = socket.currentRoom;

            if (room.users.has(socket.id)) {
                const userInfo = room.users.get(socket.id); // Get info before deleting
                room.users.delete(socket.id); // Remove user from room map

                // console.log(`${userInfo.username} left room: ${room.name} due to disconnect.`);

                // Log and notify room
                const leaveMsg = { type: 'leave', username: userInfo.username, isAdmin: userInfo.isAdmin, timestamp: Date.now() };
                addLog(roomId, leaveMsg);
                io.to(roomId).emit('userLeft', leaveMsg);
                io.to(roomId).emit('updateUserList', Array.from(room.users.values()).map(u => u.username));

                // Check if room is now empty and delete if necessary
                if (room.users.size === 0) {
                    console.log(`Deleting empty room after last user disconnected: ${room.name} (${roomId})`);
                    
                    // Delete from MongoDB
                    operations.room.delete(roomId).catch(error => {
                        console.error('Error deleting empty room from database:', error);
                    });
                    
                    // Delete from memory
                    delete rooms[roomId];

                    // Notify main lobby about room deletion
                    if (io.sockets.adapter.rooms.has('main_lobby')) {
                        io.to('main_lobby').emit('roomDeleted', roomId); // Send ID of deleted room
                        console.log(`Notified main lobby of room deletion: ${roomId}`);
                        
                        // Update room list
                        getRoomInfoList().then(roomList => {
                            io.to('main_lobby').emit('roomListUpdate', {
                                rooms: roomList,
                                connectedUsers: io.sockets.sockets.size
                            });
                        }).catch(error => {
                            console.error('Error getting room list for room deletion:', error);
                        });
                    }
                    
                    // Notify admin panel about room deletion
                    if (io.sockets.adapter.rooms.has('admin_room')) {
                        getAdminData().then(adminData => {
                            io.to('admin_room').emit('adminUpdate', adminData);
                        }).catch(error => {
                            console.error('Error getting admin data for room deletion:', error);
                        });
                    }

                } else {
                     // If room not deleted, update user count in main lobby
                     if (io.sockets.adapter.rooms.has('main_lobby')) {
                          io.to('main_lobby').emit('roomUserCountUpdate', { roomId: roomId, userCount: room.users.size });
                     }
                }
            }
        }

        // Notify admin panel about the disconnection
        if (io.sockets.adapter.rooms.has('admin_room')) {
           // Use a small delay to ensure disconnect processing completes before update
           setTimeout(async () => {
                try {
                    const adminData = await getAdminData();
                    io.to('admin_room').emit('adminUpdate', adminData);
                } catch (error) {
                    console.error('Error getting admin data for disconnect update:', error);
                }
           }, 100);
        }

         // Update total user count for main lobby (if anyone is there)
        if (io.sockets.adapter.rooms.has('main_lobby')) {
            const connectedUsers = io.sockets.sockets.size;
            io.to('main_lobby').emit('userCountUpdate', connectedUsers);
            
            // Also send roomListUpdate for consistency
            getRoomInfoList().then(roomList => {
                io.to('main_lobby').emit('roomListUpdate', {
                    rooms: roomList,
                    connectedUsers: connectedUsers
                });
            }).catch(error => {
                console.error('Error getting room list for disconnect broadcast:', error);
            });
        }
    });
});

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;
// Crucial: Listen on the http server, not the Express app directly
server.listen(PORT, () => {
    console.log(`🚀 Server listening on port ${PORT}`);
    if (!process.env.SESSION_SECRET) {
        console.warn("⚠️ WARNING: SESSION_SECRET is not set in .env! Session security is compromised.");
    }
     if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
        console.warn("⚠️ WARNING: ADMIN_USER or ADMIN_PASSWORD not set in .env! Using potentially insecure defaults.");
    }
});
