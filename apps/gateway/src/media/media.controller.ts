import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import * as crypto from 'crypto';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { BLOB, BlobPort } from '../ports/ports';

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'audio/webm': 'weba', 'audio/mpeg': 'mp3', 'video/webm': 'webm', 'video/mp4': 'mp4',
  'application/pdf': 'pdf', 'application/octet-stream': 'bin',
};
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));

@Controller('media')
export class MediaController {
  constructor(@Inject(BLOB) private blob: BlobPort) {}

  /**
   * Presign flow — identical client choreography for disk and S3 adapters:
   * presign → PUT bytes to uploadUrl → put publicUrl in the chat message.
   * The key embeds 16 random bytes: unguessable URL, and the client can't
   * choose keys (no overwriting others' media).
   */
  @Post('presign')
  @UseGuards(AuthGuard)
  async presign(@Req() req: any, @Body() body: { mime: string; size: number }) {
    const mime = body?.mime ?? '';
    if (!(mime in EXT)) throw new BadRequestException(`Unsupported type ${mime}`);
    if ((body?.size ?? 0) > 50 * 1024 * 1024) throw new BadRequestException('Max 50 MB');
    const key = `${req.auth.userId}-${crypto.randomBytes(16).toString('hex')}.${EXT[mime]}`;
    const { uploadUrl, headers } = await this.blob.presignPut(key, mime);
    return { key, uploadUrl, headers, publicUrl: this.blob.publicUrl(key) };
  }

  /** Disk-adapter upload target (S3 mode: client PUTs to MinIO directly and
   *  never hits this route). Raw body configured in main.ts. */
  @Put('blob/:key')
  async upload(@Param('key') key: string, @Req() req: any) {
    if (!this.blob.saveLocal) throw new NotFoundException(); // external mode: route disabled
    if (!/^[\w.-]+$/.test(key)) throw new BadRequestException('bad key');
    const body: Buffer = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequestException('empty body');
    await this.blob.saveLocal(key, body);
    return { ok: true, publicUrl: this.blob.publicUrl(key) };
  }

  @Get('blob/:key')
  async serve(@Param('key') key: string, @Res() res: Response) {
    if (!this.blob.readLocal) throw new NotFoundException();
    if (!/^[\w.-]+$/.test(key)) throw new BadRequestException('bad key');
    const buf = await this.blob.readLocal(key);
    if (!buf) throw new NotFoundException();
    const ext = key.split('.').pop() ?? 'bin';
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // keys are content-unique
    res.send(buf);
  }
}
