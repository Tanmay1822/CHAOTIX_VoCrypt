import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { execFile, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// Absolute paths to built binaries (macOS build done earlier)
const BIN_DIR = path.resolve('/Users/tanmayjain/Desktop/final/ggwave/build-macos/bin');
const TO_FILE = path.join(BIN_DIR, 'ggwave-to-file');
const FROM_FILE = path.join(BIN_DIR, 'ggwave-from-file');
const CLI_BIN = path.join(BIN_DIR, 'ggwave-cli');

function ensureBinaryExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, toFile: ensureBinaryExists(TO_FILE), fromFile: ensureBinaryExists(FROM_FILE), cli: ensureBinaryExists(CLI_BIN) });
});

// Encode a text into WAV. Body: { message, volume?, sampleRate?, protocol? }
app.post('/encode', async (req, res) => {
  const message = `${req.body?.message ?? ''}`;
  if (!message) return res.status(400).json({ error: 'message is required' });

  if (!ensureBinaryExists(TO_FILE)) {
    return res.status(500).json({ error: 'ggwave-to-file binary not found. Build it first.' });
  }

  // If message is longer than 140 characters, split it into chunks
  const MAX_CHUNK_SIZE = 140;
  if (message.length > MAX_CHUNK_SIZE) {
    return res.status(400).json({ 
      error: `Message too long (${message.length} chars). Maximum supported length is ${MAX_CHUNK_SIZE} characters.`,
      maxLength: MAX_CHUNK_SIZE,
      currentLength: message.length
    });
  }

  // Create temp wav path
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggwave-'));
  const wavPath = path.join(tmpDir, 'out.wav');

  const args = [`-f${wavPath}`];
  if (req.body?.volume) args.push(`-v${req.body.volume}`);
  if (req.body?.sampleRate) args.push(`-s${req.body.sampleRate}`);
  if (req.body?.protocol) args.push(`-p${req.body.protocol}`);

  const child = spawn(TO_FILE, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let responded = false;
  const safe = (fn) => { if (!responded) { responded = true; fn(); } };
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.on('error', err => {
    safe(() => res.status(500).json({ error: err.message }));
    try { child.kill('SIGKILL'); } catch {}
  });
  child.on('close', code => {
    if (responded) return;
    if (code !== 0) {
      return safe(() => res.status(500).json({ error: 'encode failed', details: stderr }));
    }
    try {
      const data = fs.readFileSync(wavPath);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Disposition', 'inline; filename="message.wav"');
      safe(() => res.send(data));
    } catch (e) {
      safe(() => res.status(500).json({ error: 'read wav failed', details: e.message }));
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
  child.stdin.end(message);
});

// Encode a long text into WAV by splitting into chunks. Body: { message, volume?, sampleRate?, protocol? }
app.post('/encode-long', async (req, res) => {
  const message = `${req.body?.message ?? ''}`;
  if (!message) return res.status(400).json({ error: 'message is required' });

  if (!ensureBinaryExists(TO_FILE)) {
    return res.status(500).json({ error: 'ggwave-to-file binary not found. Build it first.' });
  }

  const MAX_CHUNK_SIZE = 140;
  const chunks = [];
  
  // Split message into chunks
  for (let i = 0; i < message.length; i += MAX_CHUNK_SIZE) {
    chunks.push(message.slice(i, i + MAX_CHUNK_SIZE));
  }

  if (chunks.length === 1) {
    // If only one chunk, use regular encode endpoint
    return res.redirect(307, '/encode');
  }

  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggwave-'));
    const outputWavPath = path.join(tmpDir, 'output.wav');
    const tempWavPaths = [];

    // Encode each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunkWavPath = path.join(tmpDir, `chunk_${i}.wav`);
      tempWavPaths.push(chunkWavPath);

      const args = [`-f${chunkWavPath}`];
      if (req.body?.volume) args.push(`-v${req.body.volume}`);
      if (req.body?.sampleRate) args.push(`-s${req.body.sampleRate}`);
      if (req.body?.protocol) args.push(`-p${req.body.protocol}`);

      await new Promise((resolve, reject) => {
        const child = spawn(TO_FILE, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('error', err => reject(err));
        child.on('close', code => {
          if (code !== 0) {
            reject(new Error(`Chunk ${i} encode failed: ${stderr}`));
          } else {
            resolve();
          }
        });
        child.stdin.end(chunks[i]);
      });
    }

    // Concatenate all WAV files using ffmpeg
    const ffmpeg = spawn('ffmpeg', [
      '-y', '-v', 'error',
      ...tempWavPaths.flatMap(path => ['-i', path]),
      '-filter_complex', `concat=n=${chunks.length}:v=0:a=1[out]`,
      '-map', '[out]',
      outputWavPath
    ]);

    await new Promise((resolve, reject) => {
      let stderr = '';
      ffmpeg.stderr.on('data', d => { stderr += d.toString(); });
      ffmpeg.on('error', err => reject(err));
      ffmpeg.on('close', code => {
        if (code !== 0) {
          reject(new Error(`FFmpeg concatenation failed: ${stderr}`));
        } else {
          resolve();
        }
      });
    });

    // Read the concatenated WAV file
    const data = fs.readFileSync(outputWavPath);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', 'inline; filename="message.wav"');
    res.send(data);

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  } catch (error) {
    res.status(500).json({ error: 'Long message encoding failed', details: error.message });
  }
});

// Decode a provided WAV file (multipart form field: file)
app.post('/decode', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required (audio/wav)' });

  if (!ensureBinaryExists(FROM_FILE)) {
    return res.status(500).json({ error: 'ggwave-from-file binary not found. Build it first.' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggwave-'));
  const wavPath = path.join(tmpDir, 'in.wav');
  fs.writeFileSync(wavPath, req.file.buffer);

  let responded = false; const safe = (fn) => { if (!responded) { responded = true; fn(); } };
  execFile(FROM_FILE, [wavPath], (error, stdout, stderr) => {
    try {
      if (error) return safe(() => res.status(500).json({ error: error.message, stderr }));
      const m = stdout.match(/Decoded message[^:]*:\s*'([^']*)'/);
      const message = m ? m[1] : '';
      safe(() => res.json({ message, raw: stdout }));
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});

// Decode a WEBM/Opus mic chunk: convert to WAV with ffmpeg, then decode
app.post('/decode-webm', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required (audio/webm)' });
  if (!ensureBinaryExists(FROM_FILE)) {
    return res.status(500).json({ error: 'ggwave-from-file binary not found. Build it first.' });
  }

  const ffmpeg = 'ffmpeg';
  // quick existence check
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggwave-'));
  const webmPath = path.join(tmpDir, 'in.webm');
  const wavPath = path.join(tmpDir, 'in.wav');
  fs.writeFileSync(webmPath, req.file.buffer);

  const ff = spawn(ffmpeg, ['-y', '-v', 'error', '-i', webmPath, '-ar', '48000', '-ac', '1', '-f', 'wav', wavPath]);
  let ffErr = '';
  let responded = false; const safe = (fn) => { if (!responded) { responded = true; fn(); } };
  ff.stderr.on('data', d => { ffErr += d.toString(); });
  ff.on('error', err => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    safe(() => res.status(500).json({ error: 'ffmpeg not found or failed', details: err.message }));
  });
  ff.on('close', code => {
    if (code !== 0) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return safe(() => res.status(500).json({ error: 'ffmpeg failed', details: ffErr }));
    }
    execFile(FROM_FILE, [wavPath], (error, stdout, stderr) => {
      try {
        if (error) return safe(() => res.status(200).json({ message: '', raw: stdout }));
        const m = stdout.match(/Decoded message[^:]*:\s*'([^']*)'/);
        const message = m ? m[1] : '';
        safe(() => res.json({ message, raw: stdout }));
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    });
  });
});

const PORT = process.env.PORT || 5055;
const server = app.listen(PORT, () => {
  console.log(`ggwave api listening on http://localhost:${PORT}`);
});

// WebSocket: spawn ggwave-cli per connection
const wss = new WebSocketServer({ server, path: '/ws/cli' });
wss.on('connection', (ws) => {
  if (!ensureBinaryExists(CLI_BIN)) {
    ws.close(1011, 'ggwave-cli not available');
    return;
  }
  // default to protocol 1 (Fast)
  const cli = spawn(CLI_BIN, ['-t1']);

  const sendLine = (line) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(line));

  cli.stdout.on('data', (d) => {
    const s = d.toString();
    sendLine({ type: 'stdout', data: s });
    // Parse decoded messages from cli output if present
    const m = s.match(/Decoded message[^:]*:\s*'([^']*)'/);
    if (m) sendLine({ type: 'decoded', message: m[1] });
  });
  cli.stderr.on('data', (d) => sendLine({ type: 'stderr', data: d.toString() }));
  cli.on('close', (code) => ws.close(1000, `cli_exit_${code}`));

  ws.on('message', (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.type === 'send' && typeof msg.text === 'string') {
        cli.stdin.write(msg.text + '\n');
      }
    } catch {}
  });
  ws.on('close', () => {
    try { cli.kill('SIGKILL'); } catch {}
  });
});

