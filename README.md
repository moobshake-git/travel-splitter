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

## Accounts
- Everyone logs in with their own **username and password**.
- **Create account**: enter your name, a username and a password. If a friend already
  added you by that exact name, you take over that spot (max 10 people).
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
- Trips: any member can edit; only the person who created it can delete it.
- People: you can add buddies who haven't signed up yet ("invited"), and rename or remove
  them until they create an account. Only you can rename yourself.

## Features
- **Trips**: create, edit (name, currency, members), delete.
- **Expenses**: add, edit, delete, search. Each has a payer, date, category and notes.
- **Split modes**: evenly among selected people, exact amounts, percentages, or shares (weights).
  Rounding is handled to the cent so shares always add up to the total.
- **Balances & Settle up**: who paid what, each person's share, and the fewest
  payments needed to square everyone up.
