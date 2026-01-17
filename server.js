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

    // Сессии для автоматического входа
    db.run(`
        CREATE TABLE IF NOT EXISTS user_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            device_id TEXT NOT NULL,
            token TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users (id),
            UNIQUE(user_id, device_id)
        )
    `);
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

// HTML шаблон с адаптивным интерфейсом для ПК и мобильных
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="theme-color" content="#4f46e5">
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
            --sidebar-width: 320px;
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
            max-height: 100vh;
            padding: 40px 30px;
            display: flex;
            flex-direction: column;
            justify-content: center;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
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

        /* ===== МОБИЛЬНАЯ ВЕРСИЯ ===== */
        .mobile-app-panel {
            flex-direction: column;
            width: 100%;
            height: 100%;
        }

        /* Верхняя панель навигации для мобильных */
        .mobile-top-nav {
            height: var(--top-nav-height);
            background: white;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            padding: 0 15px;
            flex-shrink: 0;
        }

        .mobile-nav-tabs {
            display: flex;
            flex: 1;
            justify-content: center;
            gap: 20px;
        }

        .mobile-nav-tab {
            padding: 12px 20px;
            cursor: pointer;
            font-weight: 500;
            color: var(--text-secondary);
            transition: all 0.3s;
            display: flex;
            align-items: center;
            gap: 8px;
            border-bottom: 2px solid transparent;
            font-size: 15px;
        }

        .mobile-nav-tab.active {
            color: var(--primary-color);
            border-bottom-color: var(--primary-color);
        }

        /* Контент мобильного приложения */
        .mobile-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        /* Панель списка чатов/контактов для мобильных */
        .mobile-list-panel {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .mobile-search-box {
            padding: 15px;
            border-bottom: 1px solid var(--border-color);
        }

        .mobile-search-box input {
            width: 100%;
            padding: 10px 12px;
            border: 2px solid var(--border-color);
            border-radius: 10px;
            font-size: 14px;
        }

        .mobile-list-content {
            flex: 1;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
            padding: 15px;
        }

        /* Панель чата для мобильных */
        .mobile-chat-panel {
            flex: 1;
            display: none;
            flex-direction: column;
            overflow: hidden;
        }

        .mobile-chat-panel.active {
            display: flex;
        }

        /* Заголовок чата в мобильной версии */
        .mobile-chat-header {
            height: var(--top-nav-height);
            background: white;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            padding: 0 15px;
            flex-shrink: 0;
        }

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

        .chat-title {
            flex: 1;
            font-size: 18px;
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .chat-actions {
            display: flex;
            gap: 8px;
            margin-left: auto;
        }

        .chat-action-btn {
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

        .chat-action-btn:hover {
            background: #f3f4f6;
        }

        /* ===== ПК ВЕРСИЯ ===== */
        .desktop-app-panel {
            flex-direction: row;
            width: 100%;
            height: 100%;
        }

        /* Боковая панель для ПК */
        .desktop-sidebar {
            width: var(--sidebar-width);
            background: var(--secondary-color);
            border-right: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .desktop-user-info {
            padding: 15px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            gap: 10px;
            flex-shrink: 0;
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

        .user-details {
            flex: 1;
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

        /* Вкладки для ПК */
        .desktop-nav-tabs {
            display: flex;
            border-bottom: 1px solid var(--border-color);
            background: white;
        }

        .desktop-nav-tab {
            flex: 1;
            text-align: center;
            padding: 15px;
            cursor: pointer;
            font-weight: 500;
            color: var(--text-secondary);
            transition: all 0.3s;
            border-bottom: 2px solid transparent;
            font-size: 15px;
        }

        .desktop-nav-tab.active {
            color: var(--primary-color);
            border-bottom-color: var(--primary-color);
        }

        .desktop-tab-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .desktop-search-box {
            padding: 15px;
            border-bottom: 1px solid var(--border-color);
        }

        .desktop-search-box input {
            width: 100%;
            padding: 10px 12px;
            border: 2px solid var(--border-color);
            border-radius: 10px;
            font-size: 14px;
        }

        .desktop-list-content {
            flex: 1;
            overflow-y: auto;
            padding: 15px;
        }

        /* Область чата для ПК */
        .desktop-chat-area {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            background: #f9fafb;
        }

        .desktop-chat-header {
            padding: 15px;
            border-bottom: 1px solid var(--border-color);
            background: white;
            display: flex;
            align-items: center;
            flex-shrink: 0;
        }

        .desktop-chat-messages {
            flex: 1;
            padding: 15px;
            overflow-y: auto;
            background: #f9fafb;
            display: flex;
            flex-direction: column;
            -webkit-overflow-scrolling: touch;
        }

        .desktop-chat-placeholder {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #9ca3af;
        }

        .desktop-chat-placeholder-content {
            text-align: center;
            padding: 20px;
        }

        .desktop-chat-placeholder-content i {
            font-size: 48px;
            margin-bottom: 20px;
        }

        .desktop-chat-placeholder-content h3 {
            margin-bottom: 10px;
            font-size: 18px;
        }

        .desktop-chat-placeholder-content p {
            font-size: 14px;
        }

        /* ===== ОБЩИЕ ЭЛЕМЕНТЫ ===== */
        
        /* Список чатов/контактов */
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

        /* Контакты */
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

        /* Сообщения в чате */
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

        /* Голосовые сообщения */
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

        /* Файловые сообщения */
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

        /* Область ввода сообщения */
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

        /* Кнопка отправки */
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

        /* Индикатор печати */
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

        /* Пустое состояние */
        .empty-state {
            text-align: center;
            padding: 30px 15px;
            color: #9ca3af;
            font-size: 14px;
        }

        /* Загрузка */
        .loading {
            text-align: center;
            padding: 20px;
            color: var(--text-secondary);
            font-size: 14px;
        }

        /* Анимация пульсации */
        @keyframes pulse {
            0% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.1); opacity: 0.8; }
            100% { transform: scale(1); opacity: 1; }
        }

        /* Кнопка добавления контакта */
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

        /* Медиа-запросы для определения устройства */
        @media (max-width: 768px) {
            .mobile-app-panel {
                display: flex;
            }
            
            .desktop-app-panel {
                display: none;
            }
        }

        @media (min-width: 769px) {
            .mobile-app-panel {
                display: none;
            }
            
            .desktop-app-panel {
                display: flex;
            }
        }

        /* Исправления для маленьких экранов */
        @media (max-width: 480px) {
            .mobile-nav-tab {
                padding: 10px 15px;
                font-size: 14px;
            }
            
            .mobile-nav-tab .tab-text {
                display: none;
            }
            
            .auth-panel {
                border-radius: 10px;
                padding: 20px;
                margin: 10px;
                width: calc(100% - 20px);
                max-width: none;
                max-height: calc(100vh - 20px);
            }
        }

        /* Улучшения для очень маленьких экранов */
        @media (max-height: 500px) {
            .auth-panel {
                padding: 15px 10px;
            }
            
            .logo h1 {
                font-size: 20px;
            }
            
            .logo p {
                font-size: 12px;
            }
            
            .form-group {
                margin-bottom: 10px;
            }
            
            .form-group label {
                font-size: 14px;
                margin-bottom: 5px;
            }
            
            .form-group input,
            .btn {
                padding: 10px;
                font-size: 14px;
            }
            
            .toggle-auth {
                margin-top: 10px;
                font-size: 12px;
            }
        }

        /* Для iOS Safari и Android */
        @supports (-webkit-touch-callout: none) {
            body, html {
                height: -webkit-fill-available;
                max-height: -webkit-fill-available;
            }
            
            .app-panel {
                max-height: -webkit-fill-available;
            }
            
            .auth-panel {
                max-height: -webkit-fill-available;
            }
            
            /* Убираем задержку 300ms для мобильных Safari */
            a, button, input[type="button"], input[type="submit"] {
                cursor: pointer;
                -webkit-tap-highlight-color: transparent;
            }
            
            /* Для Android Chrome */
            .desktop-chat-messages,
            .mobile-list-content,
            .auth-panel {
                -webkit-overflow-scrolling: touch;
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
            
            <div class="form-group">
                <label style="display: flex; align-items: center; cursor: pointer;">
                    <input type="checkbox" id="rememberMe" style="margin-right: 8px; width: 16px; height: 16px;">
                    <span style="font-size: 14px;">Запомнить меня на этом устройстве</span>
                </label>
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
            
            <div class="form-group">
                <label style="display: flex; align-items: center; cursor: pointer;">
                    <input type="checkbox" id="rememberMeRegister" style="margin-right: 8px; width: 16px; height: 16px;">
                    <span style="font-size: 14px;">Запомнить меня на этом устройстве</span>
                </label>
            </div>
            
            <button class="btn" onclick="register()">Зарегистрироваться</button>
            
            <div class="toggle-auth">
                Уже есть аккаунт? <a onclick="showLogin()">Войти</a>
            </div>
        </div>
    </div>

    <!-- Основной интерфейс (скрыт до входа) -->
    <div class="container" style="display: none;" id="appContainer">
        <!-- МОБИЛЬНАЯ ВЕРСИЯ -->
        <div class="app-panel mobile-app-panel active" id="mobileAppPanel">
            <!-- Главный экран: список чатов/контактов -->
            <div class="mobile-content" id="mobileMainContent">
                <!-- Верхняя навигация с переключателем -->
                <div class="mobile-top-nav">
                    <div class="mobile-nav-tabs">
                        <div class="mobile-nav-tab active" onclick="switchMobileTab('chats')">
                            <i class="fas fa-comments"></i> <span class="tab-text">Чаты</span>
                        </div>
                        <div class="mobile-nav-tab" onclick="switchMobileTab('contacts')">
                            <i class="fas fa-users"></i> <span class="tab-text">Контакты</span>
                        </div>
                    </div>
                </div>
                
                <!-- Панель списка -->
                <div class="mobile-list-panel">
                    <!-- Поиск -->
                    <div class="mobile-search-box">
                        <input type="text" placeholder="Поиск..." oninput="searchCurrentList(this.value)">
                    </div>
                    
                    <!-- Список чатов -->
                    <div class="mobile-list-content" id="mobileChatsList">
                        <div class="loading">Загрузка чатов...</div>
                    </div>
                    
                    <!-- Список контактов -->
                    <div class="mobile-list-content" id="mobileContactsList" style="display: none;">
                        <div class="loading">Загрузка контактов...</div>
                    </div>
                </div>
            </div>
            
            <!-- Экран чата (скрыт по умолчанию) -->
            <div class="mobile-chat-panel" id="mobileChatPanel">
                <!-- Заголовок чата -->
                <div class="mobile-chat-header">
                    <button class="back-button" onclick="closeMobileChat()">
                        <i class="fas fa-arrow-left"></i>
                    </button>
                    <div class="chat-title" id="mobileChatTitle">Название чата</div>
                    <div class="chat-actions">
                        <button class="chat-action-btn" onclick="startAudioCall()" title="Аудиозвонок">
                            <i class="fas fa-phone"></i>
                        </button>
                        <button class="chat-action-btn" onclick="showChatInfo()" title="Информация о чате">
                            <i class="fas fa-info-circle"></i>
                        </button>
                    </div>
                </div>
                
                <!-- Сообщения -->
                <div class="desktop-chat-messages" id="mobileChatMessages">
                    <div class="empty-state">Сообщений пока нет</div>
                </div>
                
                <!-- Индикатор печати -->
                <div class="typing-indicator" id="mobileTypingIndicator">
                    <div class="typing-dots">
                        <div class="typing-dot"></div>
                        <div class="typing-dot"></div>
                        <div class="typing-dot"></div>
                    </div>
                    <span id="mobileTypingText">Печатает...</span>
                </div>
                
                <!-- Ввод сообщения -->
                <div class="chat-input-area">
                    <button class="chat-action-btn" onclick="toggleAttachmentMenu('mobile')">
                        <i class="fas fa-paperclip"></i>
                    </button>
                    <div class="chat-input">
                        <input type="text" id="mobileMessageInput" placeholder="Введите сообщение..." 
                               oninput="handleTyping()" onkeypress="handleKeyPress(event)">
                        <div class="input-hint">
                            <i class="fas fa-microphone"></i> Удерживайте для записи
                        </div>
                    </div>
                    <button class="send-button" id="mobileSendButton" 
                            onmousedown="startVoiceRecording(event, 'mobile')" 
                            ontouchstart="startVoiceRecording(event, 'mobile')"
                            onmouseup="stopVoiceRecording(event, 'mobile')"
                            ontouchend="stopVoiceRecording(event, 'mobile')">
                        <i class="fas fa-paper-plane"></i>
                    </button>
                </div>
            </div>
        </div>

        <!-- ПК ВЕРСИЯ -->
        <div class="app-panel desktop-app-panel active" id="desktopAppPanel">
            <!-- Боковая панель -->
            <div class="desktop-sidebar">
                <!-- Информация о пользователе -->
                <div class="desktop-user-info">
                    <div class="user-avatar" id="desktopUserAvatar">Т</div>
                    <div class="user-details">
                        <h3 id="desktopUserName">Тестовый Пользователь</h3>
                        <p id="desktopUserEmail">test@example.com</p>
                    </div>
                    <button onclick="logout()" style="background: none; border: none; cursor: pointer; color: #666; font-size: 16px;">
                        <i class="fas fa-sign-out-alt"></i>
                    </button>
                </div>
                
                <!-- Вкладки -->
                <div class="desktop-nav-tabs">
                    <div class="desktop-nav-tab active" onclick="switchDesktopTab('chats')">
                        <i class="fas fa-comments"></i> <span>Чаты</span>
                    </div>
                    <div class="desktop-nav-tab" onclick="switchDesktopTab('contacts')">
                        <i class="fas fa-users"></i> <span>Контакты</span>
                    </div>
                </div>
                
                <!-- Контент вкладки -->
                <div class="desktop-tab-content">
                    <!-- Поиск -->
                    <div class="desktop-search-box">
                        <input type="text" placeholder="Поиск..." oninput="searchCurrentList(this.value)">
                    </div>
                    
                    <!-- Список -->
                    <div class="desktop-list-content">
                        <!-- Список чатов -->
                        <div id="desktopChatsList">
                            <div class="loading">Загрузка чатов...</div>
                        </div>
                        
                        <!-- Список контактов -->
                        <div id="desktopContactsList" style="display: none;">
                            <div class="loading">Загрузка контактов...</div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Область чата -->
            <div class="desktop-chat-area">
                <!-- Заглушка при отсутствии выбранного чата -->
                <div class="desktop-chat-placeholder" id="desktopChatPlaceholder">
                    <div class="desktop-chat-placeholder-content">
                        <i class="fas fa-comments"></i>
                        <h3>Выберите чат</h3>
                        <p>Начните общение с контактом</p>
                    </div>
                </div>
                
                <!-- Интерфейс чата -->
                <div id="desktopChatInterface" style="display: none; flex-direction: column; height: 100%;">
                    <!-- Заголовок чата -->
                    <div class="desktop-chat-header">
                        <div style="flex: 1;">
                            <h3 id="desktopChatTitle" style="font-size: 18px; margin-bottom: 4px;">Название чата</h3>
                            <div id="desktopChatStatus" style="font-size: 12px; color: var(--text-secondary);">...</div>
                        </div>
                        <div style="display: flex; gap: 10px;">
                            <button onclick="startAudioCall()" style="background: none; border: none; cursor: pointer; color: var(--primary-color); font-size: 18px;">
                                <i class="fas fa-phone"></i>
                            </button>
                            <button onclick="showChatInfo()" style="background: none; border: none; cursor: pointer; color: var(--text-secondary); font-size: 18px;">
                                <i class="fas fa-info-circle"></i>
                            </button>
                        </div>
                    </div>
                    
                    <!-- Сообщения -->
                    <div class="desktop-chat-messages" id="desktopChatMessages">
                        <div class="empty-state">Сообщений пока нет</div>
                    </div>
                    
                    <!-- Индикатор печати -->
                    <div class="typing-indicator" id="desktopTypingIndicator">
                        <div class="typing-dots">
                            <div class="typing-dot"></div>
                            <div class="typing-dot"></div>
                            <div class="typing-dot"></div>
                        </div>
                        <span id="desktopTypingText">Печатает...</span>
                    </div>
                    
                    <!-- Ввод сообщения -->
                    <div class="chat-input-area">
                        <button class="chat-action-btn" onclick="toggleAttachmentMenu('desktop')">
                            <i class="fas fa-paperclip"></i>
                        </button>
                        <div class="chat-input">
                            <input type="text" id="desktopMessageInput" placeholder="Введите сообщение..." 
                                   oninput="handleTyping()" onkeypress="handleKeyPress(event)">
                            <div class="input-hint">
                                <i class="fas fa-microphone"></i> Удерживайте для записи
                            </div>
                        </div>
                        <button class="send-button" id="desktopSendButton" 
                                onmousedown="startVoiceRecording(event, 'desktop')" 
                                ontouchstart="startVoiceRecording(event, 'desktop')"
                                onmouseup="stopVoiceRecording(event, 'desktop')"
                                ontouchend="stopVoiceRecording(event, 'desktop')">
                            <i class="fas fa-paper-plane"></i>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Кнопка добавления контакта -->
    <button class="add-contact-btn" onclick="showAddContactModal()" id="addContactBtn" style="display: none;">
        <i class="fas fa-user-plus"></i>
    </button>

    <!-- JavaScript код -->
    <script>
        // Основные переменные
        let currentUser = null;
        let token = null;
        let currentChatId = null;
        let ws = null;
        let chats = [];
        let contacts = [];
        let isMobile = false;
        let deviceId = null;
        let currentMobileTab = 'chats';
        let currentDesktopTab = 'chats';
        
        // URL для подключения
        const baseUrl = window.location.origin;
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = wsProtocol + '//' + window.location.host;
        
        console.log('Base URL:', baseUrl);
        console.log('WebSocket URL:', wsUrl);
        
        // Определяем устройство
        function detectDevice() {
            isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            console.log('Устройство:', isMobile ? 'Мобильное' : 'ПК');
            return isMobile;
        }
        
        // ===== ФУНКЦИИ ДЛЯ МОБИЛЬНОГО ИНТЕРФЕЙСА =====
        
        function switchMobileTab(tabName) {
            currentMobileTab = tabName;
            
            // Обновляем активные вкладки
            document.querySelectorAll('.mobile-nav-tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            if (tabName === 'chats') {
                document.querySelector('.mobile-nav-tab:nth-child(1)').classList.add('active');
                document.getElementById('mobileChatsList').style.display = 'block';
                document.getElementById('mobileContactsList').style.display = 'none';
                
                // Загружаем чаты
                loadMobileChats();
            } else {
                document.querySelector('.mobile-nav-tab:nth-child(2)').classList.add('active');
                document.getElementById('mobileChatsList').style.display = 'none';
                document.getElementById('mobileContactsList').style.display = 'block';
                
                // Загружаем контакты
                loadMobileContacts();
            }
            
            // Показываем/скрываем кнопку добавления контакта
            document.getElementById('addContactBtn').style.display = tabName === 'contacts' ? 'block' : 'none';
        }
        
        function openMobileChat(chatId) {
            // Прячем главный экран, показываем экран чата
            document.getElementById('mobileMainContent').style.display = 'none';
            document.getElementById('mobileChatPanel').classList.add('active');
            
            // Устанавливаем текущий чат и загружаем сообщения
            currentChatId = chatId;
            loadMessages(chatId);
            
            // Обновляем заголовок чата
            const chat = chats.find(c => c.chat_id === chatId);
            if (chat) {
                const chatName = chat.chat_name || chat.other_user_name || 'Личный чат';
                document.getElementById('mobileChatTitle').textContent = chatName;
            }
            
            // Фокус на поле ввода
            setTimeout(() => {
                document.getElementById('mobileMessageInput').focus();
            }, 100);
        }
        
        function closeMobileChat() {
            // Показываем главный экран, скрываем экран чата
            document.getElementById('mobileMainContent').style.display = 'flex';
            document.getElementById('mobileChatPanel').classList.remove('active');
            currentChatId = null;
        }
        
        // ===== ФУНКЦИИ ДЛЯ ПК ИНТЕРФЕЙСА =====
        
        function switchDesktopTab(tabName) {
            currentDesktopTab = tabName;
            
            // Обновляем активные вкладки
            document.querySelectorAll('.desktop-nav-tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            if (tabName === 'chats') {
                document.querySelector('.desktop-nav-tab:nth-child(1)').classList.add('active');
                document.getElementById('desktopChatsList').style.display = 'block';
                document.getElementById('desktopContactsList').style.display = 'none';
                
                // Загружаем чаты
                loadDesktopChats();
            } else {
                document.querySelector('.desktop-nav-tab:nth-child(2)').classList.add('active');
                document.getElementById('desktopChatsList').style.display = 'none';
                document.getElementById('desktopContactsList').style.display = 'block';
                
                // Загружаем контакты
                loadDesktopContacts();
            }
            
            // Показываем/скрываем кнопку добавления контакта
            document.getElementById('addContactBtn').style.display = tabName === 'contacts' ? 'block' : 'none';
        }
        
        function openDesktopChat(chatId) {
            // Показываем интерфейс чата, скрываем заглушку
            document.getElementById('desktopChatPlaceholder').style.display = 'none';
            document.getElementById('desktopChatInterface').style.display = 'flex';
            
            // Устанавливаем текущий чат и загружаем сообщения
            currentChatId = chatId;
            loadMessages(chatId);
            
            // Обновляем заголовок чата
            const chat = chats.find(c => c.chat_id === chatId);
            if (chat) {
                const chatName = chat.chat_name || chat.other_user_name || 'Личный чат';
                document.getElementById('desktopChatTitle').textContent = chatName;
            }
            
            // Фокус на поле ввода
            setTimeout(() => {
                document.getElementById('desktopMessageInput').focus();
            }, 100);
        }
        
        // ===== ОБЩИЕ ФУНКЦИИ =====
        
        function showMainPage() {
            const isMobileDevice = detectDevice();
            
            if (isMobileDevice) {
                // В мобильной версии показываем главный экран
                closeMobileChat();
                
                // Показываем соответствующую вкладку
                if (currentMobileTab === 'chats') {
                    loadMobileChats();
                } else {
                    loadMobileContacts();
                }
            } else {
                // В ПК версии показываем заглушку чата
                document.getElementById('desktopChatPlaceholder').style.display = 'flex';
                document.getElementById('desktopChatInterface').style.display = 'none';
                currentChatId = null;
                
                // Показываем соответствующую вкладку
                if (currentDesktopTab === 'chats') {
                    loadDesktopChats();
                } else {
                    loadDesktopContacts();
                }
            }
        }
        
        function openChat(chatId) {
            const isMobileDevice = detectDevice();
            
            if (isMobileDevice) {
                openMobileChat(chatId);
            } else {
                openDesktopChat(chatId);
            }
        }
        
        function searchCurrentList(query) {
            const isMobileDevice = detectDevice();
            
            if (isMobileDevice) {
                if (currentMobileTab === 'chats') {
                    searchChats(query);
                } else {
                    searchContacts(query);
                }
            } else {
                if (currentDesktopTab === 'chats') {
                    searchChats(query);
                } else {
                    searchContacts(query);
                }
            }
        }
        
        // ===== ФУНКЦИИ ДЛЯ РАБОТЫ С ДАННЫМИ =====
        
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
                    console.log('Загружено чатов:', chats.length);
                    
                    // Обновляем отображение в зависимости от устройства
                    const isMobileDevice = detectDevice();
                    if (isMobileDevice) {
                        loadMobileChats();
                    } else {
                        loadDesktopChats();
                    }
                } else {
                    console.error('Ошибка загрузки чатов:', response.status);
                }
            } catch (error) {
                console.error('Ошибка при загрузке чатов:', error);
            }
        }
        
        function loadMobileChats() {
            const container = document.getElementById('mobileChatsList');
            
            if (!chats || chats.length === 0) {
                container.innerHTML = '<div class="empty-state">Чатов пока нет</div>';
                return;
            }
            
            displayChats(chats, container);
        }
        
        function loadDesktopChats() {
            const container = document.getElementById('desktopChatsList');
            
            if (!chats || chats.length === 0) {
                container.innerHTML = '<div class="empty-state">Чатов пока нет</div>';
                return;
            }
            
            displayChats(chats, container);
        }
        
        function displayChats(chatList, container) {
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
                    console.log('Загружено контактов:', contacts.length);
                    
                    // Обновляем отображение в зависимости от устройства
                    const isMobileDevice = detectDevice();
                    if (isMobileDevice) {
                        loadMobileContacts();
                    } else {
                        loadDesktopContacts();
                    }
                } else {
                    console.error('Ошибка загрузки контактов:', response.status);
                }
            } catch (error) {
                console.error('Ошибка при загрузке контактов:', error);
            }
        }
        
        function loadMobileContacts() {
            const container = document.getElementById('mobileContactsList');
            
            if (!contacts || contacts.length === 0) {
                container.innerHTML = '<div class="empty-state">Контактов пока нет</div>';
                return;
            }
            
            displayContacts(contacts, container);
        }
        
        function loadDesktopContacts() {
            const container = document.getElementById('desktopContactsList');
            
            if (!contacts || contacts.length === 0) {
                container.innerHTML = '<div class="empty-state">Контактов пока нет</div>';
                return;
            }
            
            displayContacts(contacts, container);
        }
        
        function displayContacts(contactList, container) {
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
        
        function searchChats(query) {
            const isMobileDevice = detectDevice();
            let container;
            
            if (isMobileDevice) {
                container = document.getElementById('mobileChatsList');
            } else {
                container = document.getElementById('desktopChatsList');
            }
            
            const filtered = chats.filter(chat => {
                const chatName = chat.chat_name || chat.other_user_name || 'Личный чат';
                const lastMessage = chat.last_message || '';
                return chatName.toLowerCase().includes(query.toLowerCase()) ||
                       lastMessage.toLowerCase().includes(query.toLowerCase());
            });
            
            if (filtered.length === 0) {
                container.innerHTML = '<div class="empty-state">Ничего не найдено</div>';
            } else {
                displayChats(filtered, container);
            }
        }
        
        function searchContacts(query) {
            const isMobileDevice = detectDevice();
            let container;
            
            if (isMobileDevice) {
                container = document.getElementById('mobileContactsList');
            } else {
                container = document.getElementById('desktopContactsList');
            }
            
            const filtered = contacts.filter(contact => 
                contact.username.toLowerCase().includes(query.toLowerCase()) ||
                contact.email.toLowerCase().includes(query.toLowerCase())
            );
            
            if (filtered.length === 0) {
                container.innerHTML = '<div class="empty-state">Ничего не найдено</div>';
            } else {
                displayContacts(filtered, container);
            }
        }
        
        // ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====
        
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
        
        // ===== ИНИЦИАЛИЗАЦИЯ =====
        
        window.onload = async function() {
            // Определяем устройство
            isMobile = detectDevice();
            
            // Настраиваем отображение в зависимости от устройства
            if (isMobile) {
                document.getElementById('mobileAppPanel').style.display = 'flex';
                document.getElementById('desktopAppPanel').style.display = 'none';
            } else {
                document.getElementById('mobileAppPanel').style.display = 'none';
                document.getElementById('desktopAppPanel').style.display = 'flex';
            }
            
            console.log('Application initialized');
            console.log('Base URL:', baseUrl);
            console.log('WebSocket URL:', wsUrl);
            console.log('Тип устройства:', isMobile ? 'Мобильное' : 'ПК');
        };
    </script>
</body>
</html>`;

// Создаем HTTP сервер
const server = http.createServer((req, res) => {
    // CORS заголовки
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id');
    
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
    } else if (req.url === '/api/validate-token' && req.method === 'POST') {
        parseJSON(req, res, () => handleValidateToken(req, res));
    } else if (req.url === '/api/logout' && req.method === 'POST') {
        parseJSON(req, res, () => handleLogout(req, res));
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
    const { email, username, password, rememberMe } = req.body;
    const deviceId = req.headers['x-device-id'];
    
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
                    
                    const userId = this.lastID;
                    const token = jwt.sign(
                        { userId: userId, email },
                        JWT_SECRET,
                        { expiresIn: '30d' }
                    );
                    
                    // Если выбрано "запомнить меня", сохраняем сессию
                    if (rememberMe && deviceId) {
                        const expiresAt = new Date();
                        expiresAt.setDate(expiresAt.getDate() + 30); // 30 дней
                        
                        db.run(
                            'INSERT OR REPLACE INTO user_sessions (user_id, device_id, token, expires_at) VALUES (?, ?, ?, ?)',
                            [userId, deviceId, token, expiresAt.toISOString()],
                            (err) => {
                                if (err) {
                                    console.error('Error saving session:', err);
                                } else {
                                    console.log('Session saved for device:', deviceId);
                                }
                            }
                        );
                    }
                    
                    res.writeHead(201, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: true, 
                        token,
                        user: { id: userId, email, username }
                    }));
                }
            );
        });
    });
}

async function handleLogin(req, res) {
    const { email, password, rememberMe } = req.body;
    const deviceId = req.headers['x-device-id'];
    
    console.log('Вход пользователя:', email, 'rememberMe:', rememberMe, 'deviceId:', deviceId);
    
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
                { expiresIn: '30d' }
            );
            
            // Если выбрано "запомнить меня", сохраняем сессию
            if (rememberMe && deviceId) {
                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + 30); // 30 дней
                
                db.run(
                    'INSERT OR REPLACE INTO user_sessions (user_id, device_id, token, expires_at) VALUES (?, ?, ?, ?)',
                    [user.id, deviceId, token, expiresAt.toISOString()],
                    (err) => {
                        if (err) {
                            console.error('Error saving session:', err);
                        } else {
                            console.log('Session saved for device:', deviceId);
                        }
                    }
                );
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: true, 
                token,
                user: { id: user.id, email: user.email, username: user.username }
            }));
        });
    });
}

// Валидация токена с проверкой сессии устройства
async function handleValidateToken(req, res) {
    const authHeader = req.headers.authorization;
    const deviceId = req.headers['x-device-id'];
    
    console.log('Валидация токена для устройства:', deviceId);
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ valid: false, error: 'No token provided' }));
        return;
    }

    const token = authHeader.replace('Bearer ', '');
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        console.log('Токен расшифрован, userId:', decoded.userId);
        
        // Проверяем сессию устройства, если предоставлен deviceId
        if (deviceId) {
            db.get(
                'SELECT token FROM user_sessions WHERE user_id = ? AND device_id = ? AND expires_at > ?',
                [decoded.userId, deviceId, new Date().toISOString()],
                (err, session) => {
                    if (err) {
                        console.error('Database error:', err);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ valid: false, error: 'Database error' }));
                        return;
                    }
                    
                    console.log('Сессия найдена:', session);
                    
                    if (!session || session.token !== token) {
                        console.log('Сессия недействительна или истекла');
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ valid: false, error: 'Session expired or invalid' }));
                        return;
                    }
                    
                    // Сессия валидна, получаем данные пользователя
                    getUserAndRespond(decoded.userId, res);
                }
            );
        } else {
            // Если нет deviceId, просто проверяем пользователя
            getUserAndRespond(decoded.userId, res);
        }
    } catch (error) {
        console.error('Token verification error:', error);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ valid: false, error: 'Invalid token' }));
    }
}

// Вспомогательная функция для получения пользователя и отправки ответа
function getUserAndRespond(userId, res) {
    db.get('SELECT id, email, username FROM users WHERE id = ?', [userId], (err, user) => {
        if (err) {
            console.error('Database error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ valid: false, error: 'Database error' }));
            return;
        }
        
        if (!user) {
            console.log('Пользователь не найден, userId:', userId);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ valid: false, error: 'User not found' }));
            return;
        }
        
        console.log('Пользователь найден:', user.username);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            valid: true,
            user: { id: user.id, email: user.email, username: user.username }
        }));
    });
}

// Выход из системы с удалением сессии устройства
async function handleLogout(req, res) {
    const authHeader = req.headers.authorization;
    const deviceId = req.headers['x-device-id'];
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No token provided' }));
        return;
    }

    const token = authHeader.replace('Bearer ', '');
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Удаляем сессию устройства
        if (deviceId) {
            db.run(
                'DELETE FROM user_sessions WHERE user_id = ? AND device_id = ?',
                [decoded.userId, deviceId],
                (err) => {
                    if (err) {
                        console.error('Error deleting session:', err);
                    } else {
                        console.log('Session deleted for device:', deviceId);
                    }
                }
            );
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Logged out successfully' }));
    } catch (error) {
        console.error('Token verification error:', error);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid token' }));
    }
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
            
            console.log('Возвращено контактов для пользователя', req.userId, ':', contacts?.length || 0);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ contacts: contacts || [] }));
        }
    );
}

async function handleAddContact(req, res) {
    const { email } = req.body;
    
    console.log('Добавление контакта:', email, 'для пользователя:', req.userId);
    
    // Находим пользователя по email
    db.get('SELECT id, username FROM users WHERE email = ?', [email], (err, contact) => {
        if (err) {
            console.error('Database error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Database error' }));
            return;
        }
        
        if (!contact) {
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
                if (err) {
                    console.error('Database error:', err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Database error' }));
                    return;
                }
                
                if (existing) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Контакт уже добавлен' }));
                    return;
                }
                
                // Добавляем контакт в обе стороны (симметрично)
                db.serialize(() => {
                    db.run(
                        'INSERT INTO contacts (user_id, contact_id) VALUES (?, ?)',
                        [req.userId, contact.id],
                        (err) => {
                            if (err) {
                                console.error('Error adding contact:', err);
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Error adding contact' }));
                                return;
                            }
                        }
                    );
                    
                    db.run(
                        'INSERT INTO contacts (user_id, contact_id) VALUES (?, ?)',
                        [contact.id, req.userId],
                        (err) => {
                            if (err) {
                                console.error('Error adding reverse contact:', err);
                            }
                        }
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
                                        
                                        console.log('Контакт добавлен и чат создан, chatId:', chatId);
                                        
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
            console.log('Возвращено чатов для пользователя', req.userId, ':', result.length);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ chats: result }));
        }
    );
}

async function handleStartChat(req, res) {
    const { contactId } = req.body;
    
    console.log('Создание чата с контактом:', contactId, 'для пользователя:', req.userId);
    
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
                console.log('Чат уже существует, chatId:', existingChat.chat_id);
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
                                    
                                    console.log('Чат создан, chatId:', chatId);
                                    
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
    
    console.log('Получение сообщений для чата:', chatId, 'пользователь:', req.userId);
    
    // Проверяем, имеет ли пользователь доступ к этому чату
    db.get(
        'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
        [chatId, req.userId],
        (err, hasAccess) => {
            if (err) {
                console.error('Database error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Database error' }));
                return;
            }
            
            if (!hasAccess) {
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
                    
                    console.log('Возвращено сообщений для чата', chatId, ':', messages?.length || 0);
                    
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
    ws.deviceId = null;
    ws.callData = null;
    ws.callAnswer = null;
    
    console.log('Новое WebSocket подключение');
    
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
                        ws.deviceId = message.deviceId;
                        
                        // Удаляем старые подключения для этого пользователя
                        clients.delete(user.id);
                        // Добавляем новое подключение
                        clients.set(user.id, ws);
                        
                        console.log('WebSocket аутентифицирован: ' + user.username + ' (' + user.email + ') ID: ' + user.id + ' Устройство: ' + message.deviceId);
                        
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
            console.log('Отключение пользователя ID: ' + ws.userId + ' с устройства: ' + ws.deviceId);
            
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
    
    console.log('\n📱 Адаптивный интерфейс:');
    console.log('• На ПК: боковая панель + область чата справа');
    console.log('• На мобильных: отдельный экран чата');
    console.log('• Автоматический вход с сохранением на устройстве');
    
    console.log('\n🔐 Автоматический вход:');
    console.log('• Сохранение токена с привязкой к устройству');
    console.log('• Опция "Запомнить меня на этом устройстве"');
    console.log('• Удаление сессии при выходе');
    
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

