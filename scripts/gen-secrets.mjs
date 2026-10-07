// Fills the secrets WE generate (not the ones a provider gives you) straight into .env,
// without printing them. Existing values are left alone. npm run secrets
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const OURS = ['CALENDLY_WEBHOOK_SIGNING_KEY', 'DASHBOARD_PASSCODE', 'CHECK_LEAD_SECRET'];
const file = new URL('../.env', import.meta.url);
let env = existsSync(file) ? readFileSync(file, 'utf8') : readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
for (const name of OURS) {
  const value = randomBytes(name === 'DASHBOARD_PASSCODE' ? 9 : 32).toString(name === 'DASHBOARD_PASSCODE' ? 'base64url' : 'hex');
  const re = new RegExp(`^${name}=\\s*$`, 'm');
  if (re.test(env)) env = env.replace(re, `${name}=${value}`);
  else if (!new RegExp(`^${name}=`, 'm').test(env)) env += `\n${name}=${value}\n`;
  else continue;
  console.log(`${name}: generated`);
}
writeFileSync(file, env);
console.log('.env updated (values not shown). Open .env to read the dashboard passcode.');
