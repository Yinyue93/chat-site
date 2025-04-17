// public/js/room.js (With URL Detection, Notification Sounds, Sound Toggle, and Settings Modal)
document.addEventListener('DOMContentLoaded', () => {
    console.log("[RoomJS] DOM Ready.");


    // --- Notification Sound System Variables ---
    // Declare these at the top of the function scope to prevent lexical declaration errors
    let notificationSound;
    let notificationsEnabled = true; // Default to on

    var chatVolume = localStorage.getItem('chatVolume') || 50;

    // --- Check for Socket.IO library ---
    if (typeof io === 'undefined') {
        console.error("[RoomJS] FATAL: Socket.IO client library (io) not loaded!");
        // ... error handling ...
        const chatLog = document.getElementById('chat-log');
        if (chatLog) chatLog.innerHTML = '<p style="color:red;">ERROR: Connection library missing.</p>';
        return;
    }
    console.log("[RoomJS] Socket.IO library (io) found.");

    // --- Get Elements ---
    const chatLog = document.getElementById('chat-log');
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');
    const userList = document.getElementById('user-list');
    const soundToggle = document.getElementById('sound-toggle');

    const volumeSlider = document.getElementById('volume-slider');

    const body = document.body;

    volumeSlider.addEventListener('input', function() {
        chatVolume = this.value
        console.log(`[RoomJS] Volume set to: ${chatVolume}%`);
    });

    volumeSlider.addEventListener('change', function() {
        try {
            localStorage.setItem('chatVolume', this.value); // Save the slider value
        } catch (e) {
            console.warn("[RoomJS] Could not save volume preference to localStorage:", e);
        }
    });

    // --- Check Elements ---
    if (!chatLog || !messageInput || !sendButton || !userList || !body) {
        console.error("[RoomJS] ERROR: A required HTML element is missing!");
        // ... error handling ...
        return;
    }
    console.log("[RoomJS] Required elements found.");

    // --- Get Room/User Data ---
    const roomId = body?.dataset?.roomId;
    const username = body?.dataset?.username;
    if (!roomId || !username) {
        console.error("[RoomJS] ERROR: Missing roomId or username!");
        // ... error handling ...
        return;
    }
    console.log(`[RoomJS] Room: ${roomId}, User: ${username}`);

    // --- Initialize Notification Sound System ---
    // Check if sound file exists
    checkSoundFileExists();

    // Initialize sound with diagnostics
    initNotificationSound();
    initNotificationPreference();

    // Update the initial state of the sound toggle button
    if (soundToggle) {
        if (notificationsEnabled) {
            soundToggle.innerHTML = '<i class="fas fa-volume-up"></i>';
            soundToggle.title = "Turn notification sounds off";
        } else {
            soundToggle.innerHTML = '<i class="fas fa-volume-mute"></i>';
            soundToggle.title = "Turn notification sounds on";
        }

        // Add click event listener
        soundToggle.addEventListener('click', toggleNotifications);
    }

    // --- Settings Modal Elements ---
    const settingsButton = document.getElementById('settings-button');
    const settingsModal = document.getElementById('settings-modal');
    const closeModalBtn = document.querySelector('.close-modal');
    const settingsForm = document.getElementById('room-settings-form');
    const roomNameInput = document.getElementById('room-name-input');
    const maxUsersInput = document.getElementById('max-users-input');
    const cancelSettingsBtn = document.getElementById('cancel-settings-btn');

    // Check for settings elements
    if (!settingsButton || !settingsModal || !settingsForm || !roomNameInput || !maxUsersInput) {
        console.error("[RoomJS] One or more settings elements not found");
    } else {
        console.log("[RoomJS] Settings elements found, initializing settings functionality");
        
        // Initialize settings data
        let currentRoomName = body?.dataset?.roomName || '';
        let currentMaxUsers = 10; // Default value, will be updated when we get room info
        
        // Button click handler to open the modal
        settingsButton.addEventListener('click', openModal);
        
        // Close button handlers
        closeModalBtn.addEventListener('click', closeModal);
        cancelSettingsBtn.addEventListener('click', closeModal);
        
        // Close when clicking outside the modal
        window.addEventListener('click', (event) => {
            if (event.target === settingsModal) {
                closeModal();
            }
        });
        
        // Form submission
        settingsForm.addEventListener('submit', (event) => {
            event.preventDefault();
            
            const newRoomName = roomNameInput.value.trim();
            const newMaxUsers = parseInt(maxUsersInput.value, 10);
            
            // Basic validation
            if (newRoomName.length < 3 || newRoomName.length > 30) {
                alert('Room name must be between 3 and 30 characters');
                return;
            }
            
            if (isNaN(newMaxUsers) || newMaxUsers < 1 || newMaxUsers > 100) {
                alert('Maximum users must be between 1 and 100');
                return;
            }
            
            // Always send update regardless of change
            socket.emit('updateRoomSettings', {
                roomId: roomId,
                roomName: newRoomName,
                maxUsers: newMaxUsers
            });
            
            logMessage(`<div class="system-message">Updating room settings...</div>`);
        });
            } else {
                // No changes made
                closeModal();
            }
        });
        
        // Helper function to open modal
        function openModal() {
            // Fill form with current values
            roomNameInput.value = currentRoomName;
            maxUsersInput.value = currentMaxUsers;
            
            // Show modal
            settingsModal.style.display = 'block';
        }
        
        // Helper function to close modal
        function closeModal() {
            settingsModal.style.display = 'none';
        }

        console.log("[RoomJS] Settings event listeners attached");
    }


    // --- Attempt Connection ---
    let socket;
    try {
        socket = io();
        console.log("[RoomJS] io() called.");
    } catch (error) {
        console.error("[RoomJS] Error calling io():", error);
        // ... error handling ...
        return;
    }

    // --- Display Initial Status ---
    if (chatLog) {
        chatLog.innerHTML = `<div class="system-message">Connecting...</div>`;
    } else {
        console.error("[RoomJS] Chat log element not found!");
    }
    if (messageInput) messageInput.disabled = true;
    if (sendButton) sendButton.disabled = true;

    // --- Helper: Escape HTML ---
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

    // --- Helper: Escape for JS in HTML ---
    function escapeJsStringInHtml(unsafe) {
        if (typeof unsafe !== 'string') return '';
        return unsafe
            .replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"')
            .replace(/\n/g, '\\n').replace(/\r/g, '\\r')
            .replace(/</g, '\\x3C').replace(/>/g, '\\x3E');
    }

    // --- Helper: Convert URLs to links in text ---
    function linkifyText(text) {
        if (typeof text !== 'string') return text;

        // URL pattern with http, https, ftp, and www prefixes
        const urlPattern = /(\b(https?|ftp):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/gi;
        // More permissive www pattern that doesn't require protocol
        const wwwPattern = /(^|[^\/])(www\.[\S]+(\b|$))/gim;

        // Replace full URLs (with protocol)
        let linkedText = text.replace(urlPattern, function(url) {
            // Escape any quotes or HTML in the URL itself for safety
            const safeUrl = escapeJsStringInHtml(url);
            return `<a href="${url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation();">${escapeHtml(url)}</a>`;
        });

        // Replace www. URLs (without protocol)
        linkedText = linkedText.replace(wwwPattern, function(match, p1, p2) {
            const url = `http://${p2}`;
            // Escape any quotes or HTML in the URL itself for safety
            const safeUrl = escapeJsStringInHtml(url);
            return `${p1}<a href="${url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation();">${escapeHtml(p2)}</a>`;
        });

        return linkedText;
    }

    // --- Enhanced Diagnostic Functions for Sound System ---
    function checkSoundFileExists() {
        console.log("[RoomJS] Checking if sound files exist...");

        // Check WAV file
        fetch('https://cdn.glitch.global/5aba5ef8-de70-4d36-ac73-78691eb1ea7a/notification.wav?v=1744073357160', { method: 'HEAD' })
            .then(response => {
                if (response.ok) {
                    console.log("[RoomJS] WAV sound file exists and is accessible! Status:", response.status);
                    console.log("[RoomJS] Content-Type:", response.headers.get('Content-Type'));
                    console.log("[RoomJS] Content-Length:", response.headers.get('Content-Length'));
                } else {
                    console.error("[RoomJS] WAV sound file not found! Status:", response.status);
                }
            })
            .catch(error => {
                console.error("[RoomJS] Error checking WAV sound file:", error);
            });

        // Check MP3 file
        fetch('https://cdn.glitch.global/5aba5ef8-de70-4d36-ac73-78691eb1ea7a/notification.wav?v=1744073357160', { method: 'HEAD' })
            .then(response => {
                if (response.ok) {
                    console.log("[RoomJS] MP3 sound file exists and is accessible! Status:", response.status);
                    console.log("[RoomJS] Content-Type:", response.headers.get('Content-Type'));
                    console.log("[RoomJS] Content-Length:", response.headers.get('Content-Length'));
                } else {
                    console.error("[RoomJS] MP3 sound file not found! Status:", response.status);
                }
            })
            .catch(error => {
                console.error("[RoomJS] Error checking MP3 sound file:", error);
            });
    }

    function initNotificationSound() {
        // Try to load MP3 first (more widely supported), then fall back to WAV
        tryLoadSound('https://cdn.glitch.global/5aba5ef8-de70-4d36-ac73-78691eb1ea7a/notification.mp3?v=1744073573418').catch(() => {
            console.log("[RoomJS] MP3 failed, trying WAV format...");
            return tryLoadSound('https://cdn.glitch.global/5aba5ef8-de70-4d36-ac73-78691eb1ea7a/notification.wav?v=1744073357160');
        }).catch(err => {
            console.error("[RoomJS] All sound formats failed to load:", err);
            // Create a silent dummy sound as a last resort
            notificationSound = new Audio("data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV");
            // Setup audio unlock for future attempts
            setupAudioUnlock();
        });
    }

    function tryLoadSound(url) {
        return new Promise((resolve, reject) => {
            console.log(`[RoomJS] Trying to load sound from: ${url}`);

            // First check if the file exists
            fetch(url, { method: 'HEAD' })
                .then(response => {
                    if (!response.ok) {
                        console.error(`[RoomJS] Sound file ${url} not found (${response.status})`);
                        return reject(new Error(`Sound file not found: ${response.status}`));
                    }

                    console.log(`[RoomJS] Sound file ${url} exists, creating Audio object`);
                    const audio = new Audio(url);

                    // Set up event listeners to monitor loading
                    audio.addEventListener('canplaythrough', () => {
                        console.log(`[RoomJS] Sound ${url} loaded successfully`);
                        notificationSound = audio;
                        resolve(audio);
                    }, { once: true });

                    audio.addEventListener('error', (e) => {
                        console.error(`[RoomJS] Error loading sound ${url}:`, e);
                        reject(e);
                    }, { once: true });

                    // Start loading the sound
                    audio.load();
                })
                .catch(err => {
                    console.error(`[RoomJS] Network error checking sound file ${url}:`, err);
                    reject(err);
                });
        });
    }

    function playNotificationSound() {
        console.log("[RoomJS] Attempting to play notification sound");
        console.log("[RoomJS] Notifications enabled:", notificationsEnabled);
        console.log("[RoomJS] Sound object exists:", !!notificationSound);

        if (notificationsEnabled && notificationSound) {
            try {
                // Check if the audio is actually loaded
                if (notificationSound.readyState < 2) { // HAVE_CURRENT_DATA
                    console.warn("[RoomJS] Sound not fully loaded yet, readyState:", notificationSound.readyState);
                }

                console.log("[RoomJS] Resetting sound to beginning");
                notificationSound.currentTime = 0;
                notificationSound.volume = chatVolume / 100;

                console.log("[RoomJS] Calling play()");
                const playPromise = notificationSound.play();

                if (playPromise !== undefined) {
                    playPromise.then(() => {
                        console.log("[RoomJS] Sound playing successfully");
                    }).catch(err => {
                        console.error("[RoomJS] Error playing sound:", err);
                        console.log("[RoomJS] This might be due to browser autoplay policy. Try creating a user gesture handler.");

                        // Try to set up a one-time user gesture handler to unlock audio
                        setupAudioUnlock();
                    });
                }
            } catch (error) {
                console.error("[RoomJS] Error attempting to play sound:", error);
            }
        } else {
            console.log("[RoomJS] Not playing sound: enabled=", notificationsEnabled, ", sound object=", !!notificationSound);
        }
    }

    // Function to try to unlock audio on first user interaction
    function setupAudioUnlock() {
        if (window._audioUnlockHandlerSet) return; // Only set once

        window._audioUnlockHandlerSet = true;
        console.log("[RoomJS] Setting up audio unlock handler for user gesture");

        const unlockAudio = () => {
            console.log("[RoomJS] User gesture detected, attempting to unlock audio");

            if (notificationSound) {
                // Create and play a silent sound
                const silentSound = new Audio("data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV");
                silentSound.play().then(() => {
                    console.log("[RoomJS] Audio unlocked successfully");

                    // Now try to play the actual notification sound
                    if (notificationSound) {
                        notificationSound.currentTime = 0;
                        notificationSound.play().then(() => {
                            console.log("[RoomJS] Notification sound played after unlock");
                        }).catch(err => {
                            console.error("[RoomJS] Still couldn't play notification sound after unlock:", err);
                        });
                    }
                }).catch(err => {
                    console.error("[RoomJS] Couldn't unlock audio:", err);
                });
            }

            // Remove the event listeners once we've tried unlocking
            document.removeEventListener('click', unlockAudio);
            document.removeEventListener('touchstart', unlockAudio);
            document.removeEventListener('keydown', unlockAudio);
        };

        // Listen for user interactions
        document.addEventListener('click', unlockAudio);
        document.addEventListener('touchstart', unlockAudio);
        document.addEventListener('keydown', unlockAudio);
    }

    function toggleNotifications() {
        notificationsEnabled = !notificationsEnabled;

        // Update the icon based on the current state
        const soundToggleBtn = document.getElementById('sound-toggle');
        if (soundToggleBtn) {
            if (notificationsEnabled) {
                soundToggleBtn.innerHTML = '<i class="fas fa-volume-up"></i>';
                soundToggleBtn.title = "Turn notification sounds off";
            } else {
                soundToggleBtn.innerHTML = '<i class="fas fa-volume-mute"></i>';
                soundToggleBtn.title = "Turn notification sounds on";
            }
        }

        // Store the preference in localStorage so it's remembered between page loads
        try {
            localStorage.setItem('chatNotificationsEnabled', notificationsEnabled ? 'true' : 'false');
        } catch (e) {
            console.warn("[RoomJS] Could not save notification preference to localStorage:", e);
        }

        console.log(`[RoomJS] Notifications ${notificationsEnabled ? 'enabled' : 'disabled'}`);
    }

    // Initialize notification settings from localStorage (if available)
    function initNotificationPreference() {
        try {
            const savedPreference = localStorage.getItem('chatNotificationsEnabled');
            if (savedPreference !== null) {
                notificationsEnabled = savedPreference === 'true';
                console.log(`[RoomJS] Loaded notification preference: ${notificationsEnabled}`);
            }
        } catch (e) {
            console.warn("[RoomJS] Could not load notification preference from localStorage:", e);
        }
    }

    // --- Helper: Add message to chat log ---
    function logMessage(htmlContent) {
        if (!chatLog) return;
        try {
            const wasScrolledToBottom = chatLog.scrollHeight - chatLog.clientHeight <= chatLog.scrollTop + 5; // Add tolerance
            const div = document.createElement('div');
            div.innerHTML = htmlContent;
            chatLog.appendChild(div);
            if (wasScrolledToBottom) {
                chatLog.scrollTop = chatLog.scrollHeight;
            }
        } catch (e) {
             console.error("[RoomJS] Error inside logMessage! Input was:", htmlContent, "Error:", e);
        }
    }

    // --- Helper: Update User List ---
    function updateUserList(users) {
        console.log("[RoomJS] Received 'updateUserList':", users);
        if (!userList) return;
        if (Array.isArray(users)) {
            userList.innerHTML = ''; // Clear list
            users.forEach(user => {
                const li = document.createElement('li');
                li.textContent = escapeHtml(user); // Escape username
                userList.appendChild(li);
            });
        } else {
            console.error("[RoomJS] Invalid 'updateUserList' data.");
        }
    }


    // --- CORE EVENT LISTENERS ---

    socket.on('connect', () => {
        console.log(`[RoomJS] CONNECT event fired. Socket ID: ${socket.id}`);
        logMessage(`<div class="system-message" style="color:green;">Connected! Joining room...</div>`);
        console.log("[RoomJS] Emitting 'joinRoom'...");
        socket.emit('joinRoom', { roomId });
    });

    socket.on('disconnect', (reason) => {
        console.warn(`[RoomJS] DISCONNECT event fired. Reason: ${reason}`);
        logMessage(`<div class="system-message" style="color:orange;">Disconnected: ${reason}. Reconnecting...</div>`);
        if (messageInput) messageInput.disabled = true;
        if (sendButton) sendButton.disabled = true;
    });

    socket.on('connect_error', (err) => {
        console.error(`[RoomJS] CONNECT_ERROR event fired. Message: ${err.message}`);
        logMessage(`<div class="system-message" style="color:red;">Connection Error: ${escapeHtml(err.message)}</div>`);
        if (messageInput) messageInput.disabled = true;
        if (sendButton) sendButton.disabled = true;
    });

    socket.on('loadLogs', (logs) => {
        console.log("[RoomJS] LOADLOGS event fired.");
        if (!chatLog) return;
        chatLog.innerHTML = ''; // Clear before adding history

        if (Array.isArray(logs)) {
            logs.forEach(entry => {
                // Display logs carefully using backticks and escaping
                const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const isAdminClass = entry.isAdmin ? 'admin-username' : '';
                const safeUser = escapeHtml(entry.username || 'System');

                if (entry.type === 'message') {
                    // For messages, linkify the content
                    const processedMessage = linkifyText(escapeHtml(entry.message));
                    logMessage(`<div class="chat-message"><span class="username ${isAdminClass}">${safeUser}:</span> ${processedMessage} <span class="timestamp">${time}</span></div>`);
                } else if (entry.type === 'image' && entry.url) {
                    const safeUrlForJs = escapeJsStringInHtml(entry.url);
                    logMessage(`<div class="chat-message"><span class="username ${isAdminClass}">${safeUser}</span> uploaded an image <span class="timestamp">${time}</span>: <br> <img src="${escapeHtml(entry.url)}" alt="Image from ${safeUser}" style="max-width:200px; max-height:150px; cursor:pointer;" onclick="window.open('${safeUrlForJs}', '_blank')"></div>`);
                } else if (entry.type === 'join' || entry.type === 'leave' || entry.type === 'system') {
                    const adminSuffix = entry.isAdmin ? ' (Admin)' : '';
                    let sysMsg = '';
                    if (entry.type === 'join') sysMsg = `${safeUser}${adminSuffix} joined.`;
                    else if (entry.type === 'leave') sysMsg = `${safeUser}${adminSuffix} left.`;
                    else sysMsg = escapeHtml(entry.message || '[System Event]');
                    logMessage(`<div class="system-message">${sysMsg} (${time})</div>`);
                }
            });
            chatLog.scrollTop = chatLog.scrollHeight; // Scroll after adding history
        } else {
             console.error("[RoomJS] Invalid 'loadLogs' data received.");
        }

        logMessage(`<div class="system-message" style="color:blue;">Successfully joined room. Chat enabled.</div>`);
        if (messageInput) messageInput.disabled = false;
        if (sendButton) sendButton.disabled = false;
        if (messageInput) messageInput.focus();
    });

    socket.on('newMessage', (entry) => {
        console.log("[RoomJS] Received 'newMessage':", entry);
        if (entry && entry.username && typeof entry.message === 'string') {
            // Play notification sound for new messages (except own messages)
            if (entry.username !== username) {
                playNotificationSound();
            }

            const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const isAdminClass = entry.isAdmin ? 'admin-username' : '';
            const safeUser = escapeHtml(entry.username);
            // Process the message to detect and convert URLs to links
            const processedMessage = linkifyText(escapeHtml(entry.message));
            logMessage(`<div class="chat-message"><span class="username ${isAdminClass}">${safeUser}:</span> ${processedMessage} <span class="timestamp">${time}</span></div>`);
        } else {
            console.warn("[RoomJS] Received malformed 'newMessage':", entry);
        }
    });

    socket.on('newImage', (entry) => {
        console.log("[RoomJS] Received 'newImage':", entry);
        if (entry && entry.username && entry.url) {
            // Play notification sound for new images (except own uploads)
            if (entry.username !== username) {
                playNotificationSound();
            }

            const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const isAdminClass = entry.isAdmin ? 'admin-username' : '';
            const safeUser = escapeHtml(entry.username);
            const safeUrlForJs = escapeJsStringInHtml(entry.url);
            logMessage(`<div class="chat-message"><span class="username ${isAdminClass}">${safeUser}</span> uploaded an image <span class="timestamp">${time}</span>: <br> <img src="${escapeHtml(entry.url)}" alt="Image from ${safeUser}" style="max-width:200px; max-height:150px; cursor:pointer;" onclick="window.open('${safeUrlForJs}', '_blank')"></div>`);
        } else {
            console.warn("[RoomJS] Received malformed 'newImage':", entry);
        }
    });

    // Add back user list listener
    socket.on('updateUserList', updateUserList); // Use helper function


    socket.on('userJoined', (entry) => {
        console.log("[RoomJS] Received 'userJoined':", entry);
        if(entry && entry.username){
            const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const adminSuffix = entry.isAdmin ? ' (Admin)' : '';
            logMessage(`<div class="system-message">${escapeHtml(entry.username)}${adminSuffix} joined. (${time})</div>`);

            // Play notification sound for user joins (if enabled)
            if (entry.username !== username) {
                playNotificationSound();
            }
        }
    });

    socket.on('userLeft', (entry) => {
        console.log("[RoomJS] Received 'userLeft':", entry);
        if(entry && entry.username){
            const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const adminSuffix = entry.isAdmin ? ' (Admin)' : '';
            logMessage(`<div class="system-message">${escapeHtml(entry.username)}${adminSuffix} left. (${time})</div>`);
        }
    });


    socket.on('errorMsg', (message) => {
        console.error(`[RoomJS] ERRORMSG event fired. Message: ${message}`);
        logMessage(`<div class="system-message" style="color:red;">Server Error: ${escapeHtml(message)}</div>`);
    });

    socket.on('kicked', (reason) => {
        console.warn(`[RoomJS] KICKED event fired. Reason: ${reason}`);
        logMessage(`<div class="system-message" style="color:red;">You were kicked: ${escapeHtml(reason)}.</div>`);
        if (messageInput) messageInput.disabled = true;
        if (sendButton) sendButton.disabled = true;
        // Redirect? setTimeout(() => window.location.href = '/main', 3000);
    });
    socket.on('banned', (reason) => { /* similar handling */ });
    socket.on('roomDeleted', (reason) => { /* similar handling */ });

    // Add this with your other socket event handlers
    socket.on('roomInfo', (roomData) => {
        console.log("[RoomJS] Received room info:", roomData);
        if (roomData && roomData.name && roomData.maxUsers) {
            currentRoomName = roomData.name;
            currentMaxUsers = roomData.maxUsers;
            
            // Update page title if needed
            document.title = `Chat: ${escapeHtml(currentRoomName)}`;
            
            // If there's a room header element, update it
            const roomHeader = document.querySelector('.room-header h1');
            if (roomHeader) {
                roomHeader.textContent = escapeHtml(currentRoomName);
            }
        }
    });

    // New socket event handler for settings update result
    socket.on('roomSettingsUpdated', (result) => {
        if (result.success) {
            logMessage(`<div class="system-message" style="color:green;">Room settings updated successfully!</div>`);
            
            // Update our cached values
            currentRoomName = result.roomName;
            currentMaxUsers = result.maxUsers;
            
            // Update page title
            document.title = `Chat: ${escapeHtml(currentRoomName)}`;
            
            // If there's a room header element, update it to show both name and max users
            const roomHeader = document.querySelector('.room-header h1');
            if (roomHeader) {
                roomHeader.textContent = escapeHtml(currentRoomName);
                
                // Add or update a max users display in the header section
                let maxUsersDisplay = document.querySelector('.room-header .max-users-display');
                if (!maxUsersDisplay) {
                    maxUsersDisplay = document.createElement('span');
                    maxUsersDisplay.className = 'max-users-display';
                    maxUsersDisplay.style.fontSize = '0.8em';
                    maxUsersDisplay.style.color = '#666';
                    maxUsersDisplay.style.marginLeft = '10px';
                    document.querySelector('.room-header').appendChild(maxUsersDisplay);
                }
                maxUsersDisplay.textContent = `Max users: ${currentMaxUsers}`;
            }
            
            // Close the modal
            closeModal();
        } else {
            logMessage(`<div class="system-message" style="color:red;">Failed to update room settings: ${escapeHtml(result.message)}</div>`);
        }
    });

    console.log("[RoomJS] Core event listeners attached.");

    // --- Client Actions ---
    function sendMessage() {
        if (!socket || socket.disconnected) { /* ... */ return; }
        const message = messageInput.value.trim();
        console.log(`[RoomJS] Send clicked. Message: "${message}"`);
        if (message && !messageInput.disabled) {
            if (message.length > 500) { /* ... */ return; }
            socket.emit('sendMessage', { message });
            console.log("[RoomJS] 'sendMessage' emitted.");
            messageInput.value = '';
        }
        messageInput.focus();
    }

    // Attach Send Listeners
    if (sendButton && messageInput) {
        sendButton.addEventListener('click', sendMessage);
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });
        console.log("[RoomJS] Send message listeners attached.");
    } else { /* ... error log ... */ }

    // --- Image Upload (Now Enabled) ---
    const uploadButton = document.getElementById('upload-button');
    const imageInput = document.getElementById('image-input');

    if (uploadButton && imageInput) {
        uploadButton.disabled = false; // Enable the button
        uploadButton.title = "Upload an image"; // Update tooltip

        // Handle file selection
        imageInput.addEventListener('change', () => {
            if (imageInput.files && imageInput.files[0]) {
                // No need to explicitly enable/disable button here if it starts enabled
                // uploadButton.disabled = false; // This line is redundant if it starts enabled
            } else {
                // uploadButton.disabled = true; // Optionally disable if no file is selected after opening dialog
            }
        });

        // Handle upload button click
        // Replace the upload button click handler with this enhanced diagnostic version
        // Fixed upload button click handler without syntax errors
        uploadButton.addEventListener('click', () => {
            console.log("[RoomJS] Upload button clicked");

            // If no file is selected, trigger the file input dialog
            if (!imageInput.files || !imageInput.files[0]) {
                console.log("[RoomJS] No file selected, opening file dialog");
                imageInput.click();
                return;
            }

            const file = imageInput.files[0];
            console.log("[RoomJS] File selected:", file.name, "Type:", file.type, "Size:", file.size, "bytes");

            // Check file type
            if (!file.type.match('image.*')) {
                console.error("[RoomJS] File is not an image");
                logMessage(`<div class="system-message" style="color:red;">Error: Please select an image file.</div>`);
                // Reset file input in case of error
                imageInput.value = '';
                return;
            }

            // Check file size (limit to 2MB)
            if (file.size > 2 * 1024 * 1024) {
                console.error("[RoomJS] File is too large:", file.size, "bytes");
                logMessage(`<div class="system-message" style="color:red;">Error: Image must be smaller than 2MB.</div>`);
                // Reset file input in case of error
                imageInput.value = '';
                return;
            }

            // Show uploading message
            logMessage(`<div class="system-message">Uploading image...</div>`);
            console.log("[RoomJS] Creating FormData for direct HTTP upload");

            // Create FormData object for direct HTTP upload
            const formData = new FormData();
            formData.append('image', file);

            // Use direct HTTP upload instead of Socket.IO
            console.log("[RoomJS] Starting HTTP upload to /upload/" + roomId);
            fetch('/upload/' + roomId, {
                method: 'POST',
                body: formData
            })
            .then(response => {
                console.log("[RoomJS] Upload response status:", response.status);
                // Check if response is ok (status in the range 200-299)
                if (!response.ok) {
                    // Attempt to parse error message from JSON response, otherwise use status text
                    return response.json().catch(() => {
                        // If JSON parsing fails, throw an error with status text
                        throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
                    }).then(errorData => {
                        // If JSON parsing succeeds, throw an error with the message from the server
                        throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
                    });
                }
                return response.json(); // Parse JSON body for successful responses
            })
            .then(data => {
                console.log("[RoomJS] Upload response data:", data);
                // Server should send back { success: true, imageUrl: '...' } or { success: false, message: '...' }
                if (data.success) {
                    console.log("[RoomJS] Upload successful:", data.imageUrl);
                    // Success! The server will emit a socket event to all clients
                    logMessage(`<div class="system-message" style="color:green;">Image uploaded successfully!</div>`);
                } else {
                    // This case might be handled by the !response.ok check now, but keep for explicit server failure message
                    console.error("[RoomJS] Upload failed:", data.message);
                    logMessage(`<div class="system-message" style="color:red;">Upload failed: ${escapeHtml(data.message || 'Unknown server error')}</div>`);
                }
                // Reset file input regardless of success or failure
                imageInput.value = '';
            })
            .catch(error => {
                console.error("[RoomJS] Upload error:", error);
                // Display the error message caught from fetch or thrown from .then block
                logMessage(`<div class="system-message" style="color:red;">Upload error: ${escapeHtml(error.message)}</div>`);
                // Reset file input
                imageInput.value = '';
            });
        }); // End of upload button event listener

        console.log("[RoomJS] Image upload listeners attached."); // Moved log message here
    } else {
        console.warn("[RoomJS] Image upload button or input not found."); // Added warning if elements are missing
    }

        // --- Clipboard Image Paste ---
    console.log("[RoomJS] Setting up clipboard image paste functionality...");
    
    // Function to handle clipboard paste events
    function handlePaste(e) {
        console.log("[RoomJS] Paste event detected");
        
        // Check if we're pasting into the message input field
        const activeElement = document.activeElement;
        if (activeElement !== messageInput) {
            console.log("[RoomJS] Paste not in message input, ignoring");
            return; // Only process pastes in the message input
        }
        
        // Check for clipboard data
        if (!e.clipboardData || !e.clipboardData.items) {
            console.log("[RoomJS] No clipboard data found");
            return;
        }
        
        // Look for images in pasted content
        const items = e.clipboardData.items;
        let imageItem = null;
        
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1) {
                console.log("[RoomJS] Found image in clipboard: ", items[i].type);
                imageItem = items[i];
                break;
            }
        }
        
        // If no image is found, let the default paste behavior continue
        if (!imageItem) {
            console.log("[RoomJS] No image found in clipboard, continuing with normal paste");
            return;
        }
        
        // Prevent the default paste behavior since we're handling an image
        e.preventDefault();
        
        // Get the image as a file
        const blob = imageItem.getAsFile();
        if (!blob) {
            console.log("[RoomJS] Failed to get image as file");
            return;
        }
        
        // Generate a unique filename
        const timestamp = new Date().getTime();
        const filename = `pasted-image-${timestamp}.png`;
        
        // Create a File object from the blob
        const file = new File([blob], filename, { type: blob.type });
        console.log("[RoomJS] Created file from pasted image:", file.name, "Type:", file.type, "Size:", file.size, "bytes");
        
        // Check file size (limit to 2MB like in the upload handler)
        if (file.size > 2 * 1024 * 1024) {
            console.error("[RoomJS] Pasted image is too large:", file.size, "bytes");
            logMessage(`<div class="system-message" style="color:red;">Error: Pasted image must be smaller than 2MB.</div>`);
            return;
        }
        
        // Show uploading message
        logMessage(`<div class="system-message">Uploading pasted image...</div>`);
        
        // Create FormData for upload
        const formData = new FormData();
        formData.append('image', file);
        
        // Use the existing upload mechanism
        console.log("[RoomJS] Uploading pasted image to /upload/" + roomId);
        fetch('/upload/' + roomId, {
            method: 'POST',
            body: formData
        })
        .then(response => {
            console.log("[RoomJS] Paste upload response status:", response.status);
            // Check if response is ok (status in the range 200-299)
            if (!response.ok) {
                // Attempt to parse error message from JSON response, otherwise use status text
                return response.json().catch(() => {
                    // If JSON parsing fails, throw error with status text
                    throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
                }).then(errorData => {
                    // If JSON parsing succeeds, throw error with the message from the server
                    throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
                });
            }
            return response.json(); // Parse JSON body for successful responses
        })
        .then(data => {
            console.log("[RoomJS] Paste upload response data:", data);
            // Server should send back { success: true, imageUrl: '...' } or { success: false, message: '...' }
            if (data.success) {
                console.log("[RoomJS] Paste upload successful:", data.imageUrl);
                // Success! The server will emit a socket event to all clients
                logMessage(`<div class="system-message" style="color:green;">Pasted image uploaded successfully!</div>`);
            } else {
                // This case might be handled by the !response.ok check now, but keep for explicit server failure message
                console.error("[RoomJS] Paste upload failed:", data.message);
                logMessage(`<div class="system-message" style="color:red;">Paste upload failed: ${escapeHtml(data.message || 'Unknown server error')}</div>`);
            }
        })
        .catch(error => {
            console.error("[RoomJS] Paste upload error:", error);
            // Display the error message caught from fetch or thrown from .then block
            logMessage(`<div class="system-message" style="color:red;">Paste upload error: ${escapeHtml(error.message)}</div>`);
        });
    }
    
    // Add the paste event listener to the document
    document.addEventListener('paste', handlePaste);
    
    console.log("[RoomJS] Clipboard image paste functionality set up.");    

    // --- Test Sound Button ---
    const testSoundBtn = document.getElementById('test-sound');
    if (testSoundBtn) {
        testSoundBtn.addEventListener('click', () => {
            console.log("[RoomJS] Test sound button clicked");
            playNotificationSound();
        });
        console.log("[RoomJS] Test sound button listener attached");
    } else {
        console.log("[RoomJS] Test sound button not found (optional)");
    }

    console.log("[RoomJS] Setup complete. Waiting for connection...");
}); // End DOMContentLoaded
