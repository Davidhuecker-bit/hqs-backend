function randomNormal() {
  return Math.sqrt(-2.0 * Math.log(Math.random())) *
         Math.cos(2.0 * Math.PI * Math.random());
}

function monteCarloSimulation(S, mu, sigma, days = 252, simulations = 1000) {
  const results = [];

  for (let i = 0; i < simulations; i++) {
    let price = S;

    for (let t = 0; t < days; t++) {
      const randomShock = sigma * randomNormal();
      price = price * (1 + mu / 252 + randomShock);
    }

    results.push(price);
  }

  results.sort((a, b) => a - b);

  return {
    pessimistic: results[Math.floor(simulations * 0.1)],
    realistic: results[Math.floor(simulations * 0.5)],
    optimistic: results[Math.floor(simulations * 0.9)]
  };
}

module.exports = { monteCarloSimulation };
