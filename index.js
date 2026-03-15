import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import os from 'os';
import pino from 'pino';
import QRCode from 'qrcode';
import { pipeline } from 'stream/promises';
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 8080);
const API_KEY = (process.env.WA_SERVICE_KEY || '').trim();
const AUTH_DIR = process.env.WA_AUTH_DIR || path.join(os.tmpdir(), 'wa_auth_info');

// S3 config (optional; if WA_S3_BUCKET set we'll use S3)
const WA_S3_BUCKET = process.env.WA_S3_BUCKET || '';
const WA_S3_PREFIX = (process.env.WA_S3_PREFIX || '').replace(/^\//, '').replace(/\/$/, '');
const WA_S3_ENDPOINT = process.env.WA_S3_ENDPOINT || '';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

let s3Client = null;
if (WA_S3_BUCKET) {
  const s3Options = { region: AWS_REGION };
  if (WA_S3_ENDPOINT) s3Options.endpoint = WA_S3_ENDPOINT;
  s3Client = new S3Client(s3Options);
}

// Supabase Storage config (optional)
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const WA_SUPABASE_BUCKET = process.env.WA_SUPABASE_BUCKET || '';
let supabase = null;
if (WA_SUPABASE_BUCKET && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

const state = {
  socket: null,
  qr: null,
  connected: false,
  initializing: false,
  lastError: null,
  lastUpdateAt: null,
};

function normalizePhone(phone) {
  let jid = String(phone || '').replace(/\D/g, '');
  if (jid.startsWith('0')) jid = `62${jid.slice(1)}`;
  if (!jid.endsWith('@s.whatsapp.net')) jid = `${jid}@s.whatsapp.net`;
  return jid;
}

function authMiddleware(req, res, next) {
  if (!API_KEY) return next();

  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice('Bearer '.length).trim()
    : '';
  const headerKey = (req.headers['x-wa-key'] || '').toString().trim();

  if (bearer === API_KEY || headerKey === API_KEY) {
    return next();
  }

  return res.status(401).json({ success: false, error: 'Unauthorized' });
}

// S3 helper functions
async function listS3Objects(prefix) {
  const listCmd = new ListObjectsV2Command({
    Bucket: WA_S3_BUCKET,
    Prefix: prefix,
  });
  const out = await s3Client.send(listCmd);
  return out.Contents || [];
}

async function downloadAuthFromS3() {
  if (!s3Client) return;
  try {
    const prefix = WA_S3_PREFIX ? `${WA_S3_PREFIX}/` : '';
    const objects = await listS3Objects(prefix);
    for (const obj of objects) {
      if (!obj.Key) continue;
      const rel = obj.Key.replace(prefix, '');
      if (!rel) continue;
      const localPath = path.join(AUTH_DIR, rel);
      const dir = path.dirname(localPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const getCmd = new GetObjectCommand({ Bucket: WA_S3_BUCKET, Key: obj.Key });
      const resp = await s3Client.send(getCmd);
      const body = resp.Body;
      if (!body) continue;
      const writeStream = fs.createWriteStream(localPath);
      await pipeline(body, writeStream);
    }
    console.log('[wa-service] downloaded auth files from S3');
  } catch (err) {
    console.error('[wa-service] failed to download auth from S3', String(err));
  }
}

async function uploadAuthToS3() {
  if (!s3Client) return;
  try {
    const walk = (dir) => {
      const files = [];
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) files.push(...walk(full));
        else files.push(full);
      }
      return files;
    };
    const files = fs.existsSync(AUTH_DIR) ? walk(AUTH_DIR) : [];
    const prefix = WA_S3_PREFIX ? `${WA_S3_PREFIX}/` : '';
    for (const f of files) {
      const key = prefix + path.relative(AUTH_DIR, f).replace(/\\/g, '/');
      const putCmd = new PutObjectCommand({
        Bucket: WA_S3_BUCKET,
        Key: key,
        Body: fs.createReadStream(f),
      });
      await s3Client.send(putCmd);
    }
    console.log('[wa-service] uploaded auth files to S3');
  } catch (err) {
    console.error('[wa-service] failed to upload auth to S3', String(err));
  }
}

// Supabase helpers
async function listSupabaseObjects(prefix) {
  if (!supabase) return [];
  try {
    const opts = { limit: 1000 };
    const { data, error } = await supabase.storage.from(WA_SUPABASE_BUCKET).list(prefix || '', opts);
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('[wa-service] listSupabaseObjects error', String(err));
    return [];
  }
}

async function downloadAuthFromSupabase() {
  if (!supabase) return;
  try {
    const prefix = WA_S3_PREFIX || '';
    const objects = await listSupabaseObjects(prefix);
    for (const obj of objects) {
      if (!obj.name) continue;
      const rel = obj.name;
      const localPath = path.join(AUTH_DIR, rel);
      const dir = path.dirname(localPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const { data, error } = await supabase.storage.from(WA_SUPABASE_BUCKET).download(obj.name);
      if (error || !data) continue;
      let buffer;
      if (typeof data.arrayBuffer === 'function') {
        const ab = await data.arrayBuffer();
        buffer = Buffer.from(ab);
      } else if (data instanceof Buffer) {
        buffer = data;
      } else {
        const chunks = [];
        for await (const chunk of data) chunks.push(Buffer.from(chunk));
        buffer = Buffer.concat(chunks);
      }
      fs.writeFileSync(localPath, buffer);
    }
    console.log('[wa-service] downloaded auth files from Supabase');
  } catch (err) {
    console.error('[wa-service] failed to download auth from Supabase', String(err));
  }
}

async function uploadAuthToSupabase() {
  if (!supabase) return;
  try {
    const walk = (dir) => {
      const files = [];
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) files.push(...walk(full));
        else files.push(full);
      }
      return files;
    };
    const files = fs.existsSync(AUTH_DIR) ? walk(AUTH_DIR) : [];
    const prefix = WA_S3_PREFIX ? `${WA_S3_PREFIX}/` : '';
    for (const f of files) {
      const key = path.relative(AUTH_DIR, f).replace(/\\/g, '/');
      const dest = prefix + key;
      const stream = fs.createReadStream(f);
      const { error } = await supabase.storage.from(WA_SUPABASE_BUCKET).upload(dest, stream, { upsert: true });
      if (error) console.error('[wa-service] upload error', dest, String(error));
    }
    console.log('[wa-service] uploaded auth files to Supabase');
  } catch (err) {
    console.error('[wa-service] failed to upload auth to Supabase', String(err));
  }
}

async function initializeWA(force = false) {
  if (state.initializing) return;
  if (state.socket && !force) return;

  state.initializing = true;
  state.lastError = null;

  try {
    if (supabase) {
      await downloadAuthFromSupabase();
    } else if (s3Client) {
      await downloadAuthFromS3();
    }

    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: authState,
      browser: ['Cinikimi WA Service', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
    });

    state.socket = sock;

    sock.ev.on('creds.update', async (creds) => {
      try {
        try { saveCreds(creds); } catch (e) { }
        if (supabase) {
          await uploadAuthToSupabase();
        } else if (s3Client) {
          await uploadAuthToS3();
        }
      } catch (err) {
        console.error('[wa-service] creds.update handler error', String(err));
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      state.lastUpdateAt = new Date().toISOString();

      if (qr) {
        state.qr = qr;
        state.connected = false;
      }

      if (connection === 'open') {
        state.connected = true;
        state.qr = null;
        state.lastError = null;
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        state.connected = false;
        state.socket = null;
        state.lastError = lastDisconnect?.error?.message || 'Connection closed';

        if (loggedOut) {
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          } catch (err) {
            state.lastError = `Logged out and failed resetting auth dir: ${String(err)}`;
          }
        }

        setTimeout(() => {
          initializeWA(true).catch((err) => {
            state.lastError = String(err);
          });
        }, 3000);
      }
    });
  } catch (err) {
    state.lastError = String(err);
    console.error('[wa-service] initializeWA error', state.lastError);
  } finally {
    state.initializing = false;
  }
}

app.get('/health', (_req, res) => {
  res.json({
    success: true,
    service: 'cinikimi-wa-service',
    connected: state.connected,
    initializing: state.initializing,
    lastError: state.lastError,
    lastUpdateAt: state.lastUpdateAt,
  });
});

app.get('/wa/status', authMiddleware, async (_req, res) => {
  try {
    if (!state.socket && !state.initializing) {
      await initializeWA();
    }

    if (state.connected && state.socket?.user) {
      return res.json({ status: 'connected', qr: null, user: state.socket.user });
    }

    if (state.qr) {
      const qrImage = await QRCode.toDataURL(state.qr);
      return res.json({ status: 'scan_qr', qr: qrImage });
    }

    return res.json({ status: state.initializing ? 'loading' : 'disconnected', qr: null });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: String(err) });
  }
});

app.post('/wa/send', authMiddleware, async (req, res) => {
  try {
    const { phone, text } = req.body || {};

    if (!phone || !text) {
      return res.status(400).json({ success: false, error: 'phone and text are required' });
    }

    if (!state.socket || !state.connected) {
      return res.status(503).json({ success: false, error: 'WhatsApp is not connected yet' });
    }

    const jid = normalizePhone(phone);
    await state.socket.sendMessage(jid, { text: String(text) });

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/wa/restart', authMiddleware, async (_req, res) => {
  try {
    state.socket = null;
    state.connected = false;
    state.qr = null;
    await initializeWA(true);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
});

app.listen(PORT, async () => {
  console.log(`WA service listening on port ${PORT}`);
  await initializeWA();
});
