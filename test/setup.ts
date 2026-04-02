/**
 * Test setup — loads .env.test before any test module runs.
 *
 * This file is preloaded via --require in the npm test script.
 * It ensures all tests use safe dummy credentials instead of real ones.
 */

import dotenv from 'dotenv';
import path from 'node:path';
import { getDirname } from '../src/utils/paths.js';

const __dirname = getDirname(import.meta.url);
const envTestPath = path.join(__dirname, '..', '.env.test');

// Load .env.test — override=true ensures test values take precedence
// even if a real .env was already loaded
dotenv.config({ path: envTestPath, override: true });
