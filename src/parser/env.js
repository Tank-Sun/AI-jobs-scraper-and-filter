import dotenv from 'dotenv';
import path from 'node:path';

export function loadEnv(projectRoot) {
  dotenv.config({ path: path.join(projectRoot, '.env') });
}
