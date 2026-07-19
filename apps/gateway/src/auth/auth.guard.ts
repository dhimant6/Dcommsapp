import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { TokensService } from './tokens.service';

/**
 * REST auth guard. Attaches { userId, deviceId, name } to the request.
 * Stateless: pure JWT verify, no DB — a revoked user keeps access for at most
 * one access-token lifetime (15 min). That's the deliberate trade-off of
 * stateless auth; instant revocation would need a Redis denylist check here.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private tokens: TokensService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const claims = token ? this.tokens.verifyAccess(token) : null;
    if (!claims) throw new UnauthorizedException();
    req.auth = { userId: claims.sub, deviceId: claims.dev, name: claims.name };
    return true;
  }
}
