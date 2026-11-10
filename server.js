// Travel Splitter — zero-dependency local server.
// Run:            node server.js [port]          then open http://localhost:3000
// Reset password: node server.js reset-password <username> <new-password>   (server stopped)
const isMain = require.main === module;

if (isMain && process.argv[2] === 'reset-password') {
  require('./bin/reset-password').resetPassword(process.argv.slice(3)).then((code) => process.exit(code));
  return;
}

let server;
try {
  ({ server } = require('./lib/http'));
} catch (err) {
  if (err.code !== 'EDATAFILE' || !isMain) throw err;
  console.error(err.message);
  process.exit(1);
}

if (isMain) {
  const holder = require('./lib/lock').acquire();
  if (holder) {
    console.error(`Another Travel Splitter server (pid ${holder}) is already using this data file. Stop it first.`);
    process.exit(1);
  }
  const arg = process.argv[2];
  const PORT = /^\d+$/.test(arg || '') ? Number(arg) : Number(process.env.PORT) || 3000; // 0 = any free port
  server.listen(PORT, () => console.log(`Travel Splitter running at http://localhost:${server.address().port}`));
}
module.exports = { server };
