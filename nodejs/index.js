console.log("#")
console.log("# Starting `crypto_portfolio`")
console.log("#")

cryptoPortfolio = require('./crypto-portfolio');
configFile = require('./config.json')

cryptoPortfolio.fetch(configFile)
