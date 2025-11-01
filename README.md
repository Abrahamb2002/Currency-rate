# Currency Rate API

A Node.js API for real-time USD/ARS and USD/BRL rates scraped from major providers.
- Updates rates every 60s
- Endpoints: /quotes, /average, /slippage
- Deployable on Railway, Render, etc. with full Puppeteer support

## Setup
npm install
node index.js


## Deploy (Railway)

1. Push this repo to Github
2. Import to Railway and set start command to `node index.js`
3. Use the provided public URL for API access

## Endpoints

- `/quotes` – All latest rates
- `/average` – Average rates
- `/slippage` – Slippage per source

