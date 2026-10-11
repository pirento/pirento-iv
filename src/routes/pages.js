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
