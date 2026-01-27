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
const VIDEOS_DIR = path.join(UPLOADS_DIR, 'videos');

// Создаем директории для загрузок
[UPLOADS_DIR, AUDIO_DIR, FILES_DIR, VIDEOS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Инициализация базы данных
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

    // Участники чатов
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
            video_url TEXT,
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

    // Сессии
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

// HTML шаблон
const HTML_TEMPLATE = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');

// Создаем HTTP сервер
const server = http.createServer((req, res) => {
    // CORS заголовки
    const allowedOrigins = [
        'http://localhost:8080',
        'http://localhost:8100',
        'http://localhost:4200',
        'capacitor://localhost',
        'ionic://localhost',
        'http://localhost',
        'file://'
    ];
    
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin) || !origin) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }
    
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id, X-Requested-With');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');
    
    // Предварительные запросы OPTIONS
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
    } else if (req.url === '/api/upload-video' && req.method === 'POST') {
        handleUploadVideo(req, res);
    } else if (req.url.startsWith('/uploads/') && req.method === 'GET') {
        serveFile(req, res);
    } else if (req.url.startsWith('/api/chat/') && req.url.includes('/other-user') && req.method === 'GET') {
        parseJSON(req, res, () => {
            authenticate(req, res, () => handleGetOtherUser(req, res));
        });
    } else if (req.url === '/' || req.url === '/index.html' || req.url === '/index') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML_TEMPLATE);
    } else if (req.url === '/health' || req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    } else {
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
            
            db.get(
                'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
                [chatId, userId],
                (err, hasAccess) => {
                    if (err || !hasAccess) {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Access denied' }));
                        return;
                    }
                    
                    const timestamp = Date.now();
                    const random = Math.random().toString(36).substring(2, 15);
                    const filename = 'voice_' + userId + '_' + timestamp + '_' + random + '.webm';
                    const filepath = path.join(AUDIO_DIR, filename);
                    const audioUrl = '/uploads/audio/' + filename;
                    
                    fs.writeFile(filepath, audioData, (err) => {
                        if (err) {
                            console.error('Error saving audio file:', err);
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Error saving audio file' }));
                            return;
                        }
                        
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
                                
                                db.get(
                                    'SELECT m.*, u.username, u.email FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?',
                                    [this.lastID],
                                    (err, savedMessage) => {
                                        if (err) {
                                            console.error('Error fetching saved message:', err);
                                            return;
                                        }
                                        
                                        db.all(
                                            'SELECT user_id FROM chat_members WHERE chat_id = ?',
                                            [chatId],
                                            (err, members) => {
                                                if (err) {
                                                    console.error('Error fetching chat members:', err);
                                                    return;
                                                }
                                                
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

// Функция для обработки загрузки видео файлов
function handleUploadVideo(req, res) {
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
            
            const boundary = req.headers['content-type'].split('boundary=')[1];
            const parts = data.toString('binary').split('--' + boundary);
            
            let chatId, duration;
            let videoData = null;
            let videoFilename = null;
            let videoType = 'video/mp4';
            
            for (const part of parts) {
                if (part.includes('Content-Disposition: form-data')) {
                    const nameMatch = part.match(/name="([^"]+)"/);
                    if (nameMatch) {
                        const name = nameMatch[1];
                        
                        if (name === 'video') {
                            const filenameMatch = part.match(/filename="([^"]+)"/);
                            if (filenameMatch) {
                                videoFilename = filenameMatch[1];
                            }
                            
                            const contentTypeMatch = part.match(/Content-Type: ([^\r\n]+)/);
                            if (contentTypeMatch) {
                                videoType = contentTypeMatch[1];
                            }
                            
                            const contentStart = part.indexOf('\r\n\r\n') + 4;
                            const contentEnd = part.lastIndexOf('\r\n');
                            const content = part.substring(contentStart, contentEnd);
                            videoData = Buffer.from(content, 'binary');
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
            
            if (!chatId || !videoData) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields' }));
                return;
            }
            
            db.get(
                'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
                [chatId, userId],
                (err, hasAccess) => {
                    if (err || !hasAccess) {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Access denied' }));
                        return;
                    }
                    
                    const timestamp = Date.now();
                    const random = Math.random().toString(36).substring(2, 15);
                    const extension = videoType.includes('mp4') ? 'mp4' : 
                                    videoType.includes('webm') ? 'webm' : 'mp4';
                    const filename = 'video_' + userId + '_' + timestamp + '_' + random + '.' + extension;
                    const filepath = path.join(VIDEOS_DIR, filename);
                    const videoUrl = '/uploads/videos/' + filename;
                    
                    fs.writeFile(filepath, videoData, (err) => {
                        if (err) {
                            console.error('Error saving video file:', err);
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Error saving video file' }));
                            return;
                        }
                        
                        db.run(
                            'INSERT INTO messages (chat_id, user_id, video_url, message_type, duration) VALUES (?, ?, ?, ?, ?)',
                            [chatId, userId, videoUrl, 'video', duration || 0],
                            function(err) {
                                if (err) {
                                    console.error('Error saving video message:', err);
                                    res.writeHead(500, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ error: 'Error saving video message' }));
                                    return;
                                }
                                
                                db.get(
                                    'SELECT m.*, u.username, u.email FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?',
                                    [this.lastID],
                                    (err, savedMessage) => {
                                        if (err) {
                                            console.error('Error fetching saved message:', err);
                                            return;
                                        }
                                        
                                        db.all(
                                            'SELECT user_id FROM chat_members WHERE chat_id = ?',
                                            [chatId],
                                            (err, members) => {
                                                if (err) {
                                                    console.error('Error fetching chat members:', err);
                                                    return;
                                                }
                                                
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
                                                    message: 'Видео сообщение отправлено'
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
            
            db.get(
                'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
                [chatId, userId],
                (err, hasAccess) => {
                    if (err || !hasAccess) {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Access denied' }));
                        return;
                    }
                    
                    const fileSize = fileData.length;
                    if (fileSize > 100 * 1024 * 1024) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'File size exceeds 100MB limit' }));
                        return;
                    }
                    
                    const fileTypeFromName = fileName.toLowerCase();
                    let messageType = 'file';
                    let targetDir = FILES_DIR;
                    
                    if (fileTypeFromName.includes('.mp4') || fileTypeFromName.includes('.webm') || 
                        fileTypeFromName.includes('.avi') || fileTypeFromName.includes('.mov')) {
                        messageType = 'video';
                        targetDir = VIDEOS_DIR;
                    } else if (fileTypeFromName.includes('.mp3') || fileTypeFromName.includes('.wav') ||
                              fileTypeFromName.includes('.ogg') || fileTypeFromName.includes('.webm')) {
                        messageType = 'voice';
                        targetDir = AUDIO_DIR;
                    }
                    
                    const timestamp = Date.now();
                    const random = Math.random().toString(36).substring(2, 15);
                    const safeFileName = fileName.replace(/[^a-zA-Z0-9.]/g, '_');
                    const filename = 'file_' + userId + '_' + timestamp + '_' + random + '_' + safeFileName;
                    const filepath = path.join(targetDir, filename);
                    const fileUrl = '/uploads/' + (messageType === 'video' ? 'videos' : 
                                                messageType === 'voice' ? 'audio' : 'files') + '/' + filename;
                    
                    fs.writeFile(filepath, fileData, (err) => {
                        if (err) {
                            console.error('Error saving file:', err);
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Error saving file' }));
                            return;
                        }
                        
                        let sql, params;
                        if (messageType === 'video') {
                            sql = 'INSERT INTO messages (chat_id, user_id, video_url, file_name, file_size, file_type, message_type) VALUES (?, ?, ?, ?, ?, ?, ?)';
                            params = [chatId, userId, fileUrl, fileName, fileSize, fileType, 'video'];
                        } else if (messageType === 'voice') {
                            sql = 'INSERT INTO messages (chat_id, user_id, audio_url, file_name, file_size, file_type, message_type) VALUES (?, ?, ?, ?, ?, ?, ?)';
                            params = [chatId, userId, fileUrl, fileName, fileSize, fileType, 'voice'];
                        } else {
                            sql = 'INSERT INTO messages (chat_id, user_id, file_url, file_name, file_size, file_type, message_type) VALUES (?, ?, ?, ?, ?, ?, ?)';
                            params = [chatId, userId, fileUrl, fileName, fileSize, fileType, 'file'];
                        }
                        
                        db.run(
                            sql,
                            params,
                            function(err) {
                                if (err) {
                                    console.error('Error saving file message:', err);
                                    res.writeHead(500, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ error: 'Error saving file message' }));
                                    return;
                                }
                                
                                db.get(
                                    'SELECT m.*, u.username, u.email FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?',
                                    [this.lastID],
                                    (err, savedMessage) => {
                                        if (err) {
                                            console.error('Error fetching saved message:', err);
                                            return;
                                        }
                                        
                                        db.all(
                                            'SELECT user_id FROM chat_members WHERE chat_id = ?',
                                            [chatId],
                                            (err, members) => {
                                                if (err) {
                                                    console.error('Error fetching chat members:', err);
                                                    return;
                                                }
                                                
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
    
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404);
            res.end('File not found');
            return;
        }
        
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
            '.webm': 'video/webm',
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
        
        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stats.size,
            'Cache-Control': 'public, max-age=31536000'
        });
        
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
                    
                    if (rememberMe && deviceId) {
                        const expiresAt = new Date();
                        expiresAt.setDate(expiresAt.getDate() + 30);
                        
                        db.run(
                            'INSERT OR REPLACE INTO user_sessions (user_id, device_id, token, expires_at) VALUES (?, ?, ?, ?)',
                            [userId, deviceId, token, expiresAt.toISOString()],
                            (err) => {
                                if (err) {
                                    console.error('Error saving session:', err);
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
            
            if (rememberMe && deviceId) {
                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + 30);
                
                db.run(
                    'INSERT OR REPLACE INTO user_sessions (user_id, device_id, token, expires_at) VALUES (?, ?, ?, ?)',
                    [user.id, deviceId, token, expiresAt.toISOString()],
                    (err) => {
                        if (err) {
                            console.error('Error saving session:', err);
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
                    
                    if (!session || session.token !== token) {
                        console.log('Сессия недействительна или истекла');
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ valid: false, error: 'Session expired or invalid' }));
                        return;
                    }
                    
                    getUserAndRespond(decoded.userId, res);
                }
            );
        } else {
            getUserAndRespond(decoded.userId, res);
        }
    } catch (error) {
        console.error('Token verification error:', error);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ valid: false, error: 'Invalid token' }));
    }
}

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
        
        if (deviceId) {
            db.run(
                'DELETE FROM user_sessions WHERE user_id = ? AND device_id = ?',
                [decoded.userId, deviceId],
                (err) => {
                    if (err) {
                        console.error('Error deleting session:', err);
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
                            
                            db.get('SELECT username FROM users WHERE id = ?', [req.userId], (err, currentUser) => {
                                if (err || !currentUser) {
                                    res.writeHead(500, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ error: 'Error getting user info' }));
                                    return;
                                }
                                
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
    db.all(
        'SELECT c.id as chat_id, cm.chat_name, c.is_group, c.created_at, ' +
        '(SELECT content FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message, ' +
        '(SELECT message_type FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_type, ' +
        '(SELECT file_name FROM messages WHERE chat_id = c.id AND message_type = "file" ORDER BY created_at DESC LIMIT 1) as file_name, ' +
        '(SELECT video_url FROM messages WHERE chat_id = c.id AND message_type = "video" ORDER BY created_at DESC LIMIT 1) as video_url, ' +
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
                console.log('Чат уже существует, chatId:', existingChat.chat_id);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    chatId: existingChat.chat_id,
                    message: 'Чат уже существует'
                }));
                return;
            }
            
            db.get('SELECT username FROM users WHERE id = ?', [contactId], (err, contact) => {
                if (err || !contact) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Контакт не найден' }));
                    return;
                }
                
                db.get('SELECT username FROM users WHERE id = ?', [req.userId], (err, currentUser) => {
                    if (err || !currentUser) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Error getting user info' }));
                        return;
                    }
                    
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

async function handleGetOtherUser(req, res) {
    const chatId = req.url.split('/')[3];
    
    if (!chatId || isNaN(chatId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid chat ID' }));
        return;
    }
    
    db.get(
        'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
        [chatId, req.userId],
        (err, hasAccess) => {
            if (err || !hasAccess) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Access denied' }));
                return;
            }
            
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

// Хранение активных звонков
const activeCalls = new Map();

wss.on('connection', (ws, req) => {
    ws.isAuthenticated = false;
    ws.userId = null;
    ws.userInfo = null;
    ws.deviceId = null;
    ws.currentCallId = null;
    ws.callType = null;
    
    console.log('Новое WebSocket подключение');
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log('WebSocket сообщение:', message.type, 'пользователь ID:', ws.userId);
            
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
                        
                        clients.delete(user.id);
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
                switch (message.type) {
                    case 'message':
                        handleTextMessage(ws, message);
                        break;
                        
                    case 'typing':
                        handleTyping(ws, message);
                        break;
                        
                    case 'start_call':
                        handleStartCall(ws, message);
                        break;
                        
                    case 'accept_call':
                        handleAcceptCall(ws, message);
                        break;
                        
                    case 'reject_call':
                        handleRejectCall(ws, message);
                        break;
                        
                    case 'end_call':
                        handleEndCall(ws, message);
                        break;
                        
                    case 'call_audio':
                        handleCallAudio(ws, message);
                        break;
                        
                    case 'call_video':
                        handleCallVideo(ws, message);
                        break;
                }
            }
        } catch (error) {
            console.error('Ошибка обработки WebSocket сообщения:', error);
        }
    });

    ws.on('close', () => {
        if (ws.isAuthenticated && ws.userId) {
            console.log('Отключение пользователя ID: ' + ws.userId);
            
            // Завершаем активный звонок при отключении
            if (ws.currentCallId) {
                handleUserDisconnected(ws.currentCallId, ws.userId);
            }
            
            clients.delete(ws.userId);
        }
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Обработчики сообщений
function handleTextMessage(ws, message) {
    const { chatId, content } = message;
    
    if (!chatId || !content) return;
    
    db.get('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?', 
        [chatId, ws.userId], 
        (err, hasAccess) => {
            if (err || !hasAccess) {
                ws.send(JSON.stringify({ 
                    type: 'error', 
                    message: 'Нет доступа к чату' 
                }));
                return;
            }
            
            db.run('INSERT INTO messages (chat_id, user_id, content, message_type) VALUES (?, ?, ?, ?)',
                [chatId, ws.userId, content, 'text'],
                function(err) {
                    if (err) {
                        console.error('Error saving message:', err);
                        return;
                    }
                    
                    db.get('SELECT m.*, u.username, u.email FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?',
                        [this.lastID],
                        (err, savedMessage) => {
                            if (err) return;
                            
                            db.all('SELECT user_id FROM chat_members WHERE chat_id = ?', 
                                [chatId],
                                (err, members) => {
                                    if (err) return;
                                    
                                    members.forEach(member => {
                                        const clientWs = clients.get(member.user_id);
                                        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                                            clientWs.send(JSON.stringify({
                                                type: 'new_message',
                                                message: savedMessage
                                            }));
                                        }
                                    });
                                }
                            );
                        }
                    );
                }
            );
        }
    );
}

function handleTyping(ws, message) {
    const { chatId } = message;
    
    db.get('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?', 
        [chatId, ws.userId], 
        (err, hasAccess) => {
            if (err || !hasAccess) return;
            
            db.all('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?',
                [chatId, ws.userId],
                (err, members) => {
                    if (err) return;
                    
                    members.forEach(member => {
                        const clientWs = clients.get(member.user_id);
                        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({
                                type: 'typing',
                                chatId: chatId,
                                userId: ws.userId,
                                username: ws.userInfo?.username
                            }));
                        }
                    });
                }
            );
        }
    );
}

// Обработчики звонков
function handleStartCall(ws, message) {
    const { chatId, callType, receiverId } = message;
    
    if (!chatId || !receiverId) {
        ws.send(JSON.stringify({ type: 'call_error', error: 'Missing parameters' }));
        return;
    }
    
    // Генерируем уникальный ID звонка
    const callId = 'call_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    // Сохраняем информацию о звонке
    const callData = {
        callId: callId,
        chatId: chatId,
        callerId: ws.userId,
        callerName: ws.userInfo?.username || 'Пользователь',
        receiverId: receiverId,
        callType: callType || 'audio',
        startTime: Date.now(),
        status: 'calling'
    };
    
    activeCalls.set(callId, callData);
    
    ws.currentCallId = callId;
    ws.callType = callType;
    
    // Отправляем уведомление вызываемому
    const receiverWs = clients.get(receiverId);
    if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
        receiverWs.send(JSON.stringify({
            type: 'incoming_call',
            callId: callId,
            callerId: ws.userId,
            callerName: ws.userInfo?.username || 'Пользователь',
            chatId: chatId,
            callType: callType || 'audio'
        }));
        
        console.log('Уведомление о звонке отправлено пользователю', receiverId);
        
        // Отправляем подтверждение вызывающему
        ws.send(JSON.stringify({
            type: 'call_started',
            callId: callId,
            status: 'calling'
        }));
        
        // Таймаут ожидания ответа (30 секунд)
        setTimeout(() => {
            if (activeCalls.has(callId) && activeCalls.get(callId).status === 'calling') {
                ws.send(JSON.stringify({
                    type: 'call_ended',
                    callId: callId,
                    reason: 'timeout'
                }));
                activeCalls.delete(callId);
                ws.currentCallId = null;
            }
        }, 30000);
        
    } else {
        // Пользователь не в сети
        activeCalls.delete(callId);
        ws.send(JSON.stringify({
            type: 'call_error',
            error: 'Пользователь не в сети'
        }));
    }
}

function handleAcceptCall(ws, message) {
    const { callId } = message;
    
    if (!callId || !activeCalls.has(callId)) return;
    
    const callData = activeCalls.get(callId);
    
    // Проверяем, что это правильный получатель
    if (callData.receiverId !== ws.userId) {
        ws.send(JSON.stringify({ type: 'call_error', error: 'Invalid call' }));
        return;
    }
    
    // Обновляем статус звонка
    callData.status = 'accepted';
    activeCalls.set(callId, callData);
    
    ws.currentCallId = callId;
    ws.callType = callData.callType;
    
    // Уведомляем вызывающего
    const callerWs = clients.get(callData.callerId);
    if (callerWs && callerWs.readyState === WebSocket.OPEN) {
        callerWs.send(JSON.stringify({
            type: 'call_accepted',
            callId: callId,
            receiverId: ws.userId,
            receiverName: ws.userInfo?.username
        }));
    }
    
    // Уведомляем принимающего
    ws.send(JSON.stringify({
        type: 'call_connected',
        callId: callId,
        callerId: callData.callerId,
        callType: callData.callType
    }));
}

function handleRejectCall(ws, message) {
    const { callId } = message;
    
    if (!callId || !activeCalls.has(callId)) return;
    
    const callData = activeCalls.get(callId);
    
    // Уведомляем вызывающего
    const callerWs = clients.get(callData.callerId);
    if (callerWs && callerWs.readyState === WebSocket.OPEN) {
        callerWs.send(JSON.stringify({
            type: 'call_rejected',
            callId: callId,
            receiverId: ws.userId
        }));
        
        callerWs.currentCallId = null;
    }
    
    // Удаляем звонок
    activeCalls.delete(callId);
    ws.currentCallId = null;
}

function handleEndCall(ws, message) {
    const { callId } = message;
    
    if (!callId || !activeCalls.has(callId)) return;
    
    const callData = activeCalls.get(callId);
    
    // Определяем, кто завершает звонк
    const isCaller = callData.callerId === ws.userId;
    const otherUserId = isCaller ? callData.receiverId : callData.callerId;
    
    // Уведомляем другого участника
    const otherWs = clients.get(otherUserId);
    if (otherWs && otherWs.readyState === WebSocket.OPEN) {
        otherWs.currentCallId = null;
        otherWs.send(JSON.stringify({
            type: 'call_ended',
            callId: callId,
            endedBy: ws.userId,
            reason: 'ended_by_user'
        }));
    }
    
    // Удаляем звонок
    activeCalls.delete(callId);
    
    // Очищаем currentCallId у обоих участников
    ws.currentCallId = null;
    if (otherWs) {
        otherWs.currentCallId = null;
    }
}

function handleCallAudio(ws, message) {
    const { callId, audioData } = message;
    
    if (!callId || !activeCalls.has(callId) || !audioData) return;
    
    const callData = activeCalls.get(callId);
    
    // Определяем получателя
    const receiverId = callData.callerId === ws.userId ? callData.receiverId : callData.callerId;
    
    // Отправляем аудио данные получателю
    const receiverWs = clients.get(receiverId);
    if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
        receiverWs.send(JSON.stringify({
            type: 'call_audio',
            callId: callId,
            audioData: audioData,
            senderId: ws.userId,
            timestamp: Date.now()
        }));
    }
}

function handleCallVideo(ws, message) {
    const { callId, videoData } = message;
    
    if (!callId || !activeCalls.has(callId) || !videoData) return;
    
    const callData = activeCalls.get(callId);
    
    // Проверяем, что это видеозвонок
    if (callData.callType !== 'video') return;
    
    // Определяем получателя
    const receiverId = callData.callerId === ws.userId ? callData.receiverId : callData.callerId;
    
    // Отправляем видео данные получателю
    const receiverWs = clients.get(receiverId);
    if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
        receiverWs.send(JSON.stringify({
            type: 'call_video',
            callId: callId,
            videoData: videoData,
            senderId: ws.userId,
            timestamp: Date.now()
        }));
    }
}

function handleUserDisconnected(callId, userId) {
    if (!callId || !activeCalls.has(callId)) return;
    
    const callData = activeCalls.get(callId);
    
    // Определяем, кто отключился
    const isCaller = callData.callerId === userId;
    const otherUserId = isCaller ? callData.receiverId : callData.callerId;
    
    // Уведомляем другого участника
    const otherWs = clients.get(otherUserId);
    if (otherWs && otherWs.readyState === WebSocket.OPEN) {
        otherWs.currentCallId = null;
        otherWs.send(JSON.stringify({
            type: 'call_ended',
            callId: callId,
            endedBy: userId,
            reason: 'disconnected'
        }));
    }
    
    // Удаляем звонок
    activeCalls.delete(callId);
}

// ========== САМО-ПИНГ ДЛЯ RENDER.COM ==========
function startSelfPing() {
    const selfUrl = 'https://beresta-messenger-web.onrender.com';
    
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
    
    pingSelf();
    setInterval(pingSelf, 5 * 60 * 1000);
    
    console.log('🔄 Само-пинг активирован: каждые 5 минут');
}

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
    console.log('• На мобильных: отдельный экран чата с меню профиля');
    console.log('• Автоматический вход с сохранением на устройстве');
    
    console.log('\n🔐 Автоматический вход:');
    console.log('• Сохранение токена с привязкой к устройству');
    console.log('• Опция "Запомнить меня на этом устройстве"');
    console.log('• Удаление сессии при выходе');
    
    console.log('\n📞 Аудио/Видео звонки:');
    console.log('• Упрощенная система звонков через WebSocket');
    console.log('• Передача аудио в реальном времени');
    console.log('• Поддержка видеозвонков');
    console.log('• Работает на мобильных устройствах');
    
    console.log('\n📎 Прикрепление файлов:');
    console.log('• Поддержка фото, видео, документов');
    console.log('• Максимальный размер файла: 100MB');
    
    console.log('\n👥 Управление контактами:');
    console.log('• Кнопка добавления контакта скрывается при открытии чата');
    console.log('• Кнопка видна только на вкладке "Контакты"');
    
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
