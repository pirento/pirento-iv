/**
 * Builds the complete web application: JSON API + server-rendered EJS pages.
 *
 * createBackend() (src/services/backend.js) wires the database, services and /api routes;
 * attachPageRoutes() adds the EJS pages and static assets on top of it.
 * Used by server.js and the hosting entry script.
 */

import { createBackend } from './services/backend.js';
import { attachPageRoutes } from './routes/pages.js';

/**
 * Creates and initializes the app. Returns the backend object ({ app, close, ... }).
 * If initialization fails, every opened resource is closed before the error is rethrown.
 */
export async function createApplication(options = {}) {
  const backend = await createBackend(options);
  attachPageRoutes(backend);
  try {
    await backend.initialize();
  } catch (error) {
    await backend.close();
    throw error;
  }
  return backend;
}
