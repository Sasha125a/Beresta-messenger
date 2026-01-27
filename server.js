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

// Читаем HTML файл
let HTML_TEMPLATE;
try {
    HTML_TEMPLATE = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
    console.log('✅ HTML template loaded successfully');
} catch (error) {
    console.error('❌ Error loading HTML template:', error);
    HTML_TEMPLATE = '<html><body><h1>Error: index.html not found</h1></body></html>';
}

// Создаем HTTP сервер
const server = http.createServer((req, res) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    
    // CORS заголовки для всех источников
    const origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id, X-Requested-With');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400'); // 24 часа
    
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
        // Отдаем HTML интерфейс
        res.writeHead(200, { 
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(HTML_TEMPLATE);
    } else if (req.url === '/health' || req.url === '/ping') {
        // Health check для Render
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            timestamp: new Date().toISOString(),
            websocket: 'enabled',
            port: PORT,
            hostname: HOST
        }));
    } else if (req.url === '/websocket-test') {
        // Тестовый эндпоинт для проверки WebSocket
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            websocket_url: `wss://${HOST}`,
            http_url: `https://${HOST}`,
            status: 'WebSocket server is running'
        }));
    } else {
        // Для SPA роутинга
        if (req.method === 'GET' && !req.url.includes('.')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(HTML_TEMPLATE);
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Not found',
                url: req.url,
                method: req.method
            }));
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
            
            // Парсим multipart/form-data
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
                            
                            // Извлекаем видео данные
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
                    const extension = videoType.includes('mp4') ? 'mp4' : 
                                    videoType.includes('webm') ? 'webm' : 'mp4';
                    const filename = 'video_' + userId + '_' + timestamp + '_' + random + '.' + extension;
                    const filepath = path.join(VIDEOS_DIR, filename);
                    const videoUrl = '/uploads/videos/' + filename;
                    
                    // Сохраняем файл
                    fs.writeFile(filepath, videoData, (err) => {
                        if (err) {
                            console.error('Error saving video file:', err);
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Error saving video file' }));
                            return;
                        }
                        
                        // Сохраняем сообщение в базу данных
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
                    
                    // Проверяем размер файла (максимум 100MB)
                    const fileSize = fileData.length;
                    if (fileSize > 100 * 1024 * 1024) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'File size exceeds 100MB limit' }));
                        return;
                    }
                    
                    // Определяем тип файла
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
                    
                    // Генерируем уникальное имя файла
                    const timestamp = Date.now();
                    const random = Math.random().toString(36).substring(2, 15);
                    const safeFileName = fileName.replace(/[^a-zA-Z0-9.]/g, '_');
                    const filename = 'file_' + userId + '_' + timestamp + '_' + random + '_' + safeFileName;
                    const filepath = path.join(targetDir, filename);
                    const fileUrl = '/uploads/' + (messageType === 'video' ? 'videos' : 
                                                messageType === 'voice' ? 'audio' : 'files') + '/' + filename;
                    
                    // Сохраняем файл
                    fs.writeFile(filepath, fileData, (err) => {
                        if (err) {
                            console.error('Error saving file:', err);
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Error saving file' }));
                            return;
                        }
                        
                        // Сохраняем сообщение в базу данных
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
const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: false,
    clientTracking: true
});

// Хранение подключенных пользователей
const clients = new Map();

wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    const clientPort = req.socket.remotePort;
    console.log(`✅ New WebSocket connection from ${clientIp}:${clientPort}`);
    console.log(`🔗 Request URL: ${req.url}`);
    console.log(`📋 Origin: ${req.headers.origin}`);
    console.log(`📱 User-Agent: ${req.headers['user-agent']}`);
    
    ws.isAuthenticated = false;
    ws.userId = null;
    ws.userInfo = null;
    ws.deviceId = null;
    ws.callData = null;
    ws.callAnswer = null;
    ws.connectionTime = new Date();
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log(`📨 WebSocket message from ${ws.userId || 'unauthenticated'}:`, message.type);
            
            if (message.type === 'authenticate') {
                try {
                    const decoded = jwt.verify(message.token, JWT_SECRET);
                    
                    db.get('SELECT id, email, username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
                        if (err || !user) {
                            console.log(`❌ Authentication failed: User not found`);
                            ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
                            return;
                        }

                        ws.isAuthenticated = true;
                        ws.userId = user.id;
                        ws.userInfo = user;
                        ws.deviceId = message.deviceId;
                        
                        // Удаляем старые подключения для этого пользователя
                        const oldClient = clients.get(user.id);
                        if (oldClient && oldClient !== ws) {
                            console.log(`🔄 Closing old connection for user ${user.id}`);
                            oldClient.close();
                        }
                        
                        // Добавляем новое подключение
                        clients.set(user.id, ws);
                        
                        console.log(`✅ WebSocket authenticated: ${user.username} (${user.email}) ID: ${user.id} Device: ${message.deviceId}`);
                        
                        ws.send(JSON.stringify({
                            type: 'authenticated',
                            user: user,
                            timestamp: new Date().toISOString()
                        }));
                        
                        // Отправляем подтверждение о подключении
                        ws.send(JSON.stringify({
                            type: 'connection_status',
                            status: 'connected',
                            message: 'WebSocket connected successfully'
                        }));
                    });
                } catch (error) {
                    console.error('❌ Authentication error:', error);
                    ws.send(JSON.stringify({ 
                        type: 'auth_error', 
                        message: 'Invalid token',
                        error: error.message 
                    }));
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
                                console.log(`❌ No access to chat ${chatId} for user ${ws.userId}`);
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
                                        console.error('❌ Error saving message:', err);
                                        ws.send(JSON.stringify({ 
                                            type: 'error', 
                                            message: 'Ошибка сохранения сообщения' 
                                        }));
                                        return;
                                    }
                                    
                                    console.log(`✅ Message saved to chat ${chatId} by user ${ws.userId}`);
                                    
                                    // Получаем сохраненное сообщение с информацией об отправителе
                                    db.get(
                                        'SELECT m.*, u.username, u.email FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?',
                                        [this.lastID],
                                        (err, savedMessage) => {
                                            if (err) {
                                                console.error('❌ Error fetching saved message:', err);
                                                return;
                                            }
                                            
                                            // Получаем участников чата
                                            db.all(
                                                'SELECT user_id FROM chat_members WHERE chat_id = ?',
                                                [chatId],
                                                (err, members) => {
                                                    if (err) {
                                                        console.error('❌ Error fetching chat members:', err);
                                                        return;
                                                    }
                                                    
                                                    console.log(`📤 Sending message to ${members.length} chat members`);
                                                    
                                                    // Отправляем сообщение всем участникам
                                                    members.forEach(member => {
                                                        const clientWs = clients.get(member.user_id);
                                                        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                                                            clientWs.send(JSON.stringify({
                                                                type: 'new_message',
                                                                message: savedMessage,
                                                                chatId: chatId
                                                            }));
                                                        }
                                                    });
                                                    
                                                    // Отправляем уведомление о создании чата (если это первое сообщение)
                                                    db.get(
                                                        'SELECT COUNT(*) as count FROM messages WHERE chat_id = ?',
                                                        [chatId],
                                                        (err, result) => {
                                                            if (!err && result.count === 1) {
                                                                console.log(`🎉 First message in chat ${chatId}, sending chat_created notification`);
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
                    
                    console.log(`📞 call_offer from ${ws.userId} to ${targetId}, chat ${chatId}, type: ${callerData.isVideo ? 'video' : 'audio'}`);
                    
                    // Проверяем, имеет ли пользователь доступ к этому чату
                    db.get(
                        'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
                        [chatId, ws.userId],
                        (err, hasAccess) => {
                            if (err || !hasAccess) {
                                console.log(`❌ No access to chat ${chatId} for user ${ws.userId}`);
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
                                console.log(`✅ Sending call_offer to user ${targetId}`);
                                
                                // Сохраняем данные о звонке у вызываемого пользователя
                                targetClient[1].callData = {
                                    chatId,
                                    targetId: ws.userId,
                                    callerId: ws.userId,
                                    callerName: ws.userInfo?.username || 'Пользователь',
                                    offer: offer,
                                    isVideo: callerData.isVideo
                                };
                                
                                targetClient[1].send(JSON.stringify({
                                    type: 'call_offer',
                                    chatId: chatId,
                                    offer: offer,
                                    callerData: {
                                        chatId: chatId,
                                        callerId: ws.userId,
                                        callerName: ws.userInfo?.username || 'Пользователь',
                                        targetId: targetId,
                                        isVideo: callerData.isVideo
                                    }
                                }));
                                
                                // Отправляем подтверждение вызывающему
                                ws.send(JSON.stringify({
                                    type: 'call_offer_sent',
                                    chatId: chatId,
                                    targetId: targetId
                                }));
                            } else {
                                console.log(`❌ User ${targetId} is offline`);
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
                    
                    console.log(`📞 call_answer from ${ws.userId} to ${targetId}`);
                    
                    // Находим вызывающего пользователя
                    const callerClient = Array.from(clients.entries()).find(([id, client]) => 
                        client.userId === targetId && client.readyState === WebSocket.OPEN
                    );
                    
                    if (callerClient && callerClient[1]) {
                        console.log(`✅ Sending call_answer to user ${targetId}`);
                        
                        // Сохраняем ответ у вызывающего
                        callerClient[1].callAnswer = answer;
                        
                        callerClient[1].send(JSON.stringify({
                            type: 'call_answer',
                            chatId: chatId,
                            answer: answer,
                            targetId: ws.userId
                        }));
                    } else {
                        console.log(`❌ Caller user ${targetId} not found`);
                    }
                    
                                } else if (message.type === 'call_ice_candidate') {
                    const { chatId, targetId, candidate } = message;
                    
                    console.log(`📞 call_ice_candidate from ${ws.userId} to ${targetId}`);
                    
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
                    
                    console.log(`📞 call_end from ${ws.userId} to ${targetId}, reason: ${reason}`);
                    
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
                    
                    console.log(`📞 call_error from ${ws.userId} to ${targetId}, error: ${error}`);
                    
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
                    
                } else if (message.type === 'renegotiate') {
                    const { chatId, targetId, offer } = message;
                    
                    console.log(`🔄 renegotiate from ${ws.userId} to ${targetId}`);
                    
                    // Находим целевого пользователя
                    const targetClient = Array.from(clients.entries()).find(([id, client]) => 
                        client.userId === targetId && client.readyState === WebSocket.OPEN
                    );
                    
                    if (targetClient && targetClient[1]) {
                        targetClient[1].send(JSON.stringify({
                            type: 'renegotiate',
                            chatId: chatId,
                            offer: offer,
                            senderId: ws.userId
                        }));
                    }
                    
                } else if (message.type === 'ice_complete') {
                    const { chatId, targetId } = message;
                    
                    console.log(`✅ ice_complete from ${ws.userId} to ${targetId}`);
                    
                    // Находим целевого пользователя
                    const targetClient = Array.from(clients.entries()).find(([id, client]) => 
                        client.userId === targetId && client.readyState === WebSocket.OPEN
                    );
                    
                    if (targetClient && targetClient[1]) {
                        targetClient[1].send(JSON.stringify({
                            type: 'ice_complete',
                            chatId: chatId,
                            senderId: ws.userId
                        }));
                    }
                } else if (message.type === 'ping') {
                    // Обработка ping сообщений для поддержания соединения
                    ws.send(JSON.stringify({
                        type: 'pong',
                        timestamp: Date.now()
                    }));
                }
            }
        } catch (error) {
            console.error('❌ Ошибка обработки WebSocket сообщения:', error);
            console.error('Raw message:', data.toString().substring(0, 200));
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`❌ WebSocket connection closed for user ${ws.userId || 'unauthenticated'}`);
        console.log(`   Code: ${code}, Reason: ${reason}`);
        console.log(`   Connection duration: ${new Date() - ws.connectionTime}ms`);
        
        if (ws.isAuthenticated && ws.userId) {
            // Если пользователь был в звонке, уведомляем другого участника
            if (ws.callData) {
                const { chatId, targetId } = ws.callData;
                
                console.log(`📞 User ${ws.userId} disconnected during call, notifying ${targetId}`);
                
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
            console.log(`   Removed user ${ws.userId} from clients map`);
        }
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
        console.error('   User:', ws.userId || 'unauthenticated');
    });
    
    // Отправляем приветственное сообщение
    ws.send(JSON.stringify({
        type: 'welcome',
        message: 'WebSocket connection established',
        server_time: new Date().toISOString(),
        protocol: 'beresta-websocket-v1'
    }));
    
    // Начинаем ping/pong для поддержания соединения
    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    }, 30000);
    
    ws.on('close', () => {
        clearInterval(pingInterval);
    });
});

// ========== САМО-ПИНГ ДЛЯ RENDER.COM ==========
function startSelfPing() {
    const selfUrl = `https://${HOST}`;
    
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
    setInterval(pingSelf, 5 * 60 * 1000);
    
    console.log('🔄 Само-пинг активирован: каждые 5 минут');
}

// ========== ЗАПУСК СЕРВЕРА ==========
server.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 Сервер Береста запущен!');
    console.log('='.repeat(60));
    console.log('📍 Порт:', PORT);
    console.log('🌐 HTTP сервер:', 'http://localhost:' + PORT);
    console.log('🔗 WebSocket сервер:', 'ws://localhost:' + PORT);
    
    if (process.env.RENDER_EXTERNAL_HOSTNAME) {
        console.log('🌍 Внешний URL:', 'https://' + process.env.RENDER_EXTERNAL_HOSTNAME);
        console.log('🔗 WebSocket URL:', 'wss://' + process.env.RENDER_EXTERNAL_HOSTNAME);
        console.log('🧪 WebSocket test URL:', 'https://' + process.env.RENDER_EXTERNAL_HOSTNAME + '/websocket-test');
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
    console.log('• Двусторонняя аудио/видеосвязь через WebRTC');
    console.log('• Используются STUN серверы');
    console.log('• Работает на мобильных устройствах');
    console.log('• Видеозвонки: полный экран собеседника, PIP видео пользователя');
    
    console.log('\n📎 Прикрепление файлов:');
    console.log('• Поддержка фото, видео, документов и других файлов');
    console.log('• Максимальный размер файла: 100MB');
    console.log('• Индикатор загрузки и возможность отмены');
    
    console.log('\n👥 Управление контактами:');
    console.log('• Кнопка добавления контакта скрывается при открытии чата');
    console.log('• Кнопка видна только на вкладке "Контакты"');
    
    console.log('\n💾 База данных:', dbPath);
    console.log('📁 Директория загрузок:', UPLOADS_DIR);
    console.log('👥 Подключенные клиенты:', clients.size);
    
    if (process.env.NODE_ENV === 'production') {
        console.log('\n✅ Режим: Production');
        console.log('✅ Поддержка HTTPS/WebSocket Secure');
        startSelfPing();
    } else {
        console.log('\n⚙️  Режим: Development');
    }
    
    console.log('\n✅ Готово! Откройте в браузере: http://localhost:' + PORT);
    console.log('='.repeat(60) + '\n');
});

// Обработка graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    wss.clients.forEach(client => {
        client.close(1001, 'Server shutdown');
    });
    server.close(() => {
        console.log('HTTP server closed');
        db.close();
        console.log('Database connection closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    wss.clients.forEach(client => {
        client.close(1001, 'Server shutdown');
    });
    server.close(() => {
        console.log('HTTP server closed');
        db.close();
        console.log('Database connection closed');
        process.exit(0);
    });
});

// Экспортируем для тестирования
module.exports = { server, wss, db };

