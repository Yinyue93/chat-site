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

// ================== PERSISTENCE SETUP ==================
const dbFilePath = '/data/db.json'; // Glitch persistent storage

function readDb() {
    try {
        if (fs.existsSync(dbFilePath)) {
            const data = fs.readFileSync(dbFilePath);
            console.log("Read DB data successfully.");
            return JSON.parse(data);
        }
        console.log("DB file not found, returning default.");
    } catch (err) {
        console.error("Error reading DB file:", err);
    }
    // Default structure if file doesn't exist or is invalid
    return { bans: [] }; // Store banned IPs/Usernames
}

function writeDb(data) {
    try {
        fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2)); // Pretty print JSON
        console.log("Wrote DB data successfully.");
    } catch (err) {
        console.error("Error writing DB file:", err);
    }
}

let dbData = readDb(); // Load bans on startup

// ================== APP/SERVER/SOCKET.IO SETUP ==================
const app = express();
const server = http.createServer(app); // Crucial: Create server from Express app
const io = new Server(server);       // Crucial: Attach Socket.IO to the HTTP server

// ================== MIDDLEWARE ==================
app.set('view engine', 'ejs'); // Set EJS as the template engine
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
function getRoomInfoList() {
    return Object.entries(rooms)
        .filter(([roomId, room]) => !room.isHidden) // Don't list hidden rooms
        .map(([roomId, room]) => ({
            id: roomId,
            name: room.name,
            userCount: room.users.size,
            maxUsers: room.maxUsers,
            hasPassword: !!room.password // Boolean flag if password exists
        }));
}

function getAdminData() {
    const allUsers = [];
    // Iterate over connected sockets
    io.sockets.sockets.forEach(socket => {
        // Only include users who have successfully joined (have username/session)
        if (socket.username) {
             const ipRaw = socket.request.connection.remoteAddress || socket.handshake.address || 'N/A';
             // Clean up IPv6 localhost representation
             const ip = (ipRaw === '::1' || ipRaw === '::ffff:127.0.0.1') ? '127.0.0.1' : ipRaw;
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
    return { users: allUsers, rooms: allRooms, bans: dbData.bans };
}

function addLog(roomId, logEntry) {
    if (rooms[roomId]) {
        if (!logEntry.timestamp) logEntry.timestamp = Date.now(); // Ensure timestamp
        rooms[roomId].logs.push(logEntry);
        // Optional: Limit log size to prevent memory issues
        if (rooms[roomId].logs.length > 150) { // Keep last 150 entries
            rooms[roomId].logs.shift();
        }
    } else {
        // console.warn(`Attempted to add log to non-existent room: ${roomId}`);
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

app.post('/login', (req, res) => {
    const username = req.body.username?.trim();
    const ip = req.ip; // Get user's IP address

    if (!username || username.length < 3 || username.length > 20) { // Add max length
        return res.render('login', { error: 'Username must be 3-20 characters.' });
    }
    // Basic check for banned username/IP
    if (dbData.bans.includes(username) || dbData.bans.includes(ip)) {
        //  console.log(`Banned login attempt: User '${username}', IP '${ip}'`);
         return res.render('login', { error: 'You are banned from this service.' });
    }
     // Crude check for existing username (prone to race conditions, better handled by socket join)
    // if (userSockets.has(username)) {
    //     return res.render('login', { error: 'Username appears to be taken. Try another.' });
    // }

    // Store user info in session
    req.session.username = username;
    req.session.isAdmin = false; // Regular users are not admins
    req.session.save(err => { // Ensure session is saved before redirecting
         if (err) {
            //   console.error("Session save error during login:", err);
              return res.render('login', { error: 'Login failed, please try again.' });
         }
        //  console.log(`User logged in: ${username}`);
        // Get the current number of connected users
        const connectedUsers = io.sockets.sockets.size;

        // Emit the updated room list and connected users count
        // io.on("connection", (socket) => {
        //     socket.broadcast.emit('roomListUpdate', {
        //         rooms: getRoomInfoList(),
        //         connectedUsers: connectedUsers
        //     });
        // })
        
        res.redirect('/main');
    });
});

app.post('/logout', (req, res) => {
    const username = req.session.username;

    req.session.destroy(err => {
        if (err) {
            console.error("Error destroying session:", err);
        }
        // Clear the cookie explicitly associated with express-session
        res.clearCookie('connect.sid'); // Default cookie name, adjust if changed in config
        // console.log(`User logged out: ${username || '(unknown)'}`);

        res.redirect('/'); // Redirect to login page
    });
});

// --- Main Room List ---
app.get('/main', requireLogin, (req, res) => {
    // Pass necessary data to the main page template
    res.render('main', {
        username: req.session.username,
        rooms: getRoomInfoList(),
        isAdmin: req.session.isAdmin || false // Pass admin status
    });
});

// --- Room Creation ---
app.post('/create-room', requireLogin, (req, res) => {
    console.log("creating room111111111111111111")
    const { roomName, maxUsers, password } = req.body;
    const creator = req.session.username;

    if (!roomName || roomName.length < 3 || roomName.length > 30) {
        // TODO: Add flash error message back to /main
        // console.log(`Room creation failed: Invalid name '${roomName}' by ${creator}`);
        return res.redirect('/main');
    }
    const max = parseInt(maxUsers, 10);
    if (isNaN(max) || max < 1 || max > 100) { // Set reasonable limits
         // TODO: Add flash error message back to /main
        // console.log(`Room creation failed: Invalid max users '${maxUsers}' by ${creator}`);
        return res.redirect('/main');
    }

    const roomId = uuidv4(); // Generate unique ID
    rooms[roomId] = {
        name: roomName,
        maxUsers: max,
        password: password || null, // Store password (Hashing recommended!)
        users: new Map(), // Map<socketId, {username, isAdmin}>
        logs: [],
        isHidden: false,
        createdBy: creator, // Track who created it
        createdAt: Date.now()
    };
    // console.log(`Room created: '${roomName}' (${roomId}) by ${creator}`);    
    // ADD THIS CODE: Grant access to the creator if a password was set
    if (password) {
        req.session[`room_${roomId}_access`] = true; // Grant access for this session
        // console.log(`Granted automatic access to room creator ${creator} for room ${roomId}`);
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
});

// --- Room Access ---
app.get('/room/:roomId', requireLogin, (req, res) => {
    const roomId = req.params.roomId;
    const room = rooms[roomId];
    const session = req.session;

    if (!room) {
        // console.log(`User ${session.username} tried to access non-existent room: ${roomId}`);
        // TODO: Add flash message 'Room not found'
        return res.redirect('/main');
    }

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
});

app.post('/room/:roomId/password', requireLogin, (req, res) => {
     const roomId = req.params.roomId;
     const room = rooms[roomId];
     const { password } = req.body;
     const session = req.session;

     if (!room) return res.redirect('/main'); // Room disappeared?

     // Check password
     if (room.password && room.password === password) {
         session[`room_${roomId}_access`] = true; // Grant access for this session
         session.save(err => { // Save session before redirect
             if (err) console.error("Session save error on password grant:", err);
            //  console.log(`User ${session.username} granted access to room ${roomId}`);
             res.redirect(`/room/${roomId}`);
         });
     } else {
        //  console.log(`User ${session.username} failed password attempt for room ${roomId}`);
         res.render('password_prompt', { roomId: roomId, roomName: room.name, error: 'Incorrect password' });
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
const ADMIN_USERNAME = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password'; // Use environment variables!

app.get('/admin-login', (req, res) => {
    if (req.session.isAdmin) return res.redirect('/admin'); // Redirect if already logged in as admin
    res.render('admin_login', { error: null });
});

app.post('/admin-login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        // Regenerate session ID upon login for security
        req.session.regenerate(err => {
            if (err) {
                //  console.error("Session regeneration error on admin login:", err);
                 return res.render('admin_login', { error: 'Admin login failed, please try again.' });
            }
            // Set admin-specific session data
            req.session.username = username;
            req.session.isAdmin = true;
            // console.log("Admin logged in:", username);
            res.redirect('/admin');
        });
    } else {
        // console.log(`Failed admin login attempt: User '${username}'`);
        res.render('admin_login', { error: 'Invalid admin credentials' });
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
app.get('/admin', requireAdmin, (req, res) => {
    res.render('admin_panel', getAdminData()); // Pass current user/room/ban data
});

// Admin Action: Download Room Log
app.get('/admin/download-log/:roomId', requireAdmin, (req, res) => {
    const roomId = req.params.roomId;
    const room = rooms[roomId];
    if (room) {
        res.setHeader('Content-Disposition', `attachment; filename="log_${room.name.replace(/[^a-z0-9]/gi, '_')}_${roomId}.json"`);
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(room.logs, null, 2)); // Pretty-print JSON log
    } else {
        res.status(404).send('Room not found');
    }
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

    // --- Handle Main Lobby Join ---
    socket.on('joinMainLobby', () => {
         // Make sure we're tracking 'main_lobby' joins
         socket.join('main_lobby');
         console.log(`User ${socket.username} joined main lobby`);

         // Send current room list
         socket.emit('roomListUpdate', {
             rooms: getRoomInfoList(),
             connectedUsers: io.sockets.sockets.size // Total connected users
         });
    });

    // --- Handle Room Joining ---
    socket.on('joinRoom', ({ roomId }) => {
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
        const ip = socket.request.connection.remoteAddress || socket.handshake.address;
        if (dbData.bans.includes(socket.username) || dbData.bans.includes(ip)) {
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
                    // console.log(`Deleting empty room after user left: ${prevRoom.name} (${prevRoomId})`);
                    delete rooms[prevRoomId];
                    // Notify admin panel about room deletion
                    if (io.sockets.adapter.rooms.has('admin_room')) {
                        io.to('admin_room').emit('adminUpdate', getAdminData());
                    }
                     // TODO: Optionally broadcast room list update to main lobby?
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
        io.emit('roomListUpdate', {
            rooms: getRoomInfoList(),
            connectedUsers: io.sockets.sockets.size // Total connected users
        });

        console.log(getRoomInfoList());
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

    // --- Handle Room Settings Update ---
    socket.on('updateRoomSettings', ({ roomId, roomName, maxUsers }) => {
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
        room.name = roomName;
        room.maxUsers = max;

        // console.log(`Room ${roomId} updated: Name changed from "${oldName}" to "${roomName}", Max users set to ${max}`);

        // Add a system log entry
        addLog(roomId, {
            type: 'system',
            message: `Room settings updated by ${socket.username}${socket.isAdmin ? ' (Admin)' : ''}. Name: "${oldName}" → "${roomName}", Max users: ${max}`
        });

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
    socket.on('adminJoin', () => { // For when admin panel page loads/connects
         if (socket.isAdmin) {
             socket.join('admin_room'); // Join a dedicated room for admin updates
             console.log(`Admin ${socket.username} joined the admin_room`);
             socket.emit('adminUpdate', getAdminData()); // Send initial data
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
             setTimeout(() => {
                  if (io.sockets.adapter.rooms.has('admin_room')) {
                     io.to('admin_room').emit('adminUpdate', getAdminData());
                  }
             }, 500);
        } else {
            //  console.warn(`Admin ${socket.username} failed kick: Target ${socketIdToKick} not found or is admin.`);
             socket.emit('errorMsg', 'Cannot kick user (not found or is admin).');
        }
    });

    socket.on('adminBanUser', ({ socketIdToBan, banUsername, banIp }) => {
        if (!socket.isAdmin) return socket.emit('errorMsg', 'Permission denied.');
        const targetSocket = io.sockets.sockets.get(socketIdToBan);

        if (targetSocket && !targetSocket.isAdmin) { // Prevent banning self or other admins
            const ip = targetSocket.request.connection.remoteAddress || targetSocket.handshake.address;
            const username = targetSocket.username;
            let changed = false;
            let bannedValue = '';

            if (banUsername && username && !dbData.bans.includes(username)) {
                dbData.bans.push(username);
                // console.log(`Admin ${socket.username} banning username: ${username}`);
                bannedValue = username;
                changed = true;
            }
            if (banIp && ip && !dbData.bans.includes(ip)) {
                dbData.bans.push(ip);
                //  console.log(`Admin ${socket.username} banning IP: ${ip}`);
                 bannedValue = ip; // IP takes precedence for message if both banned
                changed = true;
            }

            if (changed) {
               writeDb(dbData); // Persist bans
               targetSocket.emit('banned', `You have been banned (${bannedValue}).`);
               targetSocket.disconnect(true);
                // Update admin panel shortly after disconnect
                 setTimeout(() => {
                    if (io.sockets.adapter.rooms.has('admin_room')) {
                        io.to('admin_room').emit('adminUpdate', getAdminData());
                    }
                 }, 500);
            } else {
                // console.log(`Admin ${socket.username} ban attempt resulted in no change for ${username}`);
                socket.emit('errorMsg', 'User/IP already banned or no option selected.');
            }
        } else {
             console.warn(`Admin ${socket.username} failed ban: Target ${socketIdToBan} not found or is admin.`);
             socket.emit('errorMsg', 'Cannot ban user (not found or is admin).');
        }
    });

    socket.on('adminDeleteRoom', ({ roomIdToDelete }) => {
        if (!socket.isAdmin) return socket.emit('errorMsg', 'Permission denied.');
        const roomToDelete = rooms[roomIdToDelete];

        if (roomToDelete) {
            const roomName = roomToDelete.name;
            // console.log(`Admin ${socket.username} deleting room '${roomName}' (${roomIdToDelete})`);

            // Use io.to().emit() to notify users *before* disconnecting them
             io.to(roomIdToDelete).emit('roomDeleted', 'This room has been deleted by an admin.');

            // Disconnect sockets associated with that room using io.in().disconnect()
            io.in(roomIdToDelete).disconnectSockets(true); // true = close connection immediately

            // Delete the room from the main structure *after* signaling clients
            delete rooms[roomIdToDelete];
            // console.log(`Room object deleted for ${roomIdToDelete}`);

            // Notify main lobby about room deletion
            if (io.sockets.adapter.rooms.has('main_lobby')) {
                io.to('main_lobby').emit('roomDeleted', roomIdToDelete); // Send ID of deleted room
                // console.log(`Notified main lobby of room deletion: ${roomIdToDelete}`);
            }

            // Update admin panel
            if (io.sockets.adapter.rooms.has('admin_room')) {
                // console.log(' > Emitting adminUpdate after room deletion');
                io.to('admin_room').emit('adminUpdate', getAdminData());
            }

        } else {
            // console.log(`Admin ${socket.username} tried to delete non-existent room: ${roomIdToDelete}`);
            socket.emit('errorMsg', 'Room not found, cannot delete.');
        }
    });

    socket.on('adminToggleHideRoom', ({ roomIdToToggle }) => {
        if (!socket.isAdmin) return socket.emit('errorMsg', 'Permission denied.');
        const roomToToggle = rooms[roomIdToToggle];
        if (roomToToggle) {
            roomToToggle.isHidden = !roomToToggle.isHidden;
            const status = roomToToggle.isHidden ? 'hidden' : 'visible';
            // console.log(`Admin ${socket.username} toggled room ${roomToToggle.name} to ${status}`);

             // Notify main lobby about hide/show status change
            if (io.sockets.adapter.rooms.has('main_lobby')) {
                 if (roomToToggle.isHidden) {
                      io.to('main_lobby').emit('roomHidden', roomIdToToggle); // Send ID of hidden room
                 } else {
                      // If made visible, send the full room info
                      const lobbyRoomInfo = {
                           id: roomIdToToggle,
                           name: roomToToggle.name,
                           userCount: roomToToggle.users.size,
                           maxUsers: roomToToggle.maxUsers,
                           hasPassword: !!roomToToggle.password
                      };
                      io.to('main_lobby').emit('roomShown', lobbyRoomInfo);
                 }
                //  console.log(`Notified main lobby of room visibility change: ${roomIdToToggle}`);
            }

            // Update admin panel
            if (io.sockets.adapter.rooms.has('admin_room')) {
               io.to('admin_room').emit('adminUpdate', getAdminData());
            }
        } else {
             socket.emit('errorMsg', 'Room not found, cannot toggle hidden status.');
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
                    // console.log(`Deleting empty room after last user disconnected: ${room.name} (${roomId})`);
                    delete rooms[roomId];

                    // Notify main lobby about room deletion
                    if (io.sockets.adapter.rooms.has('main_lobby')) {
                        io.to('main_lobby').emit('roomDeleted', roomId); // Send ID of deleted room
                        // console.log(`Notified main lobby of room deletion: ${roomId}`);
                    }
                    // Notify admin panel about room deletion
                    if (io.sockets.adapter.rooms.has('admin_room')) {
                        io.to('admin_room').emit('adminUpdate', getAdminData());
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
           setTimeout(() => {
                io.to('admin_room').emit('adminUpdate', getAdminData());
           }, 100);
        }

         // Update total user count for main lobby (if anyone is there)
         if (io.sockets.adapter.rooms.has('main_lobby')) {
             io.to('main_lobby').emit('totalUserUpdate', io.sockets.sockets.size);
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