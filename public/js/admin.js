// public/js/admin.js (Complete - Fixed Admin Functions)
document.addEventListener('DOMContentLoaded', () => {
    console.log("[AdminJS] DOM Ready."); // Log: Script start

    // --- Crucial Check: Make sure Socket.IO library loaded ---
    if (typeof io === 'undefined') {
        console.error("[AdminJS] Socket.IO library (io) is not loaded. Check script order in admin_panel.ejs.");
        // Display an error message to the user on the page
        const container = document.querySelector('.admin-container');
        if (container) {
            const errorDiv = document.createElement('div');
            errorDiv.textContent = "FATAL ERROR: Cannot connect to real-time server. Check console (F12) and refresh.";
            errorDiv.style.color = 'red'; errorDiv.style.fontWeight = 'bold'; errorDiv.style.padding = '20px'; errorDiv.style.border = '2px solid red';
            container.prepend(errorDiv);
        }
        return; // Stop execution
    }
    console.log("[AdminJS] Socket.IO library found."); // Log: IO loaded

    // --- Initialize Socket.IO Connection ---
    const socket = io();
    console.log("[AdminJS] Socket object created."); // Log: Socket init

    // --- DOM Element References ---
    const userCountSpan = document.getElementById('user-count');
    const roomCountSpan = document.getElementById('room-count');
    const banCountSpan = document.getElementById('ban-count');
    const usersTbody = document.getElementById('users-tbody');
    const roomsTbody = document.getElementById('rooms-tbody');
    const bansList = document.getElementById('bans-list');
    const userSearch = document.getElementById('user-search');
    const roomSearch = document.getElementById('room-search');

    // --- Check if Elements Were Found (Debugging) ---
    if (!usersTbody || !roomsTbody || !bansList || !userSearch || !roomSearch || !userCountSpan || !roomCountSpan || !banCountSpan) {
         console.error("[AdminJS] One or more required admin panel elements not found in the DOM. Check IDs in admin_panel.ejs.");
         return; // Stop if essential elements are missing
    }
    console.log("[AdminJS] All required DOM elements found."); // Log: Elements ok

    // ================================================
    // --- Helper Functions ---
    console.log("[AdminJS] Defining helper functions..."); // Log: Defining helpers

    function escapeHtml(unsafe) {
        if (typeof unsafe !== 'string') return unsafe; // Return non-strings as is
        // Correctly replace special characters with HTML entities
        // console.log("[RoomJS] Escaping HTML for:", unsafe); // Keep logs if helpful
        let escaped = unsafe
            .replace(/&/g, "&amp;")  // Replace & with &amp;
            .replace(/</g, "&lt;")   // Replace < with &lt;
            .replace(/>/g, "&gt;")   // Replace > with &gt;
            .replace(/"/g, "&quot;") // CORRECT: Replace " with &quot;
            .replace(/'/g, "&#039;"); // <<< CORRECT: Replace ' with &#039;
        // console.log("[RoomJS] Escaped result:", escaped); // Keep logs if helpful
        return escaped;
    }
    console.log("[AdminJS] escapeHtml function defined."); // Log: Function defined

    function renderUsers(users) {
        if (!usersTbody) return;
        usersTbody.innerHTML = '';
        if (!Array.isArray(users)) { console.error("renderUsers received non-array:", users); return; }
        users.forEach(user => {
            const row = usersTbody.insertRow();
            row.dataset.username = user.username.toLowerCase();
            row.dataset.ip = user.ipAddress;
            // Ensure escapeHtml is called for all potentially unsafe data
            row.innerHTML = `
                <td>${escapeHtml(user.username)}</td>
                <td>${escapeHtml(user.ipAddress)}</td>
                <td>
                    ${escapeHtml(user.country)}
                    ${user.country && user.country !== '?' ? `<img src="https://flagsapi.com/${user.country}/flat/24.png" alt="${escapeHtml(user.country)}" class="flag-icon" title="${escapeHtml(user.country)}">` : ''}
                </td>
                <td>${escapeHtml(user.roomName) || 'N/A'} (${escapeHtml(user.roomId) || 'N/A'})</td>
                <td>${escapeHtml(user.socketId)}</td>
                <td>${user.isAdmin ? 'Yes' : 'No'}</td>
                <td>
                    ${!user.isAdmin ? `
                        <button class="kick-btn" data-socket-id="${user.socketId}">Kick</button>
                        <button class="ban-btn" data-socket-id="${user.socketId}" data-username="${escapeHtml(user.username)}" data-ip="${user.ipAddress}">Ban (User/IP)</button>
                    ` : '(Admin)'}
                </td>
            `;
        });
        if (userCountSpan) userCountSpan.textContent = users.length;
    }

    function renderRooms(rooms) {
         if (!roomsTbody) return;
         roomsTbody.innerHTML = '';
         if (!Array.isArray(rooms)) { console.error("renderRooms received non-array:", rooms); return; }
        rooms.forEach(room => {
            const row = roomsTbody.insertRow();
            row.dataset.roomname = room.name.toLowerCase();
            if (room.isHidden) { row.classList.add('hidden-row'); }
             // Ensure escapeHtml is called for all potentially unsafe data
            row.innerHTML = `
                <td>${escapeHtml(room.name)}</td>
                <td>${escapeHtml(room.id)}</td>
                <td>${room.userCount}</td>
                <td>${room.maxUsers}</td>
                <td>${room.isHidden ? 'Yes' : 'No'}</td>
                <td>${escapeHtml(room.users.join(', '))}</td>
                <td>
                    ${room.isHidden ?
                        `<button class="unhide-btn" data-room-id="${room.id}">Unhide</button>` :
                        `<button class="hide-btn" data-room-id="${room.id}">Hide</button>`
                    }
                    <button class="delete-btn" data-room-id="${room.id}">Delete</button>
                    <a href="/admin/download-log/${room.id}" target="_blank" class="action-link download-link">Download Log</a>
                </td>
            `;
        });
        if (roomCountSpan) roomCountSpan.textContent = rooms.length;
    }

     function renderBans(bans) {
        if (!bansList) return;
        bansList.innerHTML = '';
         if (!Array.isArray(bans)) { console.error("renderBans received non-array:", bans); return; }
        bans.forEach(ban => {
            const li = document.createElement('li');
            li.textContent = escapeHtml(ban); // Escape the ban string
            bansList.appendChild(li);
        });
        if (banCountSpan) banCountSpan.textContent = bans.length;
    }

     function filterTable(tableBody, searchTerm) {
        if (!tableBody) return;
        const term = searchTerm.toLowerCase();
        Array.from(tableBody.rows).forEach(row => {
            const username = row.dataset.username || '';
            const ip = row.dataset.ip || '';
            const roomname = row.dataset.roomname || '';
            const isVisible = username.includes(term) || ip.includes(term) || roomname.includes(term);
            row.style.display = isVisible ? '' : 'none';
        });
    }
    console.log("[AdminJS] Helper functions defined."); // Log: Helpers done

    // ================================================
    // --- Socket Event Listeners ---
    console.log("[AdminJS] Attaching Socket listeners..."); // Log: Attaching listeners

    socket.on('connect', () => {
        console.log('[AdminJS] Socket connected successfully.');
        socket.emit('adminJoin');
    });

    socket.on('adminUpdate', (data) => {
        console.log('[AdminJS] Received adminUpdate event.');
        if (!data || typeof data !== 'object' || !Array.isArray(data.users) || !Array.isArray(data.rooms) || !Array.isArray(data.bans)) {
             console.error('[AdminJS] Received malformed adminUpdate data:', data);
             return;
        }
        // Call rendering functions
        renderUsers(data.users);
        renderRooms(data.rooms);
        renderBans(data.bans);
        // Re-apply filters
        if (usersTbody && userSearch) filterTable(usersTbody, userSearch.value);
        if (roomsTbody && roomSearch) filterTable(roomsTbody, roomSearch.value);
    });

    socket.on('disconnect', (reason) => {
        console.warn('[AdminJS] Socket disconnected:', reason);
    });

    socket.on('connect_error', (err) => {
         console.error('[AdminJS] Socket connection error:', err.message);
    });
    console.log("[AdminJS] Socket listeners attached."); // Log: Listeners done

    // ================================================
    // --- Event Handlers (using Event Delegation) ---
    console.log("[AdminJS] Attaching DOM listeners..."); // Log: Attaching DOM listeners

    // User Actions
    if (usersTbody) {
        usersTbody.addEventListener('click', (event) => {
            const target = event.target;
            const socketId = target.dataset.socketId;

            if (target.classList.contains('kick-btn') && socketId) {
                // Kick user implementation
                if (confirm(`Are you sure you want to kick this user?`)) {
                    console.log(`[AdminJS] Requesting to kick user with socket ID ${socketId}`);
                    socket.emit('adminKickUser', { socketIdToKick: socketId });
                }
            }
            else if (target.classList.contains('ban-btn') && socketId) {
                // Ban user implementation
                const username = target.dataset.username;
                const ip = target.dataset.ip;
                
                if (!username && !ip) {
                    console.error("[AdminJS] Ban button clicked but missing username/IP data attributes");
                    return;
                }
                
                // Show a dialog to choose ban options
                const banUsername = confirm(`Ban username "${username}"?\nClick OK for Yes, Cancel to skip username ban.`);
                const banIp = confirm(`Ban IP address "${ip}"?\nClick OK for Yes, Cancel to skip IP ban.`);
                
                if (banUsername || banIp) {
                    console.log(`[AdminJS] Requesting ban for: Username=${banUsername ? username : 'no'}, IP=${banIp ? ip : 'no'}`);
                    socket.emit('adminBanUser', { 
                        socketIdToBan: socketId,
                        banUsername: banUsername,
                        banIp: banIp
                    });
                } else {
                    console.log("[AdminJS] Ban operation canceled by admin");
                }
            }
        });
    } else { console.error("[AdminJS] Could not attach listener to usersTbody."); }

    // Room Actions
    if (roomsTbody) {
        roomsTbody.addEventListener('click', (event) => {
            const target = event.target;
            const roomId = target.dataset.roomId;
            
            if (target.classList.contains('delete-btn') && roomId) {
                // Delete Room implementation
                if (confirm(`Are you sure you want to delete this room? All users will be disconnected.`)) {
                    console.log(`[AdminJS] Requesting room deletion for ${roomId}`);
                    socket.emit('adminDeleteRoom', { roomIdToDelete: roomId });
                }
            }
            else if (target.classList.contains('hide-btn') && roomId) {
                // Hide Room implementation
                console.log(`[AdminJS] Requesting to hide room ${roomId}`);
                socket.emit('adminToggleHideRoom', { roomIdToToggle: roomId });
            }
            else if (target.classList.contains('unhide-btn') && roomId) {
                // Unhide Room implementation
                console.log(`[AdminJS] Requesting to unhide room ${roomId}`);
                socket.emit('adminToggleHideRoom', { roomIdToToggle: roomId });
            }
        });
    } else { console.error("[AdminJS] Could not attach listener to roomsTbody."); }


    // Search/Filter Listeners
    if (userSearch && usersTbody) {
        userSearch.addEventListener('input', () => filterTable(usersTbody, userSearch.value));
    } else { console.error("[AdminJS] Could not attach listener to userSearch."); }


    if (roomSearch && roomsTbody) {
        roomSearch.addEventListener('input', () => filterTable(roomsTbody, roomSearch.value));
    } else { console.error("[AdminJS] Could not attach listener to roomSearch."); }

    console.log("[AdminJS] DOM listeners attached."); // Log: DOM listeners done
    console.log("[AdminJS] Setup complete."); // Log: End of script

}); // End of DOMContentLoaded listener