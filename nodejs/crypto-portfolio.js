const ccxt = require ('ccxt');
const usd_stablecoins = ["USTF0"]

/******************************
 *
 * PROCESSING FUNCTIONS
 *
 *******************************/

async function get_btc_fiat_rate() {
  console.log("-> calling get_btc_fiat_rate() on", rate_exchange)
  return tickerExchange.fetchTicker("BTC/" + fiat_currency)
}

async function get_balance_from_exchange(e)  {
  params = e.params || {}
  console.log("-> calling fetchBalance() for", e.name)
  return eval(e.name).fetchBalance(params)
}

async function set_fiat_value(asset, entries) {
  usd_rate = null
  if (asset === fiat_currency || usd_stablecoins.includes(asset)) {
    console.log("-- set_fiat_value: skipped for " + fiat_currency)
    usd_rate = 1
  } else if (is_fiat(asset)) {
    console.log("-> set_fiat_value: " + asset + " is fiat, will convert in", fiat_currency)
    await eval(rate_exchange).fetchTicker(asset + "/" + fiat_currency)
    .then(
      (result) => {
        console.log("<- got fetchTicker for", asset, "@", result.close)
        usd_rate = result.close
      },
      (error) => { console.log("-> error fetchTicker", exchange.name, error) }
    )
  } else if (!is_fiat(asset) && asset !== "BTC") {
    console.log("-> set_fiat_value: " + asset + " is NOT fiat, will convert in BTC then", fiat_currency)
    let exchange_to_use = "bitfinex"
    await eval(exchange_to_use).fetchTicker(asset + "/BTC")
    .then(
      (result) => {
        console.log("<- got fetchTicker for", asset, "@", result.close)
        usd_rate = result.close * btc_fiat_value
      },
      (error) => { console.log("-> error fetchTicker", asset.exchange, error) }
    )
  } else {
    console.log("-- set_fiat_value: calcuating BTC amount")
    usd_rate = btc_fiat_value
  }

  entries.forEach(function(e) {
    update_object_conversion(e, usd_rate)
  })

}

/******************************
 *
 * HELPERS
 *
 *******************************/

 function is_fiat(asset) {
  switch (asset) {
    case "USD": return true
    case "EUR": return true
    default: return false
  }
}

function is_too_small(amount) {
  let test_val = amount.toLocaleString("en-US", {maximumFractionDigits: 2})
  if (Number(test_val) === 0) {
    return true
  }
}

function is_lower_case(str) {
  return str == str.toLowerCase() && str != str.toUpperCase();
}

function format_for_influx(arr, tag, key, val) {
  let data = arr.map(asset => asset[key] + "=" + asset[val]);
  return tag + ",exchange=" + arr[0].name + " " + data.join(",")
}

function post_data(data) {
  console.log("-> Sending data to influxdb...");
  const https = require('https');

  const options = {
    protocol: influx.protocol,
    hostname: influx.hostname,
    port: influx.port,
    path: '/api/v2/write?org='+influx.org+'&bucket='+influx.bucket+'&precision=s',
    method: 'POST',
    headers: {
      'Authorization': 'Token ' + influx.token
    }
  };

  const req = https.request(options, res => {
    console.log(`statusCode: ${res.statusCode}`)

    res.on('data', d => {
      process.stdout.write(d)
    })
  })

  req.on('error', error => {
    console.error(error)
  })

  req.write(data)
  req.end()

}

function update_object_conversion(o, rate) {
  object = portfolio.find((p) => p == o);
  object.usd_rate = rate
  object.usd_value = rate * o.amount
}

function properties_sum(items, prop) {
  return items.reduce( function(a, b){
    return a + b[prop];
  }, 0);
};

function group_by(objectArray, property) {
  return objectArray.reduce(function (acc, obj) {
    let key = obj[property]
    if (!acc[key]) {
      acc[key] = []
    }
    acc[key].push(obj)
    return acc
  }, {})
}


/******************************
 *
 * LET'S GO!
 *
 *******************************/

exports.fetch = (config) => {

  global.exchanges               = config.exchanges
  global.rate_exchange           = config.portfolio_config.rate_exchange
  global.fiat_currency           = config.portfolio_config.fiat_currency || "USD"
  global.excluded_symbols        = config.portfolio_config.excluded_symbols
  global.influx                  = config.influxdb
  global.btc_fiat_value          = null;

  let assets                     = [];
  global.portfolio               = [];

  let tickerExchangeIndex        = exchanges.map((e) => e.name).indexOf(rate_exchange);
  global.tickerExchange          = new ccxt[rate_exchange] ({
    apiKey: exchanges[tickerExchangeIndex].apiKey,
    secret: exchanges[tickerExchangeIndex].secret
  });


  get_btc_fiat_rate().then((result) => {
    btc_fiat_value = result.close
    console.log("<- BTC worth", btc_fiat_value, fiat_currency)

    // balance_promises = []
    let balance_status = 0
    exchanges.forEach(function(e) {
      console.log("-- initializing", e.name)
      global[e.name] = new ccxt[e.name] ({
        apiKey: e.apiKey,
        secret: e.secret
      })

      get_balance_from_exchange(e).then((balance) => {
        console.log("<- got balance from", e.name)
        for (const [asset, amount] of Object.entries(balance.total)) {
          if(!is_too_small(amount) && !excluded_symbols.includes(asset.toUpperCase())) {
            portfolio.push({
              label: e.label,
              name: e.name,
              asset: asset,
              amount: amount,
              usd_rate: null,
              usd_value: null
            })
          }
        }

        balance_status++
        if (balance_status == exchanges.length) {
          console.log("<- got a unified balance! (without", fiat_currency, "value for now...)")

          let conversion_promises = []
          let unique_assets = group_by(portfolio, 'asset')
          let string_to_write = ''

          for (const [asset, entries] of Object.entries(unique_assets)) {
            conversion_promises.push(set_fiat_value(asset, entries))
          }

          Promise.all(conversion_promises).then((values) => {
            // console.log(portfolio)

            let portfolio_by_label = group_by(portfolio, 'label')

            // portfolio by label in usd
            for (const [label, entries] of Object.entries(portfolio_by_label)) {
              string_to_write += `portfolio,unit=usd,account=${format_for_influx(entries, label, 'asset', 'usd_value')}\n`
            }

            // portfolio by label in assets
            for (const [label, entries] of Object.entries(portfolio_by_label)) {
              string_to_write += `portfolio,unit=assets,account=${format_for_influx(entries, label, 'asset', 'amount')}\n`
            }

            // portfolio total
            string_to_write += `portfolio,unit=total USD=${properties_sum(portfolio, 'usd_value')}`

            // console.log(string_to_write)
            post_data(string_to_write)
          });

        }
      })

    })
  })

}

