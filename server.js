require('dotenv').config();

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const ExcelJS = require('exceljs');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const webpush = require('web-push');
const { obtenerSolicitudFeedback } = require('./feedback-notification');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '16kb' }));

const sessionCookieName = 'eunice_session';
const sessionDurationMs = 12 * 60 * 60 * 1000;
const accessSessions = new Map();
const loginAttempts = new Map();
const accessUsername = process.env.EUNICE_ACCESS_USERNAME || 'Eunice';
const configuredPasswordHash = process.env.EUNICE_ACCESS_PASSWORD_HASH;
const passwordHashMatch = configuredPasswordHash?.match(/^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/i);
const passwordSalt = passwordHashMatch ? Buffer.from(passwordHashMatch[1], 'hex') : null;
const passwordHash = passwordHashMatch ? Buffer.from(passwordHashMatch[2], 'hex') : null;
const derivePasswordHash = promisify(crypto.scrypt);
const passwordHashOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

if (!passwordHashMatch) {
    throw new Error('Configura EUNICE_ACCESS_PASSWORD_HASH en .env con un hash scrypt válido.');
}

function coincideSecreto(valor, esperado) {
    const recibido = Buffer.from(typeof valor === 'string' ? valor : '');
    const referencia = Buffer.from(esperado);
    return recibido.length === referencia.length && crypto.timingSafeEqual(recibido, referencia);
}

async function coincideContrasena(valor) {
    if (typeof valor !== 'string' || Buffer.byteLength(valor, 'utf8') > 1024) return false;
    const derivado = await derivePasswordHash(valor, passwordSalt, passwordHash.length, passwordHashOptions);
    return crypto.timingSafeEqual(derivado, passwordHash);
}

function getSessionToken(cookieHeader = '') {
    const cookie = cookieHeader.split(';').map(part => part.trim())
        .find(part => part.startsWith(`${sessionCookieName}=`));
    return cookie ? cookie.slice(sessionCookieName.length + 1) : '';
}

function hasValidSession(cookieHeader) {
    const token = getSessionToken(cookieHeader);
    const expiresAt = accessSessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
        accessSessions.delete(token);
        return false;
    }
    return true;
}

function setSessionCookie(response, request, token) {
    const secure = request.secure ? '; Secure' : '';
    response.setHeader(
        'Set-Cookie',
        `${sessionCookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionDurationMs / 1000}${secure}`
    );
}

app.post('/api/login', async (request, response) => {
    const ip = request.ip;
    const attempt = loginAttempts.get(ip);
    if (attempt?.blockedUntil > Date.now()) {
        response.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.' });
        return;
    }

    const valid = coincideSecreto(request.body?.username, accessUsername)
        && await coincideContrasena(request.body?.password);
    if (!valid) {
        const failures = (attempt?.failures || 0) + 1;
        loginAttempts.set(ip, {
            failures,
            blockedUntil: failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0
        });
        response.status(401).json({ error: 'El usuario o la contraseña no son correctos.' });
        return;
    }

    loginAttempts.delete(ip);
    const now = Date.now();
    for (const [token, expiresAt] of accessSessions) {
        if (expiresAt <= now) accessSessions.delete(token);
    }
    const token = crypto.randomBytes(32).toString('hex');
    accessSessions.set(token, now + sessionDurationMs);
    setSessionCookie(response, request, token);
    response.status(200).json({ authenticated: true });
});

app.get('/api/session', (request, response) => {
    response.json({ authenticated: hasValidSession(request.headers.cookie) });
});

app.post('/api/logout', (request, response) => {
    accessSessions.delete(getSessionToken(request.headers.cookie));
    response.setHeader(
        'Set-Cookie',
        `${sessionCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${request.secure ? '; Secure' : ''}`
    );
    response.status(204).end();
});

app.use('/api', (request, response, next) => {
    if (!hasValidSession(request.headers.cookie)) {
        response.status(401).json({ error: 'Inicia sesión para continuar.' });
        return;
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

const broker = process.env.MQTT_BROKER || 'mqtt://broker.emqx.io:1883';
const mqttClient = mqtt.connect(broker);
const dataDirectory = process.env.EUNICE_DATA_DIR || path.join(__dirname, 'data');
const historyFile = path.join(dataDirectory, 'records.jsonl');
const dailyHistoryDirectory = path.join(dataDirectory, 'history');
const settingsFile = path.join(dataDirectory, 'settings.json');
const routinesFile = path.join(dataDirectory, 'routines.json');
const pushSubscriptionFile = path.join(dataDirectory, 'push-subscriptions.json');
const vapidKeyFile = path.join(dataDirectory, 'vapid-keys.json');
let mqttConnected = false;
let ultimoDatoHardware = null;

fs.mkdirSync(dataDirectory, { recursive: true });

function cargarOCrearClavesVapid() {
    const publicKeyEnv = process.env.VAPID_PUBLIC_KEY;
    const privateKeyEnv = process.env.VAPID_PRIVATE_KEY;
    if (Boolean(publicKeyEnv) !== Boolean(privateKeyEnv)) {
        throw new Error('Configura juntas VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY, o deja ambas sin configurar.');
    }
    if (publicKeyEnv && privateKeyEnv) {
        return { publicKey: publicKeyEnv, privateKey: privateKeyEnv };
    }

    if (fs.existsSync(vapidKeyFile)) {
        const keys = JSON.parse(fs.readFileSync(vapidKeyFile, 'utf8'));
        if (typeof keys.publicKey !== 'string' || typeof keys.privateKey !== 'string') {
            throw new Error(`El archivo de claves VAPID no es válido: ${vapidKeyFile}`);
        }
        return keys;
    }

    const keys = webpush.generateVAPIDKeys();
    const temporaryFile = `${vapidKeyFile}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryFile, vapidKeyFile);
    console.info('Se han generado y guardado claves VAPID locales para las notificaciones push.');
    return keys;
}

const { publicKey: vapidPublicKey, privateKey: vapidPrivateKey } = cargarOCrearClavesVapid();
const pushConfigured = true;
webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    vapidPublicKey,
    vapidPrivateKey
);

const defaultSettings = {
    modo: 'automatico',
    colores: {
        frio: '#0000ff',
        neutro: '#00ff00',
        calor: '#ff0000'
    }
};

fs.mkdirSync(dailyHistoryDirectory, { recursive: true });

function isValidPushSubscription(subscription) {
    if (
        !subscription
        || typeof subscription.endpoint !== 'string'
        || typeof subscription.keys?.p256dh !== 'string'
        || typeof subscription.keys?.auth !== 'string'
    ) {
        return false;
    }

    try {
        return new URL(subscription.endpoint).protocol === 'https:';
    } catch {
        return false;
    }
}

function cargarSuscripcionesPush() {
    if (!fs.existsSync(pushSubscriptionFile)) return new Map();
    const subscriptions = JSON.parse(fs.readFileSync(pushSubscriptionFile, 'utf8'));
    if (!Array.isArray(subscriptions) || !subscriptions.every(isValidPushSubscription)) {
        throw new Error(`El archivo de suscripciones push no es válido: ${pushSubscriptionFile}`);
    }
    return new Map(subscriptions.map(subscription => [subscription.endpoint, subscription]));
}

const suscripcionesPush = cargarSuscripcionesPush();

function guardarSuscripcionesPush() {
    const temporaryFile = `${pushSubscriptionFile}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify([...suscripcionesPush.values()], null, 2)}\n`);
    fs.renameSync(temporaryFile, pushSubscriptionFile);
}

function esRutinaValida(rutina) {
    return Boolean(
        rutina
        && typeof rutina.id === 'string'
        && /^[A-Za-z0-9_-]{1,80}$/.test(rutina.id)
        && typeof rutina.nombre === 'string'
        && rutina.nombre.trim().length > 0
        && rutina.nombre.trim().length <= 48
        && ['Casa', 'Oficina'].includes(rutina.lugar)
        && Array.isArray(rutina.dias)
        && rutina.dias.length > 0
        && rutina.dias.every(dia => Number.isInteger(dia) && dia >= 0 && dia <= 6)
        && new Set(rutina.dias).size === rutina.dias.length
        && typeof rutina.hora === 'string'
        && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rutina.hora)
        && Number.isFinite(rutina.temperatura)
        && rutina.temperatura >= 16
        && rutina.temperatura <= 28
        && typeof rutina.activa === 'boolean'
    );
}

function cargarRutinas() {
    if (!fs.existsSync(routinesFile)) return [];
    const routines = JSON.parse(fs.readFileSync(routinesFile, 'utf8'));
    if (!Array.isArray(routines) || !routines.every(esRutinaValida)) {
        throw new Error(`El archivo de rutinas no es válido: ${routinesFile}`);
    }
    return routines;
}

let rutinas = cargarRutinas();

function persistirRutinas(nuevasRutinas) {
    const temporaryFile = `${routinesFile}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify(nuevasRutinas, null, 2)}\n`);
    fs.renameSync(temporaryFile, routinesFile);
    rutinas = nuevasRutinas;
    io.emit('rutinas_actualizadas', rutinas);
}

function normalizarDatosRutina(rutina, id, activa = true) {
    if (
        !rutina
        || typeof rutina.nombre !== 'string'
        || !['Casa', 'Oficina'].includes(rutina.lugar)
        || !Array.isArray(rutina.dias)
        || !rutina.dias.length
        || !rutina.dias.every(dia => Number.isInteger(dia) && dia >= 0 && dia <= 6)
        || new Set(rutina.dias).size !== rutina.dias.length
        || typeof rutina.hora !== 'string'
        || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rutina.hora)
        || !Number.isFinite(rutina.temperatura)
        || rutina.temperatura < 16
        || rutina.temperatura > 28
    ) {
        return null;
    }

    const normalizada = {
        id,
        nombre: rutina.nombre.trim(),
        lugar: rutina.lugar,
        dias: [...rutina.dias],
        hora: rutina.hora,
        temperatura: rutina.temperatura,
        activa
    };
    return esRutinaValida(normalizada) ? normalizada : null;
}

app.get('/api/rutinas', (request, response) => {
    response.json({ rutinas });
});

app.post('/api/rutinas/import', (request, response) => {
    if (!Array.isArray(request.body?.rutinas)) {
        response.status(400).json({ error: 'El formato de las rutinas no es válido.' });
        return;
    }

    const imported = request.body.rutinas
        .filter(rutina => !(rutina && typeof rutina.id === 'string' && rutina.id.startsWith('ejemplo-')))
        .map(rutina => normalizarDatosRutina(
            rutina,
            typeof rutina?.id === 'string' ? rutina.id : '',
            rutina?.activa === true
        ));
    if (imported.some(rutina => !rutina)) {
        response.status(400).json({ error: 'Una o más rutinas no tienen un formato válido.' });
        return;
    }

    const idsExistentes = new Set(rutinas.map(rutina => rutina.id));
    const nuevasRutinas = imported
        .filter(rutina => !idsExistentes.has(rutina.id))
        .reduce((acumuladas, rutina) => {
            if (!acumuladas.some(existente => existente.id === rutina.id)) acumuladas.push(rutina);
            return acumuladas;
        }, [...rutinas]);
    if (nuevasRutinas.length === rutinas.length) {
        response.json({ rutinas, imported: false });
        return;
    }

    try {
        persistirRutinas(nuevasRutinas);
        response.status(201).json({ rutinas, imported: true });
    } catch (error) {
        console.error('No se pudieron importar las rutinas:', error.message);
        response.status(500).json({ error: 'No se pudieron guardar las rutinas en el servidor.' });
    }
});

app.post('/api/rutinas', (request, response) => {
    const rutina = normalizarDatosRutina(request.body, crypto.randomBytes(12).toString('hex'));
    if (!rutina) {
        response.status(400).json({ error: 'Los datos de la rutina no son válidos.' });
        return;
    }

    try {
        persistirRutinas([...rutinas, rutina]);
        response.status(201).json({ rutinas });
    } catch (error) {
        console.error('No se pudo guardar la rutina:', error.message);
        response.status(500).json({ error: 'No se pudo guardar la rutina en el servidor.' });
    }
});

app.patch('/api/rutinas/:id', (request, response) => {
    const { id } = request.params;
    const indice = rutinas.findIndex(rutina => rutina.id === id);
    if (indice === -1) {
        response.status(404).json({ error: 'No se encontró la rutina.' });
        return;
    }
    if (typeof request.body?.activa !== 'boolean' || Object.keys(request.body).length !== 1) {
        response.status(400).json({ error: 'El estado de la rutina no es válido.' });
        return;
    }

    const nuevasRutinas = rutinas.map((rutina, index) => (
        index === indice ? { ...rutina, activa: request.body.activa } : rutina
    ));
    try {
        persistirRutinas(nuevasRutinas);
        response.json({ rutinas });
    } catch (error) {
        console.error('No se pudo actualizar la rutina:', error.message);
        response.status(500).json({ error: 'No se pudo actualizar la rutina en el servidor.' });
    }
});

app.delete('/api/rutinas/:id', (request, response) => {
    const nuevasRutinas = rutinas.filter(rutina => rutina.id !== request.params.id);
    if (nuevasRutinas.length === rutinas.length) {
        response.status(404).json({ error: 'No se encontró la rutina.' });
        return;
    }
    try {
        persistirRutinas(nuevasRutinas);
        response.json({ rutinas });
    } catch (error) {
        console.error('No se pudo eliminar la rutina:', error.message);
        response.status(500).json({ error: 'No se pudo eliminar la rutina en el servidor.' });
    }
});

app.get('/api/push/public-key', (request, response) => {
    if (!pushConfigured) {
        response.status(503).json({ error: 'El servidor todavía no está configurado para enviar notificaciones push.' });
        return;
    }
    response.json({ publicKey: vapidPublicKey });
});

app.get('/api/push/status', (request, response) => {
    response.json({ configured: pushConfigured });
});

app.post('/api/push-subscriptions', (request, response) => {
    const subscription = request.body;
    if (!isValidPushSubscription(subscription)) {
        response.status(400).json({ error: 'La suscripción de notificaciones no es válida.' });
        return;
    }
    const subscriptionAnterior = suscripcionesPush.get(subscription.endpoint);
    suscripcionesPush.set(subscription.endpoint, subscription);
    try {
        guardarSuscripcionesPush();
    } catch (error) {
        if (subscriptionAnterior) {
            suscripcionesPush.set(subscription.endpoint, subscriptionAnterior);
        } else {
            suscripcionesPush.delete(subscription.endpoint);
        }
        console.error('No se pudo guardar la suscripción push:', error.message);
        response.status(500).json({ error: 'No se pudo guardar la suscripción en disco.' });
        return;
    }
    ultimaTransicionFeedbackPush = '';
    evaluarSolicitudFeedbackPush();
    response.status(201).json({ subscribed: true });
});

app.delete('/api/push-subscriptions', (request, response) => {
    const endpoint = request.body?.endpoint;
    if (typeof endpoint !== 'string') {
        response.status(400).json({ error: 'Falta el endpoint de la suscripción.' });
        return;
    }
    const subscriptionAnterior = suscripcionesPush.get(endpoint);
    suscripcionesPush.delete(endpoint);
    try {
        guardarSuscripcionesPush();
    } catch (error) {
        if (subscriptionAnterior) suscripcionesPush.set(endpoint, subscriptionAnterior);
        console.error('No se pudo eliminar la suscripción push:', error.message);
        response.status(500).json({ error: 'No se pudo actualizar la suscripción en disco.' });
        return;
    }
    response.status(204).end();
});

app.post('/api/push/test', async (request, response) => {
    const endpoint = request.body?.endpoint;
    if (typeof endpoint !== 'string') {
        response.status(400).json({ error: 'Falta el dispositivo para enviar la prueba.' });
        return;
    }

    const subscription = suscripcionesPush.get(endpoint);
    if (!subscription) {
        response.status(404).json({ error: 'Este dispositivo no está suscrito. Activa de nuevo las notificaciones.' });
        return;
    }

    try {
        await webpush.sendNotification(subscription, JSON.stringify({
            title: 'euNICE: notificación de prueba',
            body: 'Las notificaciones push de este dispositivo están funcionando.',
            url: '/'
        }), { urgency: 'high' });
        response.status(200).json({ sent: true });
    } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
            suscripcionesPush.delete(endpoint);
            try {
                guardarSuscripcionesPush();
            } catch (saveError) {
                console.error('No se pudo eliminar la suscripción push caducada:', saveError.message);
            }
        }
        console.error('No se pudo enviar la notificación push de prueba:', error.message);
        response.status(502).json({
            error: error.statusCode === 404 || error.statusCode === 410
                ? 'La suscripción de este dispositivo ha caducado. Desactiva y vuelve a activar las notificaciones.'
                : 'El proveedor push no aceptó la notificación. Revisa la conexión y vuelve a intentarlo.'
        });
    }
});

async function enviarNotificacionPush(payload) {
    if (!pushConfigured || suscripcionesPush.size === 0) return;

    let subscriptionsExpired = false;
    await Promise.all([...suscripcionesPush.entries()].map(async ([endpoint, subscription]) => {
        try {
            await webpush.sendNotification(subscription, JSON.stringify(payload), { urgency: 'high' });
        } catch (error) {
            if (error.statusCode === 404 || error.statusCode === 410) {
                suscripcionesPush.delete(endpoint);
                subscriptionsExpired = true;
                console.info('Suscripción push caducada; se ha eliminado.');
                return;
            }
            console.error('No se pudo enviar una notificación push:', error.message);
        }
    }));

    if (subscriptionsExpired) {
        try {
            guardarSuscripcionesPush();
        } catch (error) {
            console.error('No se pudieron eliminar las suscripciones push caducadas:', error.message);
        }
    }
}

function isValidDate(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsedDate = new Date(`${date}T00:00:00`);
    return !Number.isNaN(parsedDate.getTime()) && localDateString(parsedDate) === date;
}

function localDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function validateSettings(settings) {
    if (!settings || !['automatico', 'feedback'].includes(settings.modo)) {
        throw new Error('El modo guardado debe ser automatico o feedback.');
    }

    for (const colorName of ['frio', 'neutro', 'calor']) {
        if (!/^#[0-9a-f]{6}$/i.test(settings.colores?.[colorName] || '')) {
            throw new Error(`El color "${colorName}" guardado no es válido.`);
        }
    }
    return settings;
}

function loadSettings() {
    if (!fs.existsSync(settingsFile)) {
        fs.writeFileSync(settingsFile, `${JSON.stringify(defaultSettings, null, 2)}\n`);
        return structuredClone(defaultSettings);
    }
    return validateSettings(JSON.parse(fs.readFileSync(settingsFile, 'utf8')));
}

function leerRegistrosJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];

    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
        let record;
        try {
            record = JSON.parse(line);
        } catch (error) {
            throw new Error(`Histórico inválido en ${filePath}, línea ${index + 1}: ${error.message}`);
        }
        if (!isValidDate(record.fecha) || typeof record.hora !== 'string') {
            throw new Error(`Registro inválido en ${filePath}, línea ${index + 1}.`);
        }
        return record;
    });
}

function cargarHistoricoDiario() {
    const files = fs.readdirSync(dailyHistoryDirectory)
        .filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
        .sort();
    return files.flatMap(file => leerRegistrosJsonl(path.join(dailyHistoryDirectory, file)));
}

function migrarHistoricoAnterior() {
    const registros = leerRegistrosJsonl(historyFile);
    const porFecha = new Map();
    for (const registro of registros) {
        if (!porFecha.has(registro.fecha)) porFecha.set(registro.fecha, []);
        porFecha.get(registro.fecha).push(registro);
    }

    for (const [fecha, datos] of porFecha) {
        const filePath = path.join(dailyHistoryDirectory, `${fecha}.jsonl`);
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, `${datos.map(registro => JSON.stringify(registro)).join('\n')}\n`);
        }
    }
    return registros;
}

function guardarRegistrosDemostracion() {
    const hoy = new Date();
    for (let diasAtras = 1; diasAtras <= 7; diasAtras += 1) {
        const dia = new Date(hoy);
        dia.setDate(dia.getDate() - diasAtras);
        const fecha = localDateString(dia);
        const filePath = path.join(dailyHistoryDirectory, `${fecha}.jsonl`);
        if (fs.existsSync(filePath)) continue;

        const registros = [];
        for (let hora = 0; hora < 24; hora += 2) {
            const timestampLocal = new Date(dia);
            timestampLocal.setHours(hora, 0, 0, 0);
            const variacion = Math.sin((hora + diasAtras * 3) * Math.PI / 12);
            const timestamp = timestampLocal.toISOString();
            registros.push({
                fecha,
                hora: timestampLocal.toLocaleTimeString(),
                timestamp,
                temperatura: Number((22 + variacion * 3 + diasAtras * 0.15).toFixed(1)),
                humedad: Math.round(48 + Math.cos((hora + diasAtras) * Math.PI / 12) * 12),
                luz: hora >= 8 && hora <= 18 ? 'Encender luces' : 'Apagado',
                ventilador: hora < 8 ? 'calefaccion' : 'apagado',
                simulado: true
            });
        }
        fs.writeFileSync(filePath, `${registros.map(registro => JSON.stringify(registro)).join('\n')}\n`);
    }
}

function loadHistory() {
    const files = fs.readdirSync(dailyHistoryDirectory)
        .filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file));
    if (files.length > 0) return cargarHistoricoDiario();

    if (fs.existsSync(historyFile)) {
        const migratedRecords = migrarHistoricoAnterior();
        if (migratedRecords.length > 0) return cargarHistoricoDiario();
    }

    return [];
}

let configuracion = loadSettings();
let historico = loadHistory();
guardarRegistrosDemostracion();
historico = cargarHistoricoDiario().sort((a, b) => (
    String(a.timestamp || `${a.fecha}T${a.hora}`).localeCompare(String(b.timestamp || `${b.fecha}T${b.hora}`))
));
let estadoActual = {
    sistema_encendido: false,
    temperatura: 0,
    humedad: 0,
    luz: '--',
    ventilador: 'apagado'
};

function hexToRgb(hex) {
    return [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16)
    ];
}

function rgbToHex(rgb) {
    if (
        !Array.isArray(rgb)
        || rgb.length !== 3
        || rgb.some(channel => !Number.isInteger(channel) || channel < 0 || channel > 255)
    ) {
        throw new Error('Los colores deben ser listas RGB con valores enteros de 0 a 255.');
    }
    return `#${rgb.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function escaparXml(valor) {
    return String(valor).replace(/[&<>"']/g, caracter => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;'
    })[caracter]);
}

function crearSvgGrafica(registros, tipo) {
    const ancho = 760;
    const alto = 420;
    const izquierda = 64;
    const derecha = 24;
    const arriba = 52;
    const abajo = 70;
    const anchoPlot = ancho - izquierda - derecha;
    const altoPlot = alto - arriba - abajo;
    const colores = ['#e07a5f', '#739b83', '#4a90e2'];
    const fuente = 'Arial, sans-serif';
    const encabezado = tipo === 'doughnut' ? 'Lecturas por rango de temperatura' : 'Temperatura y humedad';
    const ejeY = (valor, minimo, maximo) => arriba + altoPlot - ((valor - minimo) / (maximo - minimo)) * altoPlot;
    const formatoHora = indice => escaparXml(registros[indice].hora);
    let contenido;

    if (tipo === 'doughnut') {
        const rangos = [
            { nombre: 'Frío (<25 °C)', valor: registros.filter(registro => Number(registro.temperatura) < 25).length, color: colores[2] },
            { nombre: 'Confort (25-28 °C)', valor: registros.filter(registro => Number(registro.temperatura) >= 25 && Number(registro.temperatura) <= 28).length, color: colores[1] },
            { nombre: 'Calor (>28 °C)', valor: registros.filter(registro => Number(registro.temperatura) > 28).length, color: colores[0] }
        ];
        const total = rangos.reduce((suma, rango) => suma + rango.valor, 0);
        let angulo = -Math.PI / 2;
        const sectores = rangos.map(rango => {
            const tramo = total ? (rango.valor / total) * Math.PI * 2 : 0;
            const final = angulo + tramo;
            const x1 = 230 + 120 * Math.cos(angulo);
            const y1 = 220 + 120 * Math.sin(angulo);
            const x2 = 230 + 120 * Math.cos(final);
            const y2 = 220 + 120 * Math.sin(final);
            const grande = tramo > Math.PI ? 1 : 0;
            const path = rango.valor
                ? `<path d="M230 220 L${x1.toFixed(2)} ${y1.toFixed(2)} A120 120 0 ${grande} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${rango.color}" stroke="#fff" stroke-width="2"/>`
                : '';
            angulo = final;
            return path;
        }).join('');
        const leyenda = rangos.map((rango, indice) => {
            const y = 174 + indice * 42;
            const porcentaje = total ? `${((rango.valor / total) * 100).toFixed(1)}%` : '0.0%';
            return `<rect x="430" y="${y - 14}" width="16" height="16" rx="3" fill="${rango.color}"/><text x="458" y="${y}" font-family="${fuente}" font-size="16" fill="#34473f">${escaparXml(rango.nombre)}</text><text x="704" y="${y}" text-anchor="end" font-family="${fuente}" font-size="16" font-weight="700" fill="#34473f">${rango.valor} (${porcentaje})</text>`;
        }).join('');
        contenido = `${sectores}<circle cx="230" cy="220" r="67" fill="#fff"/><text x="230" y="215" text-anchor="middle" font-family="${fuente}" font-size="17" fill="#607068">Lecturas</text><text x="230" y="244" text-anchor="middle" font-family="${fuente}" font-size="25" font-weight="700" fill="#34473f">${total}</text>${leyenda}`;
    } else {
        const valores = registros.flatMap(registro => [Number(registro.temperatura), Number(registro.humedad)]).filter(Number.isFinite);
        let minimo = Math.floor(Math.min(...valores));
        let maximo = Math.ceil(Math.max(...valores));
        if (minimo === maximo) {
            minimo -= 1;
            maximo += 1;
        }
        const tickCount = 5;
        const ticks = Array.from({ length: tickCount + 1 }, (_, indice) => minimo + ((maximo - minimo) * indice / tickCount));
        const grid = ticks.map(valor => {
            const y = ejeY(valor, minimo, maximo);
            return `<line x1="${izquierda}" y1="${y.toFixed(2)}" x2="${ancho - derecha}" y2="${y.toFixed(2)}" stroke="#e4eae5"/><text x="${izquierda - 12}" y="${(y + 5).toFixed(2)}" text-anchor="end" font-family="${fuente}" font-size="12" fill="#607068">${valor.toFixed(1)}</text>`;
        }).join('');
        const marcasTiempo = Math.min(7, registros.length);
        const labels = Array.from({ length: marcasTiempo }, (_, indice) => {
            const lectura = Math.round(indice * (registros.length - 1) / Math.max(1, marcasTiempo - 1));
            const x = izquierda + (registros.length > 1 ? lectura / (registros.length - 1) : 0.5) * anchoPlot;
            return `<text x="${x.toFixed(2)}" y="${alto - 34}" text-anchor="middle" font-family="${fuente}" font-size="11" fill="#607068">${formatoHora(lectura)}</text>`;
        }).join('');
        const datasets = [
            { clave: 'temperatura', color: colores[0] },
            { clave: 'humedad', color: colores[1] }
        ];
        const lineas = datasets.map(dataset => {
            const puntos = registros.map((registro, indice) => {
                const valor = Number(registro[dataset.clave]);
                if (!Number.isFinite(valor)) return null;
                const x = izquierda + (registros.length > 1 ? indice / (registros.length - 1) : 0.5) * anchoPlot;
                return `${x.toFixed(2)},${ejeY(valor, minimo, maximo).toFixed(2)}`;
            }).filter(Boolean).join(' ');
            return `<polyline points="${puntos}" fill="none" stroke="${dataset.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
        }).join('');
        const leyenda = datasets.map((dataset, indice) => {
            const x = 278 + indice * 210;
            const etiqueta = dataset.clave === 'temperatura' ? 'Temperatura (°C)' : 'Humedad (%)';
            return `<line x1="${x}" y1="27" x2="${x + 28}" y2="27" stroke="${dataset.color}" stroke-width="3"/><text x="${x + 36}" y="32" font-family="${fuente}" font-size="14" fill="#34473f">${etiqueta}</text>`;
        }).join('');
        if (tipo === 'bar') {
            const espacio = anchoPlot / Math.max(1, registros.length);
            const barra = Math.max(1, Math.min(12, espacio * 0.34));
            contenido = `${grid}${registros.map((registro, indice) => {
                const centro = izquierda + (indice + 0.5) * espacio;
                return datasets.map((dataset, serie) => {
                    const valor = Number(registro[dataset.clave]);
                    if (!Number.isFinite(valor)) return '';
                    const y = ejeY(valor, minimo, maximo);
                    return `<rect x="${(centro + (serie ? 1 : -1) * barra / 2 - barra).toFixed(2)}" y="${y.toFixed(2)}" width="${barra.toFixed(2)}" height="${(arriba + altoPlot - y).toFixed(2)}" fill="${dataset.color}"/>`;
                }).join('');
            }).join('')}${labels}${leyenda}`;
        } else {
            contenido = `${grid}${lineas}${labels}${leyenda}`;
        }
        contenido += `<text x="${izquierda + anchoPlot / 2}" y="${alto - 8}" text-anchor="middle" font-family="${fuente}" font-size="12" fill="#607068">Hora</text><text transform="translate(18 ${arriba + altoPlot / 2}) rotate(-90)" text-anchor="middle" font-family="${fuente}" font-size="12" fill="#607068">Valor</text>`;
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="${alto}" viewBox="0 0 ${ancho} ${alto}"><rect width="100%" height="100%" rx="12" fill="#ffffff"/><text x="32" y="34" font-family="${fuente}" font-size="18" font-weight="700" fill="#34473f">${encabezado}</text>${contenido}</svg>`;
}

function publicarConfiguracionHardware() {
    const payload = {
        modo: configuracion.modo,
        config_led: {
            frio: hexToRgb(configuracion.colores.frio),
            neutro: hexToRgb(configuracion.colores.neutro),
            calor: hexToRgb(configuracion.colores.calor)
        }
    };
    mqttClient.publish(
        'euNICE/comando/configuracion',
        JSON.stringify(payload),
        { retain: true },
        error => {
            if (error) console.error('Error al publicar la configuración persistente:', error.message);
        }
    );
}

function persistirConfiguracion(nuevaConfiguracion) {
    validateSettings(nuevaConfiguracion);
    const temporaryFile = `${settingsFile}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify(nuevaConfiguracion, null, 2)}\n`);
    fs.renameSync(temporaryFile, settingsFile);
    configuracion = nuevaConfiguracion;
    io.emit('configuracion_actualizada', configuracion);
    publicarConfiguracionHardware();
}

function persistirRegistro(registro) {
    try {
        const historyFileForDay = path.join(dailyHistoryDirectory, `${registro.fecha}.jsonl`);
        fs.appendFileSync(historyFileForDay, `${JSON.stringify(registro)}\n`);
        historico.push(registro);
        io.emit('historico_actualizado', {
            fecha: registro.fecha,
            registros: registrosDeFecha(registro.fecha),
            simulado: false
        });
        io.emit('dias_disponibles', fechasDisponibles());
    } catch (error) {
        console.error('No se pudo guardar el registro histórico:', error);
        io.emit('error_persistencia', 'No se pudo guardar el histórico en disco.');
    }
}

function fechasDisponibles() {
    return [...new Set(historico.map(record => record.fecha))].sort();
}

function registrosDeFecha(fecha) {
    return historico.filter(record => record.fecha === fecha);
}

function emitirEstadoConexion(destino = io) {
    destino.emit('conexion_estado', {
        mqttConectado: mqttConnected,
        ultimoDatoHardware
    });
}

let ultimaTransicionFeedbackPush = '';

function evaluarSolicitudFeedbackPush() {
    const solicitud = obtenerSolicitudFeedback({
        modo: configuracion.modo,
        sistemaEncendido: estadoActual.sistema_encendido,
        temperatura: estadoActual.temperatura,
        ventilador: estadoActual.ventilador
    });
    if (!solicitud) {
        ultimaTransicionFeedbackPush = '';
        return;
    }

    if (solicitud.transicion !== ultimaTransicionFeedbackPush) {
        const accion = solicitud.accion === 'apagado'
            ? 'apagar la climatización'
            : solicitud.accion === 'calefaccion' ? 'activar la calefacción' : 'activar el aire acondicionado';
        ultimaTransicionFeedbackPush = solicitud.transicion;
        void enviarNotificacionPush({
            title: 'euNICE necesita tu confirmación',
            body: `La temperatura es ${estadoActual.temperatura} °C. ¿Quieres ${accion}?`,
            url: '/?notificacion=feedback'
        });
    }
}

function publicarComando(comando, socket) {
    mqttClient.publish('euNICE/comando/sistema', JSON.stringify(comando), error => {
        if (error) {
            console.error('Error al publicar el comando MQTT:', error.message);
            socket.emit('error_comando', 'No se pudo enviar el comando al hardware.');
        }
    });
}

app.get('/api/exportar-excel', async (request, response, next) => {
    const { fecha } = request.query;
    const tiposGrafico = {
        line: { nombre: 'Líneas', archivo: 'lineas' },
        bar: { nombre: 'Barras', archivo: 'barras' },
        doughnut: { nombre: 'Circular', archivo: 'circular' }
    };
    const tipo = request.query.tipo || 'line';
    if (fecha !== undefined && !isValidDate(fecha)) {
        response.status(400).send('La fecha solicitada no es válida.');
        return;
    }
    if (!Object.prototype.hasOwnProperty.call(tiposGrafico, tipo)) {
        response.status(400).send('El tipo de gráfica solicitado no es válido.');
        return;
    }

    try {
        const registros = fecha ? registrosDeFecha(fecha) : historico;
        if (registros.length === 0) {
            response.status(404).send('No hay lecturas para la fecha seleccionada.');
            return;
        }

        const simulados = registros.every(record => record.simulado === true);
        const origen = simulados
            ? 'Datos ficticios de demostración'
            : registros.some(record => record.simulado === true)
                ? 'Datos reales y de demostración'
                : 'Datos registrados por el hardware';
        const temperaturas = registros.map(record => Number(record.temperatura)).filter(Number.isFinite);
        const humedades = registros.map(record => Number(record.humedad)).filter(Number.isFinite);
        const media = valores => valores.length
            ? valores.reduce((total, valor) => total + valor, 0) / valores.length
            : 0;

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'euNICE';
        workbook.created = new Date();
        const colorPrincipal = 'FF34473F';
        const colorAcento = 'FF739B83';
        const estiloTitulo = {
            font: { name: 'Aptos Display', bold: true, size: 18, color: { argb: 'FFFFFFFF' } },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: colorPrincipal } },
            alignment: { vertical: 'middle', horizontal: 'left' }
        };
        const estiloSubtitulo = {
            font: { name: 'Aptos', size: 10, color: { argb: 'FF4C5A53' } },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3EE' } },
            alignment: { vertical: 'middle', horizontal: 'left' }
        };

        const grafica = workbook.addWorksheet('Datos de gráfica', {
            views: [{ showGridLines: false, state: 'frozen', ySplit: 8 }]
        });
        const fechaTexto = fecha || 'Todo el histórico';
        grafica.mergeCells('A1:C1');
        grafica.getCell('A1').value = `euNICE | Gráfica de ${tiposGrafico[tipo].nombre.toLowerCase()}`;
        Object.assign(grafica.getCell('A1'), estiloTitulo);
        grafica.getRow(1).height = 34;

        grafica.mergeCells('A2:C2');
        grafica.getCell('A2').value = `Fecha: ${fechaTexto}   |   Gráfica: ${tiposGrafico[tipo].nombre}   |   Origen: ${origen}`;
        Object.assign(grafica.getCell('A2'), estiloSubtitulo);
        grafica.getRow(2).height = 23;

        grafica.getRow(4).values = ['Lecturas', 'Temp. media (°C)', 'Humedad media (%)'];
        grafica.getRow(5).values = [registros.length, media(temperaturas), media(humedades)];
        grafica.getRow(4).eachCell({ includeEmpty: true }, cell => {
            cell.font = { name: 'Aptos', bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colorAcento } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
        grafica.getRow(5).eachCell(cell => {
            cell.font = { name: 'Aptos', bold: true, size: 12, color: { argb: colorPrincipal } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F0' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
        grafica.getRow(5).getCell(2).numFmt = '0.0';
        grafica.getRow(5).getCell(3).numFmt = '0.0';
        const imagenGrafica = workbook.addImage({
            buffer: Buffer.from(crearSvgGrafica(registros, tipo)),
            extension: 'svg'
        });
        grafica.addImage(imagenGrafica, {
            tl: { col: 4, row: 3 },
            ext: { width: 760, height: 420 }
        });

        const datosGrafica = tipo === 'doughnut'
            ? [
                ['Frío (<25 °C)', temperaturas.filter(value => value < 25).length],
                ['Confort (25-28 °C)', temperaturas.filter(value => value >= 25 && value <= 28).length],
                ['Calor (>28 °C)', temperaturas.filter(value => value > 28).length]
            ]
            : registros.map(record => [record.hora, record.temperatura, record.humedad]);
        const columnasGrafica = tipo === 'doughnut'
            ? [{ name: 'Rango de temperatura' }, { name: 'Lecturas' }]
            : [
                { name: 'Hora' },
                { name: 'Temperatura (°C)' },
                { name: 'Humedad (%)' }
            ];
        grafica.addTable({
            name: 'DatosGrafica',
            ref: 'A8',
            headerRow: true,
            style: { theme: 'TableStyleMedium4', showRowStripes: true },
            columns: columnasGrafica,
            rows: datosGrafica
        });
        grafica.getRow(8).height = 25;
        grafica.getRow(8).eachCell(cell => {
            cell.font = { name: 'Aptos', bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colorAcento } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
        grafica.columns = [{ width: 28 }, { width: 22 }, { width: 22 }];
        if (tipo !== 'doughnut') {
            grafica.getColumn(2).numFmt = '0.0';
            grafica.getColumn(3).numFmt = '0.0';
        }

        const lecturas = workbook.addWorksheet('Lecturas', {
            views: [{ showGridLines: false, state: 'frozen', ySplit: 4 }]
        });
        lecturas.mergeCells('A1:G1');
        lecturas.getCell('A1').value = 'euNICE | Lecturas del periodo';
        Object.assign(lecturas.getCell('A1'), estiloTitulo);
        lecturas.getRow(1).height = 34;
        lecturas.mergeCells('A2:G2');
        lecturas.getCell('A2').value = `Fecha: ${fechaTexto}   |   Origen: ${origen}`;
        Object.assign(lecturas.getCell('A2'), estiloSubtitulo);
        lecturas.addTable({
            name: 'LecturasHistorico',
            ref: 'A4',
            headerRow: true,
            style: { theme: 'TableStyleMedium4', showRowStripes: true },
            columns: [
                { name: 'Fecha' },
                { name: 'Hora' },
                { name: 'Temperatura (°C)' },
                { name: 'Humedad (%)' },
                { name: 'Iluminación' },
                { name: 'Climatización' },
                { name: 'Origen' }
            ],
            rows: registros.map(record => [
                record.fecha,
                record.hora,
                record.temperatura,
                record.humedad,
                record.luz || '--',
                record.ventilador || 'apagado',
                record.simulado ? 'Demostración (ficticio)' : 'Hardware'
            ])
        });
        lecturas.getRow(4).height = 25;
        lecturas.getRow(4).eachCell(cell => {
            cell.font = { name: 'Aptos', bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colorAcento } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
        lecturas.columns = [
            { width: 14 },
            { width: 16 },
            { width: 22 },
            { width: 18 },
            { width: 24 },
            { width: 24 },
            { width: 28 }
        ];
        lecturas.getColumn(3).numFmt = '0.0';
        lecturas.getColumn(4).numFmt = '0.0';

        const buffer = await workbook.xlsx.writeBuffer();
        response
            .status(200)
            .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
            .attachment(`euNICE_${fecha || 'historico'}_${tiposGrafico[tipo].archivo}${simulados ? '_demostracion' : ''}.xlsx`)
            .send(Buffer.from(buffer));
    } catch (error) {
        next(error);
    }
});

app.use((error, request, response, next) => {
    console.error('Error al generar el Excel:', error);
    if (response.headersSent) {
        next(error);
        return;
    }
    response.status(500).send('No se pudo generar el archivo Excel.');
});

mqttClient.on('connect', () => {
    mqttConnected = true;
    emitirEstadoConexion();
    console.log('✅ Backend conectado al broker MQTT (broker.emqx.io)');
    mqttClient.subscribe([
        'euNICE/data/temperatura',
        'euNICE/data/humedad',
        'euNICE/data/luz',
        'euNICE/data/led',
        'euNICE/data/ventilador'
    ], error => {
        if (error) {
            console.error('Error al suscribirse a los topics MQTT:', error.message);
            return;
        }
        console.log('✅ Suscrito a los topics de datos euNICE');
        publicarConfiguracionHardware();
    });
});

mqttClient.on('reconnect', () => {
    mqttConnected = false;
    emitirEstadoConexion();
    console.log('Reconectando al broker MQTT...');
});

mqttClient.on('close', () => {
    mqttConnected = false;
    emitirEstadoConexion();
});

mqttClient.on('offline', () => {
    mqttConnected = false;
    emitirEstadoConexion();
});

mqttClient.on('error', error => {
    console.error('Error de conexión MQTT:', error.message);
    emitirEstadoConexion();
});

mqttClient.on('message', (topic, message) => {
    const msg = message.toString();
    const ahora = new Date();
    ultimoDatoHardware = ahora.toISOString();

    if (topic === 'euNICE/data/temperatura') {
        estadoActual.temperatura = parseFloat(msg);
    }
    if (topic === 'euNICE/data/humedad') {
        estadoActual.humedad = parseFloat(msg);
    }
    if (topic === 'euNICE/data/luz') {
        estadoActual.luz = msg;
    }
    if (topic === 'euNICE/data/ventilador') {
        estadoActual.ventilador = msg.replace(/^ventilador_/, '');
    }
    if (topic === 'euNICE/data/led') {
        if (msg === 'sistema_apagado') {
            estadoActual.sistema_encendido = false;
            estadoActual.ventilador = 'apagado';
            ultimaTransicionFeedbackPush = '';
            void enviarNotificacionPush({
                title: 'euNICE: sistema apagado',
                body: 'El sistema ambiental se ha apagado.',
                url: '/'
            });
        } else if (
            msg === 'sistema_encendido'
        ) {
            estadoActual.sistema_encendido = true;
            void enviarNotificacionPush({
                title: 'euNICE: sistema encendido',
                body: 'El sistema ambiental se ha encendido.',
                url: '/'
            });
        } else if (
            msg === 'frio_custom'
            || msg === 'calor_custom'
            || msg === 'neutro_custom'
        ) {
            estadoActual.sistema_encendido = true;
        }
    }

    if (estadoActual.sistema_encendido && topic === 'euNICE/data/temperatura') {
        persistirRegistro({
            fecha: localDateString(ahora),
            hora: ahora.toLocaleTimeString(),
            timestamp: ahora.toISOString(),
            temperatura: estadoActual.temperatura,
            humedad: estadoActual.humedad,
            luz: estadoActual.luz,
            ventilador: estadoActual.ventilador
        });
    }

    if (topic === 'euNICE/data/temperatura' || topic === 'euNICE/data/ventilador') {
        evaluarSolicitudFeedbackPush();
    }

    io.emit('datos_actualizados', estadoActual);
    emitirEstadoConexion();
});

io.use((socket, next) => {
    if (hasValidSession(socket.handshake.headers.cookie)) {
        next();
        return;
    }
    next(new Error('Autenticación requerida.'));
});

io.on('connection', socket => {
    const hoy = localDateString(new Date());
    socket.emit('historico_actualizado', { fecha: hoy, registros: registrosDeFecha(hoy) });
    socket.emit('dias_disponibles', fechasDisponibles());
    socket.emit('configuracion_actualizada', configuracion);
    socket.emit('datos_actualizados', estadoActual);
    emitirEstadoConexion(socket);

    socket.on('solicitar_historico_dia', fecha => {
        if (!isValidDate(fecha)) {
            socket.emit('error_persistencia', 'La fecha solicitada no es válida.');
            return;
        }
        socket.emit('historico_actualizado', { fecha, registros: registrosDeFecha(fecha) });
    });

    socket.on('enviar_comando', comandoJSON => {
        if (!comandoJSON || typeof comandoJSON !== 'object' || Array.isArray(comandoJSON)) {
            socket.emit('error_comando', 'El formato del comando no es válido.');
            return;
        }

        const nuevaConfiguracion = {
            modo: configuracion.modo,
            colores: { ...configuracion.colores }
        };

        try {
            if (comandoJSON.modo !== undefined) {
                nuevaConfiguracion.modo = comandoJSON.modo;
            }
            if (comandoJSON.config_led !== undefined) {
                const colores = comandoJSON.config_led;
                for (const colorName of ['frio', 'neutro', 'calor']) {
                    if (colores[colorName] !== undefined) {
                        nuevaConfiguracion.colores[colorName] = rgbToHex(colores[colorName]);
                    }
                }
            }
            if (comandoJSON.modo !== undefined || comandoJSON.config_led !== undefined) {
                persistirConfiguracion(nuevaConfiguracion);
            }
        } catch (error) {
            console.error('Configuración recibida no válida:', error.message);
            socket.emit('error_comando', error.message);
            return;
        }

        publicarComando(comandoJSON, socket);

        if (comandoJSON['acción'] === 'encender') {
            estadoActual.sistema_encendido = true;
            io.emit('datos_actualizados', estadoActual);
        } else if (comandoJSON['acción'] === 'apagar') {
            estadoActual.sistema_encendido = false;
            estadoActual.ventilador = 'apagado';
            io.emit('datos_actualizados', estadoActual);
        }
    });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
    console.log('✅ Servidor euNICE activado correctamente.');
    if (PORT === 3000) {
        console.log('🌐 URL de acceso (Tailscale Funnel): https://eunice.taild05234.ts.net/');
    } else {
        console.log('⚠️ Tailscale Funnel requiere PORT=3000 para publicar esta web.');
    }
});

server.on('error', (error) => {
    if (error.code !== 'EADDRINUSE') {
        console.error(`No se pudo iniciar el servidor en el puerto ${PORT}:`, error);
        mqttClient.end(true);
        process.exitCode = 1;
        return;
    }

    const request = http.get({
        hostname: '127.0.0.1',
        port: PORT,
        path: '/',
        timeout: 2000
    }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
            body += chunk;
        });
        response.on('end', () => {
            mqttClient.end(true);
            if (response.statusCode === 200 && body.includes('<title>euNICE')) {
                console.log('✅ Servidor euNICE ya está activado.');
                if (PORT === 3000) {
                    console.log('🌐 URL de acceso (Tailscale Funnel): https://eunice.taild05234.ts.net/');
                } else {
                    console.log(`ℹ️ euNICE está activo en el puerto ${PORT}; Tailscale Funnel requiere PORT=3000.`);
                }
                return;
            }

            console.error(`El puerto ${PORT} está ocupado por otro servicio. Cierra ese servicio o inicia euNICE con PORT=3001.`);
            process.exitCode = 1;
        });
    });

    request.on('timeout', () => request.destroy());
    request.on('error', () => {
        mqttClient.end(true);
        console.error(`El puerto ${PORT} está ocupado. Cierra el proceso que lo usa o inicia euNICE con PORT=3001.`);
        process.exitCode = 1;
    });
});
