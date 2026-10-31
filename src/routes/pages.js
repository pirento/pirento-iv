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
  // Lets phones add the workspace to the home screen and open it like an app.
  app.get('/manifest.webmanifest', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('application/manifest+json').send(
      JSON.stringify({
        name: 'Business Workspace',
        short_name: 'Billing',
        start_url: '/',
        display: 'standalone',
        background_color: '#fbf1e9',
        theme_color: '#0e4d64',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      }),
    );
  });
  app.use('/shared', express.static(resolve(root, 'shared'), { dotfiles: 'deny', index: false }));
  app.use(
    '/vendor',
    express.static(resolve(root, 'node_modules/pdfmake/build'), { dotfiles: 'deny', index: false }),
  );
  // A business's logo for the emails it sends (email apps do not show images embedded in the message).
  app.get('/brand/:organizationId/logo', async (req, res, next) => {
    try {
      const organization = await backend.db.models.organizations.findById(req.params.organizationId);
      const image = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
        organization?.logoUrl ?? '',
      );
      if (!image) return next();
      // Email apps load the logo from their own pages, so it must be loadable cross-origin.
      res.set({ 'Cache-Control': 'public, max-age=86400', 'Cross-Origin-Resource-Policy': 'cross-origin' });
      res.type(image[1]).send(Buffer.from(image[2], 'base64'));
    } catch (error) {
      next(error);
    }
  });
  const controller = createPageController(backend);
  app.get('/', controller.home);
  app.get(['/login', '/signup', '/forgot-password', '/reset-password'], controller.authentication);
  app.get('/workspace/{*path}', controller.workspace);
  app.use(controller.notFound);
  app.use(controller.error);
}
