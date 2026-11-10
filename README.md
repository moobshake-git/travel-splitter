# Travel Splitter

Track shared travel expenses for up to 10 people and split costs automatically.
No dependencies — just Node.js.

## Run

```bash
cd travel-splitter
node server.js
```

Open http://localhost:3000. Data is saved to `data.json` next to `server.js`
(delete that file to start fresh). Anyone on your Wi-Fi can use it at
`http://<your-computer-ip>:3000`.

## Development

The app itself has no dependencies. Linting needs dev dependencies (ESLint), so run
`npm install` once. Tests use Node's built-in runner (Node 22+).

```bash
npm test           # API + unit tests
npm run lint       # ESLint
npm run check      # both; this is what CI runs on every push and pull request
npm run coverage   # tests with a coverage report
```

Tests start the real server on a random port against a throwaway data file
(`TS_DATA_FILE`), so your `data.json` is never touched.

## Accounts
- Everyone logs in with their own **username and password**.
- **Create account**: enter your name, a username and a password (max 10 people).
  If a friend already added you, also enter the **invite code** they were shown. You then
  take over that spot, with its trips and expenses. Each code works once.
- Passwords are stored hashed (scrypt), never in plain text. Sessions last 30 days.
- 5 wrong passwords in a row locks that username for 1 minute.
- **Forgot password?** Whoever runs the server can reset it:
  ```bash
  node server.js reset-password <username> <new-password>
  ```

## Who can do what
- You only see trips you are on.
- Expenses: any trip member can add one; only the person who **added** or **paid**
  for it can edit or delete it (others see a 🔒).
- Trips: any member can edit; only the person who created it can delete it, and the
  creator can't be removed from their own trip.
- People: you can add buddies who haven't signed up yet ("invited"). You get an invite
  code to send them (🔗 shows it again). You can rename or remove an invited person if you
  added them or share a trip with them. Only you can rename yourself.
- Each user only sees their own username; invite codes are only shown to people who can
  manage that invitee.
- Currencies must be a real 3-letter code (USD, EUR, SGD, JPY, …).

## Features
- **Trips**: create, edit (name, currency, members), delete.
- **Expenses**: add, edit, delete, search. Each has a payer, date, category and notes.
- **Split modes**: evenly among selected people, exact amounts, percentages, or shares (weights).
  Rounding is handled to the cent so shares always add up to the total.
- **Balances & Settle up**: who paid what, each person's share, and the fewest
  payments needed to square everyone up.
