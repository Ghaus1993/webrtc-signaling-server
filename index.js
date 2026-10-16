const express = require('express');
const mongoose = require('mongoose');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "여기에_مੋਂگوبي_کا_لنک_آئے_گا";

// MongoDB سے کنکشن
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB Connected Successfully! ✅'))
  .catch(err => console.log('MongoDB Connection Error: ', err));

// ڈیٹا بیس سکیمہ (سیٹنگز اور سیشن کے لیے)
const settingsSchema = new mongoose.Schema({
    sourceNumber: String,
    targetGroupJid: String,
    isForwardingActive: { type: Boolean, default: false }
});
const Settings = mongoose.model('Settings', settingsSchema);

let qrCodeData = '';
let connectionStatus = 'Connecting...';
let sock;
let groupsList = [];

// ہوم پیج (ڈیش بورڈ اور QR کوڈ)
app.get('/', async (req, res) => {
    let settings = await Settings.findOne();
    res.send(`
        <div style="font-family: sans-serif; text-align: center; margin-top: 30px;">
            <h1>WhatsApp Forwarder Dashboard</h1>
            <p><b>Status:</b> ${connectionStatus}</p>
            ${qrCodeData && connectionStatus !== 'Connected' ? `<img src="${qrCodeData}" style="width:250px;height:250px;"/><p>اس QR کوڈ کو اپنے واٹس ایپ سے سکین کریں</p>` : ''}
            <hr style="width: 50%; margin: 20px auto;">
            <h3>فارورڈنگ کی ترتیبات (Settings)</h3>
            <form action="/save-settings" method="POST" style="display: inline-block; text-align: left;">
                <label>مخصوص نمبر (Source Number):</label><br>
                <input type="text" name="sourceNumber" value="${settings?.sourceNumber || ''}" placeholder="مثلاً 923001234567" style="width: 300px; padding: 8px; margin-bottom: 10px;"><br>
                
                <label>ٹارگٹ گروپ JID (Target Group):</label><br>
                <input type="text" name="targetGroupJid" value="${settings?.targetGroupJid || ''}" placeholder="گروپ JID یہاں لکھیں" style="width: 300px; padding: 8px; margin-bottom: 10px;"><br>
                
                <label>فارورڈنگ آن/آف:</label>
                <input type="checkbox" name="isForwardingActive" ${settings?.isForwardingActive ? 'checked' : ''}><br><br>
                
                <button type="submit" style="padding: 10px 20px; background: green; color: white; border: none; cursor: pointer;">محفوظ کریں (Save)</button>
            </form>
        </div>
    `);
});

// سیٹنگز محفوظ کرنے کا روٹ
app.post('/save-settings', async (req, res) => {
    const { sourceNumber, targetGroupJid, isForwardingActive } = req.body;
    let settings = await Settings.findOne();
    if (!settings) {
        settings = new Settings();
    }
    settings.sourceNumber = sourceNumber;
    settings.targetGroupJid = targetGroupJid;
    settings.isForwardingActive = isForwardingActive === 'on';
    await settings.save();
    res.redirect('/');
});

// Render کو زندہ رکھنے کے لیے Ping روٹ
app.get('/ping', (req, res) => {
    res.status(200).send('Pong! Server is alive.');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    startWhatsApp();
});

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrCodeData = await qrcode.toDataURL(qr);
            connectionStatus = 'Waiting for QR scan';
        }
        if (connection === 'close') {
            connectionStatus = 'Disconnected';
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startWhatsApp();
        } else if (connection === 'open') {
            connectionStatus = 'Connected';
            qrCodeData = '';
            console.log('WhatsApp Connected!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // میسجز کو سننا اور فارورڈ کرنا
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid.replace('@s.whatsapp.net', '');
        const messageType = Object.keys(msg.message)[0];
        let messageText = '';

        if (messageType === 'conversation') {
            messageText = msg.message.conversation;
        } else if (messageType === 'extendedTextMessage') {
            messageText = msg.message.extendedTextMessage.text;
        }

        // ڈیٹا بیس سے سیٹنگز چیک کریں
        let settings = await Settings.findOne();
        if (settings && settings.isForwardingActive) {
            if (sender === settings.sourceNumber && settings.targetGroupJid) {
                await sock.sendMessage(settings.targetGroupJid, { 
                    text: `فارورڈ شدہ پیغام:\n\n${messageText}` 
                });
                console.log('میسج کامیابی سے گروپ میں فارورڈ کر دیا گیا!');
            }
        }
    });
}
