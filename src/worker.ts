import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./index";
import type { Env } from "./types";

export default app;
/** Profile (a): target of the panel Worker's service binding. It has no route; the panel token and assertion v2 still apply (R7). */
export class Internal extends WorkerEntrypoint<Env> {
  fetch(req: Request): Promise<Response> { return app.internal(req, this.env, this.ctx); }
}
