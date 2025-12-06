// rateLogic.js

function computeRate(T, K, usdAmount) {
    // T = Tiger rate in CNY per USD
    // K = NGN per CNY
    // usdAmount = card amount

    const PERCENT_PROFIT = 0.0303; // 3.03%
    const FIXED_PROFIT = 3000; // ₦

    const baseRateNgnPerUsd = T * K;
    const totalCost = baseRateNgnPerUsd * usdAmount;

    let profit;
    if (usdAmount >= 51) {
        profit = totalCost * PERCENT_PROFIT;
    } else {
        profit = FIXED_PROFIT;
    }

    const payout = totalCost - profit;
    const customerRate = payout / usdAmount;

    return {
        baseRateNgnPerUsd: Number(baseRateNgnPerUsd.toFixed(2)),
        totalCost: Number(totalCost.toFixed(2)),
        profit: Number(profit.toFixed(2)),
        payout: Number(payout.toFixed(2)),
        customerRate: Number(customerRate.toFixed(2)),
    };
}

module.exports = { computeRate };
