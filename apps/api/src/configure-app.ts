import type { NestExpressApplication } from '@nestjs/platform-express';

/** The largest JSON body the API reads: well above any valid outbox. */
export const BODY_LIMIT = '10mb';

/**
 * Settings shared by the real server and the tests, so the tests run the real
 * configuration. Nest's default JSON limit is 100 KB, which would answer 413
 * to a valid list and leave the whole outbox stuck behind it.
 */
export function configureApp(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: BODY_LIMIT });
}
