// public/js/main.js
document.addEventListener('DOMContentLoaded', () => {
    console.log("[MainJS] DOM Ready.");

    // --- Check for Socket.IO library ---
    if (typeof io === 'undefined') {
        console.error("[MainJS] FATAL: Socket.IO client library (io) not loaded!");
        const roomList = document.getElementById('room-list');
        if (roomList) roomList.innerHTML = '<p style="color:red;">ERROR: Connection library missing.</p>';
        return;
    }
    console.log("[MainJS] Socket.IO library (io) found.");

    // --- Get Elements ---
    const roomList = document.getElementById('room-list');
    const roomCount = document.getElementById('room-count');
    const userCount = document.getElementById('user-count');
    
    // --- Check Elements ---
    if (!roomList) {
        console.error("[MainJS] ERROR: Room list element is missing!");
        return;
    }
    console.log("[MainJS] Required elements found.");

    // --- Attempt Connection ---
    let socket;
    try {
        socket = io();
        console.log("[MainJS] io() called.");
    } catch (error) {
        console.error("[MainJS] Error calling io():", error);
        return;
    }

    // --- Helper: Escape HTML ---
    function escapeHtml(unsafe) {
        if (typeof unsafe !== 'string') return unsafe;
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // --- Helper: Update Room List ---
    function updateRoomList(rooms) {
        if (!roomList) return;
        if (!Array.isArray(rooms)) {
            console.error("[MainJS] Invalid room list data:", rooms);
            return;
        }
        
        console.log("[MainJS] Updating room list with", rooms.length, "rooms");
        
        // Update the room count if element exists
        if (roomCount) roomCount.textContent = rooms.length;
        
        // Clear existing content
        roomList.innerHTML = '';
        
        if (rooms.length === 0) {
            roomList.innerHTML = '<p class="no-rooms">No rooms available yet. Create one below!</p>';
            return;
        }
        
        // Create the room list with the same HTML structure as in the template
        let ul = document.createElement('ul');
        
        // Add each room
        rooms.forEach(room => {
            let li = document.createElement('li');
            
            // Create the room info div
            let infoDiv = document.createElement('div');
            
            // Create room name link
            let roomLink = document.createElement('a');
            roomLink.href = `/room/${room.id}`;
            roomLink.textContent = escapeHtml(room.name);
            infoDiv.appendChild(roomLink);
            
            // Create details span
            let detailsSpan = document.createElement('span');
            detailsSpan.className = 'details';
            detailsSpan.textContent = ` (${room.userCount} / ${room.maxUsers} users)`;
            infoDiv.appendChild(detailsSpan);
            
            // Add password icon if needed
            if (room.hasPassword) {
                let passwordIcon = document.createElement('span');
                passwordIcon.className = 'password-icon';
                passwordIcon.title = 'Password protected';
                passwordIcon.textContent = '🔒';
                infoDiv.appendChild(passwordIcon);
            }
            
            // Add the info div to the list item
            li.appendChild(infoDiv);
            
            // Create join button
            let joinButton = document.createElement('a');
            joinButton.href = `/room/${room.id}`;
            joinButton.className = 'join-button';
            joinButton.textContent = 'Join';
            li.appendChild(joinButton);
            
            // Add the complete list item to the list
            ul.appendChild(li);
        });
        
        roomList.appendChild(ul);
    }

    // --- Socket Event Listeners ---
    socket.on('connect', () => {
        console.log(`[MainJS] Connected. Socket ID: ${socket.id}`);
        socket.emit('joinMainLobby');
    });

    socket.on('roomListUpdate', (data) => {
        console.log('[MainJS] Received roomListUpdate event');
        updateRoomList(data.rooms);
        if (userCount && typeof data.connectedUsers === 'number') {
            userCount.textContent = data.connectedUsers;
        }
    });

    socket.on('disconnect', (reason) => {
        console.warn(`[MainJS] Disconnected. Reason: ${reason}`);
    });

    socket.on('connect_error', (err) => {
        console.error(`[MainJS] Connection Error: ${err.message}`);
    });

    console.log("[MainJS] Setup complete.");
});