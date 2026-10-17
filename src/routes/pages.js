/**
 * Page routes: the server-rendered EJS screens and the static browser assets.
 *
 * Serves /css, /js, /fonts (from public/), /shared (modules shared by server and browser),
 * /vendor (the pdfmake browser build) and the favicon, then the login and /workspace pages.
 * Page logic itself lives in src/controllers/pages/workspace-controller.js.
 */

import express from 'express';
import ejs from 'ejs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPageController } from '../controllers/pages/workspace-controller.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Templates are trusted source files. Request data never supplies EJS options. */
export function attachPageRoutes(backend) {
  const { app } = backend;
  app.engine('ejs', ejs.renderFile);
  app.set('view engine', 'ejs');
  app.set('views', resolve(root, 'views'));
  for (const folder of ['css', 'js', 'fonts'])
    app.use(
      `/${folder}`,
      express.static(resolve(root, 'public', folder), { dotfiles: 'deny', index: false, fallthrough: true }),
    );
  const favicon = resolve(root, 'public', 'favicon.svg');
  // Browsers also request /favicon.ico directly, regardless of the <link rel="icon"> tag.
  app.get(['/favicon.svg', '/favicon.ico'], (_req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('image/svg+xml').sendFile(favicon);
  });
  app.use('/shared', express.static(resolve(root, 'shared'), { dotfiles: 'deny', index: false }));
  app.use(
    '/vendor',
    express.static(resolve(root, 'node_modules/pdfmake/build'), { dotfiles: 'deny', index: false }),
  );
  const controller = createPageController(backend);
  app.get('/', controller.home);
  app.get(['/login', '/signup', '/forgot-password', '/reset-password'], controller.authentication);
  app.get('/workspace/{*path}', controller.workspace);
  app.use(controller.notFound);
  app.use(controller.error);
}
