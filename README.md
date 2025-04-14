# RealTime Chat

A real-time chat application built with Node.js, Express, and Socket.IO that allows users to create and join chat rooms, share messages and images, and includes admin functionality for moderation.

## 🌟 Features

### User Features
- **User Authentication**: Simple username-based login system
- **Room Management**: Create and join chat rooms with optional passwords
- **Real-time Messaging**: Instant message delivery using Socket.IO
- **Image Sharing**: Upload and share images within chat rooms
- **URL Detection**: Automatically converts URLs to clickable links
- **Notification System**: Sound notifications for new messages with volume control
- **User Presence**: See who is currently in the chat room

### Admin Features
- **Admin Panel**: Secure admin interface for monitoring and moderation
- **User Management**: View connected users and their details (IP, location, room)
- **Room Management**: View, hide, and delete rooms
- **Moderation Tools**: Kick and ban users
- **Room Logs**: Download chat logs for any room

### Security Features
- **HTML Escaping**: Protection against XSS attacks
- **Session Management**: Secure session handling
- **Password Protection**: Optional password protection for rooms
- **IP Banning**: Ban users by username or IP address

## 🛠️ Technology Stack

- **Backend**: Node.js with Express
- **Real-time Communication**: Socket.IO
- **Frontend**: HTML, CSS, JavaScript (Vanilla)
- **Templating**: EJS
- **Session Management**: express-session
- **File Upload**: Multer
- **Geolocation**: geoip-lite
- **Data Storage**: Simple JSON file persistence

## 📋 Prerequisites

- Node.js (v14+)
- npm

## 🚀 Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/realtime-chat.git
   cd realtime-chat
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory with the following variables:
   ```
   PORT=3000
   SESSION_SECRET=your_secret_key_here
   ADMIN_USER=admin
   ADMIN_PASSWORD=your_admin_password
   ```

4. Start the server:
   ```bash
   npm start
   ```

5. Access the application at `http://localhost:3000`

## 📁 Project Structure

```
├── public/              # Static files
│   ├── css/             # CSS stylesheets
│   ├── js/              # Client-side JavaScript
│   └── uploads/         # Uploaded images
├── views/               # EJS templates
│   ├── login.ejs        # Login page
│   ├── main.ejs         # Room selection page
│   ├── room.ejs         # Chat room page
│   ├── admin_login.ejs  # Admin login page
│   └── admin_panel.ejs  # Admin dashboard
├── .env                 # Environment variables
├── package.json         # Project dependencies
├── server.js            # Main application file
└── README.md            # This file
```

## 💡 Usage

### Regular User Flow
1. Register with a username on the login page
2. Create a new room or join an existing one
3. Chat with other users in real-time
4. Share images and URLs

### Admin Flow
1. Access the admin panel via `/admin-login`
2. Log in with admin credentials
3. Monitor active users and rooms
4. Moderate content and users as needed

## 🔒 Security Considerations

This application includes basic security measures but should be enhanced for production use:

- Password hashing for room and admin passwords
- Rate limiting to prevent abuse
- HTTPS configuration
- More robust authentication system
- Input validation and sanitization

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a pull request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 📧 Contact

Your Name - your.email@example.com

Project Link: [https://github.com/yourusername/realtime-chat](https://github.com/yourusername/realtime-chat)