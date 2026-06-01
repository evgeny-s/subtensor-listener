import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Guards the test/replay endpoint with a shared secret. The endpoint is
 * disabled (403) unless `TEST_API_SECRET` is set, so it can never be hit in a
 * deploy that didn't opt into it. The secret is passed via the
 * `x-api-secret` header and compared in constant time.
 */
@Injectable()
export class TestSecretGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('TEST_API_SECRET');
    if (!expected || expected.trim() === '') {
      throw new ForbiddenException('Test endpoint is disabled.');
    }
    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.headers['x-api-secret'];
    const candidate = Array.isArray(provided) ? provided[0] : provided;
    if (!candidate || !safeEqual(candidate, expected)) {
      throw new ForbiddenException('Invalid or missing API secret.');
    }
    return true;
  }
}

/** Constant-time comparison that doesn't short-circuit on length. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const len = Math.max(ab.length, bb.length);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ab.copy(pa);
  bb.copy(pb);
  return timingSafeEqual(pa, pb) && ab.length === bb.length;
}
