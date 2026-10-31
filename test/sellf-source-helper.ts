import { handleSourceHook } from '../src/sources';
import type { Env, SendDeps } from '../src/types';
export const handleSellfHook = (request: Request, env: Env, deps: SendDeps) => handleSourceHook(request, env, deps, 'sellf');
