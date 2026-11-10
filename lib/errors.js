class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status) => (msg) => { throw new HttpError(status, msg); };

module.exports = {
  HttpError,
  bad: fail(400),
  unauthorized: fail(401),
  forbidden: fail(403),
  notFound: (what) => { throw new HttpError(404, `${what} not found`); },
  conflict: fail(409),
  tooMany: fail(429),
};
