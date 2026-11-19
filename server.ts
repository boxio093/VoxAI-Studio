import express from 'express';
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { createServer as createViteServer } from 'vite';
import { createProxyMiddleware } from 'http-proxy-middleware';

const PORT = Number(process.env.PORT || 3000);
const FASTAPI_HOST = process.env.VOXAI_BACKEND_HOST || '127.0.0.1';
const FASTAPI_PORT = Number(process.env.VOXAI_BACKEND_PORT || 8001);
const FASTAPI_URL = `http://${FASTAPI_HOST}:${FASTAPI_PORT}`;

let pythonProcess: ChildProcess | null = null;
let isShuttingDown = false;

function resolvePythonBinary(): string {
  const venvPython = path.join(process.cwd(), '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return process.env.PYTHON_BIN || 'python3';
}

function startFastAPIBackend(): void {
  if (isShuttingDown) return;

  const pythonBin = resolvePythonBinary();
  console.log(`[VoxAI] Starting FastAPI speech backend (${pythonBin}) on ${FASTAPI_URL}...`);

  pythonProcess = spawn(
    pythonBin,
    [
      '-m',
      'uvicorn',
      'backend.main:app',
      '--host',
      FASTAPI_HOST,
      '--port',
      String(FASTAPI_PORT),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONPATH: process.cwd(),
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  pythonProcess.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[FastAPI] ${chunk.toString()}`);
  });

  pythonProcess.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[FastAPI] ${chunk.toString()}`);
  });

  pythonProcess.on('exit', (code, signal) => {
    console.warn(`[VoxAI] FastAPI process exited (code=${code}, signal=${signal}).`);
    pythonProcess = null;
    if (!isShuttingDown) {
      setTimeout(() => startFastAPIBackend(), 2000);
    }
  });
}

async function waitForFastAPIReady(timeoutMs = 20000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${FASTAPI_URL}/api/health`);
      if (res.ok) {
        return true;
      }
    } catch {
      // Backend still warming up
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function shutdown(): void {
  isShuttingDown = true;
  if (pythonProcess) {
    pythonProcess.kill('SIGTERM');
    pythonProcess = null;
  }
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});

async function startServer() {
  const app = express();

  // Proxy all /api and /ws traffic (including multipart uploads & WebSockets) to Python FastAPI
  const backendProxy = createProxyMiddleware({
    target: FASTAPI_URL,
    changeOrigin: true,
    ws: true,
    pathFilter: ['/api', '/ws'],
    on: {
      error: (err, _req, res: any) => {
        if (res && typeof res.writeHead === 'function' && !res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              detail: 'FastAPI speech processing service is temporarily unavailable.',
              error: err.message,
            }),
          );
        }
      },
    },
  });

  app.use(backendProxy);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[VoxAI] Server running on http://localhost:${PORT}`);
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/api/ws') || req.url?.startsWith('/ws')) {
      (backendProxy as any).upgrade(req, socket, head);
    }
  });

  startFastAPIBackend();
  waitForFastAPIReady(20000).then((ready) => {
    if (ready) {
      console.log(`[VoxAI] FastAPI speech backend is healthy at ${FASTAPI_URL}.`);
    } else {
      console.warn(`[VoxAI] FastAPI did not respond within 20s; continuing while backend initializes.`);
    }
  });
}

startServer();
