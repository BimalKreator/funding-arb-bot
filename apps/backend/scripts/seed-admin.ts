/**
 * Seed script: force-create/update admin so login works.
 * Run from apps/backend: npm run seed
 *
 * Force-creates admin jai@tradeictearner.online with password Admin123!
 * (or SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD from .env).
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const email = process.env.SEED_ADMIN_EMAIL ?? 'jai@tradeictearner.online';
const password = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';

async function main() {
  const { forceCreateOrUpdateAdmin } = await import('../src/services/auth.service.js');
  const user = await forceCreateOrUpdateAdmin(email, password);
  console.log(`Seed OK: admin forced: ${user.email} (id: ${user.id}). Login with this email and password "${password}".`);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
