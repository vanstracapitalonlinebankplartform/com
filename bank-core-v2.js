// Vanstra Bank v2.0 - Core Banking System with Dual Authentication
// Separate Login Password and Transaction PIN

const VanstraBank = (function() {
    'use strict';

    // Event system for real-time updates
    const eventListeners = {};
    
    function on(event, callback) {
        if (!eventListeners[event]) eventListeners[event] = [];
        eventListeners[event].push(callback);
    }
    
    function emit(event, data) {
        if (eventListeners[event]) {
            eventListeners[event].forEach(cb => cb(data));
        }
        // Also store in admin events
        const adminEvents = JSON.parse(localStorage.getItem('adminEvents') || '[]');
        adminEvents.unshift({ event, data, timestamp: new Date().toISOString() });
        localStorage.setItem('adminEvents', JSON.stringify(adminEvents.slice(0, 100)));
    }

    // Simple hash function (in production, use bcrypt or similar)
    function hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & 0xffffffff; // Keep as 32-bit integer
        }
        return (hash >>> 0).toString(16); // Convert to unsigned before hex
    }

    // Generate unique IDs
    function generateAccountNumber() {
        return 'DE' + Math.floor(1000000000 + Math.random() * 9000000000);
    }

    function generateUserId() {
        return 'USR-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
    }

    function generateTransactionId() {
        return 'TXN-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
    }

    // Initialize system
    function init() {
        // Version flag previously used to reset corrupted data during early
        // development.  Clearing all users on every upgrade meant that
        // anyone who created an account would suddenly disappear after the
        // next release, causing "wrong password" errors and broken reset
        // flows.  We now keep existing data and only bump the stored version.
        const currentVersion = '2.1';
        const storedVersion = localStorage.getItem('vanstraVersion');

        if (storedVersion !== currentVersion) {
            // do not delete users – only record the upgrade so we can run
            // migrations in future if necessary
            localStorage.setItem('vanstraVersion', currentVersion);

            // (optional) perform any one‑time migrations here
            // e.g. migrate old hash formats, add new fields, etc.
            
            // Migration: Add language and currency preferences to existing users
            const users = JSON.parse(localStorage.getItem('vanstraUsers') || '{}');
            Object.keys(users).forEach(userId => {
                const user = users[userId];
                if (!user.language) user.language = 'en';
                if (!user.currency) user.currency = 'EUR';
            });
            localStorage.setItem('vanstraUsers', JSON.stringify(users));
        }

        if (!localStorage.getItem('vanstraUsers')) {
            localStorage.setItem('vanstraUsers', JSON.stringify({}));
        }
        if (!localStorage.getItem('vanstraSessions')) {
            localStorage.setItem('vanstraSessions', JSON.stringify({}));
        }
        if (!localStorage.getItem('adminEvents')) {
            localStorage.setItem('adminEvents', JSON.stringify([]));
        }
        // Chat system removed: chatMessages no longer initialized
    }

    init();

    // ==================== USER MANAGEMENT ====================

    function createAccount(userData) {
        const users = JSON.parse(localStorage.getItem('vanstraUsers'));
        
        // Validate email uniqueness
        const existingUser = Object.values(users).find(u => u.email === userData.email);
        if (existingUser) {
            return { success: false, error: 'Email already registered' };
        }

        // Validate password requirements
        if (userData.password.length < 8) {
            return { success: false, error: 'Password must be at least 8 characters' };
        }

        // Validate PIN requirements
        if (!/^\d{4}$/.test(userData.pin)) {
            return { success: false, error: 'PIN must be exactly 4 digits' };
        }

        // Ensure password !== PIN
        if (userData.password === userData.pin) {
            return { success: false, error: 'Login password cannot be the same as transaction PIN' };
        }

        // Create user record
        const userId = generateUserId();
        const accountNumber = generateAccountNumber();
        
        const newUser = {
            id: userId,
            fullName: userData.fullName,
            email: userData.email,
            dateOfBirth: userData.dateOfBirth,
            phone: userData.phone,
            accountNumber: accountNumber,
            accountType: 'Premium Checking',
            tier: 'unlimited', // Default tier
            medal: 'gold', // Default medal
            balance: 5000.00, // Starting balance
            currency: 'EUR',
            language: 'en', // Default language
            status: 'active',
            createdAt: new Date().toISOString(),
            lastLogin: null,
            isOnline: false,
            avatar: null,
            // SECURITY: Store hashed credentials only
            passwordHash: hashString(userData.password),
            pinHash: hashString(userData.pin),
            transactions: [],
            failedPinAttempts: 0,
            lockedUntil: null
        };

        users[userId] = newUser;
        localStorage.setItem('vanstraUsers', JSON.stringify(users));

        // Emit to admin
        emit('user_created', { userId, user: sanitizeForAdmin(newUser) });

        // Send welcome email (stored in local sentEmails for demo)
        sendEmail(newUser.email, 'Welcome to Vanstra Capital', `Hi ${newUser.fullName},\n\nWelcome to Vanstra Capital. Your account has been created successfully.`);

        // Background: attempt to store user in Supabase if available
        try {
            if (window.SupabaseDB && window.SupabaseDB.initialized) {
                (async () => {
                    try {
                        // createUser expects the full user object
                        await window.SupabaseDB.createUser(newUser);
                    } catch (e) {
                        console.warn('Supabase createUser failed', e);
                    }
                })();
            }
        } catch (e) {
            console.warn('Supabase unavailable', e);
        }

        // Auto-login
        const session = createSession(userId);

        return { 
            success: true, 
            user: sanitizeForClient(newUser),
            sessionToken: session.token
        };
    }

    function login(email, password) {
        console.log('🔐 LOGIN ATTEMPT:', email);
        const usersData = localStorage.getItem('vanstraUsers');
        console.log('📦 Users data from localStorage:', usersData ? 'exists' : 'MISSING');

        const users = usersData ? JSON.parse(usersData) : {};
        console.log('👥 All users found:', Object.keys(users).length);
        // Normalize email for lookup (case-insensitive)
        const normalizedEmail = (email || '').trim().toLowerCase();
        const user = Object.values(users).find(u => (u.email || '').trim().toLowerCase() === normalizedEmail);
        console.log('🔍 User lookup result:', user ? `ID=${user.id}, Email=${user.email}` : 'NOT FOUND');

        if (!user) {
            console.log('❌ User not found in system for email:', normalizedEmail);
            return { success: false, error: 'Invalid email or password' };
        }

        if (user.status === 'locked') {
            return { success: false, error: 'Account locked. Contact support.' };
        }

        // Check account status for restrictions
        // Determine if account is restricted (frozen/blocked/suspended)
        let restrictionType = null;
        let codeType = null;
        if (user.accountStatus === 'frozen' || user.status === 'frozen') {
            restrictionType = 'frozen';
            codeType = 'COT';
        } else if (user.accountStatus === 'blocked' || user.status === 'blocked') {
            restrictionType = 'blocked';
            codeType = 'AFD';
        } else if (user.accountStatus === 'suspended' || user.status === 'suspended') {
            restrictionType = 'suspended';
            codeType = 'SVR';
        }

        // Verify password (support multiple legacy formats)
        const plain = password || '';
        const computedHash = hashString(plain);
        const doubleHash = hashString(computedHash);

        const storedHash = user.passwordHash || user.password || null;

        const passwordMatches = (
            storedHash && (
                storedHash === computedHash || // normal
                storedHash === doubleHash ||   // legacy double-hash
                storedHash === plain           // stored as plain (fallback)
            )
        );

        if (!passwordMatches) {
            console.log('❌ Password verification failed for user:', user.email, { storedHashPreview: (storedHash || '').toString().substr(0,8) });
            emit('login_failed', { email: user.email, reason: 'invalid_password' });
            return { success: false, error: 'Invalid email or password' };
        }

        // Update user status
        user.lastLogin = new Date().toISOString();
        user.isOnline = true;
        user.failedPinAttempts = 0;
        
        // Ensure tier and medal exist (migration)
        if (!user.tier) user.tier = 'unlimited';
        if (!user.medal) user.medal = 'gold';

        users[user.id] = user;
        localStorage.setItem('vanstraUsers', JSON.stringify(users));
        console.log('✅ User saved to localStorage');

        // Create session
        const session = createSession(user.id);
        if (!session || !session.token) {
            console.error('❌ Failed to create session');
            return { success: false, error: 'Session creation failed. Please try again.' };
        }
        console.log('🔑 Session created:', {token: session.token.substring(0, 20) + '...'});

        // Emit to admin
        emit('user_login', { userId: user.id, user: sanitizeForAdmin(user) });

        // Send login notification email
        sendEmail(user.email, 'Sign-in notification', `Hi ${user.fullName},\n\nWe noticed a sign-in to your Vanstra account. If this wasn't you, contact support immediately.`);

        // Background: ensure user exists/updated in Supabase
        try {
            if (window.SupabaseDB && window.SupabaseDB.initialized) {
                (async () => {
                    try {
                        await window.SupabaseDB.updateUser(user.id, {
                            id: user.id,
                            fullName: user.fullName,
                            email: user.email,
                            phone: user.phone,
                            accountNumber: user.accountNumber,
                            accountType: user.accountType,
                            balance: user.balance,
                            currency: user.currency,
                            isOnline: true,
                            lastLogin: user.lastLogin
                        });
                    } catch (e) {
                        try { await window.SupabaseDB.createUser(user); } catch (err) { console.warn('Supabase upsert failed', err); }
                    }
                })();
            }
        } catch (e) {
            console.warn('Supabase unavailable', e);
        }

        console.log('✅ LOGIN SUCCESS:', {email: user.email, sessionToken: session.token.substring(0, 20) + '...'});
        return {
            success: true,
            user: sanitizeForClient(user),
            sessionToken: session.token,
            requiresCode: !!restrictionType,
            restrictionType,
            codeType
        };
    }

    function logout(sessionToken) {
        console.log('🚪 LOGOUT:', sessionToken ? 'Valid token' : 'No token');
        const sessions = JSON.parse(localStorage.getItem('vanstraSessions'));
        const session = sessions[sessionToken];
        
        console.log('📍 Session found:', session ? `UserID=${session.userId}` : 'NOT FOUND');
        
        if (session) {
            const users = JSON.parse(localStorage.getItem('vanstraUsers'));
            const user = users[session.userId];
            if (user) {
                console.log('👤 Updating user:', user.email);
                user.isOnline = false;
                users[session.userId] = user;
                localStorage.setItem('vanstraUsers', JSON.stringify(users));
                console.log('✅ User marked offline');
                
                emit('user_logout', { userId: session.userId });
            }
            delete sessions[sessionToken];
            localStorage.setItem('vanstraSessions', JSON.stringify(sessions));
            console.log('✅ Session removed');
        }
        
        localStorage.removeItem('currentSession');
        console.log('✅ currentSession cleared from localStorage');
        return { success: true };
    }

    function createSession(userId) {
        console.log('🔑 createSession for user:', userId);
        
        let sessions = {};
        const sessionsData = localStorage.getItem('vanstraSessions');
        
        if (sessionsData) {
            try {
                sessions = JSON.parse(sessionsData);
                console.log('📍 Loaded existing sessions:', Object.keys(sessions).length);
            } catch (e) {
                console.error('❌ Failed to parse vanstraSessions:', e);
                sessions = {};
            }
        } else {
            console.log('📍 No existing sessions found, starting fresh');
        }
        
        const token = 'SES-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8).toUpperCase();
        
        sessions[token] = {
            userId: userId,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
        };
        
        try {
            localStorage.setItem('vanstraSessions', JSON.stringify(sessions));
            console.log('✅ Sessions saved to localStorage');
        } catch (e) {
            console.error('❌ Failed to save sessions:', e);
            return null;
        }
        
        try {
            localStorage.setItem('currentSession', token);
            console.log('✅ currentSession token set:', token.substring(0, 20) + '...');
        } catch (e) {
            console.error('❌ Failed to set currentSession:', e);
            return null;
        }
        
        return { token };
    }

    function getCurrentUser() {
        const sessionToken = localStorage.getItem('currentSession');
        console.log('🔍 getCurrentUser - SessionToken:', sessionToken ? sessionToken.substring(0, 20) + '...' : 'NONE');
        
        if (!sessionToken) {
            console.log('❌ No session token found');
            return null;
        }

        const sessionsData = localStorage.getItem('vanstraSessions');
        const sessions = sessionsData ? JSON.parse(sessionsData) : {};
        const session = sessions[sessionToken];
        
        console.log('📍 Session lookup:', session ? `Found, UserID=${session.userId}` : 'NOT FOUND');
        
        if (!session) {
            console.log('❌ Session not in vanstraSessions');
            localStorage.removeItem('currentSession');
            return null;
        }
        
        if (new Date(session.expiresAt) < new Date()) {
            console.log('❌ Session expired:', session.expiresAt);
            localStorage.removeItem('currentSession');
            return null;
        }

        const usersData = localStorage.getItem('vanstraUsers');
        const users = usersData ? JSON.parse(usersData) : {};
        const user = users[session.userId];
        console.log('👤 User lookup:', user ? `Found - ${user.email}` : 'NOT FOUND');
        
        return user || null;
    }

    function isAuthenticated() {
        return getCurrentUser() !== null;
    }

    // ==================== TRANSACTION PIN AUTHORIZATION ====================

    function verifyPin(userId, pin) {
        const users = JSON.parse(localStorage.getItem('vanstraUsers'));
        const user = users[userId];

        if (!user) {
            return { success: false, error: 'User not found' };
        }

        if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
            const minutesLeft = Math.ceil((new Date(user.lockedUntil) - new Date()) / 60000);
            return { success: false, error: `Account locked. Try again in ${minutesLeft} minutes.` };
        }

        // Verify PIN hash
        if (user.pinHash !== hashString(pin)) {
            user.failedPinAttempts = (user.failedPinAttempts || 0) + 1;
            
            // Lock after 3 failed attempts
            if (user.failedPinAttempts >= 3) {
                user.lockedUntil = new Date(Date.now() + 30 * 60000).toISOString(); // 30 min lock
                user.failedPinAttempts = 0;
            }
            
            users[userId] = user;
            localStorage.setItem('vanstraUsers', JSON.stringify(users));
            
            emit('pin_failed', { userId, attempts: user.failedPinAttempts });
            
            return { 
                success: false, 
                error: user.lockedUntil 
                    ? 'Too many failed attempts. Account locked for 30 minutes.' 
                    : 'Incorrect PIN. Please try again.' 
            };
        }

        // Reset failed attempts on success
        user.failedPinAttempts = 0;
        users[userId] = user;
        localStorage.setItem('vanstraUsers', JSON.stringify(users));

        return { success: true };
    }

    // ==================== TRANSACTIONS ====================

    function transfer(userId, pin, transferData) {
        // CRITICAL: Verify PIN first
        const pinCheck = verifyPin(userId, pin);
        if (!pinCheck.success) {
            return pinCheck;
        }

        const users = JSON.parse(localStorage.getItem('vanstraUsers'));
        const user = users[userId];

        if (transferData.amount > user.balance) {
            return { success: false, error: 'Insufficient funds' };
        }

        // Process transfer
        user.balance -= transferData.amount;
        
        const transaction = {
            id: generateTransactionId(),
            type: 'transfer',
            subtype: transferData.transferType,
            description: transferData.transferType === 'internal' 
                ? 'Internal Transfer' 
                : 'External Transfer',
            amount: -transferData.amount,
            currency: 'EUR',
            recipientName: transferData.recipientName,
            recipientAccount: transferData.recipientAccount,
            recipientBank: transferData.recipientBank,
            note: transferData.note || '',
            status: 'completed',
            timestamp: new Date().toISOString(),
            reference: 'REF-' + Math.random().toString(36).substr(2, 8).toUpperCase()
        };

        user.transactions.unshift(transaction);
        users[userId] = user;
        localStorage.setItem('vanstraUsers', JSON.stringify(users));

        emit('transaction', { userId, transaction, newBalance: user.balance });

        // persist to Supabase in background if available
        try {
            if (window.SupabaseDB && window.SupabaseDB.initialized) {
                (async () => {
                    try { await window.SupabaseDB.createTransaction(userId, transaction); } catch (e) { console.warn('Supabase createTransaction failed', e); }
                })();
            }
        } catch (e) { console.warn('Supabase unavailable', e); }

        return { success: true, transaction, newBalance: user.balance };
    }

    function payBill(userId, pin, paymentData) {
        // CRITICAL: Verify PIN first
        const pinCheck = verifyPin(userId, pin);
        if (!pinCheck.success) {
            return pinCheck;
        }

        const users = JSON.parse(localStorage.getItem('vanstraUsers'));
        const user = users[userId];

        if (paymentData.amount > user.balance) {
            return { success: false, error: 'Insufficient funds' };
        }

        user.balance -= paymentData.amount;

        const transaction = {
            id: generateTransactionId(),
            type: 'payment',
            subtype: 'bill',
            description: paymentData.billerName,
            amount: -paymentData.amount,
            currency: 'EUR',
            recipientName: paymentData.billerName,
            category: paymentData.category,
            referenceNumber: paymentData.referenceNumber,
            status: 'completed',
            timestamp: new Date().toISOString(),
            reference: 'REF-' + Math.random().toString(36).substr(2, 8).toUpperCase()
        };

        user.transactions.unshift(transaction);
        users[userId] = user;
        localStorage.setItem('vanstraUsers', JSON.stringify(users));

        emit('transaction', { userId, transaction, newBalance: user.balance });

        try {
            if (window.SupabaseDB && window.SupabaseDB.initialized) {
                (async () => {
                    try { await window.SupabaseDB.createTransaction(userId, transaction); } catch (e) { console.warn('Supabase createTransaction failed', e); }
                })();
            }
        } catch (e) { console.warn('Supabase unavailable', e); }

        return { success: true, transaction, newBalance: user.balance };
    }

    // Internal transfer (PIN already verified in dashboard)
    function requestInternalTransfer(userId, transferData) {
        const users = JSON.parse(localStorage.getItem('vanstraUsers'));
        const sender = users[userId];
        
        // Support both recipientId lookup and manual recipient details
        let recipient = null;
        
        if (transferData.recipientId) {
            // Legacy: lookup by ID
            recipient = users[transferData.recipientId];
        } else if (transferData.accountNumber) {
            // New: lookup by account number
            const foundUserId = Object.keys(users).find(id => users[id].accountNumber === transferData.accountNumber);
            if (foundUserId) {
                recipient = users[foundUserId];
                transferData.recipientId = foundUserId;
            }
        }

        if (!recipient) {
            return { success: false, error: 'Recipient not found' };
        }

        if (transferData.amount > sender.balance) {
            return { success: false, error: 'Insufficient funds' };
        }

        // Deduct from sender
        sender.balance -= transferData.amount;
        
        // Add to recipient
        recipient.balance += transferData.amount;

        const transaction = {
            id: generateTransactionId(),
            type: 'transfer',
            subtype: 'internal',
            description: 'Internal Transfer',
            amount: -transferData.amount,
            currency: 'EUR',
            recipientName: recipient.fullName,
            recipientAccount: recipient.accountNumber,
            note: transferData.note || '',
            status: 'completed',
            timestamp: new Date().toISOString(),
            reference: 'REF-' + Math.random().toString(36).substr(2, 8).toUpperCase()
        };

        sender.transactions.unshift(transaction);
        recipient.transactions.unshift({
            ...transaction,
            amount: transferData.amount,
            description: 'Internal Transfer Received from ' + sender.fullName,
            senderName: sender.fullName,
            senderAccount: sender.accountNumber
        });

        users[userId] = sender;
        users[transferData.recipientId] = recipient;
        localStorage.setItem('vanstraUsers', JSON.stringify(users));

        emit('transaction', { userId, transaction, newBalance: sender.balance });

        return { success: true, transaction, newBalance: sender.balance };
    }

    // External transfer (PIN already verified in dashboard)
    function requestExternalTransfer(userId, transferData) {
        const users = JSON.parse(localStorage.getItem('vanstraUsers'));
        const user = users[userId];

        // Calculate fee (2% minimum €2)
        const fee = Math.max(2, transferData.amount * 0.02);
        const totalDebit = transferData.amount + fee;

        if (totalDebit > user.balance) {
            return { success: false, error: 'Insufficient funds (including transfer fee)' };
        }

        user.balance -= totalDebit;

        const transaction = {
            id: generateTransactionId(),
            type: 'transfer',
            subtype: 'external',
            description: 'External Transfer',
            amount: -transferData.amount,
            currency: 'EUR',
            recipientName: transferData.recipientName,
            recipientAccount: transferData.accountNumber,
            recipientBank: transferData.bankName,
            fee: fee,
            note: transferData.note || '',
            status: 'completed',
            timestamp: new Date().toISOString(),
            reference: 'REF-' + Math.random().toString(36).substr(2, 8).toUpperCase()
        };

        user.transactions.unshift(transaction);
        users[userId] = user;
        localStorage.setItem('vanstraUsers', JSON.stringify(users));

        emit('transaction', { userId, transaction, newBalance: user.balance });

        return { success: true, transaction, newBalance: user.balance };
    }

    function submitDeposit(userId, pin, depositData) {
        // CRITICAL: Verify PIN first
        const pinCheck = verifyPin(userId, pin);
        if (!pinCheck.success) {
            return pinCheck;
        }

        const users = JSON.parse(localStorage.getItem('vanstraUsers'));
        const user = users[userId];

        const transaction = {
            id: generateTransactionId(),
            type: 'deposit',
            subtype: 'check',
            description: 'Mobile Check Deposit',
            amount: depositData.amount,
            currency: 'EUR',
            status: 'pending',
            timestamp: new Date().toISOString(),
            reference: 'REF-' + Math.random().toString(36).substr(2, 8).toUpperCase(),
            estimatedClearance: new Date(Date.now() + 2 * 86400000).toISOString()
        };

        user.transactions.unshift(transaction);
        users[userId] = user;
        localStorage.setItem('vanstraUsers', JSON.stringify(users));

        emit('deposit_submitted', { userId, transaction });

        try {
            if (window.SupabaseDB && window.SupabaseDB.initialized) {
                (async () => {
                    try { await window.SupabaseDB.createTransaction(userId, transaction); } catch (e) { console.warn('Supabase createTransaction failed', e); }
                })();
            }
        } catch (e) { console.warn('Supabase unavailable', e); }

        return { success: true, transaction };
    }

    // Chat system removed.
    // ==================== EMAIL / MISC ====================

    function sendEmail(to, subject, body, extraVars = {}) {
        try {
            const email = {
                id: 'MAIL-' + Date.now() + '-' + Math.random().toString(36).substr(2,6).toUpperCase(),
                to,
                subject,
                body,
                timestamp: new Date().toISOString()
            };

            // Store locally
            const sent = JSON.parse(localStorage.getItem('sentEmails') || '[]');
            sent.unshift(email);
            localStorage.setItem('sentEmails', JSON.stringify(sent));
            emit('email_sent', email);

            // Send real email via EmailJS
            if (window.emailjs) {
                const templateVars = {
                    to_email: to,
                    subject: subject,
                    message: body,
                    reply_to: 'noreply@vanstracapital.com',
                    ...extraVars
                };
                emailjs.send('service_vanstra', 'template_password_reset', templateVars).catch(err => {
                    console.warn('Email failed:', err);
                });
            }

            // attempt to persist to Supabase as well
            try {
                if (window.SupabaseDB && window.SupabaseDB.initialized) {
                    (async () => {
                        try { await window.SupabaseDB.storeEmail(email); } catch (e) { console.warn('Supabase storeEmail failed', e); }
                    })();
                }
            } catch (e) {
                console.warn('Supabase unavailable', e);
            }

            return { success: true, email };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // Chat functions removed to disable internal chat feature.

    // ==================== ADMIN FUNCTIONS ====================

    function getAllUsers() {
        const usersData = localStorage.getItem('vanstraUsers');
        if (!usersData) return [];
        const users = JSON.parse(usersData);
        if (!users || Object.keys(users).length === 0) return [];

        // Background: if Supabase is enabled, try to sync users from Supabase
        try {
            if (window.SupabaseDB && window.SupabaseDB.initialized) {
                (async () => {
                    try {
                        const supaUsers = await window.SupabaseDB.getAllUsers();
                        // supaUsers is expected to be an array; convert to object keyed by id
                        if (Array.isArray(supaUsers) && supaUsers.length > 0) {
                            const usersObj = {};
                            supaUsers.forEach(u => { usersObj[u.id] = Object.assign({}, users[u.id] || {}, u); });
                            // Merge with local users to preserve local-only fields
                            const merged = Object.assign({}, users, usersObj);
                            localStorage.setItem('vanstraUsers', JSON.stringify(merged));
                        }
                    } catch (e) {
                        console.warn('Failed to sync users from Supabase', e);
                    }
                })();
            }
        } catch (e) { console.warn('Supabase unavailable', e); }

        return Object.values(users).map(sanitizeForAdmin);
    }

    function updateUser(updatedUser) {
        try {
            const usersData = localStorage.getItem('vanstraUsers');
            const users = usersData ? JSON.parse(usersData) : {};
            
            if (users[updatedUser.id]) {
                users[updatedUser.id] = Object.assign({}, users[updatedUser.id], updatedUser);
                localStorage.setItem('vanstraUsers', JSON.stringify(users));
                
                // Sync with Supabase if available
                if (window.SupabaseDB && window.SupabaseDB.initialized) {
                    try {
                        window.SupabaseDB.updateUser(updatedUser.id, updatedUser);
                    } catch (e) {
                        console.warn('Failed to sync user update to Supabase', e);
                    }
                }
                
                // Emit event for real-time updates
                emit('userUpdated', updatedUser);
                return { success: true, user: users[updatedUser.id] };
            }
            return { success: false, error: 'User not found' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    function getAdminEvents() {
        return JSON.parse(localStorage.getItem('adminEvents') || '[]');
    }

    function getAvailableUsers(excludeUserId) {
        const usersData = localStorage.getItem('vanstraUsers');
        if (!usersData) return [];
        const users = JSON.parse(usersData);
        if (!users || Object.keys(users).length === 0) return [];

        // Return all users except the excluded one, with sanitized data for display
        return Object.values(users)
            .filter(u => u.id !== excludeUserId && u.status === 'active')
            .map(u => ({
                id: u.id,
                fullName: u.fullName,
                accountNumber: u.accountNumber,
                balance: u.balance,
                email: u.email
            }));
    }

    // adminReply removed along with internal chat support.

    // ==================== UTILITIES ====================

    function sanitizeForClient(user) {
        return {
            id: user.id,
            fullName: user.fullName,
            email: user.email,
            phone: user.phone,
            accountNumber: user.accountNumber,
            accountType: user.accountType,
            balance: user.balance,
            currency: user.currency,
            avatar: user.avatar,
            createdAt: user.createdAt,
            transactions: user.transactions || []
        };
    }

    function sanitizeForAdmin(user) {
        return {
            id: user.id,
            fullName: user.fullName,
            email: user.email,
            phone: user.phone,
            accountNumber: user.accountNumber,
            balance: user.balance,
            status: user.status,
            accountStatus: user.accountStatus || 'active',
            isOnline: user.isOnline,
            lastLogin: user.lastLogin,
            createdAt: user.createdAt,
            failedPinAttempts: user.failedPinAttempts
        };
    }

    function formatCurrency(amount, currency = null, locale = null) {
        try {
            const user = getCurrentUser();
            const userCurrency = currency || (user && user.currency) || 'EUR';
            const userLocale = locale || (user && user.language) || 'en-US';
            
            return new Intl.NumberFormat(userLocale, {
                style: 'currency',
                currency: userCurrency
            }).format(amount);
        } catch (e) {
            // Fallback if invalid currency/locale or any error
            return new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: 'EUR'
            }).format(amount);
        }
    }

    function formatDate(dateString) {
        try {
            const user = getCurrentUser();
            const locale = 'en-US'; // Default to English since we don't have user language
            
            const date = new Date(dateString);
            const now = new Date();
            const diff = now - date;
            
            if (diff < 86400000) return 'Today';
            if (diff < 172800000) return 'Yesterday';
            return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
        } catch (e) {
            return new Date(dateString).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
        }
    }

    function formatDateTime(dateString) {
        try {
            const user = getCurrentUser();
            const locale = (user && user.language) || 'en-US';
            
            return new Date(dateString).toLocaleString(locale, {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (e) {
            return new Date(dateString).toLocaleString('en-US', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        }
    }

    // ==================== PROFILE MANAGEMENT ====================

    function updateProfile(profileData) {
        try {
            const sessionToken = localStorage.getItem('currentSession');
            if (!sessionToken) {
                return { success: false, error: 'Not authenticated' };
            }

            const sessions = JSON.parse(localStorage.getItem('vanstraSessions'));
            const session = sessions[sessionToken];
            if (!session) {
                return { success: false, error: 'Session not found' };
            }

            const users = JSON.parse(localStorage.getItem('vanstraUsers'));
            const user = users[session.userId];
            if (!user) {
                return { success: false, error: 'User not found' };
            }

            // Update profile fields
            if (profileData.fullName) user.fullName = profileData.fullName;
            if (profileData.email) user.email = profileData.email;
            if (profileData.phone) user.phone = profileData.phone;

            users[session.userId] = user;
            localStorage.setItem('vanstraUsers', JSON.stringify(users));

            // Emit event
            emit('profile_updated', { userId: session.userId, user: sanitizeForClient(user) });

            return { success: true, user: sanitizeForClient(user) };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    function updateAvatar(dataUrl) {
        try {
            const sessionToken = localStorage.getItem('currentSession');
            if (!sessionToken) {
                return { success: false, error: 'Not authenticated' };
            }

            const sessions = JSON.parse(localStorage.getItem('vanstraSessions'));
            const session = sessions[sessionToken];
            if (!session) {
                return { success: false, error: 'Session not found' };
            }

            const users = JSON.parse(localStorage.getItem('vanstraUsers'));
            const user = users[session.userId];
            if (!user) {
                return { success: false, error: 'User not found' };
            }

            // Update avatar
            user.avatar = dataUrl;
            users[session.userId] = user;
            localStorage.setItem('vanstraUsers', JSON.stringify(users));

            // Emit event
            emit('avatar_updated', { userId: session.userId, avatar: dataUrl });

            return { success: true, user: sanitizeForClient(user) };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    function updateSecuritySettings(securityData) {
        try {
            const sessionToken = localStorage.getItem('currentSession');
            if (!sessionToken) {
                return { success: false, error: 'Not authenticated' };
            }

            const sessions = JSON.parse(localStorage.getItem('vanstraSessions'));
            const session = sessions[sessionToken];
            if (!session) {
                return { success: false, error: 'Session not found' };
            }

            const users = JSON.parse(localStorage.getItem('vanstraUsers'));
            const user = users[session.userId];
            if (!user) {
                return { success: false, error: 'User not found' };
            }

            // Verify current password before allowing changes
            if (user.passwordHash !== hashString(securityData.currentPassword)) {
                return { success: false, error: 'Current password is incorrect' };
            }

            // Update password and PIN if provided
            if (securityData.newPassword) {
                user.passwordHash = hashString(securityData.newPassword);
            }
            if (securityData.pin) {
                user.pinHash = hashString(securityData.pin);
            }

            users[session.userId] = user;
            localStorage.setItem('vanstraUsers', JSON.stringify(users));

            // Emit event
            emit('security_updated', { userId: session.userId });

            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    function updateUserPreferences(preferences) {
        try {
            const sessionToken = localStorage.getItem('currentSession');
            if (!sessionToken) {
                return { success: false, error: 'Not authenticated' };
            }

            const sessions = JSON.parse(localStorage.getItem('vanstraSessions'));
            const session = sessions[sessionToken];
            if (!session) {
                return { success: false, error: 'Session not found' };
            }

            const users = JSON.parse(localStorage.getItem('vanstraUsers'));
            const user = users[session.userId];
            if (!user) {
                return { success: false, error: 'User not found' };
            }

            // Update preferences
            if (preferences.currency) {
                user.currency = preferences.currency;
            }
            if (preferences.language) {
                user.language = preferences.language;
            }

            users[session.userId] = user;
            localStorage.setItem('vanstraUsers', JSON.stringify(users));

            // Emit event
            emit('preferences_updated', { userId: session.userId, preferences });

            return { success: true, user: sanitizeForClient(user) };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // ==================== PASSWORD RECOVERY ====================

    function requestPasswordReset(email) {
        try {
            const users = JSON.parse(localStorage.getItem('vanstraUsers'));
            const user = Object.values(users).find(u => u.email === email);
            
            if (!user) {
                // For security, don't reveal if email exists
                return { success: true, message: 'If an account with this email exists, a reset link has been sent.' };
            }

            // Generate reset token
            const resetToken = Math.random().toString(36).substr(2) + Date.now().toString(36);
            const resetExpiry = new Date(Date.now() + 3600000).toISOString(); // 1 hour expiry
            
            // Store reset token
            let resetRequests = JSON.parse(localStorage.getItem('passwordResetRequests') || '{}');
            resetRequests[resetToken] = {
                userId: user.id,
                email: email,
                expiresAt: resetExpiry,
                createdAt: new Date().toISOString()
            };
            localStorage.setItem('passwordResetRequests', JSON.stringify(resetRequests));

            // Simulate sending email with reset link.  We always log the link so
            // that developers/testers can retrieve it if the real mail service
            // isn't configured or fails.
            const resetLink = `${window.location.origin}/reset-password.html?token=${resetToken}`;
            sendEmail(email, 'Password Reset Request', 
                `Click the link below to reset your password. This link expires in 1 hour.\n\n${resetLink}\n\nIf you didn't request this, please ignore this email.`
            );

            // also output to console for debugging
            console.log('[VanstraBank] password reset link for', email, resetLink);

            // Log the event
            emit('password_reset_requested', { email, timestamp: new Date().toISOString(), resetLink });

            return { success: true, message: 'If an account with this email exists, a reset link has been sent.', resetLink };

        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    function resetPasswordWithToken(token, newPassword) {
        try {
            let resetRequests = JSON.parse(localStorage.getItem('passwordResetRequests') || '{}');
            const resetRequest = resetRequests[token];

            if (!resetRequest) {
                return { success: false, error: 'Invalid or expired reset token' };
            }

            // Check if token has expired
            if (new Date() > new Date(resetRequest.expiresAt)) {
                delete resetRequests[token];
                localStorage.setItem('passwordResetRequests', JSON.stringify(resetRequests));
                return { success: false, error: 'Reset token has expired. Please request a new one.' };
            }

            // Validate new password
            if (newPassword.length < 8) {
                return { success: false, error: 'Password must be at least 8 characters' };
            }

            // Update user password
            const users = JSON.parse(localStorage.getItem('vanstraUsers'));
            const user = users[resetRequest.userId];
            
            if (!user) {
                return { success: false, error: 'User not found' };
            }

            user.passwordHash = hashString(newPassword);
            users[resetRequest.userId] = user;
            localStorage.setItem('vanstraUsers', JSON.stringify(users));

            // Remove used token
            delete resetRequests[token];
            localStorage.setItem('passwordResetRequests', JSON.stringify(resetRequests));

            // Log the event
            emit('password_reset_completed', { userId: resetRequest.userId, email: resetRequest.email, timestamp: new Date().toISOString() });

            return { success: true, message: 'Password has been reset successfully. Please log in with your new password.' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    function validateResetToken(token) {
        try {
            let resetRequests = JSON.parse(localStorage.getItem('passwordResetRequests') || '{}');
            const resetRequest = resetRequests[token];

            if (!resetRequest) {
                return { valid: false, error: 'Invalid reset token' };
            }

            // Check if token has expired
            if (new Date() > new Date(resetRequest.expiresAt)) {
                delete resetRequests[token];
                localStorage.setItem('passwordResetRequests', JSON.stringify(resetRequests));
                return { valid: false, error: 'Reset token has expired' };
            }

            return { valid: true, email: resetRequest.email };
        } catch (e) {
            return { valid: false, error: e.message };
        }
    }

    // ==================== ACCOUNT SUSPENSION VERIFICATION ====================
    
    // Verification codes for suspended/frozen accounts
    // These are retrieved from admin-set codes stored per user
    const SUSPENSION_CODES = {
        COT: '962101',      // Customer Offset Token
        AFD: '385247',      // Account Freeze Directive
        SVR: '704856',      // Suspension Verification Request
        ACE: '521690',      // Account Clearance Encryption
        FVP: '813429'       // Final Verification Protocol
    };

    function getAccountSuspensionStatus() {
        const user = getCurrentUser();
        console.log('👤 Current User:', user);
        
        if (!user) {
            console.log('❌ No user found!');
            return { isSuspended: false };
        }
        
        // Check both status and accountStatus for compatibility
        const isSuspended = user.accountStatus === 'frozen' || user.accountStatus === 'suspended' || user.accountStatus === 'locked' ||
                          user.status === 'frozen' || user.status === 'suspended' || user.status === 'locked';
        
        console.log('🔒 Account Status Check:', {
            accountStatus: user.accountStatus,
            status: user.status,
            isSuspended
        });
        
        return {
            isSuspended,
            status: user.accountStatus || user.status,
            userId: user.id
        };
    }

    function initializeSuspensionChallenge(userId) {
        const user = getCurrentUser();
        if (!user) return null;

        // Determine which code is required based on account status
        let requiredCode = 'COT'; // default
        if (user.accountStatus === 'frozen' || user.status === 'frozen') {
            requiredCode = 'COT';
        } else if (user.accountStatus === 'blocked' || user.status === 'blocked') {
            requiredCode = 'AFD';
        } else if (user.accountStatus === 'suspended' || user.status === 'suspended') {
            requiredCode = 'SVR';
        } else if (user.accountStatus === 'locked' || user.status === 'locked') {
            requiredCode = 'ACE';
        }

        // Create a new suspension challenge session with only 1 code
        const challenge = {
            userId,
            codesRequired: [requiredCode], // Only one code now
            codesEntered: [],
            currentStep: 0,
            startTime: new Date().toISOString(),
            sessionId: 'SUSP-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6)
        };

        // Store in sessionStorage so it persists during the session
        sessionStorage.setItem('suspensionChallenge', JSON.stringify(challenge));

        return challenge;
    }

    function getCurrentSuspensionChallenge() {
        const challenge = sessionStorage.getItem('suspensionChallenge');
        return challenge ? JSON.parse(challenge) : null;
    }

    function verifySuspensionCode(code) {
        const challenge = getCurrentSuspensionChallenge();
        if (!challenge) {
            return { success: false, error: 'No active verification challenge' };
        }

        const currentCodeRequired = challenge.codesRequired[challenge.currentStep];
        const expectedCode = SUSPENSION_CODES[currentCodeRequired];

        if (code.trim() !== expectedCode) {
            return { 
                success: false, 
                error: 'Invalid code. Please check your verification letter from admin.',
                currentStep: challenge.currentStep,
                totalSteps: challenge.codesRequired.length
            };
        }

        // Code is correct
        challenge.codesEntered.push({
            code: currentCodeRequired,
            enteredAt: new Date().toISOString(),
            verified: true
        });
        challenge.currentStep++;

        // Check if all codes have been verified (now just 1 code)
        if (challenge.currentStep >= challenge.codesRequired.length) {
            // All codes verified - unlock the account
            const users = JSON.parse(localStorage.getItem('vanstraUsers'));
            const user = users[challenge.userId];
            if (user) {
                user.accountStatus = 'active';
                user.suspensionVerifiedAt = new Date().toISOString();
                users[challenge.userId] = user;
                localStorage.setItem('vanstraUsers', JSON.stringify(users));
            }
            
            // Clear the challenge
            sessionStorage.removeItem('suspensionChallenge');
            
            emit('account_unsuspended', { userId: challenge.userId, timestamp: new Date().toISOString() });
            
            return {
                success: true,
                completed: true,
                message: 'Account verification complete! Your account is now active.',
                nextStep: null
            };
        }

        // This should never be reached with single code system, but keeping for compatibility
        // Update the challenge
        sessionStorage.setItem('suspensionChallenge', JSON.stringify(challenge));

        const nextCode = challenge.codesRequired[challenge.currentStep];
        return {
            success: true,
            completed: false,
            requiresCustomerServiceContact: false, // No longer needed for single code
            message: `Code verified! Account will be unlocked.`,
            currentStep: challenge.currentStep,
            totalSteps: challenge.codesRequired.length,
            nextCode,
            progress: Math.round((challenge.currentStep / challenge.codesRequired.length) * 100)
        };
    }

    function verifyAccountUnlockCode(userId, code, restrictionType) {
        const SUSPENSION_CODES = {
            'COT': '962101',
            'AFD': '385247',
            'SVR': '704856',
            'ACE': '521690',
            'FVP': '813429'
        };

        // Map restriction types to required codes
        const codeMapping = {
            'frozen': 'COT',
            'blocked': 'AFD',
            'suspended': 'SVR'
        };

        const requiredCodeKey = codeMapping[restrictionType];
        if (!requiredCodeKey) {
            return { success: false, error: 'Invalid restriction type' };
        }

        const expectedCode = SUSPENSION_CODES[requiredCodeKey];
        if (code.trim() !== expectedCode) {
            return { 
                success: false, 
                error: `Invalid code for ${restrictionType} account. Required code: ${requiredCodeKey} (${expectedCode})`
            };
        }

        // Code is correct - unlock the account
        const users = JSON.parse(localStorage.getItem('vanstraUsers'));
        const user = users[userId];
        if (!user) {
            return { success: false, error: 'User not found' };
        }

        user.accountStatus = 'active';
        user.unlockedAt = new Date().toISOString();
        users[userId] = user;
        localStorage.setItem('vanstraUsers', JSON.stringify(users));

        emit('account_unlocked', { 
            userId: userId, 
            restrictionType: restrictionType,
            unlockedAt: user.unlockedAt 
        });

        return {
            success: true,
            message: `Account successfully unlocked! Your ${restrictionType} restriction has been removed.`,
            user: sanitizeForClient(user)
        };
    }

    function clearSuspensionChallenge() {
        sessionStorage.removeItem('suspensionChallenge');
    }

    // ==================== PUBLIC API ====================

    return {
        // Auth
        createAccount,
        login,
        logout,
        getCurrentUser,
        isAuthenticated,
        
        // Profile
        updateProfile,
        updateAvatar,
        updateSecuritySettings,
        updateUserPreferences,
        
        // Password Recovery
        requestPasswordReset,
        resetPasswordWithToken,
        validateResetToken,
        
        // PIN
        verifyPin,
        
        // Transactions
        transfer,
        payBill,
        submitDeposit,
        requestInternalTransfer,
        requestExternalTransfer,
        
        // Chat (removed)
        // Email (simulated)
        sendEmail,
        
        // Admin
        getAllUsers,
        updateUser,
        getAdminEvents,
        getAvailableUsers,
        
        // Account Suspension Verification
        getAccountSuspensionStatus,
        initializeSuspensionChallenge,
        getCurrentSuspensionChallenge,
        verifySuspensionCode,
        verifyAccountUnlockCode,
        clearSuspensionChallenge,
        
        // Events
        on,
        emit,
        
        // Utils
        formatCurrency,
        formatDate,
        formatDateTime,
        hashString
    };
})();

// Make available globally
window.VanstraBank = VanstraBank;
