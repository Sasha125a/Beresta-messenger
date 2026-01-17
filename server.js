const WebSocket = require('ws');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

// Конфигурация для Render.com
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'береста_секретный_ключ_2024_рендер';
const HOST = process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost';
const PROTOCOL = process.env.NODE_ENV === 'production' ? 'https' : 'http';

// Пути для загрузок
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const AUDIO_DIR = path.join(UPLOADS_DIR, 'audio');
const FILES_DIR = path.join(UPLOADS_DIR, 'files');

// Создаем директории для загрузок
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
}
if (!fs.existsSync(FILES_DIR)) {
    fs.mkdirSync(FILES_DIR, { recursive: true });
}

// Инициализация базы данных (используем файловую БД для сохранения данных)
const dbPath = process.env.NODE_ENV === 'production' 
    ? '/opt/render/project/src/beresta.db'
    : path.join(__dirname, 'beresta.db');
const db = new sqlite3.Database(dbPath);

// Инициализация таблиц
db.serialize(() => {
    // Пользователи
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            username TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Контакты
    db.run(`
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            contact_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id),
            FOREIGN KEY (contact_id) REFERENCES users (id),
            UNIQUE(user_id, contact_id)
        )
    `);

    // Чаты
    db.run(`
        CREATE TABLE IF NOT EXISTS chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            is_group BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Участники чатов с персональным названием чата для каждого участника
    db.run(`
        CREATE TABLE IF NOT EXISTS chat_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            chat_name TEXT,
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (chat_id) REFERENCES chats (id),
            FOREIGN KEY (user_id) REFERENCES users (id),
            UNIQUE(chat_id, user_id)
        )
    `);

    // Сообщения
    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            content TEXT,
            audio_url TEXT,
            file_url TEXT,
            file_name TEXT,
            file_size INTEGER,
            file_type TEXT,
            message_type TEXT DEFAULT 'text',
            duration INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (chat_id) REFERENCES chats (id),
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    `);

    // Проверяем, есть ли тестовые пользователи
    db.get('SELECT COUNT(*) as count FROM users', (err, result) => {
        if (result.count === 0) {
            // Создаем тестовых пользователей
            const testHash = bcrypt.hashSync('password123', 10);
            
            db.serialize(() => {
                db.run(
                    'INSERT INTO users (email, username, password_hash) VALUES (?, ?, ?)',
                    ['test@example.com', 'Тестовый Пользователь', testHash],
                    function(err) {
                        if (err) {
                            console.error('Error creating test user:', err);
                        } else {
                            console.log('Test user created with ID:', this.lastID);
                        }
                    }
                );

                db.run(
                    'INSERT INTO users (email, username, password_hash) VALUES (?, ?, ?)',
                    ['user2@example.com', 'Второй Пользователь', testHash],
                    function(err) {
                        if (err) {
                            console.error('Error creating second test user:', err);
                        } else {
                            console.log('Second test user created with ID:', this.lastID);
                        }
                    }
                );
            });
        }
    });
});

// Middleware для обработки JSON
function parseJSON(req, res, next) {
    if (req.headers['content-type'] === 'application/json') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                req.body = JSON.parse(body);
                next();
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    } else {
        next();
    }
}

// Middleware для аутентификации
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No token provided' }));
        return;
    }

    const token = authHeader.replace('Bearer ', '');
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        req.userEmail = decoded.email;
        next();
    } catch (error) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid token' }));
    }
}

// HTML шаблон с измененным интерфейсом
// HTML шаблон с измененным интерфейсом
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="mobile-web-app-capable" content="yes">
    <title>Береста - Мессенджер</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        :root {
            --primary-color: #4f46e5;
            --primary-gradient: linear-gradient(135deg, #4f46e5, #7c3aed);
            --secondary-color: #f8fafc;
            --text-primary: #1f2937;
            --text-secondary: #6b7280;
            --border-color: #e5e7eb;
            --success-color: #10b981;
            --error-color: #ef4444;
            --warning-color: #f59e0b;
            --sidebar-width: 300px;
            --top-nav-height: 60px;
        }

        html, body {
            height: 100%;
            width: 100%;
            overflow: hidden;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }

        body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 10px;
            margin: 0;
        }

        .container {
            display: flex;
            width: 100%;
            height: 100%;
            max-height: 100vh;
            padding: 0;
            margin: 0;
        }

        /* Панель авторизации */
        .auth-panel {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            width: 100%;
            max-width: 400px;
            padding: 40px 30px;
            display: flex;
            flex-direction: column;
            justify-content: center;
        }

        .app-panel {
            display: none;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            width: 100%;
            height: 100%;
            max-height: 100vh;
            overflow: hidden;
            flex-direction: column;
            margin: 0;
        }

        .app-panel.active {
            display: flex;
        }

        .logo {
            text-align: center;
            margin-bottom: 30px;
        }

        .logo h1 {
            font-size: 32px;
            color: var(--primary-color);
            margin-bottom: 10px;
        }

        .logo p {
            color: var(--text-secondary);
            font-size: 14px;
        }

        .form-group {
            margin-bottom: 20px;
        }

        .form-group label {
            display: block;
            margin-bottom: 8px;
            color: var(--text-primary);
            font-weight: 500;
            font-size: 16px;
        }

        .form-group input {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid var(--border-color);
            border-radius: 10px;
            font-size: 16px;
            transition: border-color 0.3s;
        }

        .form-group input:focus {
            outline: none;
            border-color: var(--primary-color);
        }

        .btn {
            width: 100%;
            padding: 14px;
            background: var(--primary-gradient);
            color: white;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s;
            margin-top: 10px;
        }

        .btn:hover {
            transform: translateY(-2px);
        }

        .btn-secondary {
            background: #f3f4f6;
            color: var(--primary-color);
        }

        .error-message {
            color: var(--error-color);
            font-size: 14px;
            margin-top: 5px;
            display: none;
        }

        .error-message.show {
            display: block;
        }

        .toggle-auth {
            text-align: center;
            margin-top: 20px;
            color: var(--text-secondary);
            font-size: 14px;
        }

        .toggle-auth a {
            color: var(--primary-color);
            text-decoration: none;
            font-weight: 600;
            cursor: pointer;
        }

        /* Верхняя панель навигации */
        .top-nav {
            height: var(--top-nav-height);
            background: white;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            padding: 0 15px;
            flex-shrink: 0;
        }

        .top-nav-content {
            display: flex;
            align-items: center;
            width: 100%;
            height: 100%;
        }

        /* Навигационные вкладки вверху */
        .nav-tabs {
            display: flex;
            flex: 1;
            max-width: 250px;
        }

        .nav-tab {
            flex: 1;
            padding: 10px;
            text-align: center;
            cursor: pointer;
            font-weight: 500;
            color: var(--text-secondary);
            transition: all 0.3s;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            border-bottom: 2px solid transparent;
            font-size: 14px;
            min-height: 40px;
        }

        .nav-tab.active {
            color: var(--primary-color);
            border-bottom-color: var(--primary-color);
        }

        .nav-tab i {
            font-size: 16px;
        }

        /* Миниатюра пользователя */
        .user-info-mini {
            margin-left: auto;
            display: flex;
            align-items: center;
        }

        .user-avatar-mini {
            width: 36px;
            height: 36px;
            background: var(--primary-gradient);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            font-size: 14px;
        }

        /* Кнопка "Назад" в чате */
        .back-button {
            background: none;
            border: none;
            width: 40px;
            height: 40px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            color: var(--text-secondary);
            font-size: 18px;
            transition: background 0.3s;
            margin-right: 10px;
            flex-shrink: 0;
        }

        .back-button:hover {
            background: #f3f4f6;
        }

        /* Заголовок чата в навигации */
        .chat-title {
            flex: 1;
            font-size: 18px;
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            padding: 0 10px;
        }

        .chat-actions-mini {
            display: flex;
            gap: 8px;
            margin-left: auto;
        }

        .chat-actions-mini button {
            background: none;
            border: none;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            color: var(--text-secondary);
            font-size: 16px;
            transition: background 0.3s;
            flex-shrink: 0;
        }

        .chat-actions-mini button:hover {
            background: #f3f4f6;
        }

        /* Боковая панель */
        .sidebar {
            width: var(--sidebar-width);
            background: var(--secondary-color);
            border-right: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            flex-shrink: 0;
            height: 100%;
        }

        .user-info {
            padding: 15px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .user-avatar {
            width: 40px;
            height: 40px;
            background: var(--primary-gradient);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            font-size: 16px;
            flex-shrink: 0;
        }

        .user-details h3 {
            font-size: 16px;
            margin-bottom: 2px;
            color: var(--text-primary);
        }

        .user-details p {
            font-size: 12px;
            color: var(--text-secondary);
        }

        .content-panel {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-height: 0;
            height: 100%;
        }

        .panel-content {
            flex: 1;
            overflow-y: auto;
            padding: 15px;
            display: none;
            height: 100%;
        }

        .panel-content.active {
            display: flex;
            flex-direction: column;
        }

        .list-item {
            padding: 12px;
            border-radius: 10px;
            margin-bottom: 8px;
            cursor: pointer;
            transition: background 0.3s;
            border: 1px solid var(--border-color);
        }

        .list-item:hover {
            background: #f3f4f6;
        }

        .list-item.active {
            background: #e0e7ff;
            border-color: var(--primary-color);
        }

        .list-item-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 4px;
        }

        .list-item-title {
            font-weight: 600;
            color: var(--text-primary);
            font-size: 14px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .list-item-time {
            font-size: 12px;
            color: #9ca3af;
            flex-shrink: 0;
            margin-left: 8px;
        }

        .list-item-preview {
            font-size: 13px;
            color: var(--text-secondary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .list-item-preview i {
            margin-right: 5px;
            color: var(--primary-color);
            font-size: 12px;
        }

        .chat-area {
            flex: 1;
            display: flex;
            flex-direction: column;
            position: relative;
            min-width: 0;
            min-height: 0;
            width: 100%;
            height: 100%;
        }

        .chat-messages {
            flex: 1;
            padding: 15px;
            overflow-y: auto;
            background: #f9fafb;
            display: flex;
            flex-direction: column;
            height: 100%;
        }

        .message {
            margin-bottom: 12px;
            max-width: 85%;
            animation: fadeIn 0.3s ease;
            display: flex;
            flex-direction: column;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .message.own {
            align-self: flex-end;
        }

        .message-content {
            padding: 10px 14px;
            border-radius: 18px;
            background: white;
            border: 1px solid var(--border-color);
            word-wrap: break-word;
            font-size: 16px;
            line-height: 1.4;
        }

        .message.own .message-content {
            background: var(--primary-color);
            color: white;
            border-color: var(--primary-color);
        }

        .message-info {
            display: flex;
            justify-content: space-between;
            margin-top: 4px;
            font-size: 12px;
            color: #9ca3af;
            padding: 0 5px;
        }

        .message.own .message-info {
            justify-content: flex-end;
        }

        .voice-message {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            background: rgba(79, 70, 229, 0.1);
            border-radius: 20px;
        }

        .message.own .voice-message {
            background: rgba(255, 255, 255, 0.2);
        }

        .voice-play-btn {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: var(--primary-color);
            color: white;
            border: none;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: transform 0.2s;
            flex-shrink: 0;
        }

        .voice-play-btn:hover {
            transform: scale(1.05);
        }

        .voice-play-btn.playing {
            background: var(--error-color);
        }

        .voice-duration {
            font-size: 14px;
            font-weight: 500;
            min-width: 40px;
        }

        .voice-waveform {
            flex: 1;
            height: 24px;
            background: rgba(79, 70, 229, 0.1);
            border-radius: 12px;
            overflow: hidden;
            position: relative;
        }

        .voice-wave {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: space-around;
            padding: 0 8px;
        }

        .voice-bar {
            width: 2px;
            background: var(--primary-color);
            border-radius: 1px;
            transition: height 0.3s;
        }

        .message.own .voice-bar {
            background: white;
        }

        .chat-input-area {
            padding: 15px;
            border-top: 1px solid var(--border-color);
            display: flex;
            gap: 8px;
            align-items: center;
            background: white;
            position: sticky;
            bottom: 0;
            flex-shrink: 0;
        }

        .chat-input {
            flex: 1;
            position: relative;
        }

        .chat-input input {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid var(--border-color);
            border-radius: 10px;
            font-size: 16px;
            padding-right: 50px;
        }

        .chat-input input:focus {
            outline: none;
            border-color: var(--primary-color);
        }

        .input-hint {
            position: absolute;
            right: 12px;
            top: 50%;
            transform: translateY(-50%);
            color: #9ca3af;
            font-size: 12px;
            pointer-events: none;
        }

        .input-hint i {
            margin-right: 4px;
            font-size: 12px;
        }

        .voice-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: white;
            padding: 10px 16px;
            border-radius: 10px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
            z-index: 10;
            display: none;
        }

        .voice-indicator.show {
            display: flex;
        }

        .voice-indicator-recording {
            width: 10px;
            height: 10px;
            background: var(--error-color);
            border-radius: 50%;
            animation: pulse 1.5s infinite;
        }

        .voice-indicator-timer {
            font-size: 14px;
            font-weight: 600;
            color: var(--error-color);
            min-width: 40px;
        }

        .send-button {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: var(--primary-color);
            color: white;
            border: none;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
            transition: all 0.3s;
            flex-shrink: 0;
        }

        .send-button:hover {
            background: #3c3791;
        }

        .send-button.recording {
            background: var(--error-color);
            animation: pulse 1.5s infinite;
        }

        .send-button:disabled {
            background: #9ca3af;
            cursor: not-allowed;
        }

        .send-button i {
            transition: transform 0.3s;
        }

        .send-button.recording i {
            transform: scale(1.1);
        }

        @keyframes pulse {
            0% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.1); opacity: 0.8; }
            100% { transform: scale(1); opacity: 1; }
        }

        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            justify-content: center;
            align-items: center;
            z-index: 1000;
            padding: 20px;
        }

        .modal.active {
            display: flex;
        }

        .modal-content {
            background: white;
            padding: 25px;
            border-radius: 15px;
            width: 100%;
            max-width: 400px;
            max-height: 90vh;
            overflow-y: auto;
        }

        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }

        .modal-header h3 {
            font-size: 20px;
            color: var(--text-primary);
        }

        .modal-close {
            background: none;
            border: none;
            font-size: 24px;
            cursor: pointer;
            color: var(--text-secondary);
        }

        .search-box {
            margin-bottom: 15px;
        }

        .search-box input {
            width: 100%;
            padding: 10px 12px;
            border: 2px solid var(--border-color);
            border-radius: 10px;
            font-size: 14px;
        }

        .loading {
            text-align: center;
            padding: 20px;
            color: var(--text-secondary);
            font-size: 14px;
        }

        .empty-state {
            text-align: center;
            padding: 30px 15px;
            color: #9ca3af;
            font-size: 14px;
        }

        .contact-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px;
            border-radius: 10px;
            cursor: pointer;
            transition: background 0.3s;
        }

        .contact-item:hover {
            background: #f3f4f6;
        }

        .contact-avatar {
            width: 32px;
            height: 32px;
            background: linear-gradient(135deg, #8b5cf6, #6366f1);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            font-size: 13px;
            flex-shrink: 0;
        }

        .contact-info h4 {
            font-size: 14px;
            margin-bottom: 2px;
            color: var(--text-primary);
        }

        .contact-info p {
            font-size: 12px;
            color: var(--text-secondary);
        }

        .add-contact-btn {
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 50px;
            height: 50px;
            background: var(--primary-gradient);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 20px;
            cursor: pointer;
            box-shadow: 0 4px 15px rgba(79, 70, 229, 0.3);
            border: none;
            z-index: 100;
        }
        
        .notification {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 10px 16px;
            background: var(--success-color);
            color: white;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            display: none;
            z-index: 1001;
            max-width: 300px;
            font-size: 14px;
        }
        
        .notification.show {
            display: block;
            animation: slideIn 0.3s ease;
        }
        
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }

        .typing-indicator {
            display: none;
            align-items: center;
            gap: 6px;
            padding: 8px 12px;
            background: white;
            border: 1px solid var(--border-color);
            border-radius: 20px;
            max-width: fit-content;
            margin-bottom: 8px;
            animation: fadeIn 0.3s ease;
        }

        .typing-indicator.show {
            display: flex;
        }

        .typing-dots {
            display: flex;
            gap: 3px;
        }

        .typing-dot {
            width: 5px;
            height: 5px;
            background: #9ca3af;
            border-radius: 50%;
            animation: typingAnimation 1.4s infinite;
        }

        .typing-dot:nth-child(2) {
            animation-delay: 0.2s;
        }

        .typing-dot:nth-child(3) {
            animation-delay: 0.4s;
        }

        @keyframes typingAnimation {
            0%, 60%, 100% { transform: translateY(0); }
            30% { transform: translateY(-6px); }
        }

        /* Улучшенное меню вложений */
        .attachment-btn {
            position: relative;
            display: inline-block;
        }

        .attachment-menu {
            position: absolute;
            bottom: 100%;
            left: 0;
            background: white;
            border: 1px solid var(--border-color);
            border-radius: 10px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
            padding: 8px;
            min-width: 180px;
            display: none;
            z-index: 100;
            margin-bottom: 5px;
            max-width: calc(100vw - 40px);
            transform-origin: bottom left;
        }

        .attachment-menu.show {
            display: block;
            animation: fadeInUp 0.2s ease;
        }

        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .attachment-option {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px;
            border-radius: 8px;
            cursor: pointer;
            transition: background 0.3s;
            font-size: 14px;
        }

        .attachment-option:hover {
            background: #f3f4f6;
        }

        .attachment-option i {
            width: 20px;
            color: var(--primary-color);
            font-size: 14px;
        }

        /* Стили для файлов */
        .file-message {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 14px;
            background: rgba(79, 70, 229, 0.1);
            border-radius: 12px;
            text-decoration: none;
            color: inherit;
            transition: background 0.3s;
        }

        .message.own .file-message {
            background: rgba(255, 255, 255, 0.2);
        }

        .file-message:hover {
            background: rgba(79, 70, 229, 0.15);
        }

        .file-icon {
            width: 36px;
            height: 36px;
            border-radius: 8px;
            background: var(--primary-gradient);
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 16px;
            flex-shrink: 0;
        }

        .file-info {
            flex: 1;
            min-width: 0;
        }

        .file-name {
            font-weight: 500;
            margin-bottom: 2px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-size: 14px;
        }

        .file-size {
            font-size: 12px;
            color: #6b7280;
        }

        .download-btn {
            padding: 6px 10px;
            background: rgba(79, 70, 229, 0.1);
            border-radius: 6px;
            color: var(--primary-color);
            font-size: 13px;
            font-weight: 500;
            transition: background 0.3s;
            margin-left: 8px;
            flex-shrink: 0;
        }

        .download-btn:hover {
            background: rgba(79, 70, 229, 0.2);
        }

        .upload-progress {
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            width: 90%;
            max-width: 300px;
            background: white;
            border-radius: 10px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.2);
            padding: 12px;
            z-index: 1002;
            display: none;
        }

        .upload-progress.show {
            display: block;
            animation: slideUp 0.3s ease;
        }

        @keyframes slideUp {
            from { transform: translate(-50%, 100%); opacity: 0; }
            to { transform: translate(-50%, 0); opacity: 1; }
        }

        .progress-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }

        .progress-bar {
            height: 5px;
            background: var(--border-color);
            border-radius: 3px;
            overflow: hidden;
        }

        .progress-fill {
            height: 100%;
            background: var(--primary-gradient);
            width: 0%;
            transition: width 0.3s ease;
        }

        .upload-list {
            margin-top: 8px;
            max-height: 150px;
            overflow-y: auto;
        }

        .upload-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px;
            border-radius: 6px;
            margin-bottom: 4px;
            font-size: 13px;
        }

        .upload-item.success {
            background: #f0fdf4;
            border: 1px solid #bbf7d0;
        }

        .upload-item.error {
            background: #fef2f2;
            border: 1px solid #fecaca;
        }

        /* Адаптивность для мобильных устройств */
        @media (max-width: 768px) {
            body {
                padding: 5px;
            }

            .auth-panel {
                padding: 30px 20px;
                border-radius: 15px;
            }

            .app-panel {
                border-radius: 15px;
                max-height: 95vh;
            }

            .sidebar {
                width: 100%;
            }

            .chat-area {
                width: 100%;
            }

            .message {
                max-width: 90%;
            }

            .top-nav {
                padding: 0 10px;
            }

            .nav-tabs {
                max-width: 200px;
            }

            .nav-tab {
                padding: 8px;
                min-height: 36px;
            }

            .user-avatar-mini {
                width: 32px;
                height: 32px;
                font-size: 13px;
            }

            .back-button {
                width: 36px;
                height: 36px;
                margin-right: 8px;
            }

            .chat-actions-mini button {
                width: 32px;
                height: 32px;
                font-size: 14px;
            }

            .attachment-menu {
                min-width: 160px;
                left: -10px;
            }
        }

        @media (max-width: 480px) {
            :root {
                --sidebar-width: 100%;
                --top-nav-height: 50px;
            }

            .logo h1 {
                font-size: 24px;
            }

            .logo p {
                font-size: 12px;
            }

            .nav-tab span {
                display: none;
            }

            .nav-tab {
                justify-content: center;
                padding: 5px;
                min-width: 40px;
            }

            .nav-tab i {
                margin: 0;
                font-size: 16px;
            }

            .chat-title {
                font-size: 16px;
                padding: 0 5px;
            }

            .message {
                max-width: 95%;
            }

            .voice-message {
                padding: 6px 10px;
                gap: 6px;
            }

            .voice-play-btn {
                width: 28px;
                height: 28px;
                font-size: 12px;
            }

            .voice-duration {
                font-size: 12px;
                min-width: 35px;
            }

            .chat-input-area {
                padding: 12px;
                gap: 6px;
            }

            .chat-input input {
                padding: 10px 14px;
                font-size: 16px;
            }

            .send-button {
                width: 36px;
                height: 36px;
                font-size: 14px;
            }

            .add-contact-btn {
                width: 44px;
                height: 44px;
                font-size: 18px;
                bottom: 15px;
                right: 15px;
            }

            .notification {
                max-width: 250px;
                padding: 8px 12px;
            }

            .form-group input {
                font-size: 16px;
                padding: 14px 16px;
            }

            .btn {
                font-size: 16px;
                padding: 16px;
            }
        }

        @media (max-width: 320px) {
            :root {
                --sidebar-width: 100%;
                --top-nav-height: 48px;
            }

            .app-panel {
                border-radius: 10px;
            }

            .logo h1 {
                font-size: 20px;
            }

            .form-group input {
                font-size: 16px;
                padding: 12px 14px;
            }

            .btn {
                font-size: 16px;
                padding: 14px;
            }

            .chat-input-area {
                padding: 10px;
            }

            .chat-input input {
                font-size: 16px;
                padding: 10px 12px;
            }
        }

        @media (max-height: 600px) {
            .auth-panel {
                padding: 20px;
                max-height: 90vh;
                overflow-y: auto;
            }

            .app-panel {
                max-height: 95vh;
            }

            .user-info {
                padding: 10px;
            }

            .panel-content {
                padding: 10px;
            }

            .list-item {
                padding: 8px;
                margin-bottom: 6px;
            }

            .chat-messages {
                padding: 10px;
            }

            .message {
                margin-bottom: 8px;
            }

            .chat-input-area {
                padding: 10px;
            }
        }

        /* Убедимся, что меню вложений не выходит за границы экрана */
        .attachment-btn {
            position: relative;
        }

        @media (max-width: 768px) {
            .attachment-menu {
                left: 0;
                right: auto;
                min-width: 180px;
                max-width: calc(100vw - 60px);
            }
        }

        @media (max-width: 480px) {
            .attachment-menu {
                min-width: 160px;
                transform-origin: bottom left;
            }
            
            .attachment-option {
                padding: 8px;
                font-size: 13px;
            }
        }

        /* Стили для аудиозвонков */
        .call-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.95);
            z-index: 2000;
            display: none;
            justify-content: center;
            align-items: center;
            color: white;
        }

        .call-overlay.active {
            display: flex;
        }

        .call-container {
            width: 90%;
            max-width: 800px;
            text-align: center;
        }

        .call-header {
            margin-bottom: 40px;
        }

        .call-header h2 {
            font-size: 28px;
            margin-bottom: 10px;
        }

        .call-header p {
            font-size: 18px;
            color: #aaa;
        }

        .call-timer {
            font-size: 48px;
            font-weight: bold;
            margin: 30px 0;
            color: var(--primary-color);
        }

        .call-audio-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 30px;
            margin: 40px 0;
        }

        .caller-avatar {
            width: 150px;
            height: 150px;
            background: var(--primary-gradient);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 48px;
            font-weight: bold;
            margin: 0 auto;
        }

        .call-audio-visualizer {
            width: 100%;
            max-width: 400px;
            height: 60px;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 3px;
        }

        .audio-bar {
            width: 4px;
            background: var(--primary-color);
            border-radius: 2px;
            animation: audioPulse 1s infinite;
        }

        @keyframes audioPulse {
            0%, 100% { height: 10px; }
            50% { height: 40px; }
        }

        .call-controls {
            display: flex;
            justify-content: center;
            gap: 20px;
            margin-top: 40px;
            flex-wrap: wrap;
        }

        .call-control-btn {
            width: 70px;
            height: 70px;
            border-radius: 50%;
            border: none;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 28px;
            cursor: pointer;
            transition: all 0.3s;
        }

        .call-control-btn.accept {
            background: var(--success-color);
            color: white;
        }

        .call-control-btn.decline {
            background: var(--error-color);
            color: white;
        }

        .call-control-btn.end {
            background: var(--error-color);
            color: white;
        }

        .call-control-btn.mute {
            background: #6b7280;
            color: white;
        }

        .call-control-btn.mute.active {
            background: var(--error-color);
        }

        .call-control-btn:hover {
            transform: scale(1.05);
            box-shadow: 0 5px 15px rgba(0,0,0,0.3);
        }

        .incoming-call-notification {
            position: fixed;
            top: 20px;
            right: 20px;
            width: 90%;
            max-width: 320px;
            background: white;
            border-radius: 15px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            z-index: 2001;
            overflow: hidden;
            animation: slideInCall 0.3s ease;
            display: none;
        }

        @keyframes slideInCall {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }

        .incoming-call-notification.show {
            display: block;
        }

        .incoming-call-header {
            background: var(--primary-gradient);
            color: white;
            padding: 20px;
            text-align: center;
        }

        .incoming-call-header h3 {
            margin-bottom: 5px;
            font-size: 18px;
        }

        .incoming-call-header p {
            font-size: 14px;
        }

        .incoming-call-content {
            padding: 20px;
            text-align: center;
        }

        .incoming-call-avatar {
            width: 60px;
            height: 60px;
            background: var(--primary-gradient);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 24px;
            font-weight: bold;
            margin: 0 auto 15px;
        }

        .incoming-call-actions {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }

        .incoming-call-actions button {
            flex: 1;
            padding: 12px;
            border: none;
            border-radius: 10px;
            font-weight: bold;
            cursor: pointer;
            transition: transform 0.2s;
            font-size: 14px;
        }

        .incoming-call-actions button:hover {
            transform: translateY(-2px);
        }

        .incoming-call-accept {
            background: var(--success-color);
            color: white;
        }

        .incoming-call-decline {
            background: var(--error-color);
            color: white;
        }

        .call-status {
            padding: 10px 20px;
            background: rgba(255,255,255,0.1);
            border-radius: 10px;
            margin: 20px 0;
            display: inline-block;
        }

        .volume-slider {
            width: 200px;
            margin: 20px auto;
        }

        .volume-slider input {
            width: 100%;
        }
        
        /* Стили для отладки */
        .debug-panel {
            position: fixed;
            top: 10px;
            left: 10px;
            background: rgba(0,0,0,0.8);
            color: white;
            padding: 10px;
            border-radius: 5px;
            font-size: 12px;
            max-width: 300px;
            z-index: 9999;
            display: none;
        }
        
        .debug-panel.show {
            display: block;
        }

        /* Поддержка iOS Safari */
        @supports (-webkit-touch-callout: none) {
            body, html {
                height: -webkit-fill-available;
            }
            
            .app-panel {
                max-height: -webkit-fill-available;
            }
            
            /* Убираем задержку 300ms для мобильных Safari */
            a, button, input[type="button"], input[type="submit"] {
                cursor: pointer;
                -webkit-tap-highlight-color: transparent;
            }
        }

        /* Для старых браузеров */
        @media all and (max-width: 1024px) {
            body {
                -webkit-text-size-adjust: 100%;
                -ms-text-size-adjust: 100%;
            }
        }

        /* Улучшаем читаемость на маленьких экранах */
        @media (max-width: 480px) {
            .list-item-title {
                font-size: 15px;
            }
            
            .list-item-preview {
                font-size: 13px;
            }
            
            .contact-info h4 {
                font-size: 15px;
            }
            
            .contact-info p {
                font-size: 13px;
            }
            
            .message-content {
                font-size: 15px;
            }
        }

        /* Исправления для полного заполнения экрана */
        @media (max-width: 768px) {
            body {
                padding: 0;
            }

            .app-panel {
                border-radius: 0;
                width: 100vw;
                height: 100vh;
                max-height: 100vh;
            }

            .auth-panel {
                border-radius: 10px;
                padding: 20px;
                margin: 10px;
                width: calc(100% - 20px);
                max-width: none;
            }
        }

        @media (max-width: 480px) {
            body {
                padding: 0;
                background: white;
            }
            
            .app-panel {
                box-shadow: none;
            }
        }
    </style>
</head>
<body>
    <!-- Панель авторизации -->
    <div class="auth-panel" id="authPanel">
        <div class="logo">
            <h1>Береста 🌿</h1>
            <p>Безопасный мессенджер с шифрованием</p>
        </div>
        
        <div id="loginForm">
            <div class="form-group">
                <label for="loginEmail">Email</label>
                <input type="email" id="loginEmail" placeholder="ваш@email.com">
                <div class="error-message" id="loginEmailError"></div>
            </div>
            
            <div class="form-group">
                <label for="loginPassword">Пароль</label>
                <input type="password" id="loginPassword" placeholder="••••••••">
                <div class="error-message" id="loginPasswordError"></div>
            </div>
            
            <button class="btn" onclick="login()">Войти</button>
            
            <div class="toggle-auth">
                Нет аккаунта? <a onclick="showRegister()">Зарегистрироваться</a>
            </div>
        </div>
        
        <div id="registerForm" style="display: none;">
            <div class="form-group">
                <label for="registerUsername">Имя пользователя</label>
                <input type="text" id="registerUsername" placeholder="Ваше имя">
                <div class="error-message" id="registerUsernameError"></div>
            </div>
            
            <div class="form-group">
                <label for="registerEmail">Email</label>
                <input type="email" id="registerEmail" placeholder="ваш@email.com">
                <div class="error-message" id="registerEmailError"></div>
            </div>
            
            <div class="form-group">
                <label for="registerPassword">Пароль</label>
                <input type="password" id="registerPassword" placeholder="минимум 6 символов">
                <div class="error-message" id="registerPasswordError"></div>
            </div>
            
            <button class="btn" onclick="register()">Зарегистрироваться</button>
            
            <div class="toggle-auth">
                Уже есть аккаунт? <a onclick="showLogin()">Войти</a>
            </div>
        </div>
    </div>

    <!-- Основной интерфейс (скрыт до входа) -->
    <div class="container" style="display: none;" id="appContainer">
        <div class="app-panel" id="appPanel">
            <!-- Верхняя панель навигации -->
            <div class="top-nav" id="topNav">
                <!-- Для главной страницы: переключатель чаты/контакты -->
                <div class="top-nav-content" id="mainNav">
                    <div class="nav-tabs">
                        <div class="nav-tab active" onclick="switchTab('chats')">
                            <i class="fas fa-comments"></i> <span>Чаты</span>
                        </div>
                        <div class="nav-tab" onclick="switchTab('contacts')">
                            <i class="fas fa-users"></i> <span>Контакты</span>
                        </div>
                    </div>
                    <div class="user-info-mini">
                        <div class="user-avatar-mini" id="userAvatarMini">Т</div>
                    </div>
                </div>
                
                <!-- Для страницы чата: кнопка назад + название чата -->
                <div class="top-nav-content" id="chatNav" style="display: none;">
                    <button class="back-button" onclick="goBackToMain()">
                        <i class="fas fa-arrow-left"></i>
                    </button>
                    <div class="chat-title" id="chatTitleNav">Название чата</div>
                    <div class="chat-actions-mini">
                        <button onclick="startAudioCall()" title="Аудиозвонок">
                            <i class="fas fa-phone"></i>
                        </button>
                        <button onclick="showChatInfo()" title="Информация о чате">
                            <i class="fas fa-info-circle"></i>
                        </button>
                    </div>
                </div>
            </div>

            <!-- Боковая панель (только для главной страницы) -->
            <div class="sidebar" id="sidebar">
                <!-- Информация о пользователе -->
                <div class="user-info">
                    <div class="user-avatar" id="userAvatar">Т</div>
                    <div class="user-details">
                        <h3 id="userName">Тестовый Пользователь</h3>
                        <p id="userEmail">test@example.com</p>
                    </div>
                </div>

                <!-- Содержимое вкладок -->
                <div class="content-panel">
                    <!-- Список чатов -->
                    <div class="panel-content active" id="chatsPanel">
                        <div class="search-box">
                            <input type="text" placeholder="Поиск чатов..." oninput="searchChats(this.value)">
                        </div>
                        <div id="chatsList">
                            <div class="loading">Загрузка чатов...</div>
                        </div>
                    </div>

                    <!-- Список контактов -->
                    <div class="panel-content" id="contactsPanel">
                        <div class="search-box">
                            <input type="text" placeholder="Поиск контактов..." oninput="searchContacts(this.value)">
                        </div>
                        <div id="contactsList">
                            <div class="loading">Загрузка контактов...</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Основная область чата -->
            <div class="chat-area" id="chatArea">
                <!-- Заглушка при отсутствии выбранного чата -->
                <div id="chatPlaceholder" style="display: flex; align-items: center; justify-content: center; height: 100%; color: #9ca3af;">
                    <div style="text-align: center; padding: 20px;">
                        <i class="fas fa-comments" style="font-size: 48px; margin-bottom: 20px;"></i>
                        <h3 style="margin-bottom: 10px; font-size: 18px;">Выберите чат</h3>
                        <p style="font-size: 14px;">Начните общение с контактом</p>
                    </div>
                </div>

                <!-- Интерфейс чата -->
                <div id="chatInterface" style="display: none; height: 100%; flex-direction: column;">
                    <div class="chat-messages" id="chatMessages">
                        <div class="empty-state">Сообщений пока нет</div>
                    </div>
                    
                    <!-- Индикатор печати -->
                    <div class="typing-indicator" id="typingIndicator">
                        <div class="typing-dots">
                            <div class="typing-dot"></div>
                            <div class="typing-dot"></div>
                            <div class="typing-dot"></div>
                        </div>
                        <span id="typingText">Печатает...</span>
                    </div>
                    
                    <!-- Область ввода сообщения -->
                    <div class="chat-input-area">
                        <div class="attachment-btn">
                            <button onclick="toggleAttachmentMenu()" style="background: none; border: none; cursor: pointer; color: #666; font-size: 20px; margin-right: 10px;">
                                <i class="fas fa-paperclip"></i>
                            </button>
                            <div class="attachment-menu" id="attachmentMenu">
                                <div class="attachment-option" onclick="attachFile()">
                                    <i class="fas fa-file"></i>
                                    <span>Прикрепить файл</span>
                                </div>
                                <div class="attachment-option" onclick="attachImage()">
                                    <i class="fas fa-image"></i>
                                    <span>Прикрепить изображение</span>
                                </div>
                                <div class="attachment-option" onclick="attachDocument()">
                                    <i class="fas fa-file-pdf"></i>
                                    <span>Документ PDF</span>
                                </div>
                                <div class="attachment-option" onclick="attachVideo()">
                                    <i class="fas fa-video"></i>
                                    <span>Видео файл</span>
                                </div>
                            </div>
                        </div>
                        
                        <div class="chat-input">
                            <input type="text" id="messageInput" placeholder="Введите сообщение..." 
                                   oninput="handleTyping()" onkeypress="handleKeyPress(event)">
                            <div class="input-hint">
                                <i class="fas fa-microphone"></i> Удерживайте для записи
                            </div>
                        </div>
                        <button class="send-button" id="sendButton" 
                                onmousedown="startVoiceRecording(event)" 
                                ontouchstart="startVoiceRecording(event)"
                                onmouseup="stopVoiceRecording(event)"
                                ontouchend="stopVoiceRecording(event)">
                            <i class="fas fa-paper-plane"></i>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Оверлей для аудиозвонков -->
    <div class="call-overlay" id="callOverlay">
        <div class="call-container">
            <div class="call-header" id="callHeader">
                <h2 id="callTitle">Аудиозвонок</h2>
                <p id="callStatus">Установка соединения...</p>
            </div>
            
            <div class="call-audio-container">
                <div class="caller-avatar" id="callerAvatar">Т</div>
                <div class="call-timer" id="callTimer">00:00</div>
                <div class="call-audio-visualizer" id="audioVisualizer">
                    <div class="audio-bar"></div>
                    <div class="audio-bar"></div>
                    <div class="audio-bar"></div>
                    <div class="audio-bar"></div>
                    <div class="audio-bar"></div>
                    <div class="audio-bar"></div>
                    <div class="audio-bar"></div>
                    <div class="audio-bar"></div>
                    <div class="audio-bar"></div>
                    <div class="audio-bar"></div>
                </div>
            </div>
            
            <div class="call-controls" id="callControls">
                <!-- Кнопки будут добавляться динамически -->
            </div>
        </div>
    </div>

    <!-- Уведомление о входящем звонке -->
    <div class="incoming-call-notification" id="incomingCallNotification">
        <div class="incoming-call-header">
            <h3>Входящий звонок</h3>
            <p>Аудиозвонок</p>
        </div>
        <div class="incoming-call-content">
            <div class="incoming-call-avatar" id="incomingCallAvatar">Т</div>
            <h4 id="incomingCallName">Имя звонящего</h4>
            <div class="call-ringing-animation">
                <div class="ringing-circle"></div>
                <div class="ringing-circle"></div>
                <div class="ringing-circle"></div>
            </div>
            <div class="incoming-call-actions">
                <button class="incoming-call-accept" onclick="acceptIncomingCall()">
                    <i class="fas fa-phone"></i> Принять
                </button>
                <button class="incoming-call-decline" onclick="declineIncomingCall()">
                    <i class="fas fa-phone-slash"></i> Отклонить
                </button>
            </div>
        </div>
    </div>

    <!-- Индикатор записи -->
    <div class="voice-indicator" id="voiceIndicator">
        <div class="voice-indicator-recording"></div>
        <div class="voice-indicator-timer" id="voiceTimer">00:00</div>
    </div>

    <!-- Прогресс загрузки файлов -->
    <div class="upload-progress" id="uploadProgress">
        <div class="progress-header">
            <span>Загрузка файлов</span>
            <button onclick="hideUploadProgress()" style="background: none; border: none; cursor: pointer; color: #666;">&times;</button>
        </div>
        <div class="progress-bar">
            <div class="progress-fill" id="progressFill"></div>
        </div>
        <div class="upload-list" id="uploadList"></div>
    </div>

    <!-- Модальное окно добавления контакта -->
    <div class="modal" id="addContactModal">
        <div class="modal-content">
            <div class="modal-header">
                <h3>Добавить контакт</h3>
                <button class="modal-close" onclick="closeModal('addContactModal')">&times;</button>
            </div>
            <div class="form-group">
                <label for="contactEmail">Email пользователя</label>
                <input type="email" id="contactEmail" placeholder="email@example.com">
                <div class="error-message" id="contactEmailError"></div>
            </div>
            <button class="btn" onclick="addContact()">Добавить</button>
        </div>
    </div>

    <!-- Уведомление -->
    <div class="notification" id="notification"></div>

    <!-- Кнопка добавления контакта -->
    <button class="add-contact-btn" onclick="showAddContactModal()" id="addContactBtn" style="display: none;">
        <i class="fas fa-user-plus"></i>
    </button>

    <!-- Панель отладки -->
    <div class="debug-panel" id="debugPanel">
        <div><strong>WebRTC Отладка:</strong></div>
        <div id="debugInfo">Загрузка...</div>
        <button onclick="toggleDebug()" style="margin-top: 5px; padding: 2px 5px; font-size: 10px;">Скрыть</button>
    </div>

    <script>
        // JavaScript код остается таким же, как в предыдущем варианте
        // Все функции и логика остаются без изменений
        
        let currentUser = null;
        let token = null;
        let currentChatId = null;
        let ws = null;
        let chats = [];
        let contacts = [];
        let mediaRecorder = null;
        let audioChunks = [];
        let recordingTimer = null;
        let recordingStartTime = null;
        let audioContext = null;
        let audioElements = new Map();
        let isRecording = false;
        let typingTimeout = null;
        let isTyping = false;
        let uploadQueue = [];
        let isUploading = false;
        
        // Переменные для аудиозвонков
        let peerConnection = null;
        let localStream = null;
        let remoteStream = null;
        let callTimerInterval = null;
        let callStartTime = null;
        let isInCall = false;
        let isCaller = false;
        let currentCallData = null;
        let muteAudio = false;
        let iceCandidatesQueue = [];
        let remoteAudioElement = null;
        let ringingInterval = null;
        let ringingAudio = null;
        let callTimeout = null;
        let debugMode = false;

        // Динамическое определение URL для Render
        const baseUrl = window.location.origin;
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = wsProtocol + '//' + window.location.host;
        
        console.log('Base URL:', baseUrl);
        console.log('WebSocket URL:', wsUrl);

        // WebSocket соединение
        function connectWebSocket() {
            if (!token) return;

            ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                console.log('WebSocket connected to:', wsUrl);
                ws.send(JSON.stringify({
                    type: 'authenticate',
                    token: token
                }));
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    console.log('WebSocket сообщение:', data.type);
                    handleWebSocketMessage(data);
                } catch (error) {
                    console.error('Error parsing WebSocket message:', error);
                }
            };

            ws.onclose = () => {
                console.log('WebSocket disconnected');
                setTimeout(connectWebSocket, 3000);
            };

            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };
        }

        function handleWebSocketMessage(data) {
            switch (data.type) {
                case 'authenticated':
                    console.log('Authenticated via WebSocket');
                    break;
                    
                case 'new_message':
                    if (data.message.chat_id === currentChatId) {
                        displayMessage(data.message);
                        hideTypingIndicator();
                    } else {
                        // Обновляем список чатов если пришло сообщение в другой чат
                        loadChats();
                    }
                    break;
                    
                case 'chat_created':
                    // Обновляем список чатов при создании нового чата
                    loadChats();
                    break;
                    
                case 'typing':
                    if (data.chatId === currentChatId && data.userId !== currentUser.id) {
                        showTypingIndicator(data.username);
                    }
                    break;
                    
                case 'call_offer':
                    console.log('Получен call_offer от:', data.callerData.callerName);
                    handleIncomingCall(data);
                    break;
                    
                case 'call_answer':
                    console.log('Получен call_answer от:', data.targetId);
                    handleCallAnswer(data);
                    break;
                    
                case 'call_ice_candidate':
                    console.log('Получен call_ice_candidate от:', data.senderId);
                    handleNewICECandidate(data);
                    break;
                    
                case 'call_end':
                    console.log('Получен call_end:', data.reason, 'от:', data.senderId);
                    handleCallEnd(data);
                    break;
                    
                case 'call_error':
                    console.log('Получена ошибка звонка:', data.error);
                    handleCallError(data);
                    break;
                    
                case 'call_offer_sent':
                    console.log('Предложение звонка отправлено');
                    break;
                    
                case 'auth_error':
                    console.error('WebSocket auth error:', data.message);
                    break;
            }
        }

        // Функции авторизации
        function showRegister() {
            document.getElementById('loginForm').style.display = 'none';
            document.getElementById('registerForm').style.display = 'block';
            clearErrors();
        }

        function showLogin() {
            document.getElementById('registerForm').style.display = 'none';
            document.getElementById('loginForm').style.display = 'block';
            clearErrors();
        }

        function clearErrors() {
            document.querySelectorAll('.error-message').forEach(el => {
                el.classList.remove('show');
                el.textContent = '';
            });
        }

        function showError(elementId, message) {
            const element = document.getElementById(elementId);
            element.textContent = message;
            element.classList.add('show');
        }

        async function login() {
            const email = document.getElementById('loginEmail').value.trim();
            const password = document.getElementById('loginPassword').value.trim();
            
            clearErrors();
            
            if (!email) {
                showError('loginEmailError', 'Введите email');
                return;
            }
            
            if (!password) {
                showError('loginPasswordError', 'Введите пароль');
                return;
            }

            try {
                const response = await fetch(baseUrl + '/api/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ email, password })
                });

                const data = await response.json();

                if (response.ok) {
                    token = data.token;
                    currentUser = data.user;
                    
                    // Обновляем информацию о пользователе
                    document.getElementById('userName').textContent = currentUser.username;
                    document.getElementById('userEmail').textContent = currentUser.email;
                    document.getElementById('userAvatar').textContent = currentUser.username.charAt(0);
                    document.getElementById('userAvatarMini').textContent = currentUser.username.charAt(0);
                    
                    // Переключаемся на основной интерфейс
                    document.getElementById('authPanel').style.display = 'none';
                    document.getElementById('appContainer').style.display = 'flex';
                    document.getElementById('appPanel').classList.add('active');
                    document.getElementById('addContactBtn').style.display = 'block';
                    
                    // Показываем главную страницу
                    showMainPage();
                    
                    // Загружаем данные и подключаем WebSocket
                    loadChats();
                    loadContacts();
                    connectWebSocket();
                    
                    // Запрашиваем разрешение на микрофон для голосовых сообщений и звонков
                    await requestMicrophonePermission();
                } else {
                    showError('loginPasswordError', data.error || 'Ошибка входа');
                }
            } catch (error) {
                console.error('Login error:', error);
                showError('loginPasswordError', 'Ошибка подключения к серверу');
            }
        }

        async function requestMicrophonePermission() {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ 
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        sampleRate: 48000,
                        channelCount: 1
                    }
                });
                stream.getTracks().forEach(track => track.stop());
                console.log('Микрофон доступен');
                return true;
            } catch (error) {
                console.warn('Микрофон недоступен:', error);
                showNotification('Для записи голосовых сообщений и звонков нужен доступ к микрофону', 'warning');
                return false;
            }
        }

        async function register() {
            const username = document.getElementById('registerUsername').value.trim();
            const email = document.getElementById('registerEmail').value.trim();
            const password = document.getElementById('registerPassword').value.trim();
            
            clearErrors();
            
            if (!username) {
                showError('registerUsernameError', 'Введите имя пользователя');
                return;
            }
            
            if (!email) {
                showError('registerEmailError', 'Введите email');
                return;
            }
            
            if (password.length < 6) {
                showError('registerPasswordError', 'Пароль должен содержать минимум 6 символов');
                return;
            }

            try {
                const response = await fetch(baseUrl + '/api/register', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ username, email, password })
                });

                const data = await response.json();

                if (response.ok) {
                    token = data.token;
                    currentUser = data.user;
                    
                    // Обновляем информацию о пользователе
                    document.getElementById('userName').textContent = currentUser.username;
                    document.getElementById('userEmail').textContent = currentUser.email;
                    document.getElementById('userAvatar').textContent = currentUser.username.charAt(0);
                    document.getElementById('userAvatarMini').textContent = currentUser.username.charAt(0);
                    
                    // Переключаемся на основной интерфейс
                    document.getElementById('authPanel').style.display = 'none';
                    document.getElementById('appContainer').style.display = 'flex';
                    document.getElementById('appPanel').classList.add('active');
                    document.getElementById('addContactBtn').style.display = 'block';
                    
                    // Показываем главную страницу
                    showMainPage();
                    
                    // Загружаем данные и подключаем WebSocket
                    loadChats();
                    loadContacts();
                    connectWebSocket();
                    
                    // Запрашиваем разрешение на микрофон
                    await requestMicrophonePermission();
                } else {
                    showError('registerEmailError', data.error || 'Ошибка регистрации');
                }
            } catch (error) {
                console.error('Register error:', error);
                showError('registerEmailError', 'Ошибка подключения к серверу');
            }
        }

        // Функции навигации
        function showMainPage() {
            // Показываем боковую панель и главную страницу
            document.getElementById('sidebar').style.display = 'flex';
            document.getElementById('chatInterface').style.display = 'none';
            document.getElementById('chatPlaceholder').style.display = 'flex';
            
            // Обновляем верхнюю навигацию
            document.getElementById('mainNav').style.display = 'flex';
            document.getElementById('chatNav').style.display = 'none';
            
            // Обновляем списки
            loadChats();
            loadContacts();
        }

        function goBackToMain() {
            showMainPage();
            currentChatId = null;
        }

        // Функции управления интерфейсом
        function switchTab(tabName) {
            // Обновляем активные вкладки
            document.querySelectorAll('.nav-tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            document.querySelectorAll('.panel-content').forEach(content => {
                content.classList.remove('active');
            });
            
            event.currentTarget.classList.add('active');
            document.getElementById(tabName + 'Panel').classList.add('active');
            
            // Показываем/скрываем кнопку добавления
            document.getElementById('addContactBtn').style.display = tabName === 'contacts' ? 'block' : 'none';
        }

        function toggleAttachmentMenu() {
            const menu = document.getElementById('attachmentMenu');
            menu.classList.toggle('show');
        }

        function hideAttachmentMenu() {
            const menu = document.getElementById('attachmentMenu');
            menu.classList.remove('show');
        }

        // Функции для прикрепления файлов
        function attachFile() {
            hideAttachmentMenu();
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = '*/*';
            input.onchange = (e) => handleFileUpload(e.target.files);
            input.click();
        }

        function attachImage() {
            hideAttachmentMenu();
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = 'image/*';
            input.onchange = (e) => handleFileUpload(e.target.files);
            input.click();
        }

        function attachDocument() {
            hideAttachmentMenu();
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = '.pdf,.doc,.docx,.txt,.rtf';
            input.onchange = (e) => handleFileUpload(e.target.files);
            input.click();
        }

        function attachVideo() {
            hideAttachmentMenu();
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = 'video/*';
            input.onchange = (e) => handleFileUpload(e.target.files);
            input.click();
        }

        function handleFileUpload(files) {
            if (!files.length || !currentChatId) {
                showNotification('Выберите файл для отправки', 'warning');
                return;
            }

            for (let file of files) {
                uploadQueue.push({
                    file: file,
                    status: 'pending',
                    progress: 0
                });
            }

            showUploadProgress();
            processUploadQueue();
        }

        function showUploadProgress() {
            document.getElementById('uploadProgress').classList.add('show');
            updateUploadList();
        }

        function hideUploadProgress() {
            document.getElementById('uploadProgress').classList.remove('show');
        }

        function updateUploadList() {
            const uploadList = document.getElementById('uploadList');
            let html = '';
            
            uploadQueue.forEach((item, index) => {
                const file = item.file;
                const status = item.status;
                const progress = item.progress;
                
                html += '<div class="upload-item ' + status + '">';
                html += '<i class="fas fa-file"></i>';
                html += '<span style="flex: 1;">' + file.name + ' (' + formatFileSize(file.size) + ')</span>';
                
                if (status === 'uploading') {
                    html += '<span>' + progress + '%</span>';
                } else if (status === 'success') {
                    html += '<i class="fas fa-check" style="color: #10b981;"></i>';
                } else if (status === 'error') {
                    html += '<i class="fas fa-times" style="color: #ef4444;"></i>';
                }
                
                html += '</div>';
            });
            
            uploadList.innerHTML = html;
            
            // Обновляем общий прогресс
            const totalProgress = uploadQueue.reduce((sum, item) => sum + item.progress, 0);
            const avgProgress = uploadQueue.length > 0 ? Math.round(totalProgress / uploadQueue.length) : 0;
            document.getElementById('progressFill').style.width = avgProgress + '%';
            
            // Если все загрузки завершены, скрываем через 3 секунды
            if (uploadQueue.length > 0 && uploadQueue.every(item => item.status === 'success' || item.status === 'error')) {
                setTimeout(() => {
                    if (uploadQueue.every(item => item.status === 'success' || item.status === 'error')) {
                        uploadQueue = [];
                        hideUploadProgress();
                    }
                }, 3000);
            }
        }

        async function processUploadQueue() {
            if (isUploading || uploadQueue.length === 0) return;
            
            isUploading = true;
            
            for (let i = 0; i < uploadQueue.length; i++) {
                if (uploadQueue[i].status === 'pending') {
                    await uploadFile(uploadQueue[i], i);
                }
            }
            
            isUploading = false;
        }

        async function uploadFile(item, index) {
            if (!currentChatId) {
                item.status = 'error';
                updateUploadList();
                return;
            }

            const formData = new FormData();
            formData.append('file', item.file);
            formData.append('chatId', currentChatId);

            item.status = 'uploading';
            updateUploadList();

            try {
                const xhr = new XMLHttpRequest();
                
                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        item.progress = Math.round((e.loaded / e.total) * 100);
                        updateUploadList();
                    }
                };

                xhr.onload = () => {
                    if (xhr.status === 200) {
                        item.status = 'success';
                        item.progress = 100;
                        updateUploadList();
                    } else {
                        item.status = 'error';
                        updateUploadList();
                        showNotification('Ошибка загрузки файла: ' + xhr.statusText, 'error');
                    }
                };

                xhr.onerror = () => {
                    item.status = 'error';
                    updateUploadList();
                    showNotification('Ошибка загрузки файла', 'error');
                };

                xhr.open('POST', baseUrl + '/api/upload-file');
                xhr.setRequestHeader('Authorization', 'Bearer ' + token);
                xhr.send(formData);

            } catch (error) {
                item.status = 'error';
                updateUploadList();
                showNotification('Ошибка загрузки файла', 'error');
            }
        }

        function formatFileSize(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        function getFileIcon(fileType) {
            if (fileType.includes('image')) return 'fas fa-image';
            if (fileType.includes('pdf')) return 'fas fa-file-pdf';
            if (fileType.includes('word') || fileType.includes('document')) return 'fas fa-file-word';
            if (fileType.includes('excel')) return 'fas fa-file-excel';
            if (fileType.includes('video')) return 'fas fa-file-video';
            if (fileType.includes('audio')) return 'fas fa-file-audio';
            if (fileType.includes('zip') || fileType.includes('archive')) return 'fas fa-file-archive';
            if (fileType.includes('text')) return 'fas fa-file-alt';
            return 'fas fa-file';
        }

        // Загрузка чатов
        async function loadChats() {
            try {
                const response = await fetch(baseUrl + '/api/chats', {
                    headers: {
                        'Authorization': 'Bearer ' + token
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    chats = data.chats || [];
                    displayChats(chats);
                } else {
                    console.error('Ошибка загрузки чатов:', response.status);
                }
            } catch (error) {
                console.error('Ошибка при загрузке чатов:', error);
            }
        }

        function displayChats(chatList) {
            const container = document.getElementById('chatsList');
            
            if (!chatList || chatList.length === 0) {
                container.innerHTML = '<div class="empty-state">Чатов пока нет</div>';
                return;
            }
            
            let html = '';
            for (const chat of chatList) {
                const chatName = chat.chat_name || chat.other_user_name || 'Личный чат';
                let lastMessage = chat.last_message || 'Нет сообщений';
                const time = chat.last_message_time ? formatTime(chat.last_message_time) : '';
                
                // Если это голосовое сообщение
                if (chat.last_message_type === 'voice') {
                    lastMessage = '<i class="fas fa-microphone"></i> Голосовое сообщение';
                }
                // Если это файл
                else if (chat.last_message_type === 'file') {
                    lastMessage = '<i class="fas fa-file"></i> Файл: ' + chat.file_name;
                }
                
                html += '<div class="list-item" onclick="openChat(' + chat.chat_id + ')">';
                html += '<div class="list-item-header">';
                html += '<div class="list-item-title">' + chatName + '</div>';
                html += '<div class="list-item-time">' + time + '</div>';
                html += '</div>';
                html += '<div class="list-item-preview">' + lastMessage + '</div>';
                html += '</div>';
            }
            container.innerHTML = html;
        }

        function searchChats(query) {
            const filtered = chats.filter(chat => {
                const chatName = chat.chat_name || chat.other_user_name || 'Личный чат';
                const lastMessage = chat.last_message || '';
                return chatName.toLowerCase().includes(query.toLowerCase()) ||
                       lastMessage.toLowerCase().includes(query.toLowerCase());
            });
            displayChats(filtered);
        }

        // Загрузка контактов
        async function loadContacts() {
            try {
                const response = await fetch(baseUrl + '/api/contacts', {
                    headers: {
                        'Authorization': 'Bearer ' + token
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    contacts = data.contacts || [];
                    displayContacts(contacts);
                } else {
                    console.error('Ошибка загрузки контактов:', response.status);
                }
            } catch (error) {
                console.error('Ошибка при загрузке контактов:', error);
            }
        }

        function displayContacts(contactList) {
            const container = document.getElementById('contactsList');
            
            if (!contactList || contactList.length === 0) {
                container.innerHTML = '<div class="empty-state">Контактов пока нет</div>';
                return;
            }
            
            let html = '';
            for (const contact of contactList) {
                html += '<div class="contact-item" onclick="startChatWithContact(' + contact.id + ')">';
                html += '<div class="contact-avatar">' + contact.username.charAt(0).toUpperCase() + '</div>';
                html += '<div class="contact-info">';
                html += '<h4>' + contact.username + '</h4>';
                html += '<p>' + contact.email + '</p>';
                html += '</div>';
                html += '</div>';
            }
            container.innerHTML = html;
        }

        function searchContacts(query) {
            const filtered = contacts.filter(contact => 
                contact.username.toLowerCase().includes(query.toLowerCase()) ||
                contact.email.toLowerCase().includes(query.toLowerCase())
            );
            displayContacts(filtered);
        }

        // Работа с чатами
        async function openChat(chatId) {
            currentChatId = chatId;
            
            // Скрываем главную страницу
            document.getElementById('sidebar').style.display = 'none';
            document.getElementById('chatPlaceholder').style.display = 'none';
            document.getElementById('chatInterface').style.display = 'flex';
            
            // Обновляем верхнюю навигацию
            document.getElementById('mainNav').style.display = 'none';
            document.getElementById('chatNav').style.display = 'flex';
            
            // Загружаем сообщения
            await loadMessages(chatId);
            
            // Обновляем заголовок чата
            const chat = chats.find(c => c.chat_id === chatId);
            if (chat) {
                const chatName = chat.chat_name || chat.other_user_name || 'Личный чат';
                document.getElementById('chatTitleNav').textContent = chatName;
            }
            
            // Фокус на поле ввода
            document.getElementById('messageInput').focus();
            
            // Восстанавливаем состояние аудиоплееров
            restoreAudioPlayers();
        }

        async function loadMessages(chatId) {
            try {
                const response = await fetch(baseUrl + '/api/messages/' + chatId, {
                    headers: {
                        'Authorization': 'Bearer ' + token
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    displayMessages(data.messages || []);
                } else {
                    console.error('Ошибка загрузки сообщений:', response.status);
                }
            } catch (error) {
                console.error('Ошибка при загрузке сообщений:', error);
            }
        }

        function displayMessages(messages) {
            const container = document.getElementById('chatMessages');
            
            if (!messages || messages.length === 0) {
                container.innerHTML = '<div class="empty-state">Сообщений пока нет</div>';
                return;
            }
            
            let html = '';
            for (const message of messages) {
                const isOwn = message.user_id === currentUser.id;
                html += '<div class="message ' + (isOwn ? 'own' : '') + '" data-message-id="' + message.id + '">';
                
                if (message.message_type === 'voice') {
                    // Голосовое сообщение
                    html += '<div class="message-content voice-message">';
                    html += '<button class="voice-play-btn" onclick="toggleAudioPlayback(' + message.id + ')" data-audio-url="' + message.audio_url + '">';
                    html += '<i class="fas fa-play"></i>';
                    html += '</button>';
                    html += '<span class="voice-duration">' + formatDuration(message.duration) + '</span>';
                    html += '<div class="voice-waveform">';
                    html += '<div class="voice-wave" id="waveform-' + message.id + '">';
                    // Генерируем волны
                    for (let i = 0; i < 20; i++) {
                        const height = Math.random() * 20 + 5;
                        html += '<div class="voice-bar" style="height:' + height + 'px"></div>';
                    }
                    html += '</div>';
                    html += '</div>';
                    html += '</div>';
                } else if (message.message_type === 'file') {
                    // Файловое сообщение
                    const fileUrl = baseUrl + message.file_url;
                    const fileIcon = getFileIcon(message.file_type);
                    
                    html += '<a href="' + fileUrl + '" target="_blank" download="' + message.file_name + '" class="message-content file-message">';
                    html += '<div class="file-icon">';
                    html += '<i class="' + fileIcon + '"></i>';
                    html += '</div>';
                    html += '<div class="file-info">';
                    html += '<div class="file-name">' + message.file_name + '</div>';
                    html += '<div class="file-size">' + formatFileSize(message.file_size) + '</div>';
                    html += '</div>';
                    html += '<div class="download-btn">';
                    html += '<i class="fas fa-download"></i>';
                    html += '</div>';
                    html += '</a>';
                } else {
                    // Текстовое сообщение
                    html += '<div class="message-content">' + message.content + '</div>';
                }
                
                html += '<div class="message-info">';
                if (!isOwn) {
                    html += '<span>' + message.username + '</span>';
                }
                html += '<span>' + formatTime(message.created_at) + '</span>';
                html += '</div>';
                html += '</div>';
            }
            container.innerHTML = html;
            
            // Прокручиваем вниз
            container.scrollTop = container.scrollHeight;
        }

        function displayMessage(message) {
            const container = document.getElementById('chatMessages');
            
            // Убираем сообщение "Сообщений пока нет"
            if (container.querySelector('.empty-state')) {
                container.innerHTML = '';
            }
            
            const isOwn = message.user_id === currentUser.id;
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message ' + (isOwn ? 'own' : '');
            messageDiv.setAttribute('data-message-id', message.id);
            
            if (message.message_type === 'voice') {
                // Голосовое сообщение
                messageDiv.innerHTML = '<div class="message-content voice-message">' +
                    '<button class="voice-play-btn" onclick="toggleAudioPlayback(' + message.id + ')" data-audio-url="' + message.audio_url + '">' +
                    '<i class="fas fa-play"></i>' +
                    '</button>' +
                    '<span class="voice-duration">' + formatDuration(message.duration) + '</span>' +
                    '<div class="voice-waveform">' +
                    '<div class="voice-wave" id="waveform-' + message.id + '">' +
                    generateWaveformBars() +
                    '</div>' +
                    '</div>' +
                    '</div>' +
                    '<div class="message-info">' +
                    (isOwn ? '' : '<span>' + message.username + '</span>') +
                    '<span>' + formatTime(message.created_at) + '</span>' +
                    '</div>';
            } else if (message.message_type === 'file') {
                // Файловое сообщение
                const fileUrl = baseUrl + message.file_url;
                const fileIcon = getFileIcon(message.file_type);
                
                messageDiv.innerHTML = '<a href="' + fileUrl + '" target="_blank" download="' + message.file_name + '" class="message-content file-message">' +
                    '<div class="file-icon">' +
                    '<i class="' + fileIcon + '"></i>' +
                    '</div>' +
                    '<div class="file-info">' +
                    '<div class="file-name">' + message.file_name + '</div>' +
                    '<div class="file-size">' + formatFileSize(message.file_size) + '</div>' +
                    '</div>' +
                    '<div class="download-btn">' +
                    '<i class="fas fa-download"></i>' +
                    '</div>' +
                    '</a>' +
                    '<div class="message-info">' +
                    (isOwn ? '' : '<span>' + message.username + '</span>') +
                    '<span>' + formatTime(message.created_at) + '</span>' +
                    '</div>';
            } else {
                // Текстовое сообщение
                messageDiv.innerHTML = '<div class="message-content">' + message.content + '</div>' +
                    '<div class="message-info">' +
                    (isOwn ? '' : '<span>' + message.username + '</span>') +
                    '<span>' + formatTime(message.created_at) + '</span>' +
                    '</div>';
            }
            
            container.appendChild(messageDiv);
            container.scrollTop = container.scrollHeight;
        }

        function generateWaveformBars() {
            let bars = '';
            for (let i = 0; i < 20; i++) {
                const height = Math.random() * 20 + 5;
                bars += '<div class="voice-bar" style="height:' + height + 'px"></div>';
            }
            return bars;
        }

        // Голосовые сообщения
        async function startVoiceRecording(e) {
            e.preventDefault();
            
            const input = document.getElementById('messageInput');
            const sendButton = document.getElementById('sendButton');
            
            // Если есть текст в поле ввода, отправляем его при клике
            if (input.value.trim() && !isRecording) {
                sendMessage();
                return;
            }
            
            // Если нет текста, начинаем запись голосового сообщения
            if (isRecording || !currentChatId) {
                return;
            }
            
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ 
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        sampleRate: 44100
                    } 
                });
                
                mediaRecorder = new MediaRecorder(stream);
                audioChunks = [];
                
                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        audioChunks.push(event.data);
                    }
                };
                
                mediaRecorder.onstop = async () => {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    
                    // Останавливаем все треки
                    stream.getTracks().forEach(track => track.stop());
    
                    // Сбрасываем состояние кнопки сразу после остановки записи
                    const sendButton = document.getElementById('sendButton');
                    sendButton.classList.remove('recording');
                    sendButton.innerHTML = '<i class="fas fa-paper-plane"></i>';
                    sendButton.style.background = 'var(--primary-color)';
                    document.getElementById('voiceIndicator').classList.remove('show');
                    clearInterval(recordingTimer);
    
                    // Отправляем голосовое сообщение
                    await sendVoiceMessage(audioBlob);
    
                    showNotification('Голосовое сообщение отправлено', 'success');
                };
                
                // Начинаем запись
                mediaRecorder.start(100); // Собираем данные каждые 100мс
                
                // Обновляем UI
                sendButton.classList.add('recording');
                sendButton.innerHTML = '<i class="fas fa-stop"></i>';
                document.getElementById('voiceIndicator').classList.add('show');
                
                // Запускаем таймер
                isRecording = true;
                recordingStartTime = Date.now();
                recordingTimer = setInterval(updateRecordingTimer, 1000);
                updateRecordingTimer();
                
            } catch (error) {
                console.error('Ошибка записи:', error);
                showNotification('Не удалось начать запись. Проверьте доступ к микрофону.', 'error');
            }
        }

        function stopVoiceRecording(e) {
            e.preventDefault();

            if (!isRecording) return;

            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();

                // Если запись длилась менее 1 секунды, считаем это отменой
                const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
                if (elapsed < 1) {
                    showNotification('Запись отменена', 'info');
                    // Сбрасываем состояние кнопки
                    const sendButton = document.getElementById('sendButton');
                    sendButton.classList.remove('recording');
                    sendButton.innerHTML = '<i class="fas fa-paper-plane"></i>';
                    sendButton.style.background = 'var(--primary-color)';
                    document.getElementById('voiceIndicator').classList.remove('show');
                    clearInterval(recordingTimer);
                    isRecording = false;
                }
            }
        }

        function updateRecordingTimer() {
            if (!recordingStartTime || !isRecording) return;
            
            const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
            const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const seconds = (elapsed % 60).toString().padStart(2, '0');
            
            document.getElementById('voiceTimer').textContent = minutes + ':' + seconds;
            
            // Максимальная длительность записи - 2 минуты
            if (elapsed >= 120) {
                stopVoiceRecording({ preventDefault: () => {} });
            }
        }

        async function sendVoiceMessage(audioBlob) {
            if (!currentChatId || !ws) {
                showNotification('Нет активного чата', 'error');
                return;
            }

            // Создаем FormData для отправки файла
            const formData = new FormData();
            formData.append('audio', audioBlob, 'voice-message.webm');
            formData.append('chatId', currentChatId);
            formData.append('duration', Math.floor((Date.now() - recordingStartTime) / 1000));

            try {
                const response = await fetch(baseUrl + '/api/upload-audio', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + token
                    },
                    body: formData
                });

                if (response.ok) {
                    console.log('Голосовое сообщение отправлено');
                    // Сбрасываем состояние кнопки после успешной отправки
                    resetSendButton();
                } else {
                    const error = await response.json();
                    showNotification('Ошибка отправки: ' + error.error, 'error');
                    // Тоже сбрасываем состояние кнопки при ошибке
                    resetSendButton();
                }
            } catch (error) {
                console.error('Ошибка отправки голосового сообщения:', error);
                showNotification('Ошибка отправки', 'error');
                // Сбрасываем состояние кнопки при ошибке сети
                resetSendButton();
            }
        }

        // Добавляем функцию для сброса состояния кнопки отправки
        function resetSendButton() {
            const sendButton = document.getElementById('sendButton');
            sendButton.classList.remove('recording');
            sendButton.innerHTML = '<i class="fas fa-paper-plane"></i>';
            sendButton.style.background = 'var(--primary-color)';

            // Также сбрасываем индикатор записи
            document.getElementById('voiceIndicator').classList.remove('show');
            clearInterval(recordingTimer);
            isRecording = false;
        }

        // Воспроизведение голосовых сообщений
        function toggleAudioPlayback(messageId) {
            const playButton = document.querySelector('[onclick="toggleAudioPlayback(' + messageId + ')"]');
            const audioUrl = playButton.getAttribute('data-audio-url');
            
            if (!audioElements.has(messageId)) {
                // Создаем новый аудио элемент
                const audio = new Audio(baseUrl + audioUrl);
                audioElements.set(messageId, audio);
                
                audio.addEventListener('play', () => {
                    playButton.classList.add('playing');
                    playButton.innerHTML = '<i class="fas fa-pause"></i>';
                    animateWaveform(messageId, true);
                });
                
                audio.addEventListener('pause', () => {
                    playButton.classList.remove('playing');
                    playButton.innerHTML = '<i class="fas fa-play"></i>';
                    animateWaveform(messageId, false);
                });
                
                audio.addEventListener('ended', () => {
                    playButton.classList.remove('playing');
                    playButton.innerHTML = '<i class="fas fa-play"></i>';
                    animateWaveform(messageId, false);
                });
            }
            
            const audio = audioElements.get(messageId);
            
            if (audio.paused) {
                // Останавливаем все другие аудио
                audioElements.forEach((otherAudio, otherId) => {
                    if (otherId !== messageId && !otherAudio.paused) {
                        otherAudio.pause();
                    }
                });
                
                audio.play();
            } else {
                audio.pause();
            }
        }

        function animateWaveform(messageId, isPlaying) {
            const waveform = document.getElementById('waveform-' + messageId);
            if (!waveform) return;
            
            const bars = waveform.querySelectorAll('.voice-bar');
            
            if (isPlaying) {
                bars.forEach(bar => {
                    bar.style.animation = 'wave 0.5s ease-in-out infinite alternate';
                });
            } else {
                bars.forEach(bar => {
                    bar.style.animation = '';
                });
            }
        }

        function restoreAudioPlayers() {
            // Восстанавливаем состояние всех аудиоплееров
            document.querySelectorAll('.voice-play-btn').forEach(button => {
                const onclickAttr = button.getAttribute('onclick');
                if (onclickAttr) {
                    const match = onclickAttr.match(/toggleAudioPlayback\\((\d+)\\)/);
                    if (match) {
                        const messageId = parseInt(match[1]);
                        if (audioElements.has(messageId)) {
                            const audio = audioElements.get(messageId);
                            if (!audio.paused) {
                                button.classList.add('playing');
                                button.innerHTML = '<i class="fas fa-pause"></i>';
                                animateWaveform(messageId, true);
                            }
                        }
                    }
                }
            });
        }

        // Отправка сообщений
        async function sendMessage() {
            const input = document.getElementById('messageInput');
            const content = input.value.trim();
            
            if (!content || !currentChatId || !ws) return;
            
            // Отправляем через WebSocket
            ws.send(JSON.stringify({
                type: 'message',
                chatId: currentChatId,
                content: content
            }));
            
            // Очищаем поле ввода
            input.value = '';
            input.focus();
            
            // Убираем индикатор печати
            hideTypingIndicator();
            isTyping = false;
            if (typingTimeout) clearTimeout(typingTimeout);
        }

        function handleKeyPress(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        }

        // Индикатор печати
        function handleTyping() {
            const input = document.getElementById('messageInput');
            
            if (!isTyping && input.value.trim()) {
                isTyping = true;
                // Отправляем уведомление о печати
                if (ws && ws.readyState === WebSocket.OPEN && currentChatId) {
                    ws.send(JSON.stringify({
                        type: 'typing',
                        chatId: currentChatId,
                        userId: currentUser.id,
                        username: currentUser.username
                    }));
                }
            }
            
            // Сбрасываем таймер
            if (typingTimeout) clearTimeout(typingTimeout);
            typingTimeout = setTimeout(() => {
                isTyping = false;
            }, 1000);
        }

        function showTypingIndicator(username) {
            const indicator = document.getElementById('typingIndicator');
            const typingText = document.getElementById('typingText');
            
            typingText.textContent = username + ' печатает...';
            indicator.classList.add('show');
            
            // Автоматически скрываем через 3 секунды
            setTimeout(() => {
                hideTypingIndicator();
            }, 3000);
        }

        function hideTypingIndicator() {
            const indicator = document.getElementById('typingIndicator');
            indicator.classList.remove('show');
        }

        // Управление контактами
        function showAddContactModal() {
            document.getElementById('addContactModal').classList.add('active');
        }

        function closeModal(modalId) {
            document.getElementById(modalId).classList.remove('active');
            clearErrors();
        }

        async function addContact() {
            const email = document.getElementById('contactEmail').value.trim();
            
            if (!email) {
                showError('contactEmailError', 'Введите email');
                return;
            }

            try {
                const response = await fetch(baseUrl + '/api/contacts', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ email })
                });

                const data = await response.json();

                if (response.ok) {
                    showNotification('Контакт добавлен!', 'success');
                    closeModal('addContactModal');
                    loadContacts();
                    loadChats();
                } else {
                    showError('contactEmailError', data.error || 'Ошибка добавления контакта');
                }
            } catch (error) {
                showError('contactEmailError', 'Ошибка подключения к серверу');
            }
        }

        async function startChatWithContact(contactId) {
            try {
                const response = await fetch(baseUrl + '/api/start-chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ contactId: contactId })
                });

                const data = await response.json();

                if (response.ok) {
                    // Открываем чат
                    openChat(data.chatId);
                } else {
                    showNotification('Ошибка: ' + data.error, 'error');
                }
            } catch (error) {
                showNotification('Ошибка подключения к серверу', 'error');
            }
        }

        // ==================== АУДИОЗВОНКИ ====================

        // Конфигурация WebRTC
        const peerConnectionConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' }
            ],
            iceTransportPolicy: 'all',
            rtcpMuxPolicy: 'require',
            bundlePolicy: 'max-bundle'
        };

        // Начать аудиозвонок
        async function startAudioCall() {
            if (!currentChatId) {
                showNotification('Выберите чат для звонка', 'warning');
                return;
            }

            try {
                // Получаем ID собеседника
                const otherUserId = await getOtherUserId();
                if (!otherUserId) {
                    showNotification('Не удалось определить собеседника', 'error');
                    return;
                }

                console.log('Начинаем звонок пользователю ID:', otherUserId);

                // Получаем медиа поток (микрофон)
                localStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        sampleRate: 48000,
                        channelCount: 1
                    },
                    video: false
                });

                console.log('Локальный поток получен, треков:', localStream.getTracks().length);

                // Создаем RTCPeerConnection
                peerConnection = new RTCPeerConnection(peerConnectionConfig);

                // Добавляем локальный поток
                localStream.getTracks().forEach(track => {
                    console.log('Добавление трека:', track.kind, track.id);
                    peerConnection.addTrack(track, localStream);
                });

                // Обработка удаленного потока
                peerConnection.ontrack = (event) => {
                    console.log('Получен удаленный трек:', event.track.kind);
                    
                    if (!remoteStream) {
                        remoteStream = new MediaStream();
                    }
                    
                    remoteStream.addTrack(event.track);
                    
                    // Воспроизводим удаленный звук
                    playRemoteAudio();
                    
                    console.log('Удаленный поток обработан, треков:', remoteStream.getTracks().length);
                };

                // Обработка ICE кандидатов
                peerConnection.onicecandidate = (event) => {
                    console.log('Новый ICE кандидат:', event.candidate ? event.candidate.candidate : 'null');
                    
                    if (event.candidate && ws && ws.readyState === WebSocket.OPEN && currentCallData) {
                        ws.send(JSON.stringify({
                            type: 'call_ice_candidate',
                            chatId: currentChatId,
                            targetId: otherUserId,
                            candidate: event.candidate
                        }));
                    }
                };

                // Отслеживание состояния соединения
                peerConnection.onconnectionstatechange = () => {
                    console.log('Состояние соединения:', peerConnection.connectionState);
                    
                    if (peerConnection.connectionState === 'connected') {
                        console.log('Соединение установлено!');
                        updateCallStatus('Соединение установлено');
                        startCallTimer();
                        showNotification('Звонок подключен', 'success');
                        
                        // Очищаем очередь ICE кандидатов
                        iceCandidatesQueue = [];
                        
                    } else if (peerConnection.connectionState === 'disconnected' ||
                               peerConnection.connectionState === 'failed' ||
                               peerConnection.connectionState === 'closed') {
                        console.log('Соединение прервано');
                        endCall();
                        showNotification('Соединение прервано', 'error');
                    }
                };

                peerConnection.oniceconnectionstatechange = () => {
                    console.log('ICE состояние:', peerConnection.iceConnectionState);
                    
                    if (peerConnection.iceConnectionState === 'connected') {
                        console.log('ICE соединение установлено');
                    }
                };

                // Обработка переговоров
                peerConnection.onnegotiationneeded = async () => {
                    console.log('Требуется пересогласование соединения');
                };

                // Создаем предложение (offer)
                const offerOptions = {
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: false,
                    voiceActivityDetection: true
                };
                
                console.log('Создание предложения...');
                const offer = await peerConnection.createOffer(offerOptions);
                console.log('Предложение создано, установка локального описания...');
                await peerConnection.setLocalDescription(offer);
                console.log('Локальное описание установлено');

                // Подготавливаем данные для вызова
                isCaller = true;
                currentCallData = {
                    chatId: currentChatId,
                    callerId: currentUser.id,
                    callerName: currentUser.username,
                    targetId: otherUserId,
                    offer: offer
                };

                // Отправляем предложение через WebSocket
                if (ws && ws.readyState === WebSocket.OPEN) {
                    console.log('Отправка call_offer пользователю', otherUserId);
                    
                    ws.send(JSON.stringify({
                        type: 'call_offer',
                        chatId: currentChatId,
                        targetId: otherUserId,
                        offer: offer,
                        callerData: currentCallData
                    }));
                    
                    // Показываем интерфейс звонка
                    showCallInterface('Исходящий звонок...', 'Исходящий звонок', 'Ожидание ответа...');
                    
                    // Таймаут ожидания ответа (60 секунд)
                    callTimeout = setTimeout(() => {
                        if (!isInCall) {
                            console.log('Таймаут ожидания ответа');
                            showNotification('Собеседник не отвечает', 'error');
                            endCall();
                        }
                    }, 60000);
                    
                } else {
                    showNotification('Ошибка соединения WebSocket', 'error');
                    cleanupCall();
                }

            } catch (error) {
                console.error('Ошибка при начале звонка:', error);
                showNotification('Не удалось начать звонок: ' + error.message, 'error');
                cleanupCall();
            }
        }

        // Воспроизведение удаленного аудио
        function playRemoteAudio() {
            if (!remoteStream) {
                console.log('Нет удаленного потока для воспроизведения');
                return;
            }

            try {
                if (remoteAudioElement) {
                    remoteAudioElement.srcObject = null;
                }

                remoteAudioElement = new Audio();
                remoteAudioElement.srcObject = remoteStream;
                remoteAudioElement.autoplay = true;
                remoteAudioElement.volume = 1.0;

                // Для мобильных устройств - требуем пользовательское взаимодействие
                const playPromise = remoteAudioElement.play();
                
                if (playPromise !== undefined) {
                    playPromise.catch(error => {
                        console.log('Автовоспроизведение заблокировано, требуется пользовательское взаимодействие');
                        
                        // Пробуем воспроизвести после клика пользователя
                        document.addEventListener('click', function tryPlayOnce() {
                            remoteAudioElement.play().then(() => {
                                console.log('Удаленный звук воспроизведен после клика');
                            }).catch(e => {
                                console.error('Снова ошибка воспроизведения:', e);
                            });
                            document.removeEventListener('click', tryPlayOnce);
                        });
                    });
                }
            } catch (error) {
                console.error('Ошибка создания аудио элемента:', error);
            }
        }

        // Обработка входящего звонка
        async function handleIncomingCall(data) {
            console.log('Входящий звонок от:', data.callerData.callerName);
            
            // Сохраняем данные звонка
            currentCallData = data.callerData;
            currentCallData.offer = data.offer;
            
            // Показываем уведомление
            document.getElementById('incomingCallName').textContent = data.callerData.callerName;
            document.getElementById('incomingCallAvatar').textContent = data.callerData.callerName.charAt(0);
            document.getElementById('incomingCallNotification').classList.add('show');
            
            // Воспроизводим звук звонка
            playRingtone();
            
            // Автоматическое отклонение через 45 секунд
            setTimeout(() => {
                if (document.getElementById('incomingCallNotification').classList.contains('show')) {
                    console.log('Автоматическое отклонение звонка (таймаут)');
                    declineIncomingCall();
                }
            }, 45000);
        }

        // Воспроизвести звук звонка
        function playRingtone() {
            try {
                // Создаем простой звонок с использованием Web Audio API
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                ringingAudio = audioContext;
                
                ringingInterval = setInterval(() => {
                    const oscillator = audioContext.createOscillator();
                    const gainNode = audioContext.createGain();
                    
                    oscillator.connect(gainNode);
                    gainNode.connect(audioContext.destination);
                    
                    oscillator.frequency.value = 800;
                    oscillator.type = 'sine';
                    
                    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
                    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
                    
                    oscillator.start(audioContext.currentTime);
                    oscillator.stop(audioContext.currentTime + 0.5);
                }, 2000);
                
            } catch (error) {
                console.error('Ошибка воспроизведения мелодии звонка:', error);
            }
        }

        // Остановить звук звонка
        function stopRingtone() {
            if (ringingInterval) {
                clearInterval(ringingInterval);
                ringingInterval = null;
            }
            if (ringingAudio) {
                ringingAudio.close().catch(e => console.error('Ошибка закрытия аудиоконтекста:', e));
                ringingAudio = null;
            }
        }

        // Принять входящий звонок
        async function acceptIncomingCall() {
            console.log('Принимаем входящий звонок');
            
            stopRingtone();
            document.getElementById('incomingCallNotification').classList.remove('show');
            
            try {
                // Получаем медиа поток (микрофон)
                localStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        sampleRate: 48000,
                        channelCount: 1
                    },
                    video: false
                });
                
                console.log('Локальный поток получен для ответа');

                // Создаем RTCPeerConnection
                peerConnection = new RTCPeerConnection(peerConnectionConfig);

                // Добавляем локальный поток
                localStream.getTracks().forEach(track => {
                    peerConnection.addTrack(track, localStream);
                });

                // Обработка удаленного потока
                peerConnection.ontrack = (event) => {
                    console.log('Получен удаленный трек при ответе:', event.track.kind);
                    
                    if (!remoteStream) {
                        remoteStream = new MediaStream();
                    }
                    
                    remoteStream.addTrack(event.track);
                    
                    // Воспроизводим удаленный звук
                    playRemoteAudio();
                };

                // Обработка ICE кандидатов
                peerConnection.onicecandidate = (event) => {
                    if (event.candidate && ws && ws.readyState === WebSocket.OPEN && currentCallData) {
                        ws.send(JSON.stringify({
                            type: 'call_ice_candidate',
                            chatId: currentCallData.chatId,
                            targetId: currentCallData.callerId,
                            candidate: event.candidate
                        }));
                    }
                };

                // Отслеживание состояния
                peerConnection.onconnectionstatechange = () => {
                    console.log('Состояние соединения при ответе:', peerConnection.connectionState);
                    
                    if (peerConnection.connectionState === 'connected') {
                        console.log('Соединение установлено при ответе!');
                        updateCallStatus('Соединение установлено');
                        startCallTimer();
                        showNotification('Звонок подключен', 'success');
                    } else if (peerConnection.connectionState === 'disconnected' ||
                               peerConnection.connectionState === 'failed' ||
                               peerConnection.connectionState === 'closed') {
                        console.log('Соединение прервано при ответе');
                        endCall();
                        showNotification('Соединение прервано', 'error');
                    }
                };

                // Устанавливаем удаленное предложение
                console.log('Установка удаленного описания...');
                await peerConnection.setRemoteDescription(new RTCSessionDescription(currentCallData.offer));
                console.log('Удаленное описание установлено');

                // Создаем ответ
                console.log('Создание ответа...');
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                console.log('Ответ создан и локальное описание установлено');

                // Отправляем ответ
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'call_answer',
                        chatId: currentCallData.chatId,
                        targetId: currentCallData.callerId,
                        answer: answer
                    }));
                    
                    // Показываем интерфейс звонка
                    isCaller = false;
                    isInCall = true;
                    showCallInterface('Входящий звонок...', 'Аудиозвонок', 'Соединение...');
                    
                    document.getElementById('callerAvatar').textContent = currentCallData.callerName.charAt(0);
                    document.getElementById('callTitle').textContent = 'Звонок с ' + currentCallData.callerName;
                    
                    // Обрабатываем накопленные ICE кандидаты
                    if (iceCandidatesQueue.length > 0) {
                        console.log('Обработка накопленных ICE кандидатов:', iceCandidatesQueue.length);
                        for (const candidate of iceCandidatesQueue) {
                            try {
                                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                            } catch (error) {
                                console.error('Ошибка добавления ICE кандидата из очереди:', error);
                            }
                        }
                        iceCandidatesQueue = [];
                    }
                }

            } catch (error) {
                console.error('Ошибка при принятии звонка:', error);
                showNotification('Не удалось принять звонок: ' + error.message, 'error');
                cleanupCall();
            }
        }

        // Отклонить входящий звонок
        function declineIncomingCall() {
            console.log('Отклоняем входящий звонок');
            stopRingtone();
            document.getElementById('incomingCallNotification').classList.remove('show');
            
            // Отправляем сообщение об отказе
            if (ws && ws.readyState === WebSocket.OPEN && currentCallData && currentCallData.callerId) {
                ws.send(JSON.stringify({
                    type: 'call_end',
                    chatId: currentCallData.chatId,
                    targetId: currentCallData.callerId,
                    reason: 'declined'
                }));
            }
            
            // Очищаем данные
            currentCallData = null;
            
            showNotification('Звонок отклонен', 'info');
        }

        // Обработка ответа на звонок
        async function handleCallAnswer(data) {
            console.log('Обрабатываем ответ на звонок от пользователя:', data.targetId);
            
            if (!peerConnection || !isCaller) {
                console.log('Нет активного соединения или не вызывающий');
                return;
            }
            
            try {
                // Устанавливаем удаленное описание
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
                console.log('Удаленное описание установлено из ответа');
                
                // Обрабатываем накопленные ICE кандидаты
                if (iceCandidatesQueue.length > 0) {
                    console.log('Обработка накопленных ICE кандидатов из ответа:', iceCandidatesQueue.length);
                    for (const candidate of iceCandidatesQueue) {
                        try {
                            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                        } catch (error) {
                            console.error('Ошибка добавления ICE кандидата:', error);
                        }
                    }
                    iceCandidatesQueue = [];
                }
                
            } catch (error) {
                console.error('Ошибка при обработке ответа на звонок:', error);
            }
        }

        // Обработка новых ICE кандидатов
        async function handleNewICECandidate(data) {
            console.log('Обработка нового ICE кандидата от пользователя:', data.senderId);
            
            if (!peerConnection) {
                // Сохраняем в очередь для последующей обработки
                console.log('Соединение еще не готово, сохраняем кандидат в очередь');
                iceCandidatesQueue.push(data.candidate);
                return;
            }
            
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
                console.log('ICE кандидат успешно добавлен');
            } catch (error) {
                console.error('Ошибка при добавлении ICE кандидата:', error);
            }
        }

        // Обработка завершения звонка
        function handleCallEnd(data) {
            console.log('Обрабатываем завершение звонка:', data.reason);
            
            if (isInCall) {
                endCall();
                
                let message = 'Звонок завершен';
                if (data.reason === 'declined') {
                    message = 'Собеседник отклонил звонок';
                } else if (data.reason === 'user_disconnected') {
                    message = 'Собеседник отключился';
                }
                
                showNotification(message, 'info');
            } else if (isCaller) {
                hideCallInterface();
                
                let message = 'Звонок завершен';
                if (data.reason === 'declined') {
                    message = 'Собеседник отклонил звонок';
                } else if (data.reason === 'user_offline') {
                    message = 'Собеседник не в сети';
                }
                
                showNotification(message, 'info');
            }
        }

        // Обработка ошибки звонка
        function handleCallError(data) {
            console.log('Ошибка звонка:', data.error);
            showNotification('Ошибка звонка: ' + data.error, 'error');
            cleanupCall();
        }

        // Получить ID другого пользователя в чате
        async function getOtherUserId() {
            if (!currentChatId) return null;
            
            try {
                const response = await fetch(baseUrl + '/api/chat/' + currentChatId + '/other-user', {
                    headers: {
                        'Authorization': 'Bearer ' + token
                    }
                });
                
                if (response.ok) {
                    const data = await response.json();
                    return data.userId;
                }
            } catch (error) {
                console.error('Ошибка получения ID собеседника:', error);
            }
            
            // Запасной вариант: пытаемся определить из списка чатов
            const chat = chats.find(c => c.chat_id === currentChatId);
            if (chat && chat.other_user_name) {
                // Возвращаем ID второго тестового пользователя для демонстрации
                return currentUser.email === 'test@example.com' ? 2 : 1;
            }
            
            return null;
        }

        // Показать интерфейс звонка
        function showCallInterface(status, title, subtitle) {
            isInCall = true;
            document.getElementById('callOverlay').classList.add('active');
            if (title) document.getElementById('callTitle').textContent = title;
            if (subtitle) document.getElementById('callStatus').textContent = subtitle;
            updateCallControls();
        }

        // Обновить статус звонка
        function updateCallStatus(status) {
            const callStatusElement = document.getElementById('callStatus');
            if (callStatusElement) {
                callStatusElement.textContent = status;
            }
        }

        // Обновить элементы управления звонком
        function updateCallControls() {
            const controlsContainer = document.getElementById('callControls');
            let html = '';
            
            if (isCaller && !isInCall) {
                // Исходящий звонок - только кнопка завершения
                html = '<button class="call-control-btn end" onclick="endCall()">' +
                       '<i class="fas fa-phone-slash"></i>' +
                       '</button>';
            } else if (isInCall) {
                // Активный звонок - кнопки управления
                html = '<button class="call-control-btn mute ' + (muteAudio ? 'active' : '') + '" onclick="toggleMute()">' +
                       '<i class="fas fa-microphone' + (muteAudio ? '-slash' : '') + '"></i>' +
                       '</button>' +
                       '<button class="call-control-btn end" onclick="endCall()">' +
                       '<i class="fas fa-phone-slash"></i>' +
                       '</button>';
            }
            
            controlsContainer.innerHTML = html;
        }

        // Переключить микрофон
        function toggleMute() {
            if (!localStream) return;
            
            muteAudio = !muteAudio;
            localStream.getAudioTracks().forEach(track => {
                track.enabled = !muteAudio;
            });
            
            updateCallControls();
            showNotification(muteAudio ? 'Микрофон выключен' : 'Микрофон включен', 'info');
        }

        // Запустить таймер звонка
        function startCallTimer() {
            callStartTime = Date.now();
            updateCallTimer();
            callTimerInterval = setInterval(updateCallTimer, 1000);
        }

        // Обновить таймер звонка
        function updateCallTimer() {
            if (!callStartTime) return;
            
            const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
            const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const seconds = (elapsed % 60).toString().padStart(2, '0');
            
            document.getElementById('callTimer').textContent = minutes + ':' + seconds;
            
            // Анимация визуализатора звука
            const bars = document.querySelectorAll('.audio-bar');
            bars.forEach((bar, index) => {
                const height = muteAudio ? 10 : Math.random() * 30 + 10;
                bar.style.height = height + 'px';
            });
        }

        // Скрыть интерфейс звонка
        function hideCallInterface() {
            isInCall = false;
            isCaller = false;
            document.getElementById('callOverlay').classList.remove('active');
            
            // Очищаем таймер
            if (callTimerInterval) {
                clearInterval(callTimerInterval);
                callTimerInterval = null;
            }
        }

        // Очистка ресурсов звонка
        function cleanupCall() {
            console.log('Очистка ресурсов звонка');
            
            // Останавливаем таймаут
            if (callTimeout) {
                clearTimeout(callTimeout);
                callTimeout = null;
            }
            
            // Останавливаем локальный поток
            if (localStream) {
                localStream.getTracks().forEach(track => {
                    track.stop();
                });
                localStream = null;
            }
            
            // Останавливаем удаленный поток
            if (remoteStream) {
                remoteStream.getTracks().forEach(track => {
                    track.stop();
                });
                remoteStream = null;
            }
            
            // Удаляем аудио элемент
            if (remoteAudioElement) {
                remoteAudioElement.srcObject = null;
                remoteAudioElement = null;
            }
            
            // Закрываем соединение
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
            
            // Очищаем таймер звонка
            if (callTimerInterval) {
                clearInterval(callTimerInterval);
                callTimerInterval = null;
            }
            
            // Сбрасываем состояние
            hideCallInterface();
            isInCall = false;
            isCaller = false;
            currentCallData = null;
            muteAudio = false;
            iceCandidatesQueue = [];
        }

        // Завершить звонок
        async function endCall() {
            console.log('Завершение звонка');
            
            // Отправляем уведомление о завершении, если есть данные о звонке
            if (ws && ws.readyState === WebSocket.OPEN && currentCallData) {
                const targetId = isCaller ? currentCallData.targetId : currentCallData.callerId;
                
                if (targetId) {
                    ws.send(JSON.stringify({
                        type: 'call_end',
                        chatId: currentCallData.chatId,
                        targetId: targetId,
                        reason: 'ended_by_user'
                    }));
                }
            }
            
            // Очищаем ресурсы
            cleanupCall();
            
            showNotification('Звонок завершен', 'info');
        }

        // Отладка WebRTC
        function updateDebugInfo() {
            if (!debugMode) return;
            
            const debugInfo = document.getElementById('debugInfo');
            let info = '';
            
            info += 'WebSocket: ' + (ws ? ws.readyState : 'Не подключен') + '\\n';
            info += 'PeerConnection: ' + (peerConnection ? peerConnection.connectionState : 'Нет') + '\\n';
            info += 'Локальный поток: ' + (localStream ? localStream.getTracks().length + ' треков' : 'Нет') + '\\n';
            info += 'Удаленный поток: ' + (remoteStream ? remoteStream.getTracks().length + ' треков' : 'Нет') + '\\n';
            info += 'В звонке: ' + (isInCall ? 'Да' : 'Нет') + '\\n';
            info += 'Вызывающий: ' + (isCaller ? 'Да' : 'Нет') + '\\n';
            info += 'ICE кандидатов в очереди: ' + iceCandidatesQueue.length;
            
            debugInfo.textContent = info;
        }

        function toggleDebug() {
            debugMode = !debugMode;
            document.getElementById('debugPanel').classList.toggle('show');
            
            if (debugMode) {
                setInterval(updateDebugInfo, 1000);
            }
        }

        // Уведомления
        function showNotification(message, type = 'info') {
            const notification = document.getElementById('notification');
            notification.textContent = message;
            notification.className = 'notification show';
            
            // Цвет в зависимости от типа
            if (type === 'success') {
                notification.style.background = 'var(--success-color)';
            } else if (type === 'error') {
                notification.style.background = 'var(--error-color)';
            } else if (type === 'warning') {
                notification.style.background = 'var(--warning-color)';
            }
            
            // Автоматическое скрытие
            setTimeout(() => {
                notification.classList.remove('show');
            }, 3000);
        }

        // Вспомогательные функции
        function formatTime(dateString) {
            if (!dateString) return '';
            
            try {
                const date = new Date(dateString);
                const now = new Date();
                const diff = now - date;
                
                if (diff < 24 * 60 * 60 * 1000) {
                    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                } else if (diff < 7 * 24 * 60 * 60 * 1000) {
                    const days = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
                    return days[date.getDay()];
                } else {
                    return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
                }
            } catch (e) {
                return '';
            }
        }

        function formatDuration(seconds) {
            if (!seconds) return '0:00';
            const minutes = Math.floor(seconds / 60);
            const secs = seconds % 60;
            return minutes + ':' + secs.toString().padStart(2, '0');
        }

        // Инициализация тестового входа и голосовых сообщений
        window.onload = function() {
            // Автоматически заполняем тестовые данные
            document.getElementById('loginEmail').value = 'test@example.com';
            document.getElementById('loginPassword').value = 'password123';
            
            // Добавляем CSS для анимации волн
            const style = document.createElement('style');
            style.textContent = '@keyframes wave { from { height: 5px; } to { height: 25px; } }';
            document.head.appendChild(style);
            
            // Закрываем меню вложений при клике вне его
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.attachment-btn')) {
                    hideAttachmentMenu();
                }
            });
            
            // Для мобильных устройств: обработка касаний
            document.addEventListener('touchstart', function(e) {
                // Обработка для предотвращения масштабирования
                if (e.touches.length > 1) {
                    e.preventDefault();
                }
            }, { passive: false });
            
            console.log('Application initialized');
            console.log('Base URL:', baseUrl);
            console.log('WebSocket URL:', wsUrl);
            
            // Добавляем обработчик для отладки по Ctrl+D
            document.addEventListener('keydown', function(e) {
                if (e.ctrlKey && e.key === 'd') {
                    e.preventDefault();
                    toggleDebug();
                }
            });

            if (/Mobi|Android/i.test(navigator.userAgent)) {
                document.body.classList.add('mobile-device');
                // Увеличиваем размеры некоторых элементов для лучшей читаемости
                const style = document.createElement('style');
                style.textContent = \`
                    .mobile-device .form-group input,
                    .mobile-device .btn {
                        font-size: 16px !important;
                    }
                    
                    .mobile-device .chat-input input {
                        font-size: 16px !important;
                        padding: 12px 16px !important;
                    }
                    
                    .mobile-device .list-item-title {
                        font-size: 15px !important;
                    }
                    
                    .mobile-device .contact-info h4 {
                        font-size: 15px !important;
                    }
                \`;
                document.head.appendChild(style);
            }
        };
    </script>
</body>
</html>`;

// Создаем HTTP сервер
const server = http.createServer((req, res) => {
    // CORS заголовки
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Маршрутизация
    if (req.url === '/api/register' && req.method === 'POST') {
        parseJSON(req, res, () => handleRegister(req, res));
    } else if (req.url === '/api/login' && req.method === 'POST') {
        parseJSON(req, res, () => handleLogin(req, res));
    } else if (req.url === '/api/contacts' && req.method === 'GET') {
        parseJSON(req, res, () => {
            authenticate(req, res, () => handleGetContacts(req, res));
        });
    } else if (req.url === '/api/contacts' && req.method === 'POST') {
        parseJSON(req, res, () => {
            authenticate(req, res, () => handleAddContact(req, res));
        });
    } else if (req.url === '/api/chats' && req.method === 'GET') {
        parseJSON(req, res, () => {
            authenticate(req, res, () => handleGetChats(req, res));
        });
    } else if (req.url === '/api/start-chat' && req.method === 'POST') {
        parseJSON(req, res, () => {
            authenticate(req, res, () => handleStartChat(req, res));
        });
    } else if (req.url.startsWith('/api/messages/') && req.method === 'GET') {
        parseJSON(req, res, () => {
            authenticate(req, res, () => handleGetMessages(req, res));
        });
    } else if (req.url === '/api/upload-audio' && req.method === 'POST') {
        handleUploadAudio(req, res);
    } else if (req.url === '/api/upload-file' && req.method === 'POST') {
        handleUploadFile(req, res);
    } else if (req.url.startsWith('/uploads/') && req.method === 'GET') {
        serveFile(req, res);
    } else if (req.url.startsWith('/api/chat/') && req.url.includes('/other-user') && req.method === 'GET') {
        parseJSON(req, res, () => {
            authenticate(req, res, () => handleGetOtherUser(req, res));
        });
    } else if (req.url === '/' || req.url === '/index.html' || req.url === '/index') {
        // Отдаем HTML интерфейс
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML_TEMPLATE);
    } else if (req.url === '/health' || req.url === '/ping') {
        // Health check для Render
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    } else {
        // Для SPA роутинга
        if (req.method === 'GET' && !req.url.includes('.')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(HTML_TEMPLATE);
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    }
});

// Функция для обработки загрузки аудио файлов
function handleUploadAudio(req, res) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No token provided' }));
        return;
    }

    const token = authHeader.replace('Bearer ', '');
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;
        
        let body = [];
        req.on('data', chunk => {
            body.push(chunk);
        });
        
        req.on('end', () => {
            const data = Buffer.concat(body);
            
            // Парсим multipart/form-data
            const boundary = req.headers['content-type'].split('boundary=')[1];
            const parts = data.toString('binary').split('--' + boundary);
            
            let chatId, duration;
            let audioData = null;
            let audioFilename = null;
            
            for (const part of parts) {
                if (part.includes('Content-Disposition: form-data')) {
                    const nameMatch = part.match(/name="([^"]+)"/);
                    if (nameMatch) {
                        const name = nameMatch[1];
                        
                        if (name === 'audio') {
                            const filenameMatch = part.match(/filename="([^"]+)"/);
                            if (filenameMatch) {
                                audioFilename = filenameMatch[1];
                            }
                            
                            // Извлекаем аудио данные
                            const contentStart = part.indexOf('\r\n\r\n') + 4;
                            const contentEnd = part.lastIndexOf('\r\n');
                            const content = part.substring(contentStart, contentEnd);
                            audioData = Buffer.from(content, 'binary');
                        } else if (name === 'chatId') {
                            const valueMatch = part.match(/\r\n\r\n([^\r\n]+)/);
                            if (valueMatch) {
                                chatId = parseInt(valueMatch[1]);
                            }
                        } else if (name === 'duration') {
                            const valueMatch = part.match(/\r\n\r\n([^\r\n]+)/);
                            if (valueMatch) {
                                duration = parseInt(valueMatch[1]);
                            }
                        }
                    }
                }
            }
            
            if (!chatId || !audioData || !duration) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields' }));
                return;
            }
            
            // Проверяем доступ к чату
            db.get(
                'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
                [chatId, userId],
                (err, hasAccess) => {
                    if (err || !hasAccess) {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Access denied' }));
                        return;
                    }
                    
                    // Генерируем уникальное имя файла
                    const timestamp = Date.now();
                    const random = Math.random().toString(36).substring(2, 15);
                    const filename = 'voice_' + userId + '_' + timestamp + '_' + random + '.webm';
                    const filepath = path.join(AUDIO_DIR, filename);
                    const audioUrl = '/uploads/audio/' + filename;
                    
                    // Сохраняем файл
                    fs.writeFile(filepath, audioData, (err) => {
                        if (err) {
                            console.error('Error saving audio file:', err);
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Error saving audio file' }));
                            return;
                        }
                        
                        // Сохраняем сообщение в базу данных
                        db.run(
                            'INSERT INTO messages (chat_id, user_id, audio_url, message_type, duration) VALUES (?, ?, ?, ?, ?)',
                            [chatId, userId, audioUrl, 'voice', duration],
                            function(err) {
                                if (err) {
                                    console.error('Error saving voice message:', err);
                                    res.writeHead(500, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ error: 'Error saving voice message' }));
                                    return;
                                }
                                
                                // Получаем сохраненное сообщение
                                db.get(
                                    'SELECT m.*, u.username, u.email FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?',
                                    [this.lastID],
                                    (err, savedMessage) => {
                                        if (err) {
                                            console.error('Error fetching saved message:', err);
                                            return;
                                        }
                                        
                                        // Получаем участников чата
                                        db.all(
                                            'SELECT user_id FROM chat_members WHERE chat_id = ?',
                                            [chatId],
                                            (err, members) => {
                                                if (err) {
                                                    console.error('Error fetching chat members:', err);
                                                    return;
                                                }
                                                
                                                // Отправляем сообщение всем участникам через WebSocket
                                                members.forEach(member => {
                                                    const clientWs = clients.get(member.user_id);
                                                    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                                                        clientWs.send(JSON.stringify({
                                                            type: 'new_message',
                                                            message: savedMessage
                                                        }));
                                                    }
                                                });
                                                
                                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                                res.end(JSON.stringify({ 
                                                    success: true, 
                                                    message: 'Голосовое сообщение отправлено'
                                                }));
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    });
                }
            );
        });
        
    } catch (error) {
        console.error('Token verification error:', error);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid token' }));
    }
}

// Функция для обработки загрузки файлов
function handleUploadFile(req, res) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No token provided' }));
        return;
    }

    const token = authHeader.replace('Bearer ', '');
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;
        
        let body = [];
        req.on('data', chunk => {
            body.push(chunk);
        });
        
        req.on('end', () => {
            const data = Buffer.concat(body);
            
            // Парсим multipart/form-data
            const boundary = req.headers['content-type'].split('boundary=')[1];
            const parts = data.toString('binary').split('--' + boundary);
            
            let chatId;
            let fileData = null;
            let fileName = null;
            let fileType = null;
            
            for (const part of parts) {
                if (part.includes('Content-Disposition: form-data')) {
                    const nameMatch = part.match(/name="([^"]+)"/);
                    if (nameMatch) {
                        const name = nameMatch[1];
                        
                        if (name === 'file') {
                            const filenameMatch = part.match(/filename="([^"]+)"/);
                            if (filenameMatch) {
                                fileName = filenameMatch[1];
                            }
                            
                            const contentTypeMatch = part.match(/Content-Type: ([^\r\n]+)/);
                            if (contentTypeMatch) {
                                fileType = contentTypeMatch[1];
                            }
                            
                            // Извлекаем данные файла
                            const contentStart = part.indexOf('\r\n\r\n') + 4;
                            const contentEnd = part.lastIndexOf('\r\n');
                            const content = part.substring(contentStart, contentEnd);
                            fileData = Buffer.from(content, 'binary');
                        } else if (name === 'chatId') {
                            const valueMatch = part.match(/\r\n\r\n([^\r\n]+)/);
                            if (valueMatch) {
                                chatId = parseInt(valueMatch[1]);
                            }
                        }
                    }
                }
            }
            
            if (!chatId || !fileData || !fileName) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields' }));
                return;
            }
            
            // Проверяем доступ к чату
            db.get(
                'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
                [chatId, userId],
                (err, hasAccess) => {
                    if (err || !hasAccess) {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Access denied' }));
                        return;
                    }
                    
                    // Проверяем размер файла (максимум 50MB)
                    const fileSize = fileData.length;
                    if (fileSize > 50 * 1024 * 1024) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'File size exceeds 50MB limit' }));
                        return;
                    }
                    
                    // Генерируем уникальное имя файла
                    const timestamp = Date.now();
                    const random = Math.random().toString(36).substring(2, 15);
                    const safeFileName = fileName.replace(/[^a-zA-Z0-9.]/g, '_');
                    const filename = 'file_' + userId + '_' + timestamp + '_' + random + '_' + safeFileName;
                    const filepath = path.join(FILES_DIR, filename);
                    const fileUrl = '/uploads/files/' + filename;
                    
                    // Сохраняем файл
                    fs.writeFile(filepath, fileData, (err) => {
                        if (err) {
                            console.error('Error saving file:', err);
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Error saving file' }));
                            return;
                        }
                        
                        // Сохраняем сообщение в базу данных
                        db.run(
                            'INSERT INTO messages (chat_id, user_id, file_url, file_name, file_size, file_type, message_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
                            [chatId, userId, fileUrl, fileName, fileSize, fileType, 'file'],
                            function(err) {
                                if (err) {
                                    console.error('Error saving file message:', err);
                                    res.writeHead(500, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ error: 'Error saving file message' }));
                                    return;
                                }
                                
                                // Получаем сохраненное сообщение
                                db.get(
                                    'SELECT m.*, u.username, u.email FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?',
                                    [this.lastID],
                                    (err, savedMessage) => {
                                        if (err) {
                                            console.error('Error fetching saved message:', err);
                                            return;
                                        }
                                        
                                        // Получаем участников чата
                                        db.all(
                                            'SELECT user_id FROM chat_members WHERE chat_id = ?',
                                            [chatId],
                                            (err, members) => {
                                                if (err) {
                                                    console.error('Error fetching chat members:', err);
                                                    return;
                                                }
                                                
                                                // Отправляем сообщение всем участникам через WebSocket
                                                members.forEach(member => {
                                                    const clientWs = clients.get(member.user_id);
                                                    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                                                        clientWs.send(JSON.stringify({
                                                            type: 'new_message',
                                                            message: savedMessage
                                                        }));
                                                    }
                                                });
                                                
                                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                                res.end(JSON.stringify({ 
                                                    success: true, 
                                                    message: 'Файл отправлен',
                                                    fileUrl: fileUrl
                                                }));
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    });
                }
            );
        });
        
    } catch (error) {
        console.error('Token verification error:', error);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid token' }));
    }
}

// Функция для отдачи файлов
function serveFile(req, res) {
    const filePath = path.join(__dirname, req.url);
    
    // Проверяем существование файла
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404);
            res.end('File not found');
            return;
        }
        
        // Определяем Content-Type
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.webm': 'audio/webm',
            '.mp3': 'audio/mpeg',
            '.mp4': 'video/mp4',
            '.pdf': 'application/pdf',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xls': 'application/vnd.ms-excel',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.zip': 'application/zip',
            '.txt': 'text/plain'
        };
        
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        
        // Устанавливаем заголовки
        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stats.size,
            'Cache-Control': 'public, max-age=31536000'
        });
        
        // Отправляем файл
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
    });
}

// Обработчики HTTP запросов
async function handleRegister(req, res) {
    const { email, username, password } = req.body;
    
    if (!email || !username || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Все поля обязательны' }));
        return;
    }
    
    db.get('SELECT id FROM users WHERE email = ?', [email], (err, user) => {
        if (err) {
            console.error('Database error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Database error' }));
            return;
        }
        
        if (user) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Пользователь с таким email уже существует' }));
            return;
        }
        
        bcrypt.hash(password, 10, (err, hash) => {
            if (err) {
                console.error('Error hashing password:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Error hashing password' }));
                return;
            }
            
            db.run(
                'INSERT INTO users (email, username, password_hash) VALUES (?, ?, ?)',
                [email, username, hash],
                function(err) {
                    if (err) {
                        console.error('Error creating user:', err);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Error creating user' }));
                        return;
                    }
                    
                    const token = jwt.sign(
                        { userId: this.lastID, email },
                        JWT_SECRET,
                        { expiresIn: '7d' }
                    );
                    
                    res.writeHead(201, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: true, 
                        token,
                        user: { id: this.lastID, email, username }
                    }));
                }
            );
        });
    });
}

async function handleLogin(req, res) {
    const { email, password } = req.body;
    
    db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
        if (err || !user) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Неверный email или пароль' }));
            return;
        }
        
        bcrypt.compare(password, user.password_hash, (err, result) => {
            if (err || !result) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Неверный email или пароль' }));
                return;
            }
            
            const token = jwt.sign(
                { userId: user.id, email: user.email },
                JWT_SECRET,
                { expiresIn: '7d' }
            );
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: true, 
                token,
                user: { id: user.id, email: user.email, username: user.username }
            }));
        });
    });
}

async function handleGetContacts(req, res) {
    db.all(
        'SELECT u.id, u.email, u.username FROM contacts c JOIN users u ON c.contact_id = u.id WHERE c.user_id = ?',
        [req.userId],
        (err, contacts) => {
            if (err) {
                console.error('Database error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Database error' }));
                return;
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ contacts: contacts || [] }));
        }
    );
}

async function handleAddContact(req, res) {
    const { email } = req.body;
    
    // Находим пользователя по email
    db.get('SELECT id, username FROM users WHERE email = ?', [email], (err, contact) => {
        if (err || !contact) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Пользователь не найден' }));
            return;
        }
        
        if (contact.id === req.userId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Нельзя добавить себя в контакты' }));
            return;
        }
        
        // Проверяем, есть ли уже такой контакт
        db.get(
            'SELECT id FROM contacts WHERE user_id = ? AND contact_id = ?',
            [req.userId, contact.id],
            (err, existing) => {
                if (existing) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Контакт уже добавлен' }));
                    return;
                }
                
                // Добавляем контакт в обе стороны (симметрично)
                db.serialize(() => {
                    db.run(
                        'INSERT INTO contacts (user_id, contact_id) VALUES (?, ?)',
                        [req.userId, contact.id]
                    );
                    
                    db.run(
                        'INSERT INTO contacts (user_id, contact_id) VALUES (?, ?)',
                        [contact.id, req.userId]
                    );
                    
                    // Создаем новый чат без названия
                    db.run(
                        'INSERT INTO chats (is_group) VALUES (0)',
                        function(err) {
                            if (err) {
                                console.error('Error creating chat:', err);
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Error creating chat' }));
                                return;
                            }
                            
                            const chatId = this.lastID;
                            
                            // Получаем имя текущего пользователя
                            db.get('SELECT username FROM users WHERE id = ?', [req.userId], (err, currentUser) => {
                                if (err || !currentUser) {
                                    res.writeHead(500, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ error: 'Error getting user info' }));
                                    return;
                                }
                                
                                // Добавляем участников в чат с персонализированными названиями
                                // Для пользователя 1: чат называется "Чат с {contact.username}"
                                // Для пользователя 2: чат называется "Чат с {currentUser.username}"
                                db.run(
                                    'INSERT INTO chat_members (chat_id, user_id, chat_name) VALUES (?, ?, ?), (?, ?, ?)',
                                    [chatId, req.userId, 'Чат с ' + contact.username, 
                                     chatId, contact.id, 'Чат с ' + currentUser.username],
                                    (err) => {
                                        if (err) {
                                            console.error('Database error:', err);
                                            res.writeHead(500, { 'Content-Type': 'application/json' });
                                            res.end(JSON.stringify({ error: 'Error adding chat members' }));
                                            return;
                                        }
                                        
                                        res.writeHead(201, { 'Content-Type': 'application/json' });
                                        res.end(JSON.stringify({ 
                                            success: true, 
                                            message: 'Контакт добавлен и чат создан',
                                            chatId: chatId
                                        }));
                                    }
                                );
                            });
                        }
                    );
                });
            }
        );
    });
}

async function handleGetChats(req, res) {
    // Получаем все чаты пользователя с информацией о последнем сообщении
    db.all(
        'SELECT c.id as chat_id, cm.chat_name, c.is_group, c.created_at, ' +
        '(SELECT content FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message, ' +
        '(SELECT message_type FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_type, ' +
        '(SELECT file_name FROM messages WHERE chat_id = c.id AND message_type = "file" ORDER BY created_at DESC LIMIT 1) as file_name, ' +
        '(SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time, ' +
        '(SELECT u.username FROM chat_members cm2 ' +
        'JOIN users u ON cm2.user_id = u.id WHERE cm2.chat_id = c.id AND cm2.user_id != ? LIMIT 1) as other_user_name ' +
        'FROM chats c JOIN chat_members cm ON c.id = cm.chat_id ' +
        'WHERE cm.user_id = ? ORDER BY last_message_time DESC',
        [req.userId, req.userId],
        (err, chats) => {
            if (err) {
                console.error('Database error in handleGetChats:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Database error' }));
                return;
            }
            
            const result = chats || [];
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ chats: result }));
        }
    );
}

async function handleStartChat(req, res) {
    const { contactId } = req.body;
    
    // Проверяем, есть ли уже чат с этим контактом
    db.get(
        'SELECT c.id as chat_id FROM chats c ' +
        'JOIN chat_members cm1 ON c.id = cm1.chat_id ' +
        'JOIN chat_members cm2 ON c.id = cm2.chat_id ' +
        'WHERE c.is_group = 0 AND cm1.user_id = ? AND cm2.user_id = ?',
        [req.userId, contactId],
        (err, existingChat) => {
            if (err) {
                console.error('Database error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Database error' }));
                return;
            }
            
            if (existingChat) {
                // Чат уже существует, возвращаем его ID
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    chatId: existingChat.chat_id,
                    message: 'Чат уже существует'
                }));
                return;
            }
            
            // Получаем имя контакта
            db.get('SELECT username FROM users WHERE id = ?', [contactId], (err, contact) => {
                if (err || !contact) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Контакт не найден' }));
                    return;
                }
                
                // Получаем имя текущего пользователя
                db.get('SELECT username FROM users WHERE id = ?', [req.userId], (err, currentUser) => {
                    if (err || !currentUser) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Error getting user info' }));
                        return;
                    }
                    
                    // Создаем новый чат без названия
                    db.run(
                        'INSERT INTO chats (is_group) VALUES (0)',
                        function(err) {
                            if (err) {
                                console.error('Error creating chat:', err);
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Error creating chat' }));
                                return;
                            }
                            
                            const chatId = this.lastID;
                            
                            // Добавляем участников в чат с персонализированными названиями
                            db.run(
                                'INSERT INTO chat_members (chat_id, user_id, chat_name) VALUES (?, ?, ?), (?, ?, ?)',
                                [chatId, req.userId, 'Чат с ' + contact.username, 
                                 chatId, contactId, 'Чат с ' + currentUser.username],
                                (err) => {
                                    if (err) {
                                        console.error('Database error:', err);
                                        res.writeHead(500, { 'Content-Type': 'application/json' });
                                        res.end(JSON.stringify({ error: 'Error adding chat members' }));
                                        return;
                                    }
                                    
                                    res.writeHead(201, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ 
                                        success: true, 
                                        chatId: chatId,
                                        message: 'Чат создан'
                                    }));
                                }
                            );
                        }
                    );
                });
            });
        }
    );
}

async function handleGetMessages(req, res) {
    const chatId = req.url.split('/')[3];
    
    if (!chatId || isNaN(chatId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid chat ID' }));
        return;
    }
    
    // Проверяем, имеет ли пользователь доступ к этому чату
    db.get(
        'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
        [chatId, req.userId],
        (err, hasAccess) => {
            if (err || !hasAccess) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Access denied' }));
                return;
            }
            
            db.all(
                'SELECT m.*, u.username, u.email FROM messages m JOIN users u ON m.user_id = u.id WHERE m.chat_id = ? ORDER BY m.created_at ASC',
                [chatId],
                (err, messages) => {
                    if (err) {
                        console.error('Database error:', err);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Database error' }));
                        return;
                    }
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ messages: messages || [] }));
                }
            );
        }
    );
}

// Функция для получения ID другого пользователя в чате
async function handleGetOtherUser(req, res) {
    const chatId = req.url.split('/')[3];
    
    if (!chatId || isNaN(chatId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid chat ID' }));
        return;
    }
    
    // Проверяем, имеет ли пользователь доступ к этому чату
    db.get(
        'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
        [chatId, req.userId],
        (err, hasAccess) => {
            if (err || !hasAccess) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Access denied' }));
                return;
            }
            
            // Находим ID другого пользователя в чате
            db.get(
                'SELECT u.id FROM chat_members cm ' +
                'JOIN users u ON cm.user_id = u.id ' +
                'WHERE cm.chat_id = ? AND cm.user_id != ?',
                [chatId, req.userId],
                (err, otherUser) => {
                    if (err) {
                        console.error('Database error:', err);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Database error' }));
                        return;
                    }
                    
                    if (!otherUser) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Other user not found' }));
                        return;
                    }
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ userId: otherUser.id }));
                }
            );
        }
    );
}

// Создаем WebSocket сервер
const wss = new WebSocket.Server({ server });

// Хранение подключенных пользователей
const clients = new Map();

wss.on('connection', (ws, req) => {
    ws.isAuthenticated = false;
    ws.userId = null;
    ws.userInfo = null;
    ws.callData = null;
    ws.callAnswer = null;
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log('WebSocket сообщение от клиента:', message.type, 'пользователь ID:', ws.userId);
            
            if (message.type === 'authenticate') {
                try {
                    const decoded = jwt.verify(message.token, JWT_SECRET);
                    
                    db.get('SELECT id, email, username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
                        if (err || !user) {
                            ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
                            return;
                        }

                        ws.isAuthenticated = true;
                        ws.userId = user.id;
                        ws.userInfo = user;
                        
                        clients.set(user.id, ws);
                        
                        console.log('WebSocket аутентифицирован: ' + user.username + ' (' + user.email + ') ID: ' + user.id);
                        
                        ws.send(JSON.stringify({
                            type: 'authenticated',
                            user: user
                        }));
                    });
                } catch (error) {
                    console.error('Ошибка аутентификации:', error);
                    ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
                }
            } else if (ws.isAuthenticated) {
                // Обработка сообщений от аутентифицированных пользователей
                if (message.type === 'message' && message.content) {
                    const { chatId, content } = message;
                    
                    // Проверяем, имеет ли пользователь доступ к этому чату
                    db.get(
                        'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
                        [chatId, ws.userId],
                        (err, hasAccess) => {
                            if (err || !hasAccess) {
                                ws.send(JSON.stringify({ 
                                    type: 'error', 
                                    message: 'Нет доступа к чату' 
                                }));
                                return;
                            }
                            
                            // Сохраняем сообщение в базу данных
                            db.run(
                                'INSERT INTO messages (chat_id, user_id, content, message_type) VALUES (?, ?, ?, ?)',
                                [chatId, ws.userId, content, 'text'],
                                function(err) {
                                    if (err) {
                                        console.error('Error saving message:', err);
                                        ws.send(JSON.stringify({ 
                                            type: 'error', 
                                            message: 'Ошибка сохранения сообщения' 
                                        }));
                                        return;
                                    }
                                    
                                    // Получаем сохраненное сообщение с информацией об отправителе
                                    db.get(
                                        'SELECT m.*, u.username, u.email FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?',
                                        [this.lastID],
                                        (err, savedMessage) => {
                                            if (err) {
                                                console.error('Error fetching saved message:', err);
                                                return;
                                            }
                                            
                                            // Получаем участников чата
                                            db.all(
                                                'SELECT user_id FROM chat_members WHERE chat_id = ?',
                                                [chatId],
                                                (err, members) => {
                                                    if (err) {
                                                        console.error('Error fetching chat members:', err);
                                                        return;
                                                    }
                                                    
                                                    // Отправляем сообщение всем участникам
                                                    members.forEach(member => {
                                                        const clientWs = clients.get(member.user_id);
                                                        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                                                            clientWs.send(JSON.stringify({
                                                                type: 'new_message',
                                                                message: savedMessage
                                                            }));
                                                        }
                                                    });
                                                    
                                                    // Отправляем уведомление о создании чата (если это первое сообщение)
                                                    db.get(
                                                        'SELECT COUNT(*) as count FROM messages WHERE chat_id = ?',
                                                        [chatId],
                                                        (err, result) => {
                                                            if (!err && result.count === 1) {
                                                                members.forEach(member => {
                                                                    const clientWs = clients.get(member.user_id);
                                                                    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                                                                        clientWs.send(JSON.stringify({
                                                                            type: 'chat_created',
                                                                            chatId: chatId
                                                                        }));
                                                                    }
                                                                });
                                                            }
                                                        }
                                                    );
                                                }
                                            );
                                        }
                                    );
                                }
                            );
                        }
                    );
                } else if (message.type === 'typing') {
                    const { chatId, userId, username } = message;
                    
                    // Проверяем, имеет ли пользователь доступ к этому чату
                    db.get(
                        'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
                        [chatId, ws.userId],
                        (err, hasAccess) => {
                            if (err || !hasAccess) return;
                            
                            // Отправляем уведомление о печати другим участникам чата
                            db.all(
                                'SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?',
                                [chatId, userId],
                                (err, members) => {
                                    if (err) return;
                                    
                                    members.forEach(member => {
                                        const clientWs = clients.get(member.user_id);
                                        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                                            clientWs.send(JSON.stringify({
                                                type: 'typing',
                                                chatId: chatId,
                                                userId: userId,
                                                username: username
                                            }));
                                        }
                                    });
                                }
                            );
                        }
                    );
                } else if (message.type === 'call_offer') {
                    // Отправляем предложение о звонке целевым пользователям
                    const { chatId, targetId, offer, callerData } = message;
                    
                    console.log('call_offer от', ws.userId, 'для', targetId, 'чат', chatId);
                    
                    // Проверяем, имеет ли пользователь доступ к этому чату
                    db.get(
                        'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
                        [chatId, ws.userId],
                        (err, hasAccess) => {
                            if (err || !hasAccess) {
                                console.log('Нет доступа к чату');
                                ws.send(JSON.stringify({
                                    type: 'call_error',
                                    chatId: chatId,
                                    error: 'Нет доступа к чату'
                                }));
                                return;
                            }
                            
                            // Находим целевого пользователя
                            const targetClient = Array.from(clients.entries()).find(([id, client]) => 
                                client.userId === targetId && client.readyState === WebSocket.OPEN
                            );
                            
                            if (targetClient && targetClient[1]) {
                                console.log('Отправка call_offer пользователю', targetId);
                                
                                // Сохраняем данные о звонке у вызываемого пользователя
                                targetClient[1].callData = {
                                    chatId,
                                    targetId: ws.userId,
                                    callerId: ws.userId,
                                    callerName: ws.userInfo?.username || 'Пользователь',
                                    offer: offer
                                };
                                
                                targetClient[1].send(JSON.stringify({
                                    type: 'call_offer',
                                    chatId: chatId,
                                    offer: offer,
                                    callerData: {
                                        chatId: chatId,
                                        callerId: ws.userId,
                                        callerName: ws.userInfo?.username || 'Пользователь',
                                        targetId: targetId
                                    }
                                }));
                                
                                // Отправляем подтверждение вызывающему
                                ws.send(JSON.stringify({
                                    type: 'call_offer_sent',
                                    chatId: chatId,
                                    targetId: targetId
                                }));
                            } else {
                                console.log('Пользователь', targetId, 'не в сети');
                                ws.send(JSON.stringify({
                                    type: 'call_error',
                                    chatId: chatId,
                                    error: 'Пользователь не в сети'
                                }));
                            }
                        }
                    );
                    
                } else if (message.type === 'call_answer') {
                    const { chatId, targetId, answer } = message;
                    
                    console.log('call_answer от', ws.userId, 'для', targetId);
                    
                    // Находим вызывающего пользователя
                    const callerClient = Array.from(clients.entries()).find(([id, client]) => 
                        client.userId === targetId && client.readyState === WebSocket.OPEN
                    );
                    
                    if (callerClient && callerClient[1]) {
                        console.log('Отправка call_answer пользователю', targetId);
                        
                        // Сохраняем ответ у вызывающего
                        callerClient[1].callAnswer = answer;
                        
                        callerClient[1].send(JSON.stringify({
                            type: 'call_answer',
                            chatId: chatId,
                            answer: answer,
                            targetId: ws.userId
                        }));
                    } else {
                        console.log('Вызывающий пользователь', targetId, 'не найден');
                    }
                    
                } else if (message.type === 'call_ice_candidate') {
                    const { chatId, targetId, candidate } = message;
                    
                    console.log('call_ice_candidate от', ws.userId, 'для', targetId);
                    
                    // Находим целевого пользователя
                    const targetClient = Array.from(clients.entries()).find(([id, client]) => 
                        client.userId === targetId && client.readyState === WebSocket.OPEN
                    );
                    
                    if (targetClient && targetClient[1]) {
                        targetClient[1].send(JSON.stringify({
                            type: 'call_ice_candidate',
                            chatId: chatId,
                            candidate: candidate,
                            senderId: ws.userId
                        }));
                    }
                    
                } else if (message.type === 'call_end') {
                    const { chatId, targetId, reason } = message;
                    
                    console.log('call_end от', ws.userId, 'для', targetId, 'причина:', reason);
                    
                    // Находим целевого пользователя
                    const targetClient = Array.from(clients.entries()).find(([id, client]) => 
                        client.userId === targetId && client.readyState === WebSocket.OPEN
                    );
                    
                    if (targetClient && targetClient[1]) {
                        targetClient[1].send(JSON.stringify({
                            type: 'call_end',
                            chatId: chatId,
                            reason: reason,
                            senderId: ws.userId
                        }));
                        
                        // Очищаем данные о звонке
                        ws.callData = null;
                        targetClient[1].callData = null;
                    }
                    
                } else if (message.type === 'call_error') {
                    const { chatId, targetId, error } = message;
                    
                    console.log('call_error от', ws.userId, 'для', targetId, 'ошибка:', error);
                    
                    // Находим целевого пользователя
                    const targetClient = Array.from(clients.entries()).find(([id, client]) => 
                        client.userId === targetId && client.readyState === WebSocket.OPEN
                    );
                    
                    if (targetClient && targetClient[1]) {
                        targetClient[1].send(JSON.stringify({
                            type: 'call_error',
                            chatId: chatId,
                            error: error,
                            senderId: ws.userId
                        }));
                    }
                }
            }
        } catch (error) {
            console.error('Ошибка обработки WebSocket сообщения:', error);
        }
    });

    ws.on('close', () => {
        if (ws.isAuthenticated && ws.userId) {
            console.log('Отключение пользователя ID: ' + ws.userId);
            
            // Если пользователь был в звонке, уведомляем другого участника
            if (ws.callData) {
                const { chatId, targetId } = ws.callData;
                
                const targetClient = Array.from(clients.entries()).find(([id, client]) => 
                    client.userId === targetId && client.readyState === WebSocket.OPEN
                );
                
                if (targetClient && targetClient[1]) {
                    targetClient[1].send(JSON.stringify({
                        type: 'call_end',
                        chatId: chatId,
                        reason: 'user_disconnected',
                        senderId: ws.userId
                    }));
                    
                    targetClient[1].callData = null;
                }
            }
            
            clients.delete(ws.userId);
        }
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// ========== САМО-ПИНГ ДЛЯ RENDER.COM ==========
function startSelfPing() {
    const selfUrl = 'https://beresta-messenger-web.onrender.com';
    
    // Функция для выполнения пинга
    const pingSelf = async () => {
        try {
            console.log('🔔 Выполняю само-пинг...');
            const response = await fetch(selfUrl + '/health');
            const data = await response.text();
            console.log('✅ Само-пинг успешен:', response.status, data);
        } catch (error) {
            console.error('❌ Ошибка само-пинга:', error.message);
        }
    };
    
    // Выполняем пинг сразу при запуске
    pingSelf();
    
    // Устанавливаем интервал пинга каждые 5 минут (300000 мс)
    // Render.com отключает инстансы после 15 минут неактивности
    setInterval(pingSelf, 5 * 60 * 1000);
    
    console.log('🔄 Само-пинг активирован: каждые 5 минут');
}

// Запускаем само-пинг только в production режиме
if (process.env.NODE_ENV === 'production') {
    startSelfPing();
}

// Запускаем сервер
server.listen(PORT, () => {
    console.log('🚀 Сервер Береста запущен!');
    console.log('📍 Порт:', PORT);
    console.log('🌐 HTTP сервер:', 'http://localhost:' + PORT);
    console.log('🔗 WebSocket сервер:', 'ws://localhost:' + PORT);
    
    if (process.env.RENDER_EXTERNAL_HOSTNAME) {
        console.log('🌍 Внешний URL:', 'https://' + process.env.RENDER_EXTERNAL_HOSTNAME);
        console.log('🔗 WebSocket URL:', 'wss://' + process.env.RENDER_EXTERNAL_HOSTNAME);
    }
    
    console.log('\n👥 Доступные тестовые аккаунты:');
    console.log('1. Email: test@example.com, Пароль: password123 (Тестовый Пользователь)');
    console.log('2. Email: user2@example.com, Пароль: password123 (Второй Пользователь)');
    
    console.log('\n📱 Новый интерфейс:');
    console.log('• Сразу виден список чатов');
    console.log('• Переключатель между чатами и контактами');
    console.log('• Кнопка "Назад" в чате для возврата к списку');
    
    console.log('\n📞 Аудиозвонки:');
    console.log('• Двусторонняя аудиосвязь через WebRTC');
    console.log('• Используются STUN серверы');
    console.log('• Работает на мобильных устройствах');
    
    console.log('\n💾 База данных:', dbPath);
    console.log('📁 Директория загрузок:', UPLOADS_DIR);
    
    if (process.env.NODE_ENV === 'production') {
        console.log('\n✅ Режим: Production');
        console.log('✅ Поддержка HTTPS/WebSocket Secure');
    } else {
        console.log('\n⚙️  Режим: Development');
    }
    
    console.log('\n✅ Готово! Откройте в браузере: http://localhost:' + PORT);
});

// Обработка graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        db.close();
        console.log('Database connection closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        db.close();
        console.log('Database connection closed');
        process.exit(0);
    });
});


