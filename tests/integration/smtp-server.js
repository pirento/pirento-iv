/**
 * A minimal SMTP server for tests: speaks EHLO, AUTH PLAIN/LOGIN (password "secret"; `rejectLogins` makes every login fail), MAIL, RCPT,
 * DATA and QUIT on 127.0.0.1, and keeps each received message's raw text, so emails can be sent
 * through the real nodemailer transport without any outside mail server.
 */

import { createServer } from 'node:net';

export async function startSmtpServer() {
  const messages = [];
  const state = { rejectLogins: false };
  const server = createServer((socket) => {
    let buffer = '';
    let data = null;
    let login = null;
    const reply = (line) => socket.write(`${line}\r\n`);
    const checkPassword = (password) =>
      reply(
        password === 'secret' && !state.rejectLogins
          ? '235 Authenticated'
          : '535 5.7.8 Authentication credentials invalid',
      );
    reply('220 test-smtp ready');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data !== null) {
          if (line === '.') {
            messages.push(data.join('\r\n'));
            data = null;
            reply('250 Message accepted');
          } else data.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        if (login === 'user') {
          login = 'password';
          reply('334 UGFzc3dvcmQ6');
          continue;
        }
        if (login === 'password') {
          login = null;
          checkPassword(Buffer.from(line, 'base64').toString());
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO') reply('250-test-smtp\r\n250 AUTH PLAIN LOGIN');
        else if (command === 'HELO') reply('250 test-smtp');
        else if (/^AUTH PLAIN /i.test(line))
          checkPassword(Buffer.from(line.slice(11), 'base64').toString().split('\0')[2] ?? '');
        else if (/^AUTH LOGIN/i.test(line)) {
          login = 'user';
          reply('334 VXNlcm5hbWU6');
        } else if (command === 'DATA') {
          data = [];
          reply('354 End data with <CR><LF>.<CR><LF>');
        } else if (command === 'QUIT') {
          reply('221 Bye');
          socket.end();
        } else reply('250 OK');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    messages,
    // Set to true to answer every login with 535, like a server after a password change.
    set rejectLogins(value) {
      state.rejectLogins = value;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
