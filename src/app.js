import { createBackend } from './services/backend.js';
import { attachPageRoutes } from './routes/pages.js';

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
