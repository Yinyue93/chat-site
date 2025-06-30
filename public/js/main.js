// public/js/main.js - Updates to improve user count handling

document.addEventListener('DOMContentLoaded', () => {
    // --- Check for Socket.IO library ---
    if (typeof io === 'undefined') {
        console.error("[MainJS] FATAL: Socket.IO client library (io) not loaded!");
        const roomList = document.getElementById('room-list');
        if (roomList) roomList.innerHTML = '<p style="color:red;">ERROR: Connection library missing.</p>';
        return;
    }

    // --- Get Elements ---
    const roomList = document.getElementById('room-list');
    const roomCount = document.getElementById('room-count');
    const userCount = document.getElementById('user-count');
    
    // --- Check Elements ---
    if (!roomList) {
        console.error("[MainJS] ERROR: Room list element is missing!");
        return;
    }

    // --- Attempt Connection ---
    let socket;
    try {
        socket = io();
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

    // --- Helper: Update Single Room ---
    function updateSingleRoom(updatedRoom) {
        if (!roomList) return;
        
        // Find the room in the list
        const roomElements = roomList.querySelectorAll('li');
        let roomFound = false;
        
        roomElements.forEach(li => {
            const roomLink = li.querySelector('a');
            const roomUrl = roomLink.getAttribute('href');
            const roomId = roomUrl.split('/').pop(); // Extract room ID from URL
            
            if (roomId === updatedRoom.id) {
                roomFound = true;
                
                // Update the room name
                roomLink.textContent = escapeHtml(updatedRoom.name);
                
                // Update user count details
                const detailsSpan = li.querySelector('.details');
                if (detailsSpan) {
                    detailsSpan.textContent = ` (${updatedRoom.userCount} / ${updatedRoom.maxUsers} users)`;
                }
            }
        });
        
        if (!roomFound) {
            // If room wasn't found, refresh the entire list
            socket.emit('joinMainLobby'); // Request a full room list refresh
        }
    }

    // --- Helper: Update User Count With Animation ---
    function updateUserCountWithAnimation(count) {
        if (!userCount) return;
        
        // Add a brief highlight animation
        userCount.style.transition = 'background-color 0.5s ease';
        userCount.style.backgroundColor = '#ffff99'; // Subtle yellow highlight
        
        // Update the text
        userCount.textContent = count;
        
        // Remove the highlight after a delay
        setTimeout(() => {
            userCount.style.backgroundColor = 'transparent';
        }, 1000);
    }

    // --- Socket Event Listeners ---
    socket.on('connect', () => {
        socket.emit('joinMainLobby');
    });

    socket.on('roomListUpdate', (data) => {
        updateRoomList(data.rooms);
        if (userCount && typeof data.connectedUsers === 'number') {
            updateUserCountWithAnimation(data.connectedUsers);
        }
    });

    // Enhanced userCountUpdate handler with animation
    socket.on('userCountUpdate', (count) => {
        updateUserCountWithAnimation(count);
    });

    // New event listener for single room updates
    socket.on('roomSettingsChanged', (updatedRoom) => {
        updateSingleRoom(updatedRoom);
    });

    socket.on('roomDeleted', (roomId) => {
        // Find and remove the room from the list or refresh the entire list
        const roomElements = roomList.querySelectorAll('li');
        let roomRemoved = false;
        
        roomElements.forEach(li => {
            const roomLink = li.querySelector('a');
            const roomUrl = roomLink.getAttribute('href');
            const liRoomId = roomUrl.split('/').pop(); // Extract room ID from URL
            
            if (liRoomId === roomId) {
                li.remove();
                roomRemoved = true;
                
                // Update the room count if element exists
                if (roomCount && roomCount.textContent) {
                    const currentCount = parseInt(roomCount.textContent) - 1;
                    roomCount.textContent = currentCount;

                    // If that was the last room, show the "no rooms" message
                    if (currentCount === 0) {
                        roomList.innerHTML = '<p class="no-rooms">No rooms available yet. Create one below!</p>';
                    }
                }
            }
        });
        
        if (!roomRemoved) {
            // If room wasn't found, refresh the entire list
            socket.emit('joinMainLobby'); // Request a full room list refresh
        }
    });

    socket.on('disconnect', (reason) => {
        console.warn(`[MainJS] Disconnected. Reason: ${reason}`);
        
        // Visually indicate disconnection to user
        if (userCount) {
            userCount.classList.add('loading-data');
            userCount.style.color = '#999';
            userCount.textContent = '...';
        }
    });

    socket.on('connect_error', (err) => {
        console.error(`[MainJS] Connection Error: ${err.message}`);
        
        // Visually indicate connection error to user
        if (userCount) {
            userCount.classList.add('loading-data');
            userCount.style.color = 'red';
            userCount.textContent = '!';
        }
    });
});
