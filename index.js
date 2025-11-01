const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const sqlite3 = require('sqlite3').verbose();
const puppeteer = require('puppeteer');
const app = express();
const PORT = 3000;

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9'
};

const sources = [
  {
    url: 'https://www.dolarhoy.com',
    name: 'dolarhoy',
    parser: ($) => {
      const buy = parseFloat($('.compra .val').first().text().replace('$', '').replace(',', '.').trim());
      const sell = parseFloat($('.venta .val').first().text().replace('$', '').replace(',', '.').trim());
      return { buy, sell };
    }
  },
  {
    url: 'https://www.cronista.com/MercadosOnline/moneda.html?id=ARSB',
    name: 'cronista',
    parser: ($) => {
      const buy = parseFloat($('.buy .val').first().text().replace('$', '').replace(/\./g, '').replace(',', '.').trim());
      const sell = parseFloat($('.sell .val').first().text().replace('$', '').replace(/\./g, '').replace(',', '.').trim());
      return { buy, sell };
    }
  },
  {
    url: 'https://wise.com/in/currency-converter/brl-to-usd-rate',
    name: 'wise',
    parser: ($) => {
      const text = $('main').text();
      const match = text.match(/1\s*BRL.*?([0-9.,]+)\s*USD/i);
      const rate = match ? parseFloat(match[1].replace(',', '.')) : null;
      return { buy: rate, sell: rate };
    }
  }
];

// Puppeteer for Nomad's homepage
async function fetchNomadRate() {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.goto('https://www.nomadglobal.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000); // ensure content loads

    const rateText = await page.evaluate(() => {
      const txt = document.body.innerText;
      const match = txt.match(/US\$ 1 = R\$ ([0-9.,]+)/);
      return match ? match[1] : null;
    });

    await browser.close();

    if (rateText) {
      const usdBrl = parseFloat(rateText.replace(',', '.'));
      const brlUsd = usdBrl ? 1 / usdBrl : null;
      return { buy: brlUsd, sell: brlUsd, source: 'https://www.nomadglobal.com/' };
    }
    return { buy: null, sell: null, source: 'https://www.nomadglobal.com/' };
  } catch (err) {
    console.error('Puppeteer/Nomad error:', err.message);
    if (browser) await browser.close();
    return { buy: null, sell: null, source: 'https://www.nomadglobal.com/' };
  }
}


// Puppeteer for Nubank
async function fetchNubankRate() {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.goto('https://nubank.com.br/taxas-conversao/', { waitUntil: 'domcontentloaded' });

    // Extract the most recent rate inside the conversion table
    const rateText = await page.evaluate(() => {
      const el = document.querySelector('td.css-119vuvi font');
      return el ? el.textContent : null;
    });

    await browser.close();

    if (rateText) {
      const usdBrl = parseFloat(rateText.replace(',', '.'));
      const brlUsd = usdBrl ? 1 / usdBrl : null;
      return { buy: brlUsd, sell: brlUsd, source: 'https://nubank.com.br/taxas-conversao/' };
    }
    return { buy: null, sell: null, source: 'https://nubank.com.br/taxas-conversao/' };
  } catch (err) {
    console.error('Puppeteer/Nubank error:', err.message);
    if (browser) await browser.close();
    return { buy: null, sell: null, source: 'https://nubank.com.br/taxas-conversao/' };
  }
}

const db = new sqlite3.Database(':memory:');
db.run(`CREATE TABLE IF NOT EXISTS rates (
  id INTEGER PRIMARY KEY,
  buy_price REAL,
  sell_price REAL,
  source TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

async function fetchAndStoreAllRates() {
  // cheerio/axios sources
  for (let src of sources) {
    try {
      const { data } = await axios.get(src.url, { headers, timeout: 15000 });
      const $ = cheerio.load(data);
      const { buy, sell } = src.parser($);
      if (!isNaN(buy) && !isNaN(sell)) {
        db.run("INSERT INTO rates (buy_price, sell_price, source) VALUES (?, ?, ?)", [buy, sell, src.url]);
      }
    } catch (err) {
      console.error(`Error fetching from ${src.name}:`, err.message);
    }
  }
  // Puppeteer sources
  const nomad = await fetchNomadRate();
  if (!isNaN(nomad.buy) && !isNaN(nomad.sell)) {
    db.run("INSERT INTO rates (buy_price, sell_price, source) VALUES (?, ?, ?)", [nomad.buy, nomad.sell, nomad.source]);
  }
  const nubank = await fetchNubankRate();
  if (!isNaN(nubank.buy) && !isNaN(nubank.sell)) {
    db.run("INSERT INTO rates (buy_price, sell_price, source) VALUES (?, ?, ?)", [nubank.buy, nubank.sell, nubank.source]);
  }
}

fetchAndStoreAllRates();
setInterval(fetchAndStoreAllRates, 60000);

app.get('/quotes', (req, res) => {
  db.all('SELECT * FROM rates WHERE id IN (SELECT MAX(id) FROM rates GROUP BY source)', (err, rows) => {
    if (err) return res.status(500).send(err.message);
    res.json(rows.map(row => ({
      buy_price: row.buy_price,
      sell_price: row.sell_price,
      source: row.source
    })));
  });
});

app.get('/average', (req, res) => {
  db.all('SELECT * FROM rates WHERE id IN (SELECT MAX(id) FROM rates GROUP BY source)', (err, rows) => {
    if (err) return res.status(500).send(err.message);
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const buys = rows.map(r => r.buy_price);
    const sells = rows.map(r => r.sell_price);
    res.json({
      average_buy_price: avg(buys),
      average_sell_price: avg(sells)
    });
  });
});

app.get('/slippage', (req, res) => {
  db.all('SELECT * FROM rates WHERE id IN (SELECT MAX(id) FROM rates GROUP BY source)', (err, rows) => {
    if (err) return res.status(500).send(err.message);
    const avgBuy = rows.reduce((acc, r) => acc + r.buy_price, 0) / rows.length;
    const avgSell = rows.reduce((acc, r) => acc + r.sell_price, 0) / rows.length;
    const slips = rows.map(r => ({
      buy_price_slippage: ((r.buy_price - avgBuy) / avgBuy),
      sell_price_slippage: ((r.sell_price - avgSell) / avgSell),
      source: r.source
    }));
    res.json(slips);
  });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
