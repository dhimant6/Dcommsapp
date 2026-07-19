import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from './app.module';
import { config } from './config';
import { WsService } from './ws/ws.service';

/**
 * One process, both pipes' control plane:
 *   REST  /api/*  + /media/*        (auth, sync, presign)
 *   WS    /ws?token=<jwt>           (chat, presence, signaling, rooms)
 *   Static  /                       (the built web client, staging mode)
 *
 * Serving the SPA from the gateway keeps staging single-origin: no CORS, and
 * ws:// shares the host. Production would put a CDN in front of the static
 * part; the API surface is unchanged.
 */
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] });

  app.use(express.json({ limit: '1mb' }));
  // Raw body ONLY for the disk-adapter upload target (media bytes).
  app.use('/media/blob', express.raw({ type: '*/*', limit: '52mb' }));
  app.enableCors(); // dev convenience (vite on :5173 → gateway :3000); staging is same-origin anyway

  // Web client build, if present (staging mode). Search upward so the path
  // works from src (tsx dev), dist (compiled), and any cwd.
  let staticDir: string | undefined;
  for (let dir = __dirname, i = 0; i < 8; i++, dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'apps', 'web', 'dist');
    if (fs.existsSync(path.join(candidate, 'index.html'))) {
      staticDir = candidate;
      break;
    }
  }
  if (staticDir) {
    app.useStaticAssets(staticDir);
    // SPA fallback: client-side routes (/chat, /room) must serve index.html.
    app.use((req: any, res: any, next: any) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/media') && !req.path.startsWith('/ws') && !path.extname(req.path)) {
        res.sendFile(path.join(staticDir, 'index.html'));
      } else next();
    });
  }

  return app;
}

async function bootstrap() {
  const app = await createApp();
  await app.listen(config.port);
  // WS attaches AFTER listen: it hooks the raw HTTP 'upgrade' event, so it
  // needs the actual server object Nest created.
  app.get(WsService).attach(app.getHttpServer());
  // eslint-disable-next-line no-console
  console.log(`Dcom gateway: http://localhost:${config.port}  (adapters: ${config.adapters})`);
}

if (require.main === module) void bootstrap();
