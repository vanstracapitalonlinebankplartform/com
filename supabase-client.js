// Supabase client wrapper with localStorage fallback
// Usage:
//  - Include supabase-js via CDN and then include a `supabase-config.js` file that calls SupabaseDB.init(url, key)
//  - If not initialized, functions fall back to localStorage-based persistence for compatibility/testing

(function(global){
    const SupabaseDB = {
        client: null,
        initialized: false,

        init(url, key) {
            try {
                if (!url || !key) return;
                if (typeof supabase === 'undefined' && typeof createClient === 'function') {
                    this.client = createClient(url, key);
                } else if (typeof supabase !== 'undefined') {
                    this.client = supabase.createClient ? supabase.createClient(url, key) : supabase;
                } else if (typeof createClient === 'function') {
                    this.client = createClient(url, key);
                }

                if (!this.client) {
                    console.warn('Supabase client not found; running in fallback mode');
                    this.initialized = false;
                    return;
                }

                this.initialized = true;
                console.info('SupabaseDB initialized');
            } catch (e) {
                console.error('Failed to initialize Supabase client', e);
                this.initialized = false;
            }
        },

        // Users table CRUD
        async createUser(user) {
            if (this.initialized) {
                const { data, error } = await this.client.from('users').insert([user]);
                if (error) throw error;
                return data;
            }
            // fallback
            const users = JSON.parse(localStorage.getItem('vanstraUsers') || '{}');
            users[user.id] = user;
            localStorage.setItem('vanstraUsers', JSON.stringify(users));
            return user;
        },

        async getAllUsers() {
            if (this.initialized) {
                const { data, error } = await this.client.from('users').select('*');
                if (error) throw error;
                return data;
            }
            const users = JSON.parse(localStorage.getItem('vanstraUsers') || '{}');
            return Object.values(users);
        },

        async getUser(userId) {
            if (this.initialized) {
                const { data, error } = await this.client.from('users').select('*').eq('id', userId).single();
                if (error) throw error;
                return data;
            }
            const users = JSON.parse(localStorage.getItem('vanstraUsers') || '{}');
            return users[userId];
        },

        async updateUser(userId, changes) {
            if (this.initialized) {
                const { data, error } = await this.client.from('users').update(changes).eq('id', userId);
                if (error) throw error;
                return data;
            }
            const users = JSON.parse(localStorage.getItem('vanstraUsers') || '{}');
            if (!users[userId]) throw new Error('User not found');
            Object.assign(users[userId], changes);
            localStorage.setItem('vanstraUsers', JSON.stringify(users));
            return users[userId];
        },

        // Transactions
        async createTransaction(userId, txn) {
            if (this.initialized) {
                const { data, error } = await this.client.from('transactions').insert([{ userId, ...txn }]);
                if (error) throw error;
                return data;
            }
            const users = JSON.parse(localStorage.getItem('vanstraUsers') || '{}');
            if (!users[userId]) throw new Error('User not found');
            users[userId].transactions = users[userId].transactions || [];
            users[userId].transactions.unshift(txn);
            localStorage.setItem('vanstraUsers', JSON.stringify(users));
            return txn;
        },

        async getTransactions(userId) {
            if (this.initialized) {
                const { data, error } = await this.client.from('transactions').select('*').eq('userId', userId).order('timestamp', { ascending: false });
                if (error) throw error;
                return data;
            }
            const users = JSON.parse(localStorage.getItem('vanstraUsers') || '{}');
            return (users[userId] && users[userId].transactions) || [];
        },

        // Emails
        async storeEmail(email) {
            if (this.initialized) {
                const { data, error } = await this.client.from('sent_emails').insert([email]);
                if (error) throw error;
                return data;
            }
            const sent = JSON.parse(localStorage.getItem('sentEmails') || '[]');
            sent.unshift(email);
            localStorage.setItem('sentEmails', JSON.stringify(sent));
            return email;
        },

        async getSentEmails() {
            if (this.initialized) {
                const { data, error } = await this.client.from('sent_emails').select('*').order('timestamp', { ascending: false });
                if (error) throw error;
                return data;
            }
            return JSON.parse(localStorage.getItem('sentEmails') || '[]');
        }
    };

    global.SupabaseDB = SupabaseDB;
})(window);
