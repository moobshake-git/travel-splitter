// Travel Splitter — zero-dependency local server.
// Run:            node server.js [port]          then open http://localhost:3000
// Reset password: node server.js reset-password <username> <new-password>
if (require.main === module && process.argv[2] === 'reset-password') {
  process.exit(require('./bin/reset-password').resetPassword(process.argv.slice(3)));
}

let server;
try {
  ({ server } = require('./lib/http'));
} catch (err) {
  if (err.code !== 'EDATAFILE' || require.main !== module) throw err;
  console.error(err.message);
  process.exit(1);
}

if (require.main === module) {
  const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 3000;
  server.listen(PORT, () => console.log(`Travel Splitter running at http://localhost:${PORT}`));
}
module.exports = { server };
